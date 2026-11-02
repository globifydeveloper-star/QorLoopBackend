import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import ExcelJS from 'exceljs';
import { generate } from 'otplib';
import pg from 'pg';
import type { HTTPMethods } from 'fastify';
import { buildApp } from '../app.js';
import { createHarness, password, testServices, type Harness, type Session, type Store } from './harness.js';
import { processUpload } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import { digest, opaqueToken, unseal } from '../../../../packages/shared/src/security.js';
import type { Database } from '../../../../packages/db/src/database.js';

/**
 * G12 / ADR 012: Database.run locks the tenant row FOR NO KEY UPDATE. These checks need real concurrent transactions,
 * so they run on real PostgreSQL only (the embedded database is one WASM backend: nothing can overlap there).
 *
 * Races go through `gated`: a separate connection holds the tenant row lock, the competing calls are started, and the
 * gate is released only once every one of them is queued on that lock inside its own transaction. That is the tightest
 * interleaving possible: without the lock all of them would read the same state and all would succeed.
 */
const realPostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
/** Lock wait budget for statements that must NOT wait on a held Database.run lock. */
const NO_WAIT_MS = 1_000;

let h: Harness, s: Store, pooled: { database: Database; close: () => Promise<void> };
let api: Awaited<ReturnType<typeof buildApp>>;
let schema: string;
let counter = 0;

/** The same requests as the harness, but served by an API whose Database has a pool of 6, so requests really overlap. */
function concurrent(method: HTTPMethods, url: string, store: Pick<Store, 'hostname'>, session?: Session, payload?: Record<string, unknown>) {
  return api.server.inject({
    method, url, remoteAddress: '127.0.0.1',
    headers: { host: store.hostname + ':4000', origin: 'http://' + store.hostname + ':3000', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) },
    ...(payload ? { payload } : {}),
  });
}
async function invitationToken(id: string) {
  const message = await h.fixture.prisma.emailOutbox.findFirstOrThrow({ where: { dedupeKey: { startsWith: 'invitation:' + id } }, orderBy: { createdAt: 'desc' } });
  return (await unseal<{ text: string }>(message.sealedMessage, h.config.AUTH_SECRET)).text.match(/#token=([A-Za-z0-9_-]+)/)![1]!;
}
async function invite(store: Store, role: string) {
  const email = `lock${++counter}@${store.hostname}.test`;
  const r = await h.request('POST', '/api/team/invitations', store, store.owner, { role, email });
  expect(r.statusCode).toBe(200);
  return { id: r.json().data.id as string, email, token: await invitationToken(r.json().data.id) };
}
/** A second Owner with a full (MFA-verified) session. */
async function secondOwner(store: Store) {
  const invited = await invite(store, 'owner');
  const pending = h.sessionFrom(await h.request('POST', '/api/auth/invitations/accept', store, undefined, { token: invited.token, name: 'Second owner', password }));
  const setup = await h.request('POST', '/api/auth/mfa/setup', store, pending, { password });
  const secret = new URL(setup.json().data.totpUri).searchParams.get('secret')!;
  const session = h.sessionFrom(await h.request('POST', '/api/auth/mfa/verify', store, pending, { code: await generate({ secret }) }));
  const membership = await h.fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: store.id, user: { email: invited.email } } });
  return { session, membershipId: membership.id };
}
const ownerOf = (store: Store) => h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id, email: 'owner@' + store.hostname.replace(/\.localhost$/, '') + '.test' } });
const activeOwners = (store: Store) => h.fixture.prisma.membership.count({ where: { tenantId: store.id, role: 'owner', active: true } });

/** Postgres connection on the test schema, outside both Prisma pools. */
async function connection() {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public -c timezone=UTC` });
  await c.connect();
  return c;
}
/** Starts `calls` while the tenant row is locked, releases the lock once all of them wait for it, and settles them. */
async function gated<T>(tenantId: string, calls: (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
  const gate = await connection();
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM tenants WHERE id = $1::uuid FOR NO KEY UPDATE', [tenantId]);
    const running = calls.map(call => call());
    const deadline = Date.now() + 15_000;
    for (;;) {
      // the gate is inside a transaction, which would otherwise keep reading its first pg_stat_activity snapshot
      await gate.query('SELECT pg_stat_clear_snapshot()');
      const { rows: [{ n }] } = await gate.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE 'SELECT id FROM tenants WHERE id = %FOR %'`);
      if (n >= calls.length) break;
      if (Date.now() > deadline) {
        const activity = (await gate.query(`SELECT state, wait_event_type, wait_event, left(query, 120) AS query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`)).rows;
        await gate.query('ROLLBACK');
        const settled = await Promise.allSettled(running);
        throw new Error(`only ${n} of ${calls.length} calls reached the tenant lock: ${JSON.stringify({ activity, settled: settled.map(r => r.status === 'fulfilled' ? (r.value as { statusCode?: number })?.statusCode ?? r.value : String(r.reason)) })}`);
      }
      await new Promise(r => setTimeout(r, 20));
    }
    await gate.query('COMMIT');
    return await Promise.allSettled(running);
  } finally { await gate.end(); }
}
const statuses = (results: PromiseSettledResult<{ statusCode: number }>[]) =>
  results.map(r => r.status === 'fulfilled' ? r.value.statusCode : -1).sort((x, y) => x - y);

/** Holds Database.run's tenant lock (on the pooled Database) until the returned release is called. */
async function holdTenantLock(tenantId: string) {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const inside = new Promise<void>(r => { entered = r; });
  const done = pooled.database.run(tenantId, async () => { entered(); await held; });
  await inside;
  return async () => { release(); await done; };
}
/** Runs `sql` in its own transaction with a short lock_timeout: 'ok', or 'blocked' when it had to wait for a lock. */
async function attempt(c: pg.Client, sql: string, params: unknown[]): Promise<'ok' | 'blocked'> {
  await c.query('BEGIN');
  try {
    await c.query(`SET LOCAL lock_timeout = '300ms'`);
    await c.query(sql, params);
    await c.query('ROLLBACK');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK');
    if ((e as { code?: string }).code === '55P03') return 'blocked';
    throw e;
  }
}

realPostgres('tenant row lock FOR NO KEY UPDATE (real PostgreSQL)', () => {
  beforeAll(async () => {
    h = await createHarness();
    h.queue.handler = job => processUpload({ database: h.fixture.database, storage: h.storage }, job).then(() => undefined);
    s = await h.createOwner('tenantlock');
    [{ schema }] = await h.fixture.prisma.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS schema`;
    pooled = await h.fixture.pooled!(6);
    api = await buildApp(h.config, { database: pooled.database, logger: false, ...testServices(), rateLimitMax: 100000 });
  }, 120_000);
  afterAll(async () => { await api?.app.close(); await pooled?.close(); await h?.close(); });

  describe('lock semantics', () => {
    it('serialises Database.run against Database.run on the same tenant', async () => {
      const order: string[] = [];
      const release = await holdTenantLock(s.id);
      order.push('first in');
      const second = pooled.database.run(s.id, async () => { order.push('second in'); });
      await new Promise(r => setTimeout(r, 500));
      expect(order).toEqual(['first in']);
      order.push('first out');
      await release();
      await second;
      expect(order).toEqual(['first in', 'first out', 'second in']);
    });

    it('lets foreign-key inserts on tenant tables through while Database.run holds the lock (G12)', async () => {
      const c = await connection();
      const release = await holdTenantLock(s.id);
      try {
        // every insert below takes FOR KEY SHARE on the tenant row (and recon_rows also on its product): FOR UPDATE blocked them all
        const t = performance.now();
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '${NO_WAIT_MS}ms'`);
        const { rows: [p] } = await c.query<{ id: string }>(`
          INSERT INTO products (id, tenant_id, barcode, normalized_barcode, name_en, erp_price, updated_at)
          VALUES (gen_random_uuid(), $1::uuid, '7000000000001', '7000000000001', 'Lock probe', 1, now()) RETURNING id`, [s.id]);
        await c.query(`INSERT INTO listings (id, tenant_id, marketplace_id, marketplace_product_id, product_id, price, available, updated_at)
                       VALUES (gen_random_uuid(), $1::uuid, 'talabat', 'lock-probe', $2::uuid, 1, true, now())`, [s.id, p!.id]);
        await c.query(`INSERT INTO recon_rows (id, tenant_id, product_id, marketplace_id, status) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'talabat', 'in_sync')`, [s.id, p!.id]);
        await c.query(`INSERT INTO audit_events (id, tenant_id, action) VALUES (gen_random_uuid(), $1::uuid, 'lock.probe')`, [s.id]);
        await c.query('ROLLBACK');
        expect(performance.now() - t).toBeLessThan(NO_WAIT_MS);
      } finally { await release(); await c.end(); }
    });

    it('does not make Database.run wait for a transaction that holds foreign-key locks on the tenant (G12)', async () => {
      const c = await connection();
      try {
        // what a recompute does for a minute: uncommitted recon_rows inserts holding FOR KEY SHARE on the tenant row
        await c.query('BEGIN');
        const { rows: [p] } = await c.query<{ id: string }>(`
          INSERT INTO products (id, tenant_id, barcode, normalized_barcode, name_en, erp_price, updated_at)
          VALUES (gen_random_uuid(), $1::uuid, '7000000000002', '7000000000002', 'Lock probe', 1, now()) RETURNING id`, [s.id]);
        await c.query(`INSERT INTO recon_rows (id, tenant_id, product_id, marketplace_id, status) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'talabat', 'in_sync')`, [s.id, p!.id]);
        const t = performance.now();
        await Promise.race([
          pooled.database.run(s.id, async d => d.tenantId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Database.run waited for the foreign-key locks')), NO_WAIT_MS)),
        ]);
        expect(performance.now() - t).toBeLessThan(NO_WAIT_MS);
        // and an API write (session touch + audit event) completes too
        expect((await concurrent('GET', '/api/auth/me', s, s.owner)).statusCode).toBe(200);
      } finally { await c.query('ROLLBACK'); await c.end(); }
    });

    it('still conflicts with NO KEY UPDATE, UPDATE, SHARE, row updates and deletes, but not with KEY SHARE', async () => {
      const c = await connection();
      const release = await holdTenantLock(s.id);
      try {
        const row = 'SELECT id FROM tenants WHERE id = $1::uuid';
        expect({
          noKeyUpdate: await attempt(c, row + ' FOR NO KEY UPDATE', [s.id]),
          update: await attempt(c, row + ' FOR UPDATE', [s.id]),
          share: await attempt(c, row + ' FOR SHARE', [s.id]),
          rowUpdate: await attempt(c, 'UPDATE tenants SET status = status WHERE id = $1::uuid', [s.id]),
          rowDelete: await attempt(c, 'DELETE FROM tenants WHERE id = $1::uuid', [s.id]),
          keyShare: await attempt(c, row + ' FOR KEY SHARE', [s.id]),
        }).toEqual({ noKeyUpdate: 'blocked', update: 'blocked', share: 'blocked', rowUpdate: 'blocked', rowDelete: 'blocked', keyShare: 'ok' });
      } finally { await release(); await c.end(); }
    });
  });

  describe('the guarantees the lock exists for', () => {
    it('two simultaneous acceptances of one invitation consume the token once', async () => {
      const invited = await invite(s, 'analyst');
      const accept = () => concurrent('POST', '/api/auth/invitations/accept', s, undefined, { token: invited.token, name: 'Racer', password });
      expect(statuses(await gated(s.id, [accept, accept]))).toEqual([200, 400]);
      const users = await h.fixture.prisma.user.findMany({ where: { tenantId: s.id, email: invited.email } });
      expect(users).toHaveLength(1);
      expect(await h.fixture.prisma.membership.count({ where: { tenantId: s.id, userId: users[0]!.id } })).toBe(1);
      expect((await h.fixture.prisma.invitation.findUniqueOrThrow({ where: { id: invited.id } })).acceptedAt).not.toBeNull();
      expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'invitation.accepted', entityId: invited.id } })).toBe(1);
      expect(await h.fixture.prisma.session.count({ where: { tenantId: s.id, userId: users[0]!.id } })).toBe(1);
    });

    it('one TOTP code verifies only one of two simultaneous challenge sessions', async () => {
      const owner = await ownerOf(s);
      const login = async () => h.sessionFrom(await h.request('POST', '/api/auth/login', s, undefined, { email: owner.email, password }));
      const [first, second] = [await login(), await login()];
      const secret = await unseal<string>(owner.mfaSecret!, h.config.AUTH_SECRET);
      // allow the current step (enrolment used it), so the only thing refusing the second use is the replay check
      await h.fixture.prisma.user.update({ where: { id: owner.id }, data: { lastTotpStep: Math.floor(Date.now() / 30_000) - 2 } });
      const code = await generate({ secret });
      const before = await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'auth.mfa_verified' } });
      const verify = (session: Session) => () => concurrent('POST', '/api/auth/mfa/verify', s, session, { code });
      expect(statuses(await gated(s.id, [verify(first), verify(second)]))).toEqual([200, 401]);
      expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'auth.mfa_verified' } })).toBe(before + 1);
    });

    it('one recovery code is consumed by only one of two simultaneous challenge sessions', async () => {
      const owner = await ownerOf(s);
      const code = opaqueToken();
      await h.fixture.database.run(s.id, d => d.replaceRecoveryCodes(owner.id, [digest(code), digest(opaqueToken())]));
      const login = async () => h.sessionFrom(await h.request('POST', '/api/auth/login', s, undefined, { email: owner.email, password }));
      const [first, second] = [await login(), await login()];
      const recover = (session: Session) => () => concurrent('POST', '/api/auth/mfa/recovery', s, session, { code });
      expect(statuses(await gated(s.id, [recover(first), recover(second)]))).toEqual([200, 401]);
      expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'auth.recovery_used', actorId: owner.id } })).toBe(1);
      expect(await h.fixture.prisma.recoveryCode.count({ where: { tenantId: s.id, userId: owner.id, usedAt: { not: null } } })).toBe(1);
    });

    it('a role change and a removal racing between the last two Owners leave one active Owner', async () => {
      const store = await h.createOwner('tenantlockrole');
      const other = await secondOwner(store);
      const first = await h.fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: store.id, role: 'owner', NOT: { id: other.membershipId } } });
      expect(await activeOwners(store)).toBe(2);
      const results = await gated(store.id, [
        () => concurrent('PATCH', `/api/team/members/${other.membershipId}/role`, store, store.owner, { role: 'admin' }),
        () => concurrent('DELETE', `/api/team/members/${first.id}`, store, other.session),
      ]);
      // the loser re-reads after the winner commits: its own Owner seat (and session) is gone
      expect(statuses(results)).toEqual([200, 401]);
      expect(await activeOwners(store)).toBe(1);
    });

    it('two Owners removing each other at once leave one active Owner', async () => {
      const store = await h.createOwner('tenantlockremove');
      const other = await secondOwner(store);
      const first = await h.fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: store.id, role: 'owner', NOT: { id: other.membershipId } } });
      const results = await gated(store.id, [
        () => concurrent('DELETE', `/api/team/members/${other.membershipId}`, store, store.owner),
        () => concurrent('DELETE', `/api/team/members/${first.id}`, store, other.session),
      ]);
      expect(statuses(results)).toEqual([200, 401]);
      expect(await activeOwners(store)).toBe(1);
    });

    it('two simultaneous applies of the same upload apply it once', async () => {
      const ROWS = 200;
      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('ERP');
      ws.addRow(['Barcode', 'Item Name', 'Sale Price', 'Qty']);
      for (let i = 0; i < ROWS; i++) ws.addRow([String(7_100_000_000_000 + i), `Racing product ${i}`, 2 + (i % 5), i % 7]);
      const data = Buffer.from(await workbook.xlsx.writeBuffer());
      const created = await h.request('POST', '/api/uploads', s, s.owner, { source: 'erp', fileName: 'erp.xlsx', size: data.length });
      expect(created.statusCode).toBe(200);
      const id = created.json().data.id as string;
      await h.storage.put((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).storageKey, data);
      expect((await h.request('POST', `/api/uploads/${id}/complete`, s, s.owner)).statusCode).toBe(200);
      if ((await h.request('GET', `/api/uploads/${id}`, s, s.owner)).json().data.status === 'needs_mapping') {
        expect((await h.request('POST', `/api/uploads/${id}/mapping`, s, s.owner, { fields: { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' } })).statusCode).toBe(200);
      }
      expect((await h.request('POST', `/api/uploads/${id}/apply`, s, s.owner)).statusCode).toBe(200);
      // no apply handler in this harness: the job is only recorded, so both "workers" below race for it
      const job = h.queue.applyJobs.find(j => j.uploadId === id)!;
      expect((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).status).toBe('applying');
      const before = await h.fixture.prisma.product.count({ where: { tenantId: s.id } });
      const worker = () => applyUpload({ database: pooled.database }, job);
      const results = await gated(s.id, [worker, worker]);
      expect(results.map(r => r.status === 'fulfilled' ? r.value : 'rejected').sort()).toEqual(['applied', 'skipped']);
      expect((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).status).toBe('applied');
      expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id } })).toBe(before + ROWS);
      expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'upload.applied', entityId: id } })).toBe(1);
      expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'upload.apply_failed', entityId: id } })).toBe(0);
    }, 60_000);
  });
});
