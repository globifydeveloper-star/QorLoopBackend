import type { Database } from '../../../packages/db/src/database.js';
import { storagePrefixes } from '../../../packages/db/src/store-reset.js';
import type { StoreCleanupJob } from '../../../packages/shared/src/store-cleanup.js';
import type { ObjectStorage } from '../../../packages/shared/src/storage.js';

export interface CleanupDeps {
  database: Database; storage: ObjectStorage;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

/**
 * ADR 022: after an in-app reset, deletes the store's files under tenants/<id>/uploads/ and tenants/<id>/generated/
 * that (a) no upload or generated-file row points at and (b) were last written before the reset. A file uploaded or
 * generated after the reset is never touched, and anything else under the store's prefix is left alone. Idempotent:
 * a retry lists again. Writes one store.storage_cleaned event (kept by later resets, like store.data_reset).
 */
export async function cleanStoreStorage(deps: CleanupDeps, job: StoreCleanupJob) {
  const resetAt = new Date(job.resetAt).getTime();
  const prefixes = storagePrefixes(job.tenantId);
  const listed = (await Promise.all(prefixes.delete.map(p => deps.storage.list(p)))).flat();
  const candidates = listed.filter(o => o.lastModified.getTime() <= resetAt);
  const referenced = new Set<string>();
  for (let i = 0; i < candidates.length; i += 1000) {
    const keys = candidates.slice(i, i + 1000).map(o => o.key);
    for (const k of await deps.database.run(job.tenantId, d => d.referencedStorageKeys(keys))) referenced.add(k);
  }
  const orphans = candidates.filter(o => !referenced.has(o.key));
  const { deleted, failed } = orphans.length ? await deps.storage.deleteMany(orphans.map(o => o.key)) : { deleted: 0, failed: 0 };
  const details = { resetEventId: job.resetEventId, listed: listed.length, deleted, failed, kept: listed.length - deleted - failed, bytes: orphans.reduce((a, o) => a + o.size, 0) };
  await deps.database.run(job.tenantId, d => d.event('store.storage_cleaned', null, job.tenantId, 'operations', details));
  deps.log?.info({ tenantId: job.tenantId, ...details }, 'Store files cleaned after reset');
  // A partial failure is retried by the queue; the retry deletes only what is still there.
  if (failed) throw new Error(`${failed} files could not be deleted`);
  return details;
}
