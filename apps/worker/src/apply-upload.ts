import type { Database } from '../../../packages/db/src/database.js';
import type { ApplyUploadJob } from '../../../packages/shared/src/queue.js';
import type { ReconQueue } from '../../../packages/shared/src/recon.js';
import type { ErpRow, MarketplaceRow } from '../../../packages/core/src/upload/validate.js';
import { planErpApply, planListingApply, type SkippedRow } from '../../../packages/core/src/upload/apply.js';

export interface ApplyDeps {
  database: Database;
  /** Asked for a recon recompute once an apply has committed. */
  recon?: ReconQueue;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export type ApplyOutcome = 'applied' | 'failed' | 'skipped';

export interface ApplyCounts {
  created: number; updated: number; flagged: number; listingsUpserted: number; listingsRemoved: number; skipped: number;
  /** marketplace only: written listings matched to a product at apply time, and those left without one */
  matchedAtApply?: number; unmatchedAtApply?: number;
}

/** Skipped rows listed in the 'upload.applied' audit event; the count is always complete. */
const MAX_SKIPPED_LISTED = 1000;

const RETRY_MESSAGE = 'We could not apply this file. Nothing was changed; please try again.';
/** A 23,500-row ERP file takes 4-6 s on local Postgres 18; leave room for a slower server, below the 120 s BullMQ job lock. */
export const APPLY_TIMEOUT_MS = 60_000;

type Staged = { data: unknown };

export type ApplyPhase = 'start' | 'create products' | 'update products' | 'flag missing' | 'listings' | 'audit' | 'finish';

/** What failed, without row data: safe for logs and the audit trail. */
export interface ApplyFailure<P extends string = ApplyPhase> { phase: P; errorType: string; sqlState: string | null; prismaCode: string | null; message: string; ms: number }

// Prisma's own codes are P1xxx-P6xxx; SQLSTATE's only P class is P0 (PL/pgSQL).
const PRISMA_CODE = /^P[1-9]\d{3}$/;
const SQLSTATE = /^(?!P[1-9])[0-9A-Z]{5}$/;

/**
 * The error type, codes and the first line of the message cut at the first quote, so no cell value
 * (Postgres and Prisma quote values and identifiers) reaches a log. Walks Prisma's wrapping down to the driver error.
 */
export function describeApplyError<P extends string = ApplyPhase>(e: unknown, phase: P, ms: number): ApplyFailure<P> {
  let sqlState: string | null = null;
  let prismaCode: string | null = null;
  let driverMessage: string | null = null;
  const seen = new Set<unknown>();
  const queue: unknown[] = [e];
  while (queue.length && seen.size < 10) {
    const x = queue.shift();
    if (!x || typeof x !== 'object' || seen.has(x)) continue;
    seen.add(x);
    const o = x as { code?: unknown; originalCode?: unknown; originalMessage?: unknown; meta?: { code?: unknown; driverAdapterError?: unknown }; cause?: unknown };
    for (const c of [o.originalCode, o.code, o.meta?.code]) {
      if (typeof c !== 'string') continue;
      if (!sqlState && SQLSTATE.test(c)) sqlState = c;
      if (!prismaCode && PRISMA_CODE.test(c)) prismaCode = c;
    }
    if (!driverMessage && typeof o.originalMessage === 'string') driverMessage = o.originalMessage;
    queue.push(o.meta?.driverAdapterError, o.cause);
  }
  const raw = driverMessage ?? (e instanceof Error ? e.message : '');
  const line = raw.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const message = line.split(/["'`‘’“”]/)[0]!.trim().slice(0, 200);
  return { phase, errorType: e instanceof Error ? e.name : typeof e, sqlState, prismaCode, message, ms };
}

/**
 * Step 12 (docs 5.6): write a reviewed upload to the catalogue in ONE transaction, all or nothing.
 * Values are absolute (never increments) and old values are read at apply time, so a retry gives the same result.
 * On failure everything rolls back and the upload returns to needs_review with a plain message, so the user can retry.
 * Safe to run twice: a job whose upload is no longer "applying" at that revision returns 'skipped'.
 */
export async function applyUpload(deps: ApplyDeps, job: ApplyUploadJob): Promise<ApplyOutcome> {
  const { database } = deps;
  const { tenantId, uploadId } = job;
  const upload = await database.run(tenantId, d => d.uploads.get(uploadId));
  if (!upload || upload.status !== 'applying' || upload.revision !== job.revision) return 'skipped';
  // Staging rows cannot change while applying (discard refuses it), so read them before taking the long lock.
  const staged = await database.run(tenantId, d => d.uploads.stagedRows(uploadId));

  const t0 = Date.now();
  // Which step is running and how long each took, so a failure or a slow apply can be traced without row data.
  let phase: ApplyPhase = 'start';
  const timings: Partial<Record<ApplyPhase, number>> = {};
  let mark = t0;
  const enter = (next: ApplyPhase) => { timings[phase] = (timings[phase] ?? 0) + Date.now() - mark; mark = Date.now(); phase = next; };
  // rows the database would refuse are left out (row number and reason only), so one bad row cannot sink the file
  let skipped: SkippedRow[] = [];
  let counts: ApplyCounts | null;
  try {
    counts = await database.run(tenantId, async d => {
      const u = await d.uploads.get(uploadId);
      if (!u || u.status !== 'applying' || u.revision !== job.revision) return null;
      const actorId = await d.uploads.applyRequestedBy(uploadId);
      const full = u.contains !== 'partial';
      const c: ApplyCounts = { created: 0, updated: 0, flagged: 0, listingsUpserted: 0, listingsRemoved: 0, skipped: 0 };

      if (u.source === 'erp') {
        const products = (await d.uploads.applySnapshot()).map(p => ({ ...p, erpPrice: p.erpPrice.toNumber(), costPrice: p.costPrice?.toNumber() ?? null }));
        // "first import" is decided at review time; re-checked so a second first-import file applied later makes 'new' products
        const firstImport = (u.summary as { firstImport?: unknown } | null)?.firstImport === true && products.length === 0;
        const mapped = Object.entries((u.mapping as Record<string, string> | null) ?? {}).filter(([, header]) => header).map(([key]) => key);
        const plan = planErpApply(staged.map(r => (r.parsed as Staged).data as ErpRow), products, mapped, firstImport ? 'active' : 'new');
        enter('create products');
        await d.uploads.createProducts(plan.create);
        enter('update products');
        await d.uploads.updateProducts(plan.update);
        enter('flag missing');
        const flagged = full ? await d.uploads.flagMissingProducts(plan.barcodes) : [];
        enter('audit');
        await d.uploads.auditEvents(actorId, [
          ...plan.changes.map(ch => ({ action: 'product.field_changed', entityId: ch.productId, details: { field: ch.field, old: ch.old, new: ch.new, uploadId } })),
          ...flagged.map(id => ({ action: 'product.field_changed', entityId: id, details: { field: 'inLatestErpFile', old: true, new: false, uploadId } })),
        ]);
        skipped = plan.skipped;
        Object.assign(c, { created: plan.create.length, updated: plan.update.length, flagged: flagged.length });
      } else {
        enter('listings');
        // matched again against the catalogue as it is now: the review may predate the ERP apply that created the products
        const products = await d.uploads.productSnapshot();
        const plan = planListingApply(staged.map(r => (r.parsed as Staged).data as MarketplaceRow), products);
        await d.uploads.upsertListings(u.source, uploadId, plan.listings);
        // a skipped row's ID still counts as in the file, so a full list does not remove its existing listing
        const inFile = staged.map(r => ((r.parsed as Staged).data as MarketplaceRow).marketplaceProductId).filter(id => typeof id === 'string' && id);
        const removed = full ? await d.uploads.removeListingsNotIn(u.source, inFile) : 0;
        skipped = plan.skipped;
        Object.assign(c, { listingsUpserted: plan.listings.length, listingsRemoved: removed, matchedAtApply: plan.matched, unmatchedAtApply: plan.unmatched });
      }
      c.skipped = skipped.length;

      enter('finish');
      const ok = await d.uploads.transition(uploadId, ['applying'], { status: 'applied', appliedAt: new Date(), step: null, progress: 100, errorMessage: null });
      if (!ok) throw new Error('Upload left the applying state during apply');
      const skippedRows = skipped.slice(0, MAX_SKIPPED_LISTED).map(s => ({ row: s.rowNumber, reason: s.reason }));
      await d.event('upload.applied', actorId, uploadId, undefined, { ...c, uploadId, ...(skipped.length ? { skippedRows } : {}) });
      return c;
    }, { timeout: APPLY_TIMEOUT_MS });
  } catch (e) {
    // Never log row data: describeApplyError keeps only the type, codes and the unquoted start of the message.
    const failed = phase;
    enter(failed);
    const failure = describeApplyError(e, failed, Date.now() - t0);
    deps.log?.warn({ tenantId, uploadId, ...failure, timings }, 'Upload apply failed; rolled back');
    // If even this fails, rethrow so BullMQ retries the whole (idempotent) job.
    try { await revertToReview(deps, job, failure); } catch { throw e; }
    return 'failed';
  }
  if (!counts) return 'skipped';
  enter(phase);
  // After commit, so the recompute reads the applied catalogue; it is coalesced with every other trigger of the tenant.
  try { await deps.recon?.enqueueRecon(tenantId, 'upload.applied'); }
  catch { deps.log?.warn({ tenantId, uploadId }, 'Could not queue the recon recompute after apply'); }
  deps.log?.info({ tenantId, uploadId, ...counts, ms: Date.now() - t0, timings }, 'Upload applied');
  if (skipped.length) {
    const reasons: Record<string, number> = {};
    for (const s of skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
    deps.log?.warn({ tenantId, uploadId, skipped: skipped.length, reasons }, 'Upload applied without rows the database would refuse');
  }
  return 'applied';
}

/** Back to needs_review so the user can retry. Also used when BullMQ has exhausted every attempt. */
export async function revertToReview(deps: ApplyDeps, job: ApplyUploadJob, failure?: ApplyFailure) {
  await deps.database.run(job.tenantId, async d => {
    const ok = await d.uploads.transition(job.uploadId, ['applying'], { status: 'needs_review', step: 'review', progress: 100, errorMessage: RETRY_MESSAGE });
    if (ok) await d.event('upload.apply_failed', null, job.uploadId, undefined, failure ? { ...failure } : undefined);
  });
}
