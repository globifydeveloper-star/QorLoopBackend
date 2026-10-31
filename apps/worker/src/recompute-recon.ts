import type { Database } from '../../../packages/db/src/database.js';
import type { ReconMarketplaceState } from '../../../packages/db/src/recon.js';
import type { ReconJob } from '../../../packages/shared/src/recon.js';
import { MARKETPLACES } from '../../../packages/core/src/constants.js';
import { computeReconRows, diffReconRows, enabledMarketplaces, isStale } from '../../../packages/core/src/recon/index.js';
import { describeApplyError, type ApplyFailure } from './apply-upload.js';

export interface ReconDeps {
  database: Database;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export type ReconPhase = 'start' | 'load' | 'compute' | 'insert' | 'update' | 'remove' | 'summaries' | 'finish';
export type ReconFailure = ApplyFailure<ReconPhase>;

export interface ReconCounts {
  products: number; marketplaces: number; rows: number; inserted: number; updated: number; removed: number; summaries: number;
}

/**
 * A full rewrite of 200,000 rows (first run, or a default-rule change at 50,000 products x 4 marketplaces) takes
 * 20-30 s on a laptop Postgres 18; leave room below the 180 s BullMQ job lock.
 */
export const RECON_TIMEOUT_MS = 120_000;

/**
 * Recomputes every recon row and summary of one tenant in ONE transaction, from one consistent snapshot of the
 * catalogue, without the tenant row lock (Database.runSnapshot): readers see the previous results until it commits.
 * Only the difference is written (new, changed and no-longer-qualifying rows), so a repeated run writes nothing.
 * A change committed while a run is in progress queues the next run (BullReconQueue keepLastIfActive).
 * On failure the transaction rolls back, so the previous rows and summaries stay; a 'recon.failed' audit event records
 * a safe summary (no row data) and the error is rethrown for BullMQ to retry.
 */
export async function recomputeRecon(deps: ReconDeps, job: ReconJob): Promise<ReconCounts> {
  const { database } = deps;
  const { tenantId, reason } = job;
  const t0 = Date.now();
  let phase: ReconPhase = 'start';
  const timings: Partial<Record<ReconPhase, number>> = {};
  let mark = t0;
  const enter = (next: ReconPhase) => { timings[phase] = (timings[phase] ?? 0) + Date.now() - mark; mark = Date.now(); phase = next; };
  try {
    const counts = await database.runSnapshot(tenantId, 'recon', async d => {
      enter('load');
      const now = new Date();
      const [settings, switches, applied] = await Promise.all([d.recon.settings(), d.recon.marketplaceSwitches(), d.recon.lastApplied()]);
      const marketplaces = enabledMarketplaces(MARKETPLACES, switches, new Set(applied.keys()));
      const [stored, products, listings, pricing] = await Promise.all([
        d.recon.storedSignatures(),
        marketplaces.length ? d.recon.products() : [],
        marketplaces.length ? d.recon.listings(marketplaces.map(m => m.marketplaceId)) : new Map(),
        d.pricing.snapshot(),
      ]);

      enter('compute');
      const rows = computeReconRows(products, marketplaces, listings, pricing, settings, now);
      const diff = diffReconRows(stored, rows);

      enter('insert');
      const inserted = await d.recon.insertRows(diff.insert);
      enter('update');
      const updated = await d.recon.updateRows(diff.update);
      enter('remove');
      const removed = await d.recon.deleteRows(diff.remove);
      enter('summaries');
      const states: ReconMarketplaceState[] = marketplaces.map(m => {
        const lastUploadAt = applied.get(m.marketplaceId) ?? null;
        return { ...m, lastUploadAt, stale: isStale(lastUploadAt, settings.staleHours, now) };
      });
      const summaries = await d.recon.writeSummaries(states);
      enter('finish');
      return { products: products.length, marketplaces: marketplaces.length, rows: rows.length, inserted, updated, removed, summaries };
    }, { timeout: RECON_TIMEOUT_MS });
    enter(phase);
    // counts and timings only, never row data; the tenant row lock is never taken (tenantLockMs is always 0)
    deps.log?.info({ tenantId, reason, ...counts, ms: Date.now() - t0, tenantLockMs: 0, timings }, 'Recon recomputed');
    return counts;
  } catch (e) {
    const failed = phase;
    enter(failed);
    const failure: ReconFailure = describeApplyError(e, failed, Date.now() - t0);
    deps.log?.warn({ tenantId, reason, ...failure, timings }, 'Recon recompute failed; previous results kept');
    try {
      await database.run(tenantId, d => d.event('recon.failed', null, null, undefined, { reason, ...failure }));
    } catch {
      deps.log?.warn({ tenantId }, 'Could not record the recon failure');
    }
    throw e;
  }
}
