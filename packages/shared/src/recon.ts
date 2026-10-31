import { Queue, type ConnectionOptions } from 'bullmq';
import { JOB_DEFAULTS } from './queue.js';

/** Why the reconciliation must be recomputed; every change that can move a marketplace price or availability names one. */
export type ReconReason =
  | 'pricing.settings'
  | 'pricing.category_rule'
  | 'product.price_rule'
  | 'product.offer'
  | 'product.category'
  | 'product.status'
  | 'product.activated'
  | 'upload.applied'
  | 'manual'
  | 'sweep';

/** Called after a change has committed: asks for one (coalesced, per-tenant) recompute of the recon rows and summaries. */
export interface ReconQueue {
  enqueueRecon(tenantId: string, reason: ReconReason): Promise<void>;
}

export const RECON_QUEUE_NAME = 'recon';
export const RECON_JOB_NAME = 'recompute-recon';
export interface ReconJob { tenantId: string; reason: ReconReason }

/** Deterministic per tenant: every trigger for a tenant shares it, so many triggers collapse into one run. */
export const reconJobKey = (tenantId: string) => `recon-${tenantId}`;
/** Triggers within this window share one run (an upload apply followed by a price edit, a bulk activation...). */
export const RECON_DEBOUNCE_MS = 2_000;

/**
 * BullMQ deduplication keyed by reconJobKey, not a fixed job ID: while a run waits, new triggers are dropped (it will
 * see their changes); while a run is active, `keepLastIfActive` keeps exactly one follow-up run, because the active
 * run may have read the data before the change. A fixed job ID would drop that follow-up and keep stale results.
 */
export class BullReconQueue implements ReconQueue {
  private readonly queue: Queue<ReconJob>;
  constructor(connection: ConnectionOptions) {
    this.queue = new Queue<ReconJob>(RECON_QUEUE_NAME, { connection, defaultJobOptions: JOB_DEFAULTS });
  }
  async enqueueRecon(tenantId: string, reason: ReconReason) {
    await this.queue.add(RECON_JOB_NAME, { tenantId, reason }, {
      delay: RECON_DEBOUNCE_MS,
      deduplication: { id: reconJobKey(tenantId), keepLastIfActive: true },
    });
  }
  async close() { await this.queue.close(); }
}

/**
 * Test double with BullReconQueue's coalescing: per tenant at most one run active and one waiting; triggers while one
 * waits are absorbed. `drain()` resolves when no run is active or waiting.
 */
export class InlineReconQueue implements ReconQueue {
  readonly calls: { tenantId: string; reason: ReconReason }[] = [];
  runs = 0;
  handler?: (job: ReconJob) => Promise<unknown>;
  private readonly active = new Map<string, Promise<void>>();
  private readonly waiting = new Set<string>();
  /** Like RECON_DEBOUNCE_MS: a run starts after a timer, so triggers awaited one after another share it. */
  constructor(private readonly delayMs = 5) {}
  async enqueueRecon(tenantId: string, reason: ReconReason) {
    this.calls.push({ tenantId, reason });
    if (this.waiting.has(tenantId)) return;
    this.waiting.add(tenantId);
    const before = this.active.get(tenantId) ?? Promise.resolve();
    const run = before.then(() => new Promise(r => setTimeout(r, this.delayMs))).then(async () => {
      this.waiting.delete(tenantId);
      this.runs++;
      await this.handler?.({ tenantId, reason });
    });
    const settled = run.catch(() => undefined);
    this.active.set(tenantId, settled);
    void settled.then(() => { if (this.active.get(tenantId) === settled) this.active.delete(tenantId); });
  }
  async drain() {
    while (this.active.size) await Promise.all([...this.active.values()]);
  }
}
