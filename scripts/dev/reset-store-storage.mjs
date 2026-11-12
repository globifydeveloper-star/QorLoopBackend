#!/usr/bin/env node
// Second, separate step of a store data reset (ADR 018): deletes the store's files in object storage. Development only;
// you run it, from the repository, AFTER scripts/dev/reset-store-data.mjs has committed:
//   node scripts/dev/reset-store-storage.mjs --tenant <slug>                                        DRY RUN (default)
//   node scripts/dev/reset-store-storage.mjs --tenant <slug> --confirm <slug> --expect-count <n>   real run
// Options: --env-path <path> (default: this repository's .env), --keys-dir <path> (default D:\Qorloop-test\backups).
//
// Only tenants/<store id>/uploads/ and tenants/<store id>/generated/ are listed for deletion (the only keys the app
// builds); anything else under tenants/<store id>/ is reported as untouched. Another store's objects can never match:
// the store id is a validated UUID and the prefix ends in '/'.
// The dry run prints the count, the bytes and the first 50 keys, and writes every key to a list file. A real run
// refuses while the store still has upload or generated-file rows, or when the listing differs from --expect-count.
// NOT reversible: the database backup does not contain these files.
//
// Nothing secret is printed: not the S3 endpoint, keys or secret, not the database URL, not raw error messages.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { DeleteObjectCommand, DeleteObjectsCommand, GetBucketVersioningCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { describeError, pgClientOptions, readEnvFile, splitDatabaseUrl } from './database-url.mjs';
import * as plan from './store-reset-plan.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const n = v => Number(v).toLocaleString('en-US');
const out = line => console.log(line);
const SHOWN_KEYS = 50;

/** AWS errors: their name and HTTP status only (messages can carry the endpoint, bucket or request details). */
const describeS3 = e => {
  const name = e && typeof e.name === 'string' && /^[A-Za-z]{1,60}$/.test(e.name) ? e.name : '';
  const status = e?.$metadata?.httpStatusCode;
  return name || status ? `${name || 'S3 error'}${status ? ` (HTTP ${status})` : ''}` : describeError(e);
};

function options() {
  try {
    return parseArgs({
      options: { tenant: { type: 'string' }, confirm: { type: 'string' }, 'expect-count': { type: 'string' }, 'env-path': { type: 'string' }, 'keys-dir': { type: 'string' } },
      strict: true, allowPositionals: false,
    }).values;
  } catch {
    throw new plan.ResetRefused('Unknown or malformed option. Use --tenant <slug> [--confirm <slug> --expect-count <n>] [--env-path] [--keys-dir].');
  }
}

function s3From(env) {
  const opts = {
    region: env.S3_REGION || 'me-central-1', forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'false') === 'true',
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } } : {}),
    // Like packages/shared/src/storage.ts: checksums only where the API requires them (DeleteObjects does).
    requestChecksumCalculation: 'WHEN_REQUIRED',
  };
  return { client: new S3Client(opts), bucket: env.S3_BUCKET || 'qorloop-private' };
}

async function main() {
  const values = options();
  const args = plan.validateStorageArgs(values);
  const env = readEnvFile(resolve(values['env-path'] ?? resolve(REPO, '.env')));
  const keysDir = values['keys-dir'] ?? plan.DEFAULT_BACKUP_DIR;

  const db = new pg.Client(pgClientOptions(splitDatabaseUrl(env.DATABASE_URL), 'qorloop-reset-store-storage'));
  db.on('error', () => undefined);
  try { await db.connect(); } catch (e) { throw new plan.ResetRefused(`Could not connect to the database: ${describeError(e)}.`); }
  const q = async (text, params) => (await db.query(text, params)).rows;
  let tenant, rows;
  try {
    tenant = await plan.findTenant(q, args.tenant);
    if (!tenant) throw new plan.ResetRefused(`No store with the slug "${args.tenant}" in this database. Nothing was changed.`);
    rows = await plan.storageRowCounts(q, tenant.id);
  } finally { await db.end().catch(() => undefined); }

  const { client, bucket } = s3From(env);
  try {
    const prefixes = plan.storagePrefixes(tenant.id);
    const listPage = async (prefix, token) => {
      const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
      return { objects: (r.Contents ?? []).map(o => ({ key: o.Key, size: o.Size ?? 0 })), next: r.IsTruncated ? r.NextContinuationToken : undefined };
    };
    let objects;
    try { objects = await plan.listAllObjects(listPage, prefixes.root); } catch (e) { throw new plan.ResetRefused(`Could not list the bucket: ${describeS3(e)}.`); }
    const p = plan.storagePlan(tenant.id, objects);
    let versioning = 'unknown (no permission to read it)';
    try { versioning = (await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status ?? 'not enabled'; } catch { /* reported as unknown */ }

    out(`Qorloop store storage reset - ${args.mode === 'dry-run' ? 'DRY RUN (nothing is deleted)' : 'REAL RUN'}`);
    out(`Store: ${tenant.name}   slug: ${tenant.slug}   id: ${tenant.id}`);
    out(`Bucket: ${bucket}   versioning: ${versioning}${versioning === 'Enabled' || versioning === 'Suspended' ? ' (deletes only add delete markers; old versions stay)' : ''}`);
    out(`Database rows that still point at files: ${rows.uploads} uploads, ${rows.generated} generated files.`);
    out('');
    out(`Would delete: ${n(p.delete.length)} objects, ${n(p.bytes)} bytes, under ${p.prefixes.delete.join(' and ')}`);
    for (const o of p.delete.slice(0, SHOWN_KEYS)) out(`  ${o.key}  (${n(o.size)} bytes)`);
    if (p.delete.length > SHOWN_KEYS) out(`  ... and ${n(p.delete.length - SHOWN_KEYS)} more (see the list file)`);
    if (p.untouched.length) {
      out(`Untouched (other paths under ${p.prefixes.root}): ${n(p.untouched.length)} objects`);
      for (const o of p.untouched.slice(0, 10)) out(`  ${o.key}`);
    }

    const refusals = plan.storageRefusals({ rows, listed: p.delete.length, expectCount: args.expectCount });
    if (args.mode === 'dry-run') {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const file = join(keysDir, `storage-keys-${tenant.slug}-${stamp}.txt`);
      try {
        mkdirSync(keysDir, { recursive: true });
        writeFileSync(file, p.delete.map(o => `${o.key}\t${o.size}`).join('\n') + (p.delete.length ? '\n' : ''), 'utf8');
        out(`Full list: ${file}`);
      } catch (e) { out(`The list file could not be written (${describeError(e)}).`); }
      out('');
      if (refusals.length) { out('A real run would refuse:'); for (const r of refusals) out(`  - ${r}`); }
      out(refusals.length ? 'Fix the above, then run:' : 'After reviewing the list, a real run is:');
      out(`  node scripts/dev/reset-store-storage.mjs --tenant ${tenant.slug} --confirm ${tenant.slug} --expect-count ${p.delete.length}`);
      return 0;
    }
    if (refusals.length) {
      out('');
      out('REFUSED. Nothing was deleted.');
      for (const r of refusals) out(`  - ${r}`);
      return 2;
    }
    if (!p.delete.length) { out('Nothing to delete.'); return 0; }

    let deleted = 0;
    const failures = {};
    for (const batch of plan.batches(p.delete.map(o => o.key))) {
      try {
        const r = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true } }));
        for (const err of r.Errors ?? []) failures[err.Code ?? 'unknown'] = (failures[err.Code ?? 'unknown'] ?? 0) + 1;
        deleted += batch.length - (r.Errors?.length ?? 0);
      } catch (e) {
        // A store without multi-object delete (or without its checksum): one request per key instead.
        if (e?.$metadata?.httpStatusCode && e.$metadata.httpStatusCode !== 501 && e.name !== 'NotImplemented') throw new plan.ResetRefused(`Delete failed after ${n(deleted)} objects: ${describeS3(e)}.`);
        for (const Key of batch) {
          try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key })); deleted++; } catch (e2) { const c = describeS3(e2); failures[c] = (failures[c] ?? 0) + 1; }
        }
      }
    }
    const left = plan.storagePlan(tenant.id, await plan.listAllObjects(listPage, prefixes.root)).delete.length;
    out(`Deleted ${n(deleted)} of ${n(p.delete.length)} objects.${Object.keys(failures).length ? ` Failed: ${Object.entries(failures).map(([c, k]) => `${c} ${k}`).join(', ')}.` : ''}`);
    out(`Objects left under the two prefixes: ${n(left)}.`);
    return left ? 1 : 0;
  } finally { client.destroy(); }
}

process.exitCode = await main().catch(e => {
  const refused = e instanceof plan.ResetRefused;
  console.error(`${refused ? 'REFUSED' : 'FAILED'}: ${describeError(e)}`);
  return refused ? 2 : 1;
});
