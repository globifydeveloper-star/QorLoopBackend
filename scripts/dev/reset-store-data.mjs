#!/usr/bin/env node
// Removes ALL business data of ONE store (ADR 018) and keeps the store, its users, roles, invitations, sessions, MFA data,
// tenant and pricing settings, saved file mapping layouts and security/team/settings audit events. Other stores in the
// same database are never touched. Development only; you run it, from the repository:
//   node scripts/dev/reset-store-data.mjs --tenant <slug>                       DRY RUN (default): counts only, no change
//   node scripts/dev/reset-store-data.mjs --tenant <slug> --confirm <slug>      real run
// Options: --env-path <path> (default: this repository's .env; not --env-file, which Node itself takes), --backup-dir <path> (default D:\Qorloop-test\backups),
//          --api-port <n> (default: PORT from the env file, else 4000), --skip-redis (do not check or clean BullMQ jobs).
//
// A real run refuses unless: --confirm repeats the slug; a *.dump backup under 30 minutes old exists (timestamp only;
// never opened); nothing listens on the API port; no other session is connected to the database; no BullMQ worker is
// connected and no job of this store is running; the database matches the plan in store-reset-plan.mjs.
// Then ONE transaction deletes, verifies (this store's kept rows and every other store's rows unchanged) and writes one
// store.data_reset audit event; anything unexpected rolls it all back. After COMMIT: this store's queued jobs are removed.
// Files in object storage are NOT deleted: that is scripts/dev/reset-store-storage.mjs, with its own dry run.
//
// Nothing secret is printed: not the URL, not a password, not file contents, not raw error messages (only codes).
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { describeError, pgClientOptions, readEnvFile, splitDatabaseUrl } from './database-url.mjs';
import * as plan from './store-reset-plan.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const n = v => Number(v).toLocaleString('en-US');
const out = line => console.log(line);

function options() {
  try {
    return parseArgs({
      options: {
        tenant: { type: 'string' }, confirm: { type: 'string' }, 'env-path': { type: 'string' }, 'backup-dir': { type: 'string' },
        'api-port': { type: 'string' }, 'skip-redis': { type: 'boolean' },
      },
      strict: true, allowPositionals: false,
    }).values;
  } catch {
    throw new plan.ResetRefused('Unknown or malformed option. Use --tenant <slug> [--confirm <slug>] [--env-path] [--backup-dir] [--api-port] [--skip-redis].');
  }
}

/** Redis + one BullMQ Queue per queue name; null when Redis does not answer. Never prints the URL or a driver message. */
async function openQueues(url) {
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 1, retryStrategy: () => null, enableOfflineQueue: false });
  redis.on('error', () => undefined);
  try { await redis.connect(); } catch { redis.disconnect(); return null; }
  const queues = Object.fromEntries(plan.ALL_QUEUES.map(name => [name, new Queue(name, { connection: redis })]));
  for (const queue of Object.values(queues)) queue.on('error', () => undefined);
  return { queues, close: async () => { for (const queue of Object.values(queues)) await queue.close().catch(() => undefined); await redis.quit().catch(() => redis.disconnect()); } };
}

function printDryRun(tenant, counts, checks) {
  const { snapshot, audit, unclassified, otherStores } = counts;
  const width = Math.max(...Object.keys(snapshot.tables).map(t => t.length)) + 2;
  out('');
  out('Would delete (this store only):');
  let total = 0;
  for (const s of plan.DELETE_STEPS) {
    const t = snapshot.tables[s.table];
    total += t.delete;
    out(`  ${s.table.padEnd(width)}${n(t.delete).padStart(12)}${s.keeps ? `   (keeps ${n(t.keep)} ${s.keeps})` : ''}`);
  }
  out(`  ${'total'.padEnd(width)}${n(total).padStart(12)}`);
  out('');
  out('Kept unchanged (this store):');
  for (const t of plan.KEEP_TABLES) out(`  ${t.padEnd(width)}${n(snapshot.tables[t].keep).padStart(12)}`);
  if (audit.length) {
    out('');
    out('Audit events by action:');
    for (const a of audit) out(`  ${a.kept ? 'keep  ' : 'delete'}  ${a.action.padEnd(40)}${n(a.n).padStart(10)}`);
  }
  if (Object.keys(unclassified).length) {
    out('');
    out('Tables the plan does not know (a real run refuses):');
    for (const [t, c] of Object.entries(unclassified)) out(`  ${t.padEnd(width)}${n(c).padStart(12)} rows of this store`);
  }
  out('');
  out(`Other stores in this database: ${otherStores} (their rows are never touched).`);
  if (checks.redis.jobs) {
    out('');
    out('BullMQ jobs of this store (removed after a real run; running ones make it refuse):');
    for (const [queue, states] of Object.entries(checks.redis.jobs)) {
      out(`  ${queue.padEnd(20)}${Object.entries(states).map(([s, c]) => `${s} ${c}`).join(', ')}`);
    }
  }
}

function printChecks(checks, refusals) {
  out('');
  out('Checks for a real run:');
  const { backup, api, sessions, redis } = checks;
  out(backup.ok ? `  [ok]     backup: ${backup.file}, ${Math.floor(backup.ageMs / 60_000)} min old` : `  [refuse] backup: ${backup.reason}${backup.file ? ` (${backup.file})` : ''}`);
  out(`  ${api.open ? '[refuse]' : '[ok]    '} API port ${api.port}: ${api.open ? 'something is listening' : 'nothing listening'}`);
  out(`  ${sessions.length ? '[refuse]' : '[ok]    '} other database sessions: ${sessions.length}`);
  for (const s of sessions) out(`             pid ${s.pid}  ${s.app}  from ${s.addr}${s.state ? `  (${s.state})` : ''}`);
  if (redis.skipped) out('  [skip]   Redis: --skip-redis given; workers and queued jobs NOT checked or cleaned');
  else if (redis.unreachable) out('  [refuse] Redis: not reachable');
  else if (redis.error) out(`  [refuse] Redis: ${redis.error}`);
  else {
    const workers = Object.values(redis.workers).reduce((a, b) => a + b, 0);
    out(`  ${workers ? '[refuse]' : '[ok]    '} BullMQ workers connected: ${workers}`);
  }
  if (refusals.length) {
    out('');
    out('A real run would refuse:');
    for (const r of refusals) out(`  - ${r}`);
  }
}

async function main() {
  const values = options();
  const args = plan.validateArgs(values);
  const env = readEnvFile(resolve(values['env-path'] ?? resolve(REPO, '.env')));
  const port = Number(values['api-port'] ?? env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new plan.ResetRefused('--api-port (or PORT in the env file) is not a port number.');
  const backupDir = values['backup-dir'] ?? plan.DEFAULT_BACKUP_DIR;

  const db = new pg.Client(pgClientOptions(splitDatabaseUrl(env.DATABASE_URL), 'qorloop-reset-store-data'));
  db.on('error', () => undefined);
  try { await db.connect(); } catch (e) { throw new plan.ResetRefused(`Could not connect to the database: ${describeError(e)}.`); }
  const q = async (text, params) => (await db.query(text, params)).rows;
  let redis = null;
  try {
    const tenant = await plan.findTenant(q, args.tenant);
    if (!tenant) throw new plan.ResetRefused(`No store with the slug "${args.tenant}" in this database. Nothing was changed.`);
    out(`Qorloop store data reset - ${args.mode === 'dry-run' ? 'DRY RUN (nothing is changed)' : 'REAL RUN'}`);
    out(`Store: ${tenant.name}   slug: ${tenant.slug}   id: ${tenant.id}   status: ${tenant.status}`);

    const counts = await plan.inTransaction(q, () => plan.dryRunCounts(q, tenant.id), { readOnly: true });
    const checks = {
      classification: counts.classification,
      backup: plan.findRecentBackup(backupDir, Date.now()),
      api: { port, open: await plan.isPortOpen(port) },
      sessions: await plan.otherSessions(q),
      redis: { skipped: true },
    };
    if (!values['skip-redis']) {
      redis = await openQueues(env.REDIS_URL ?? 'redis://localhost:6379');
      if (!redis) checks.redis = { unreachable: true };
      else {
        try { checks.redis = await plan.redisFacts(redis.queues, tenant.id); } catch (e) { checks.redis = { error: describeError(e) }; }
      }
    }
    const refusals = plan.refusals(checks);
    printDryRun(tenant, counts, checks);
    printChecks(checks, refusals);

    if (args.mode === 'dry-run') {
      out('');
      out(refusals.length ? 'Fix the above, then run:' : 'A real run is allowed now:');
      out(`  node scripts/dev/reset-store-data.mjs --tenant ${tenant.slug} --confirm ${tenant.slug}`);
      return 0;
    }
    if (refusals.length) {
      out('');
      out('REFUSED. Nothing was changed.');
      return 2;
    }

    out('');
    out('Deleting in one transaction...');
    const result = await plan.inTransaction(q, () => plan.resetTenantInTransaction(q, { tenantId: tenant.id, eventId: randomUUID() }));
    const total = Object.values(result.deleted).reduce((a, b) => a + b, 0);
    out(`Committed. Deleted ${n(total)} rows:`);
    for (const [t, c] of Object.entries(result.deleted)) if (c) out(`  ${t.padEnd(26)}${n(c).padStart(12)}`);
    out(`Kept: ${n(result.kept.auditEvents)} security/team/settings audit events, ${n(result.kept.storeWideMarketplaceRules)} store-wide marketplace rules, and every row of the kept tables.`);
    out(`Audit event written: ${plan.RESET_ACTION} (${result.eventId}).`);

    if (redis && !checks.redis.skipped) {
      try {
        const jobs = await plan.removeTenantJobs(redis.queues, tenant.id);
        out(`BullMQ: removed ${Object.entries(jobs.removed).map(([q2, c]) => `${q2} ${c}`).join(', ')}${jobs.failed ? `; ${jobs.failed} could not be removed` : ''}.`);
      } catch (e) {
        out(`BullMQ: the jobs could not be removed (${describeError(e)}). The database reset is committed; a leftover job only finds no data.`);
      }
    } else out('BullMQ: not checked (--skip-redis). A leftover job of this store only finds no data, but a queued file generation would log a failure event.');
    out('');
    out('Files in object storage were NOT deleted. Review them with:');
    out(`  node scripts/dev/reset-store-storage.mjs --tenant ${tenant.slug}`);
    return 0;
  } finally {
    if (redis) await redis.close();
    await db.end().catch(() => undefined);
  }
}

process.exitCode = await main().catch(e => {
  const refused = e instanceof plan.ResetRefused;
  console.error(`${refused ? 'REFUSED' : 'FAILED'}: ${describeError(e)}`);
  return refused ? 2 : 1;
});
