import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from './generated/client.js';
import { randomUUID } from 'node:crypto';
import type { Role } from './generated/enums.js';

export { PrismaClient };
export type { Role };
type Transaction = Prisma.TransactionClient;

// Only this package sees the unrestricted Prisma client. HTTP services receive
// the deliberately small tenant-scoped interface below.
export class Database {
  private readonly client: PrismaClient;
  constructor(url: string, client?: PrismaClient) {
    this.client = client ?? new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 }),
    });
  }
  connect() { return this.client.$connect(); }
  close() { return this.client.$disconnect(); }
  async ping() { await this.client.$queryRaw`SELECT 1`; }
  async resolve(hostname: string, pinnedId?: string) {
    return this.client.tenant.findFirst({
      where: { hostname, status: 'active', ...(pinnedId ? { id: pinnedId } : {}) },
      select: { id: true, name: true, slug: true, hostname: true },
    });
  }
  async run<T>(tenantId: string, action: (data: TenantData) => Promise<T>): Promise<T> {
    return this.client.$transaction(async tx => {
      // A tenant row lock serializes invitation consumption, MFA/recovery replay,
      // membership changes and last-Owner checks, including across API replicas.
      const rows = await tx.$queryRaw<{id: string}[]>`SELECT id FROM tenants WHERE id = ${tenantId}::uuid AND status = 'active' FOR UPDATE`;
      if (!rows.length) throw new Error('Tenant unavailable');
      return action(new TenantData(tenantId, tx));
    }, { maxWait: 10000, timeout: 20000 });
  }
  async initialize(input: { name: string; slug: string; hostname: string }) {
    return this.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.slug}))`;
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
  async dueMail() {
    return this.client.emailOutbox.findMany({
      where: { deliveredAt: null, availableAt: { lte: new Date() }, attempts: { lt: 10 }, tenant: { status: 'active' } },
      select: { id: true, tenantId: true }, orderBy: { availableAt: 'asc' }, take: 25,
    });
  }
}

export class TenantData {
  constructor(readonly tenantId: string, private readonly tx: Transaction) {}
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

