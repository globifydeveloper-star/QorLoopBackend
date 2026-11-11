// The plan behind scripts/dev/reset-store-data.mjs (ADR 018): which tables are kept or emptied for ONE store, the SQL,
// the before/after verification, and the pre-flight checks. No dependencies and no output: the CLI prints, and the
// PGlite tests (apps/api/src/__tests__/store-reset.integration.test.ts) run exactly this SQL.
//
// `q(text, params)` runs one statement and resolves to its rows. Every statement here returns rows (DELETEs are wrapped
// as `WITH d AS (DELETE ... RETURNING 1) SELECT count(*)`), so node-pg, PGlite and Prisma's $queryRawUnsafe all fit.
// The tenant id is always a bound parameter; table names come only from the constant lists below (checked by IDENT).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';

export class ResetRefused extends Error {
  constructor(message) { super(message); this.name = 'ResetRefused'; }
}
const refuse = message => { throw new ResetRefused(message); };

/** The provisioning rule (infra/provision-store.ts). */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
export const DEFAULT_BACKUP_DIR = 'D:\\Qorloop-test\\backups';
export const BACKUP_MAX_AGE_MS = 30 * 60_000;
/** A backup stamped slightly in the future (clock skew) still counts; one further ahead does not. */
export const BACKUP_FUTURE_SKEW_MS = 2 * 60_000;
export const RESET_ACTION = 'store.data_reset';

// ───────── Audit events (owner decision A1 b) ─────────
// Kept: security, team and settings events, which describe rows that are kept. Everything else is deleted, including
// actions this list does not know, so no business event can slip through. 'store.' keeps earlier store.data_reset events.
export const AUDIT_KEEP_PREFIXES = Object.freeze(['auth.', 'invitation.', 'team.', 'store.']);
export const AUDIT_KEEP_ACTIONS = Object.freeze(['settings.changed', 'pricing.settings_changed', 'template.updated']);
for (const p of AUDIT_KEEP_PREFIXES) if (!/^[a-z.]+$/.test(p)) throw new Error('audit prefix must not contain LIKE wildcards');
for (const a of AUDIT_KEEP_ACTIONS) if (!/^[a-z_.]+$/.test(a)) throw new Error('invalid audit action');
export const AUDIT_KEEP_SQL = `(${AUDIT_KEEP_PREFIXES.map(p => `action LIKE '${p}%'`).join(' OR ')} OR action IN (${AUDIT_KEEP_ACTIONS.map(a => `'${a}'`).join(', ')}))`;
export const isKeptAuditAction = action => AUDIT_KEEP_PREFIXES.some(p => action.startsWith(p)) || AUDIT_KEEP_ACTIONS.includes(action);

// ───────── Tables ─────────
// Every table with a tenant_id must be in exactly one of KEEP_TABLES, DELETE_STEPS or ASK_TABLES (completeness test);
// a real run also refuses while the live database has one that is not.

/** Never written by the reset. Their counts for this store must be identical before and after. */
export const KEEP_TABLES = Object.freeze([
  'users', 'memberships', 'invitations', 'sessions', 'password_resets', 'recovery_codes', 'stores',
  'tenant_settings', 'pricing_settings', 'email_outbox', 'input_templates', 'tenant_marketplaces',
]);

/**
 * Children before parents: no step deletes a row that a later-deleted or kept row still references (all foreign keys
 * are RESTRICT, except upload_rows / upload_errors / erp_upload_changes -> uploads, which CASCADE; they are deleted
 * explicitly anyway, for exact counts). `where` limits a step to part of the store's rows; the rest is kept.
 *
 * When feature/marketplace-export-values is merged (migration 202611100001_marketplace_value_overrides), add
 * { table: 'marketplace_value_overrides' } BEFORE 'products': its product and user foreign keys are RESTRICT.
 * The completeness test fails until it is classified.
 */
export const DELETE_STEPS = Object.freeze([
  { table: 'erp_upload_changes' },
  { table: 'upload_errors' },
  { table: 'upload_rows' },
  { table: 'catalogue_stock_edits' },
  { table: 'recon_rows' },
  { table: 'recon_summaries' },
  { table: 'listings' },
  { table: 'product_offers' },
  { table: 'product_price_rules' },
  // A3: store-wide rules (product_id IS NULL) are part of the pricing settings and are kept. No foreign key on product_id.
  { table: 'marketplace_price_rules', where: 'product_id IS NOT NULL', keeps: 'store-wide marketplace rules' },
  { table: 'generated_files' },
  { table: 'notifications' },
  { table: 'uploads' },
  { table: 'products' },
  // A2: the three go together; category_price_rules has no foreign key to categories.
  { table: 'category_price_rules' },
  { table: 'category_mappings' },
  // Self-referencing (parent_id): one statement; the foreign key is checked after the statement, when both are gone.
  { table: 'categories' },
  { table: 'audit_events', where: `NOT ${AUDIT_KEEP_SQL}`, keeps: 'security, team and settings events' },
].map(Object.freeze));

/** Known tables still awaiting the owner's decision. A real run refuses while this is not empty. */
export const ASK_TABLES = Object.freeze([]);
/** No tenant_id: shared by every store; only counted, to prove they are unchanged. */
export const GLOBAL_TABLES = Object.freeze(['tenants', 'marketplaces', 'output_templates']);
const IGNORED_TABLES = new Set(['_prisma_migrations']);

export const DELETE_TABLES = Object.freeze(DELETE_STEPS.map(s => s.table));
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = name => { if (!IDENT.test(name)) throw new Error('unexpected table name'); return `"${name}"`; };
for (const t of [...KEEP_TABLES, ...DELETE_TABLES, ...ASK_TABLES, ...GLOBAL_TABLES]) ident(t);

// ───────── Queues (packages/shared/src/queue.ts, recon.ts, generated-files.ts, apps/worker/src/main.ts) ─────────
export const TENANT_QUEUES = Object.freeze(['upload-processing', 'upload-apply', 'recon', 'generated-files']);
export const ALL_QUEUES = Object.freeze([...TENANT_QUEUES, 'email-outbox']);
/** BullMQ states whose jobs are removed after the reset; 'active' jobs make the run refuse instead. */
export const REMOVABLE_JOB_STATES = Object.freeze(['wait', 'delayed', 'prioritized', 'waiting-children', 'completed', 'failed']);
export const reconDeduplicationId = tenantId => `recon-${tenantId}`;
/** Database.runSnapshot(tenantId, 'recon', ...) takes pg_try_advisory_xact_lock(hashtextextended('recon:' + id, 0)). */
export const reconLockKey = tenantId => `recon:${tenantId}`;

// ───────── Arguments ─────────

/** --tenant <slug> alone is a dry run; --confirm must repeat the slug exactly for a real run. */
export function validateArgs({ tenant, confirm }) {
  if (!tenant) refuse('Give the store with --tenant <slug>.');
  if (!SLUG_PATTERN.test(tenant)) refuse('--tenant is not a store slug (lowercase letters, digits and hyphens).');
  if (confirm === undefined) return { tenant, mode: 'dry-run' };
  if (confirm !== tenant) refuse('--confirm does not repeat the --tenant slug exactly. Nothing was changed.');
  return { tenant, mode: 'reset' };
}

// ───────── Schema classification ─────────

export async function schemaTables(q) {
  const rows = await q(`
    SELECT t.table_name AS name,
           EXISTS (SELECT 1 FROM information_schema.columns c
                   WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'tenant_id') AS tenant
    FROM information_schema.tables t
    WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name`, []);
  return { tenantTables: rows.filter(r => r.tenant).map(r => r.name), otherTables: rows.filter(r => !r.tenant).map(r => r.name) };
}

/** What the plan and the schema disagree on. All four lists must be empty for a real run. */
export function classify({ tenantTables, otherTables }) {
  const lists = [KEEP_TABLES, DELETE_TABLES, ASK_TABLES];
  const times = t => lists.reduce((n, l) => n + l.filter(x => x === t).length, 0);
  const present = new Set([...tenantTables, ...otherTables]);
  return {
    unclassified: tenantTables.filter(t => times(t) === 0),
    duplicated: [...new Set([...KEEP_TABLES, ...DELETE_TABLES, ...ASK_TABLES])].filter(t => times(t) > 1),
    missing: [...KEEP_TABLES, ...DELETE_TABLES, ...ASK_TABLES, ...GLOBAL_TABLES].filter(t => !present.has(t)),
    unknownGlobal: otherTables.filter(t => !GLOBAL_TABLES.includes(t) && !IGNORED_TABLES.has(t)),
  };
}

export function classificationProblems(c) {
  const out = [];
  if (c.unclassified.length) out.push(`tables with a tenant_id that the reset does not know: ${c.unclassified.join(', ')}`);
  if (c.duplicated.length) out.push(`tables listed more than once: ${c.duplicated.join(', ')}`);
  if (c.missing.length) out.push(`tables in the plan but not in the database: ${c.missing.join(', ')}`);
  if (c.unknownGlobal.length) out.push(`tables without a tenant_id that the reset does not know: ${c.unknownGlobal.join(', ')}`);
  if (ASK_TABLES.length) out.push(`tables still awaiting a decision: ${ASK_TABLES.join(', ')}`);
  return out;
}

// ───────── Counts ─────────

export async function findTenant(q, slug) {
  const [row] = await q('SELECT id::text AS id, name, slug, status FROM tenants WHERE slug = $1', [slug]);
  return row ?? null;
}

/**
 * Per table, for this store: rows to delete, rows kept; and the rows of every other store (never touched). One scan per
 * table. Global tables: total rows.
 */
export async function countSnapshot(q, tenantId) {
  const tables = {};
  const steps = [...DELETE_STEPS.map(s => ({ table: s.table, group: 'delete', del: s.where ?? 'TRUE' })),
    ...KEEP_TABLES.map(table => ({ table, group: 'keep', del: 'FALSE' }))];
  for (const s of steps) {
    const [r] = await q(`
      SELECT count(*) FILTER (WHERE tenant_id = $1::uuid AND (${s.del}))::int AS delete,
             count(*) FILTER (WHERE tenant_id = $1::uuid AND NOT (${s.del}))::int AS keep,
             count(*) FILTER (WHERE tenant_id IS DISTINCT FROM $1::uuid)::int AS others
      FROM ${ident(s.table)}`, [tenantId]);
    tables[s.table] = { group: s.group, delete: r.delete, keep: r.keep, others: r.others };
  }
  const global = {};
  for (const t of GLOBAL_TABLES) global[t] = (await q(`SELECT count(*)::int AS n FROM ${ident(t)}`, []))[0].n;
  return { tables, global };
}

/** The store's audit events per action, with the decision the reset takes for each (from the same SQL predicate). */
export async function auditByAction(q, tenantId) {
  return q(`SELECT action, ${AUDIT_KEEP_SQL} AS kept, count(*)::int AS n FROM audit_events
            WHERE tenant_id = $1::uuid GROUP BY action ORDER BY action`, [tenantId]);
}

/** Rows of this store in tables the plan does not know (names from information_schema, checked by IDENT). */
export async function unclassifiedCounts(q, tenantId, tables) {
  const out = {};
  for (const t of tables) out[t] = (await q(`SELECT count(*)::int AS n FROM ${ident(t)} WHERE tenant_id = $1::uuid`, [tenantId]))[0].n;
  return out;
}

/** Everything a dry run shows from the database. Read only; the CLI runs it in a READ ONLY transaction. */
export async function dryRunCounts(q, tenantId) {
  const classification = classify(await schemaTables(q));
  return {
    classification,
    snapshot: await countSnapshot(q, tenantId),
    audit: await auditByAction(q, tenantId),
    unclassified: await unclassifiedCounts(q, tenantId, classification.unclassified),
    otherStores: (await q('SELECT count(*)::int AS n FROM tenants WHERE id <> $1::uuid', [tenantId]))[0].n,
  };
}

// ───────── The reset ─────────

/** Differences between the before and after counts that the reset must not produce. Empty = verified. */
export function verifyCounts(before, after, deleted) {
  const out = [];
  for (const [t, b] of Object.entries(before.tables)) {
    const a = after.tables[t];
    if (b.group === 'delete') {
      if (a.delete !== 0) out.push(`${t}: ${a.delete} rows left to delete`);
      if (deleted[t] !== b.delete) out.push(`${t}: deleted ${deleted[t]}, expected ${b.delete}`);
    }
    if (a.keep !== b.keep) out.push(`${t}: kept rows changed from ${b.keep} to ${a.keep}`);
    if (a.others !== b.others) out.push(`${t}: other stores' rows changed from ${b.others} to ${a.others}`);
  }
  for (const [t, n] of Object.entries(before.global)) if (after.global[t] !== n) out.push(`${t}: changed from ${n} to ${after.global[t]}`);
  return out;
}

/**
 * Deletes the store's business data. Must run inside ONE transaction that the caller opens and commits (inTransaction);
 * any refusal or error rolls everything back. Takes the same tenant row lock as Database.run (every app write for the
 * store waits) and the recon job's advisory lock (refuses while a recompute runs).
 */
export async function resetTenantInTransaction(q, { tenantId, eventId }) {
  await q(`SELECT set_config('lock_timeout', '5s', true) AS a, set_config('statement_timeout', '30min', true) AS b`, []);
  const [tenant] = await q('SELECT id::text AS id, name, slug FROM tenants WHERE id = $1::uuid FOR NO KEY UPDATE', [tenantId]);
  if (!tenant) refuse('The store no longer exists.');
  const [{ locked }] = await q('SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked', [reconLockKey(tenantId)]);
  if (!locked) refuse('The reconciliation is running for this store. Stop the worker and try again. Nothing was changed.');
  const problems = classificationProblems(classify(await schemaTables(q)));
  if (problems.length) refuse(`The database does not match the reset plan: ${problems.join('; ')}. Nothing was changed.`);

  const before = await countSnapshot(q, tenantId);
  const deleted = {};
  for (const s of DELETE_STEPS) {
    const [r] = await q(`WITH d AS (DELETE FROM ${ident(s.table)} WHERE tenant_id = $1::uuid${s.where ? ` AND (${s.where})` : ''} RETURNING 1)
                         SELECT count(*)::int AS n FROM d`, [tenantId]);
    deleted[s.table] = r.n;
  }
  const after = await countSnapshot(q, tenantId);
  const differences = verifyCounts(before, after, deleted);
  if (differences.length) refuse(`Verification failed, so everything was rolled back: ${differences.join('; ')}.`);

  const kept = { auditEvents: after.tables.audit_events.keep, storeWideMarketplaceRules: after.tables.marketplace_price_rules.keep };
  const details = { deleted, kept, storageObjects: 'not deleted by this run (scripts/dev/reset-store-storage.mjs)' };
  await q(`INSERT INTO audit_events (id, tenant_id, actor_id, action, entity_id, request_id, details)
           VALUES ($1::uuid, $2::uuid, NULL, '${RESET_ACTION}', $2::uuid, 'operations', $3::jsonb) RETURNING id::text AS id`,
  [eventId, tenantId, JSON.stringify(details)]);
  return { tenant, before, deleted, kept, eventId };
}

/** BEGIN [READ ONLY] ... COMMIT through one connection; ROLLBACK on any error. A read-only run always rolls back. */
export async function inTransaction(q, fn, { readOnly = false } = {}) {
  await q(readOnly ? 'BEGIN READ ONLY' : 'BEGIN', []);
  try {
    const result = await fn();
    await q(readOnly ? 'ROLLBACK' : 'COMMIT', []);
    return result;
  } catch (e) {
    await q('ROLLBACK', []).catch(() => undefined);
    throw e;
  }
}

// ───────── Pre-flight checks ─────────

/** The newest *.dump in `dir`, by its timestamp only: the file is never opened. */
export function findRecentBackup(dir, nowMs, fs = { readdirSync, statSync }) {
  let names;
  try { names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.dump')); } catch { return { ok: false, reason: 'the backup folder does not exist or cannot be read' }; }
  const files = names.flatMap(name => {
    try { const s = fs.statSync(join(dir, name)); return s.isFile() ? [{ name, mtimeMs: s.mtimeMs, size: s.size }] : []; } catch { return []; }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = files.find(f => f.mtimeMs <= nowMs + BACKUP_FUTURE_SKEW_MS);
  if (!newest) return { ok: false, reason: 'no .dump file in the backup folder' };
  const ageMs = Math.max(0, nowMs - newest.mtimeMs);
  if (newest.size <= 0) return { ok: false, file: newest.name, ageMs, reason: 'the newest backup is empty' };
  if (ageMs > BACKUP_MAX_AGE_MS) return { ok: false, file: newest.name, ageMs, reason: `the newest backup is ${Math.floor(ageMs / 60_000)} minutes old (at most 30)` };
  return { ok: true, file: newest.name, ageMs };
}

/** True when anything accepts a TCP connection on the port (127.0.0.1 or ::1): the API is probably running. */
export async function isPortOpen(port, hosts = ['127.0.0.1', '::1'], timeoutMs = 1000) {
  const probe = host => new Promise(resolve => {
    const s = connect({ host, port });
    const done = open => { s.destroy(); resolve(open); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  for (const h of hosts) if (await probe(h)) return true;
  return false;
}

/** Other client sessions on this database (any of them could be the API, the worker, pgAdmin, psql or Prisma Studio). */
export async function otherSessions(q) {
  const rows = await q(`
    SELECT pid, coalesce(application_name, '') AS app, coalesce(host(client_addr), 'local socket') AS addr, coalesce(state, '') AS state
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
    ORDER BY pid`, []);
  const clean = v => String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 60);
  return rows.map(r => ({ pid: Number(r.pid), app: clean(r.app) || '(no application name)', addr: clean(r.addr), state: clean(r.state) }));
}

/** BullMQ: connected workers per queue and this store's jobs per queue and state. `queues` maps a name to a Queue. */
export async function redisFacts(queues, tenantId) {
  const workers = {};
  for (const name of ALL_QUEUES) workers[name] = await queues[name].getWorkersCount();
  const jobs = {};
  for (const name of TENANT_QUEUES) {
    jobs[name] = {};
    for (const state of [...REMOVABLE_JOB_STATES, 'active']) {
      jobs[name][state] = (await queues[name].getJobs([state], 0, -1)).filter(j => j?.data?.tenantId === tenantId).length;
    }
  }
  return { workers, jobs };
}

/** After COMMIT: removes this store's jobs in every non-active state, and the recon deduplication key. */
export async function removeTenantJobs(queues, tenantId) {
  const removed = {};
  let failed = 0;
  for (const name of TENANT_QUEUES) {
    removed[name] = 0;
    for (const state of REMOVABLE_JOB_STATES) {
      for (const job of (await queues[name].getJobs([state], 0, -1)).filter(j => j?.data?.tenantId === tenantId)) {
        try { await job.remove(); removed[name]++; } catch { failed++; }
      }
    }
  }
  await queues.recon.removeDeduplicationKey(reconDeduplicationId(tenantId));
  return { removed, failed };
}

/**
 * Why a real run must not start. Empty = allowed. `redis` is { skipped } or { unreachable } or { error } or
 * redisFacts(); `sessions` is otherSessions().
 */
export function refusals({ classification, backup, api, sessions, redis }) {
  const out = classificationProblems(classification).map(p => `Database: ${p}.`);
  if (!backup.ok) out.push(`Backup: ${backup.reason}. Run scripts\\dev\\db-backup.ps1 -Label before-reset first.`);
  if (api.open) out.push(`API: something is listening on port ${api.port}. Stop the API (npm run dev / npm start) first.`);
  if (sessions.length) {
    const list = sessions.map(s => `pid ${s.pid} ${s.app} from ${s.addr}${s.state ? ` (${s.state})` : ''}`).join('; ');
    out.push(`Database: ${sessions.length} other session(s) are connected: ${list}. Close them (API, worker, pgAdmin, psql, Prisma Studio) first.`);
  }
  if (redis.skipped) return out;
  if (redis.unreachable) out.push('Redis: not reachable, so queued jobs and running workers cannot be checked. Start Redis, or pass --skip-redis.');
  else if (redis.error) out.push(`Redis: the check failed (${redis.error}). Fix it, or pass --skip-redis.`);
  else {
    const busy = Object.entries(redis.workers).filter(([, n]) => n > 0);
    if (busy.length) out.push(`Worker: BullMQ workers are connected (${busy.map(([q, n]) => `${q} ${n}`).join(', ')}). Stop the worker first.`);
    const active = Object.entries(redis.jobs).filter(([, s]) => s.active > 0);
    if (active.length) out.push(`Worker: jobs for this store are running (${active.map(([q, s]) => `${q} ${s.active}`).join(', ')}).`);
  }
  return out;
}
