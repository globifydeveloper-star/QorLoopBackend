/** Why the reconciliation must be recomputed; every change that can move a marketplace price names one. */
export type ReconReason =
  | 'pricing.settings'
  | 'pricing.category_rule'
  | 'product.price_rule'
  | 'product.offer'
  | 'product.category';

/**
 * Called after a price-related change has committed. R1 replaces the no-op with a real (debounced,
 * per-tenant) recompute job; callers already call it in the right places.
 */
export interface ReconQueue {
  enqueueRecon(tenantId: string, reason: ReconReason): Promise<void>;
}

export class NoopReconQueue implements ReconQueue {
  async enqueueRecon() { /* R1 */ }
}

/** Test double: records every call. */
export class RecordingReconQueue implements ReconQueue {
  readonly calls: { tenantId: string; reason: ReconReason }[] = [];
  async enqueueRecon(tenantId: string, reason: ReconReason) { this.calls.push({ tenantId, reason }); }
}
