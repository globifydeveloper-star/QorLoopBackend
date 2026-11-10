import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from './generated/client.js';
import { randomUUID } from 'node:crypto';
import type { Role } from './generated/enums.js';
import { UploadRepository } from './uploads.js';
import { CategoryRepository, ProductRepository } from './products.js';
import { PricingRepository } from './pricing.js';
import { ReconRepository } from './recon.js';
import { GeneratedFilesRepository } from './generated-files.js';
import { SettingsRepository } from './settings.js';
import { ActivityRepository } from './activity.js';
import { OnboardingRepository } from './onboarding.js';
import { CatalogueStockRepository } from './catalogue-stock.js';

export { UploadRepository, ProductRepository, CategoryRepository, PricingRepository, ReconRepository, CatalogueStockRepository };
export type { ReconMarketplaceState, ReconRowsQuery, ReconRowType } from './recon.js';
export type { PricingSelection, ProductFilter, ProductMarketplaceFilter, ProductMarketplaceRow, ProductTab } from './products.js';

export { PrismaClient };
export type { Role };
type Transaction = Prisma.TransactionClient;

/** Another run of the same background job holds the tenant's advisory lock. */
export class BusyError extends Error {
  constructor(job: string) { super(`${job} is already running for this store`); this.name = 'BusyError'; }
}

/** Tables whose statistics a bulk job refreshes after commit (Database.analyze). */
export const ANALYZED_TABLES = ['products', 'listings', 'recon_rows'] as const;
export type AnalyzedTable = typeof ANALYZED_TABLES[number];

// Only this package sees the unrestricted Prisma client. HTTP services receive
// the deliberately small tenant-scoped interface below.
export class Database {
  private readonly client: PrismaClient;
  constructor(url: string, client?: PrismaClient) {
    this.client = client ?? new PrismaClient({
      // adapter-pg sends and parses timestamptz as offset-less UTC, so the session must be UTC
      // regardless of the server or database TimeZone setting.
      adapter: new PrismaPg({ connectionString: url, max: 5, connectionTimeoutMillis: 5000, options: '-c timezone=UTC' }),
    });
  }
  private isClosed = false;
  connect() { this.isClosed = false; return this.client.$connect(); }
  close() { this.isClosed = true; return this.client.$disconnect(); }
  /**
   * True from close() until the next connect(). Prisma connects lazily, so a query after close() silently opens a new
   * pool; background work that outlives a shutdown checks this instead of writing (recomputeRecon's failure event).
   */
  get closed() { return this.isClosed; }
  async ping() { await this.client.$queryRaw`SELECT 1`; }
  async resolve(hostname: string, pinnedId?: string) {
    return this.client.tenant.findFirst({
      where: { hostname, status: 'active', ...(pinnedId ? { id: pinnedId } : {}) },
      select: { id: true, name: true, slug: true, hostname: true },
    });
  }
  /** `timeout` (ms) is for the few bulk jobs that must stay one transaction, such as an upload apply; requests keep 20 s. */
  async run<T>(tenantId: string, action: (data: TenantData) => Promise<T>, { timeout = 20000 }: { timeout?: number } = {}): Promise<T> {
    return this.client.$transaction(async tx => {
      // A tenant row lock serializes invitation consumption, MFA/recovery replay,
      // membership changes and last-Owner checks, including across API replicas.
      // NO KEY UPDATE, not UPDATE (ADR 012): it still conflicts with itself, FOR SHARE, FOR UPDATE and any UPDATE or
      // DELETE of the tenant row, but not with the FOR KEY SHARE that every foreign-key insert (recon rows, products,
      // listings, audit events) takes on it, so a long recompute's inserts no longer make every request wait.
      const rows = await tx.$queryRaw<{id: string}[]>`SELECT id FROM tenants WHERE id = ${tenantId}::uuid AND status = 'active' FOR NO KEY UPDATE`;
      if (!rows.length) throw new Error('Tenant unavailable');
      return action(new TenantData(tenantId, tx));
    }, { maxWait: 10000, timeout });
  }
  /**
   * For long background recomputes that read many tables and write only their own (the recon): ONE transaction on a
   * consistent snapshot (REPEATABLE READ) WITHOUT the tenant row lock, so requests and upload applies are never kept
   * waiting. Runs of the same `job` for a tenant are serialized by a transaction advisory lock instead; a run that finds
   * it taken throws BusyError (the queue retries it).
   */
  async runSnapshot<T>(tenantId: string, job: string, action: (data: TenantData) => Promise<T>, { timeout = 20000 }: { timeout?: number } = {}): Promise<T> {
    return this.client.$transaction(async tx => {
      const [state] = await tx.$queryRaw<{ active: boolean; locked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantId}::uuid AND status = 'active') AS active,
               pg_try_advisory_xact_lock(hashtextextended(${job + ':' + tenantId}, 0)) AS locked`;
      if (!state?.active) throw new Error('Tenant unavailable');
      if (!state.locked) throw new BusyError(job);
      return action(new TenantData(tenantId, tx));
    }, { maxWait: 10000, timeout, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  /** Consistent multi-table inputs for preview/generation, without a tenant lock or an exclusive job lock. */
  async readSnapshot<T>(tenantId: string, action: (data: TenantData) => Promise<T>): Promise<T> {
    return this.client.$transaction(async tx => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, status: 'active' }, select: { id: true } });
      if (!tenant) throw new Error('Tenant unavailable');
      return action(new TenantData(tenantId, tx));
    }, { maxWait: 10000, timeout: 20000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  /**
   * Refreshes planner statistics after a committed bulk write (apply, recompute), so the next query on a freshly
   * loaded table is planned from real row counts instead of waiting for autovacuum. Outside any transaction; SKIP_LOCKED
   * returns at once when autovacuum (or another ANALYZE) is already on the table. Statistics are per table, not per
   * tenant, so only allow-listed table names are accepted.
   */
  async analyze(tables: readonly AnalyzedTable[]): Promise<number> {
    const names = [...new Set(tables)];
    if (!names.length) return 0;
    if (names.some(t => !ANALYZED_TABLES.includes(t))) throw new Error('Table not allowed for ANALYZE');
    const t0 = Date.now();
    await this.client.$executeRawUnsafe(`ANALYZE (SKIP_LOCKED) ${names.map(t => `"${t}"`).join(', ')}`);
    return Date.now() - t0;
  }
  async initialize(input: { name: string; slug: string; hostname: string }) {
    return this.client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.slug}))`;
      const prior = await tx.tenant.findUnique({ where: { slug: input.slug } });
      if (prior) {
        if (prior.name !== input.name || prior.hostname !== input.hostname || prior.status !== 'active') throw new Error('Existing store configuration differs; explicit operations review required');
        return prior;
      }
      return tx.tenant.create({
        data: { ...input, id: randomUUID(), stores: { create: { name: input.name } }, settings: { create: {} } },
      });
    });
  }
  // Control-plane enumeration returns only routing coordinates, never user data.
  async tenantsWithStuckUploads(olderThan: Date) {
    const rows = await this.client.upload.findMany({
      where: { status: { in: ['processing', 'applying'] }, updatedAt: { lt: olderThan }, tenant: { status: 'active' } },
      select: { tenantId: true }, distinct: ['tenantId'], take: 100,
    });
    return rows.map(r => r.tenantId);
  }
  async dueMail() {
    return this.client.emailOutbox.findMany({
      where: { deliveredAt: null, availableAt: { lte: new Date() }, attempts: { lt: 10 }, tenant: { status: 'active' } },
      select: { id: true, tenantId: true }, orderBy: { availableAt: 'asc' }, take: 25,
    });
  }
}

export class TenantData {
  readonly uploads: UploadRepository;
  readonly products: ProductRepository;
  readonly categories: CategoryRepository;
  readonly pricing: PricingRepository;
  readonly recon: ReconRepository;
  readonly generatedFiles: GeneratedFilesRepository;
  readonly settings: SettingsRepository;
  readonly activity: ActivityRepository;
  readonly onboarding: OnboardingRepository;
  readonly stock: CatalogueStockRepository;
  constructor(readonly tenantId: string, private readonly tx: Transaction) {
    this.uploads = new UploadRepository(tenantId, tx);
    this.products = new ProductRepository(tenantId, tx);
    this.categories = new CategoryRepository(tenantId, tx);
    this.pricing = new PricingRepository(tenantId, tx);
    this.recon = new ReconRepository(tenantId, tx);
    this.generatedFiles = new GeneratedFilesRepository(tenantId, tx);
    this.settings = new SettingsRepository(tenantId, tx);
    this.activity = new ActivityRepository(tenantId, tx);
    this.onboarding = new OnboardingRepository(tenantId, tx);
    this.stock = new CatalogueStockRepository(tenantId, tx);
  }
  tenant() { return this.tx.tenant.findUniqueOrThrow({ where: { id: this.tenantId }, include: { settings: true } }); }
  userByEmail(email: string) { return this.tx.user.findFirst({ where: { tenantId: this.tenantId, email } }); }
  userById(id: string) { return this.tx.user.findFirst({ where: { tenantId: this.tenantId, id } }); }
  createUser(data: Omit<Prisma.UserUncheckedCreateInput, 'tenantId'>) {
    return this.tx.user.create({ data: { ...data, tenantId: this.tenantId } });
  }
  updateUser(id: string, data: Pick<Prisma.UserUpdateManyMutationInput, 'passwordHash' | 'mfaSecret' | 'pendingMfaSecret' | 'pendingMfaExpiresAt' | 'lastTotpStep'>) {
    return this.tx.user.updateMany({ where: { tenantId: this.tenantId, id }, data });
  }
  membership(userId: string) { return this.tx.membership.findFirst({ where: { tenantId: this.tenantId, userId } }); }
  memberById(id: string) { return this.tx.membership.findFirst({ where: { tenantId: this.tenantId, id }, include: { user: true } }); }
  members() {
    return this.tx.membership.findMany({
      where: { tenantId: this.tenantId, active: true }, orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, active: true, createdAt: true, user: { select: { id: true, name: true, email: true, mfaSecret: true } } },
    });
  }
  ownerCount() { return this.tx.membership.count({ where: { tenantId: this.tenantId, role: 'owner', active: true } }); }
  createMembership(userId: string, role: Role) { return this.tx.membership.create({ data: { tenantId: this.tenantId, userId, role } }); }
  updateMembership(id: string, data: { role?: Role; active?: boolean }) {
    return this.tx.membership.updateMany({ where: { tenantId: this.tenantId, id }, data });
  }
  invitationByHash(tokenHash: string) { return this.tx.invitation.findFirst({ where: { tenantId: this.tenantId, tokenHash } }); }
  invitationById(id: string) { return this.tx.invitation.findFirst({ where: { tenantId: this.tenantId, id } }); }
  pendingInvitation(email: string) { return this.tx.invitation.findFirst({ where: { tenantId: this.tenantId, pendingEmail: email } }); }
  firstOwnerInvitation() { return this.tx.invitation.findFirst({ where: { tenantId: this.tenantId, role: 'owner' }, orderBy: { createdAt: 'asc' } }); }
  invitations() {
    return this.tx.invitation.findMany({
      where: { tenantId: this.tenantId, acceptedAt: null, revokedAt: null }, orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
  }
  createInvitation(data: Omit<Prisma.InvitationUncheckedCreateInput, 'tenantId'>) {
    return this.tx.invitation.create({ data: { ...data, tenantId: this.tenantId } });
  }
  updateInvitation(id: string, data: Pick<Prisma.InvitationUpdateManyMutationInput, 'pendingEmail' | 'tokenHash' | 'expiresAt' | 'acceptedAt' | 'revokedAt'>) {
    return this.tx.invitation.updateMany({ where: { tenantId: this.tenantId, id }, data });
  }
  sessionByHash(tokenHash: string) { return this.tx.session.findFirst({ where: { tenantId: this.tenantId, tokenHash }, include: { user: true } }); }
  createSession(data: Omit<Prisma.SessionUncheckedCreateInput, 'tenantId'>) { return this.tx.session.create({ data: { ...data, tenantId: this.tenantId } }); }
  touchSession(id: string) { return this.tx.session.updateMany({ where: { tenantId: this.tenantId, id }, data: { lastSeenAt: new Date() } }); }
  deleteSession(id: string) { return this.tx.session.deleteMany({ where: { tenantId: this.tenantId, id } }); }
  deleteUserSessions(userId: string) { return this.tx.session.deleteMany({ where: { tenantId: this.tenantId, userId } }); }
  createReset(data: Omit<Prisma.PasswordResetUncheckedCreateInput, 'tenantId'>) { return this.tx.passwordReset.create({ data: { ...data, tenantId: this.tenantId } }); }
  resetByHash(tokenHash: string) { return this.tx.passwordReset.findFirst({ where: { tenantId: this.tenantId, tokenHash } }); }
  invalidateResets(userId: string) { return this.tx.passwordReset.updateMany({ where: { tenantId: this.tenantId, userId, usedAt: null }, data: { usedAt: new Date() } }); }
  async replaceRecoveryCodes(userId: string, hashes: string[]) {
    await this.tx.recoveryCode.deleteMany({ where: { tenantId: this.tenantId, userId } });
    await this.tx.recoveryCode.createMany({ data: hashes.map(codeHash => ({ tenantId: this.tenantId, userId, codeHash })) });
  }
  consumeRecovery(userId: string, codeHash: string) {
    return this.tx.recoveryCode.updateMany({ where: { tenantId: this.tenantId, userId, codeHash, usedAt: null }, data: { usedAt: new Date() } });
  }
  event(action: string, actorId: string | null, entityId: string | null, requestId?: string, details?: Prisma.InputJsonObject) {
    return this.tx.auditEvent.create({ data: { tenantId: this.tenantId, action, actorId, entityId, requestId, details } });
  }
  queueMail(dedupeKey: string, sealedMessage: string) {
    return this.tx.emailOutbox.create({ data: { tenantId: this.tenantId, dedupeKey, sealedMessage } });
  }
  async claimMail(id: string) {
    const row = await this.tx.emailOutbox.findFirst({ where: { tenantId: this.tenantId, id, deliveredAt: null, availableAt: { lte: new Date() }, attempts: { lt: 10 } } });
    if (!row) return null;
    await this.tx.emailOutbox.updateMany({ where: { tenantId: this.tenantId, id }, data: { attempts: { increment: 1 }, availableAt: new Date(Date.now() + 300_000) } });
    return row;
  }
  ackMail(id: string) { return this.tx.emailOutbox.updateMany({ where: { tenantId: this.tenantId, id }, data: { deliveredAt: new Date(), sealedMessage: '' } }); }
}

