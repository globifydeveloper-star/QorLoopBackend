// ADR 018: scripts/dev/reset-store-data.mjs and reset-store-storage.mjs. The database tests run the plan module's own SQL
// (store-reset-plan.mjs) on PGlite inside a Prisma interactive transaction, the way the CLI runs it inside BEGIN/COMMIT.
// The CLI's checks that need a live API, Redis, S3 or a second PostgreSQL session are tested with fakes below.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { testDatabase } from './database.js';
import { onboardingProgress } from '../../../../packages/core/src/onboarding.js';
import { QUEUES } from '../../../../packages/shared/src/queue.js';
import { RECON_QUEUE_NAME, reconJobKey } from '../../../../packages/shared/src/recon.js';
import * as plan from '../../../../scripts/dev/store-reset-plan.mjs';
import { describeError, splitDatabaseUrl } from '../../../../scripts/dev/database-url.mjs';

type Row = Record<string, unknown>;
type Q = (text: string, params?: unknown[]) => Promise<Row[]>;
interface Raw {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
/** The plan's `q`: statements without a result set go through $executeRawUnsafe. */
const sql = (c: Raw): Q => async (text, params = []) =>
  /^\s*(ANALYZE|SET|BEGIN|COMMIT|ROLLBACK|CREATE|DROP)\b/i.test(text) ? (await c.$executeRawUnsafe(text, ...params), []) : c.$queryRawUnsafe<Row[]>(text, ...params);

const KEPT_ACTIONS = ['store.provisioned', 'auth.login_failed', 'invitation.created', 'team.role_changed', 'settings.changed', 'pricing.settings_changed', 'template.updated'];
const DELETED_ACTIONS = ['upload.applied', 'pricing.bulk_applied', 'product.field_changed', 'category.created', 'file.generated', 'recon.failed', 'pricing.marketplace_rule_set', 'some.future_action'];
const EXPECTED_DELETED = {
  erp_upload_changes: 1, upload_errors: 1, upload_rows: 1, catalogue_stock_edits: 1, marketplace_value_overrides: 1, recon_rows: 1, recon_summaries: 1, listings: 2,
  product_offers: 1, product_price_rules: 1, marketplace_price_rules: 1, generated_files: 1, notifications: 1, uploads: 2, products: 2,
  category_price_rules: 1, category_mappings: 1, categories: 2, audit_events: DELETED_ACTIONS.length,
};

type Fixture = Awaited<ReturnType<typeof testDatabase>>;
type Prisma = Fixture['prisma'];

/** One store with rows in every table that has a tenant_id (all 31). */
async function seedStore(prisma: Prisma, slug: string) {
  const id = randomUUID();
  const future = new Date(Date.now() + 86_400_000);
  const appliedAt = new Date(Date.now() - 3_600_000);
  await prisma.tenant.create({ data: { id, name: `Store ${slug}`, slug, hostname: `${slug}.localhost`, stores: { create: { name: `Store ${slug}` } }, settings: { create: {} } } });
  const owner = await prisma.user.create({ data: { tenantId: id, email: `owner@${slug}.test`, name: 'Owner', passwordHash: 'hash', emailVerifiedAt: new Date(), mfaSecret: 'sealed-secret' } });
  const analyst = await prisma.user.create({ data: { tenantId: id, email: `analyst@${slug}.test`, name: 'Analyst', passwordHash: 'hash', emailVerifiedAt: new Date() } });
  await prisma.membership.createMany({ data: [{ tenantId: id, userId: owner.id, role: 'owner' }, { tenantId: id, userId: analyst.id, role: 'analyst' }] });
  await prisma.invitation.create({ data: { tenantId: id, email: `new@${slug}.test`, pendingEmail: `new@${slug}.test`, role: 'analyst', tokenHash: randomUUID(), invitedBy: owner.id, expiresAt: future } });
  await prisma.session.create({ data: { tenantId: id, userId: owner.id, tokenHash: randomUUID(), csrfHash: 'csrf', assurance: 'full', expiresAt: future } });
  await prisma.passwordReset.create({ data: { tenantId: id, userId: analyst.id, tokenHash: randomUUID(), expiresAt: future } });
  await prisma.recoveryCode.create({ data: { tenantId: id, userId: owner.id, codeHash: 'code-hash' } });
  await prisma.pricingSettings.create({ data: { tenantId: id, rounding: '0.05' } });
  await prisma.emailOutbox.create({ data: { tenantId: id, dedupeKey: 'invitation:1', sealedMessage: 'sealed' } });
  await prisma.tenantMarketplace.create({ data: { tenantId: id, marketplaceId: 'talabat' } });
  await prisma.inputTemplate.create({ data: { tenantId: id, source: 'erp', name: 'My ERP', fields: { barcode: 'Barcode' }, signature: ['Barcode'] } });
  const parent = await prisma.category.create({ data: { tenantId: id, nameEn: 'Food' } });
  const child = await prisma.category.create({ data: { tenantId: id, nameEn: 'Snacks', parentId: parent.id } });
  await prisma.categoryMapping.create({ data: { tenantId: id, categoryId: child.id, marketplaceId: 'talabat', marketplaceCategory: 'Snacks' } });
  const p1 = await prisma.product.create({ data: { tenantId: id, barcode: '6281000000011', normalizedBarcode: '6281000000011', nameEn: 'Chips', erpPrice: 5, erpStock: 3, categoryId: child.id, status: 'active' } });
  const p2 = await prisma.product.create({ data: { tenantId: id, barcode: '6281000000028', normalizedBarcode: '6281000000028', nameEn: 'Juice', erpPrice: 7, erpStock: 0 } });
  await prisma.listing.createMany({ data: [
    { tenantId: id, productId: p1.id, marketplaceId: 'talabat', marketplaceProductId: 'T-1', barcodes: ['6281000000011'], price: 5.5, available: true },
    { tenantId: id, productId: null, marketplaceId: 'talabat', marketplaceProductId: 'T-X', barcodes: [], price: 1, available: false },
  ] });
  await prisma.categoryPriceRule.create({ data: { tenantId: id, categoryId: parent.id, mode: 'percent', value: 10 } });
  await prisma.productPriceRule.create({ data: { tenantId: id, productId: p1.id, mode: 'fixed', value: 6 } });
  await prisma.productOffer.create({ data: { tenantId: id, productId: p1.id, price: 4.5 } });
  await prisma.marketplacePriceRule.createMany({ data: [
    { tenantId: id, marketplaceId: 'talabat', productId: null, mode: 'percent', value: 5 },
    { tenantId: id, marketplaceId: 'talabat', productId: p2.id, mode: 'amount', value: 1 },
  ] });
  const erp = await prisma.upload.create({ data: { tenantId: id, source: 'erp', fileName: 'erp.xlsx', size: 100, storageKey: `tenants/${id}/uploads/e/original.xlsx`, uploadedById: owner.id, status: 'applied', appliedAt } });
  const talabat = await prisma.upload.create({ data: { tenantId: id, source: 'talabat', fileName: 't.csv', size: 50, storageKey: `tenants/${id}/uploads/t/original.csv`, uploadedById: owner.id, status: 'applied', appliedAt } });
  await prisma.uploadRow.create({ data: { tenantId: id, uploadId: erp.id, rowNumber: 2, parsed: { barcode: '6281000000011' }, matchProductId: p1.id, changeType: 'new' } });
  await prisma.uploadError.create({ data: { tenantId: id, uploadId: talabat.id, row: 3, reason: 'Missing barcode' } });
  await prisma.erpUploadChange.create({ data: { tenantId: id, uploadId: erp.id, productId: p1.id, rowNumber: 2, barcode: '6281000000011', kind: 'new' } });
  await prisma.catalogueStockEdit.create({ data: { tenantId: id, productId: p1.id, stock: 5, erpStockAtEdit: 3, setById: owner.id, setAt: new Date() } });
  await prisma.marketplaceValueOverride.create({ data: { tenantId: id, productId: p1.id, marketplaceId: 'talabat', priceValue: 5.75, priceState: 'pending', priceSetById: owner.id, priceSetAt: new Date() } });
  await prisma.reconRow.create({ data: { tenantId: id, productId: p1.id, marketplaceId: 'talabat', status: 'in_sync' } });
  await prisma.reconSummary.create({ data: { tenantId: id, marketplaceId: 'talabat', reference: 'marketplace', listed: 1, total: 1, hasData: true, computedAt: new Date() } });
  await prisma.generatedFile.create({ data: { tenantId: id, marketplaceId: 'talabat', kind: 'stock', scope: 'all', reference: 'erp', fileName: 'f.csv', storageKey: `tenants/${id}/generated/g.csv`, productCount: 1, generatedById: owner.id, expiresAt: future } });
  await prisma.notification.create({ data: { tenantId: id, userId: owner.id, type: 'upload.applied', payload: { uploadId: erp.id } } });
  await prisma.auditEvent.createMany({ data: [...KEPT_ACTIONS, ...DELETED_ACTIONS].map(action => ({ tenantId: id, action, actorId: owner.id, details: { seeded: true } })) });
  return { id, slug };
}

interface Digest { n: number; digest: string }
async function rowsDigest(q: Q, table: string, where = 'TRUE', params: unknown[] = []): Promise<Digest> {
  const [r] = await q(`SELECT count(*)::int AS n, md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text), '')) AS digest
                       FROM "${table}" t WHERE ${where}`, params);
  return { n: Number(r.n), digest: String(r.digest) };
}
async function tableNames(q: Q) { return plan.schemaTables(q) as Promise<{ tenantTables: string[]; otherTables: string[] }>; }
/** Every row of every table. */
async function databaseDigest(q: Q) {
  const { tenantTables, otherTables } = await tableNames(q);
  const out: Record<string, Digest> = {};
  for (const t of [...tenantTables, ...otherTables]) out[t] = await rowsDigest(q, t);
  return out;
}
/** Every row of one store, in the given tables (or all tables with a tenant_id). */
async function storeDigest(q: Q, tenantId: string, tables?: readonly string[]) {
  const out: Record<string, Digest> = {};
  for (const t of tables ?? (await tableNames(q)).tenantTables) out[t] = await rowsDigest(q, t, 'tenant_id = $1::uuid', [tenantId]);
  return out;
}
async function onboarding(fixture: Fixture, tenantId: string) {
  return onboardingProgress(await fixture.database.run(tenantId, d => d.onboarding.facts()));
}

describe('store data reset on PGlite (ADR 018)', () => {
  let fixture: Fixture;
  let q: Q;
  let a: { id: string; slug: string };
  let b: { id: string; slug: string };

  beforeAll(async () => {
    fixture = await testDatabase();
    q = sql(fixture.prisma);
    a = await seedStore(fixture.prisma, 'reset-me');
    b = await seedStore(fixture.prisma, 'keep-me');
    await fixture.prisma.outputTemplate.create({ data: { marketplaceId: 'talabat', name: 'Built-in', columns: ['barcode'] } });
    await fixture.prisma.inputTemplate.create({ data: { tenantId: null, source: 'talabat', name: 'Built-in', fields: {}, signature: [] } });
  });
  afterAll(async () => { await fixture.close(); });

  const reset = (wrap: (q: Q) => Q = x => x) => fixture.prisma.$transaction(
    tx => plan.resetTenantInTransaction(wrap(sql(tx)), { tenantId: a.id, eventId: randomUUID() }), { timeout: 60_000, maxWait: 10_000 });

  it('classifies every table with a tenant_id in exactly one of KEEP, DELETE or ASK', async () => {
    const tables = await tableNames(q);
    expect(plan.classify(tables)).toEqual({ unclassified: [], duplicated: [], missing: [], unknownGlobal: [] });
    const lists = [...plan.KEEP_TABLES, ...plan.DELETE_TABLES, ...plan.ASK_TABLES] as string[];
    for (const t of tables.tenantTables) expect([t, lists.filter(x => x === t).length]).toEqual([t, 1]);
    expect(plan.ASK_TABLES).toEqual([]);
  });

  it('deletes children before parents, and no kept table references a deleted one', async () => {
    const fks = await q(`SELECT DISTINCT ch.relname AS child, pa.relname AS parent FROM pg_constraint k
                         JOIN pg_class ch ON ch.oid = k.conrelid JOIN pg_class pa ON pa.oid = k.confrelid
                         JOIN pg_namespace ns ON ns.oid = ch.relnamespace
                         WHERE k.contype = 'f' AND ns.nspname = current_schema()`);
    const order = plan.DELETE_TABLES as string[];
    for (const { child, parent } of fks as { child: string; parent: string }[]) {
      if (!order.includes(parent)) continue;
      expect([child, parent, (plan.KEEP_TABLES as string[]).includes(child)]).toEqual([child, parent, false]);
      if (child !== parent) expect([child, parent, order.indexOf(child) < order.indexOf(parent)]).toEqual([child, parent, true]);
    }
  });

  it('seeds both stores with rows in every table that has a tenant_id', async () => {
    for (const store of [a, b]) {
      for (const [t, d] of Object.entries(await storeDigest(q, store.id))) expect([t, d.n > 0]).toEqual([t, true]);
    }
    expect((await onboarding(fixture, a.id)).percent).toBe(100);
  });

  it('dry run: reports the counts and changes nothing', async () => {
    const before = await databaseDigest(q);
    const counts = await fixture.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return plan.dryRunCounts(sql(tx), a.id);
    });
    expect(await databaseDigest(q)).toEqual(before);
    for (const [t, n] of Object.entries(EXPECTED_DELETED)) expect([t, counts.snapshot.tables[t].delete]).toEqual([t, n]);
    expect(counts.snapshot.tables.products).toEqual({ group: 'delete', delete: 2, keep: 0, others: 2 });
    expect(counts.snapshot.tables.marketplace_price_rules).toEqual({ group: 'delete', delete: 1, keep: 1, others: 2 });
    expect(counts.snapshot.tables.users).toEqual({ group: 'keep', delete: 0, keep: 2, others: 2 });
    expect(counts.snapshot.tables.input_templates.others).toBe(2); // store B's layout and the built-in one
    expect(counts.audit.filter((r: Row) => r.kept).map((r: Row) => r.action).sort()).toEqual([...KEPT_ACTIONS].sort());
    for (const r of counts.audit as { action: string; kept: boolean }[]) expect([r.action, r.kept]).toEqual([r.action, plan.isKeptAuditAction(r.action)]);
    expect(counts.otherStores).toBe(1);
    expect(counts.unclassified).toEqual({});
  });

  it('rolls everything back when a statement fails half-way', async () => {
    const before = await databaseDigest(q);
    const failing = (inner: Q): Q => async (text, params) => {
      if (/DELETE FROM "products"/.test(text)) throw new Error('simulated failure');
      return inner(text, params);
    };
    await expect(reset(failing)).rejects.toThrow('simulated failure');
    expect(await databaseDigest(q)).toEqual(before);
  });

  it('refuses and rolls back when the verification finds rows left behind', async () => {
    const before = await databaseDigest(q);
    const skipping = (inner: Q): Q => async (text, params) => /DELETE FROM "notifications"/.test(text) ? [{ n: 1 }] : inner(text, params);
    await expect(reset(skipping)).rejects.toMatchObject({ name: 'ResetRefused', message: expect.stringContaining('notifications: 1 rows left to delete') });
    expect(await databaseDigest(q)).toEqual(before);
  });

  it('refuses while the database has a tenant table the plan does not know', async () => {
    await q('CREATE TABLE "zz_unplanned" (tenant_id uuid NOT NULL)');
    try {
      const before = await databaseDigest(q);
      const counts = await plan.dryRunCounts(q, a.id);
      expect(counts.classification.unclassified).toEqual(['zz_unplanned']);
      expect(counts.unclassified).toEqual({ zz_unplanned: 0 });
      await expect(reset()).rejects.toMatchObject({ name: 'ResetRefused', message: expect.stringContaining('zz_unplanned') });
      expect(await databaseDigest(q)).toEqual(before);
    } finally {
      await q('DROP TABLE "zz_unplanned"');
    }
  });

  it('real run: leaves exactly the KEEP rows, writes one event, resets onboarding and never touches the other store', async () => {
    const { tenantTables, otherTables } = await tableNames(q);
    const keptBefore = await storeDigest(q, a.id, plan.KEEP_TABLES);
    const keptAuditBefore = await rowsDigest(q, 'audit_events', `tenant_id = $1::uuid AND ${plan.AUDIT_KEEP_SQL}`, [a.id]);
    const storeWideBefore = await rowsDigest(q, 'marketplace_price_rules', 'tenant_id = $1::uuid AND product_id IS NULL', [a.id]);
    const otherBefore = await storeDigest(q, b.id);
    const globalBefore: Record<string, Digest> = {};
    for (const t of otherTables) globalBefore[t] = await rowsDigest(q, t);
    const builtInBefore = await rowsDigest(q, 'input_templates', 'tenant_id IS NULL');

    const result = await reset();
    expect(result.deleted).toEqual(EXPECTED_DELETED);
    expect(result.kept).toEqual({ auditEvents: KEPT_ACTIONS.length, storeWideMarketplaceRules: 1 });

    // This store: the DELETE tables are empty except the kept parts; the KEEP tables are identical, row for row.
    const after = await storeDigest(q, a.id);
    for (const t of tenantTables) {
      const expected = (plan.KEEP_TABLES as string[]).includes(t) ? keptBefore[t].n : t === 'marketplace_price_rules' ? 1 : t === 'audit_events' ? KEPT_ACTIONS.length + 1 : 0;
      expect([t, after[t].n]).toEqual([t, expected]);
    }
    expect(await storeDigest(q, a.id, plan.KEEP_TABLES)).toEqual(keptBefore);
    expect(await rowsDigest(q, 'audit_events', `tenant_id = $1::uuid AND ${plan.AUDIT_KEEP_SQL} AND action <> '${plan.RESET_ACTION}'`, [a.id])).toEqual(keptAuditBefore);
    expect(await rowsDigest(q, 'marketplace_price_rules', 'tenant_id = $1::uuid', [a.id])).toEqual(storeWideBefore);

    const [event] = await fixture.prisma.auditEvent.findMany({ where: { tenantId: a.id, action: plan.RESET_ACTION } });
    expect(event).toMatchObject({ id: result.eventId, actorId: null, entityId: a.id, requestId: 'operations' });
    expect(event.details).toMatchObject({ deleted: EXPECTED_DELETED, kept: result.kept });

    // The other store and the global tables: identical, row for row.
    expect(await storeDigest(q, b.id)).toEqual(otherBefore);
    for (const t of otherTables) expect([t, await rowsDigest(q, t)]).toEqual([t, globalBefore[t]]);
    expect(await rowsDigest(q, 'input_templates', 'tenant_id IS NULL')).toEqual(builtInBefore);

    // Onboarding (D6): the Owner keeps MFA, so 25%; the data-driven steps are not done.
    const progress = await onboarding(fixture, a.id);
    const status = Object.fromEntries(progress.steps.map(s => [s.id, s.status]));
    expect(progress.percent).toBe(25);
    expect(progress.nextStepId).toBe('erp_upload');
    expect(progress.complete).toBe(false);
    expect(status).toMatchObject({ owner_mfa: 'done', erp_upload: 'next', marketplace_upload: 'todo', first_comparison: 'todo', generated_file: 'todo' });
    expect(progress.marketplaces.every(m => !m.applied)).toBe(true);
    expect((await onboarding(fixture, b.id)).percent).toBe(100);
  });

  it('ANALYZE runs on the emptied tables after the commit', async () => {
    await expect(plan.analyzeEmptiedTables(q)).resolves.toEqual(expect.any(Number));
  });

  it('a second run deletes nothing more and still leaves the other store alone', async () => {
    const otherBefore = await storeDigest(q, b.id);
    const again = await reset();
    expect(Object.values(again.deleted).every(n => n === 0)).toBe(true);
    expect(await storeDigest(q, b.id)).toEqual(otherBefore);
    expect(await fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: plan.RESET_ACTION } })).toBe(2);
  });

  it('the storage step refuses while rows still point at files, and allows it after the reset', async () => {
    expect(await plan.storageRowCounts(q, a.id)).toEqual({ uploads: 0, generated: 0 });
    expect(await plan.storageRowCounts(q, b.id)).toEqual({ uploads: 2, generated: 1 });
    expect(plan.storageRefusals({ rows: await plan.storageRowCounts(q, b.id), listed: 3 })[0]).toContain('Run reset-store-data.mjs first');
  });
});

describe('store data reset: checks, queues and storage without a database', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('needs the slug twice for a real run', () => {
    expect(plan.validateArgs({ tenant: 'demo-store' })).toEqual({ tenant: 'demo-store', mode: 'dry-run' });
    expect(plan.validateArgs({ tenant: 'demo-store', confirm: 'demo-store' })).toEqual({ tenant: 'demo-store', mode: 'reset' });
    expect(() => plan.validateArgs({ tenant: 'demo-store', confirm: 'demo-stor' })).toThrow('does not repeat');
    expect(() => plan.validateArgs({ tenant: 'demo-store', confirm: '' })).toThrow('does not repeat');
    expect(() => plan.validateArgs({ tenant: 'Demo Store' })).toThrow('not a store slug');
    expect(() => plan.validateArgs({})).toThrow('--tenant');
    expect(plan.validateStorageArgs({ tenant: 'demo-store', confirm: 'demo-store', 'expect-count': '12' })).toEqual({ tenant: 'demo-store', mode: 'reset', expectCount: 12 });
    expect(() => plan.validateStorageArgs({ tenant: 'demo-store', confirm: 'demo-store' })).toThrow('--expect-count');
    expect(() => plan.validateStorageArgs({ tenant: 'demo-store', 'expect-count': '3' })).toThrow('only used with --confirm');
  });

  it('accepts only a non-empty .dump under 30 minutes old, by timestamp alone', () => {
    const now = Date.parse('2026-11-11T10:00:00Z');
    const fs = (files: Record<string, { mtimeMs: number; size: number }>) => ({
      readdirSync: () => Object.keys(files),
      statSync: (p: string) => ({ ...files[basename(p)], isFile: () => true }),
    });
    const min = 60_000;
    expect(plan.findRecentBackup('D:\\b', now, fs({ 'a.dump': { mtimeMs: now - 10 * min, size: 5 } }))).toEqual({ ok: true, file: 'a.dump', ageMs: 10 * min });
    expect(plan.findRecentBackup('D:\\b', now, fs({ 'a.dump': { mtimeMs: now - 31 * min, size: 5 } }))).toMatchObject({ ok: false, reason: expect.stringContaining('31 minutes old') });
    expect(plan.findRecentBackup('D:\\b', now, fs({ 'a.dump': { mtimeMs: now - min, size: 0 } }))).toMatchObject({ ok: false, reason: 'the newest backup is empty' });
    expect(plan.findRecentBackup('D:\\b', now, fs({ 'notes.txt': { mtimeMs: now, size: 5 } }))).toMatchObject({ ok: false, reason: 'no .dump file in the backup folder' });
    expect(plan.findRecentBackup('D:\\b', now, fs({ 'skew.dump': { mtimeMs: now + min, size: 5 } }))).toMatchObject({ ok: true, file: 'skew.dump' });
    expect(plan.findRecentBackup('D:\\b', now, fs({ 'far.dump': { mtimeMs: now + 60 * min, size: 5 }, 'old.dump': { mtimeMs: now - 50 * min, size: 5 } })))
      .toMatchObject({ ok: false, file: 'old.dump' });
    const missing = { readdirSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, statSync: () => { throw new Error('unused'); } };
    expect(plan.findRecentBackup('D:\\none', now, missing)).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
  });

  it('detects a listening API port', async () => {
    const server = createServer(socket => socket.destroy());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    expect(await plan.isPortOpen(port, ['127.0.0.1'])).toBe(true);
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await plan.isPortOpen(port, ['127.0.0.1'])).toBe(false);
  });

  const clean = {
    classification: { unclassified: [], duplicated: [], missing: [], unknownGlobal: [] },
    backup: { ok: true, file: 'x.dump', ageMs: 0 }, api: { port: 4000, open: false }, sessions: [] as unknown[],
    redis: { workers: Object.fromEntries(plan.ALL_QUEUES.map((n: string) => [n, 0])), jobs: { recon: { active: 0 } } },
  };
  it('lists every reason a real run must not start, including the open sessions', () => {
    expect(plan.refusals(clean)).toEqual([]);
    const all = plan.refusals({
      classification: { ...clean.classification, unclassified: ['some_future_table'] },
      backup: { ok: false, reason: 'no .dump file in the backup folder' }, api: { port: 4000, open: true },
      sessions: [{ pid: 4242, app: 'pgAdmin 4', addr: '127.0.0.1', state: 'idle' }, { pid: 77, app: '(no application name)', addr: '::1', state: 'idle' }],
      redis: { workers: { ...clean.redis.workers, 'email-outbox': 1 }, jobs: { recon: { active: 1 } } },
    }).join('\n');
    for (const part of ['some_future_table', 'db-backup.ps1 -Label before-reset', 'port 4000', '2 other session(s)', 'pid 4242 pgAdmin 4 from 127.0.0.1 (idle)',
      'pid 77', 'email-outbox 1', 'jobs for this store are running (recon 1)']) expect(all).toContain(part);
    expect(plan.refusals({ ...clean, redis: { unreachable: true } })[0]).toContain('--skip-redis');
    expect(plan.refusals({ ...clean, redis: { error: 'NOPERM' } })[0]).toContain('NOPERM');
    expect(plan.refusals({ ...clean, redis: { skipped: true } })).toEqual([]);
  });

  /** A BullMQ Queue stand-in: jobs per state, each with remove(). */
  function fakeQueue(byState: Record<string, string[]>, workers = 0) {
    const removed: string[] = [];
    const dedup: string[] = [];
    return {
      removed, dedup,
      getWorkersCount: async () => workers,
      getJobs: async ([state]: string[]) => (byState[state] ?? []).map((tenantId, i) => ({ data: { tenantId }, remove: async () => { removed.push(`${state}:${tenantId}:${i}`); } })),
      removeDeduplicationKey: async (id: string) => { dedup.push(id); return 1; },
    };
  }
  it("counts and removes only this store's jobs, never active ones, and clears the recon deduplication", async () => {
    const queues = {
      'upload-processing': fakeQueue({ wait: [A, B], failed: [A] }),
      'upload-apply': fakeQueue({ completed: [A, A, B] }),
      recon: fakeQueue({ delayed: [A], active: [A] }),
      'generated-files': fakeQueue({ wait: [B] }),
      'email-outbox': fakeQueue({}, 1),
    };
    const facts = await plan.redisFacts(queues, A);
    expect(facts.workers).toEqual({ 'upload-processing': 0, 'upload-apply': 0, recon: 0, 'generated-files': 0, 'email-outbox': 1 });
    expect(facts.jobs['upload-processing']).toMatchObject({ wait: 1, failed: 1, active: 0 });
    expect(facts.jobs.recon).toMatchObject({ delayed: 1, active: 1 });
    expect(plan.refusals({ ...clean, redis: facts }).join('\n')).toContain('recon 1');

    const removed = await plan.removeTenantJobs(queues, A);
    expect(removed).toEqual({ removed: { 'upload-processing': 2, 'upload-apply': 2, recon: 1, 'generated-files': 0 }, failed: 0 });
    expect(queues.recon.removed).toEqual([`delayed:${A}:0`]);
    expect(queues['generated-files'].removed).toEqual([]);
    expect(queues.recon.dedup).toEqual([reconJobKey(A)]);
  });

  it('uses the same queue names, recon deduplication id and recon lock key as the app', async () => {
    expect(plan.TENANT_QUEUES).toEqual([QUEUES.uploads, QUEUES.uploadApply, RECON_QUEUE_NAME, 'generated-files']);
    expect(await readFile('packages/shared/src/generated-files.ts', 'utf8')).toContain("export const GENERATED_FILES_QUEUE = 'generated-files';");
    expect(await readFile('apps/worker/src/main.ts', 'utf8')).toContain("new Queue('email-outbox'");
    expect(plan.reconDeduplicationId(A)).toBe(reconJobKey(A));
    expect(await readFile('apps/worker/src/recompute-recon.ts', 'utf8')).toContain("runSnapshot(tenantId, 'recon'");
    expect(await readFile('packages/db/src/database.ts', 'utf8')).toContain("hashtextextended(${job + ':' + tenantId}, 0)");
    expect(plan.reconLockKey(A)).toBe(`recon:${A}`);
  });

  it("deletes only this store's uploads/ and generated/ objects, in batches of 1,000", async () => {
    const objects = [
      { key: `tenants/${A}/uploads/u1/original.xlsx`, size: 10 }, { key: `tenants/${A}/generated/g1.csv`, size: 5 },
      { key: `tenants/${A}/exports/x.csv`, size: 1 }, { key: `tenants/${B}/uploads/u2/original.csv`, size: 99 },
      { key: `tenants/${A}uploads/sneaky.csv`, size: 7 },
    ];
    const p = plan.storagePlan(A, objects);
    expect(p.delete.map((o: { key: string }) => o.key)).toEqual([`tenants/${A}/generated/g1.csv`, `tenants/${A}/uploads/u1/original.xlsx`]);
    expect(p.untouched.map((o: { key: string }) => o.key)).toEqual([`tenants/${A}/exports/x.csv`]);
    expect([p.bytes, p.foreign]).toEqual([15, 2]);
    expect(() => plan.storagePrefixes('not-a-uuid')).toThrow('not a UUID');
    expect(plan.batches(Array.from({ length: 2500 }, (_, i) => i)).map((b: unknown[]) => b.length)).toEqual([1000, 1000, 500]);
    expect(plan.batches([])).toEqual([]);
    const pages: Record<string, { objects: { key: string; size: number }[]; next?: string }> = {
      start: { objects: [objects[0]], next: 't1' }, t1: { objects: [objects[1]], next: 't2' }, t2: { objects: [objects[2]] },
    };
    const seen: (string | undefined)[] = [];
    const listed = await plan.listAllObjects(async (_prefix: string, token?: string) => { seen.push(token); return pages[token ?? 'start']; }, `tenants/${A}/`);
    expect([listed.length, seen]).toEqual([3, [undefined, 't1', 't2']]);
    expect(plan.storageRefusals({ rows: { uploads: 0, generated: 0 }, listed: 2, expectCount: 2 })).toEqual([]);
    expect(plan.storageRefusals({ rows: { uploads: 0, generated: 0 }, listed: 3, expectCount: 2 })[0]).toContain('--expect-count is 2');
  });

  it('commits or rolls back through one connection', async () => {
    const log: string[] = [];
    const q = async (text: string) => { log.push(text); return []; };
    await plan.inTransaction(q, async () => { await q('work'); });
    expect(log.splice(0)).toEqual(['BEGIN', 'work', 'COMMIT']);
    await expect(plan.inTransaction(q, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(log.splice(0)).toEqual(['BEGIN', 'ROLLBACK']);
    await plan.inTransaction(q, async () => 1, { readOnly: true });
    expect(log.splice(0)).toEqual(['BEGIN READ ONLY', 'ROLLBACK']);
  });

  it('splits DATABASE_URL on the last @ and never repeats an error message', () => {
    expect(splitDatabaseUrl('postgresql://app:p@ss:w@rd@db.local:6543/qorloop?sslmode=require'))
      .toEqual({ user: 'app', password: 'p@ss:w@rd', host: 'db.local', port: 6543, database: 'qorloop', sslMode: 'require' });
    expect(splitDatabaseUrl('postgres://app@[::1]/x')).toMatchObject({ host: '::1', port: 5432, password: '' });
    expect(() => splitDatabaseUrl('mysql://a:b@c/d')).toThrow('not a postgres');
    const secret = 'postgresql://app:hunter2@db/x';
    expect(describeError(Object.assign(new Error(`password authentication failed: ${secret}`), { code: '28P01' }))).toBe('28P01 (password authentication failed)');
    expect(describeError(Object.assign(new Error(secret), { code: '23503', table: 'products', constraint: 'recon_rows_tenant_id_product_id_fkey' })))
      .toBe('23503 (foreign key violation) on products / recon_rows_tenant_id_product_id_fkey');
    expect(describeError(new Error(secret))).toBe('unexpected error (details withheld)');
  });

  it('keeps exactly the security, team and settings audit actions', () => {
    for (const a of ['auth.mfa_enrolled', 'invitation.revoked', 'team.member_deactivated', 'store.provisioned', 'store.data_reset', 'settings.changed', 'pricing.settings_changed', 'template.updated']) {
      expect([a, plan.isKeptAuditAction(a)]).toEqual([a, true]);
    }
    for (const a of ['upload.applied', 'pricing.bulk_applied', 'pricing.marketplace_rule_set', 'product.field_changed', 'category.created', 'catalogue.stock_bulk_set', 'file.generated', 'recon.failed', 'authx.fake', 'unknown']) {
      expect([a, plan.isKeptAuditAction(a)]).toEqual([a, false]);
    }
    expect(plan.ANALYZE_SQL).toBe(`ANALYZE (SKIP_LOCKED) ${plan.DELETE_TABLES.map((t: string) => `"${t}"`).join(', ')}`);
  });
});
