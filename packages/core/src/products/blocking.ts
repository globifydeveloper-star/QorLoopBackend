/**
 * Blocked products (old or seasonal): ignored by every check and change. Blocking is separate from the product's
 * status (new / active / inactive), so unblocking restores the product exactly as it was, except for the offers the
 * block ended: those stay ended.
 *
 * Names: the API calls a product's flag `isBlocked` (with `blockedAt`, `blockedReason`), to stay clear of the existing
 * "blocked" meanings (Marketplace values field state, bulk price `blocked` counts), which are not renamed.
 */
export const PRODUCT_BLOCK_REASONS = ['old', 'seasonal', 'other'] as const;
export type ProductBlockReason = (typeof PRODUCT_BLOCK_REASONS)[number];
export const PRODUCT_BLOCK_REASON_LABELS: Record<ProductBlockReason, string> = { old: 'Old product', seasonal: 'Seasonal', other: 'Other' };

/** How a product list or count treats blocked products: exclude (default), only, or include. */
export const BLOCKED_FILTERS = ['exclude', 'only', 'include'] as const;
export type BlockedFilter = (typeof BLOCKED_FILTERS)[number];

/** At most this many ids per block / unblock request. */
export const PRODUCT_BLOCK_IDS_MAX = 500;
/** A filter selection matching more products than this is refused (narrow the filter). */
export const PRODUCT_BLOCK_FILTER_MAX = 10_000;

/** The skip / reject reason bulk price and bulk offers report for a blocked product (totals still add up). */
export const PRODUCT_BLOCKED_REASON = 'product_blocked' as const;
export const PRODUCT_BLOCKED_MESSAGE = 'This product is blocked; unblock it first';

/** What the API and UI say on unblock: the offers the block ended do not come back. */
export const ENDED_OFFERS_NOT_RESTORED = 'Offers that were ended when the product was blocked are not restored; set a new offer if needed';
/** What the block preview says next to the offer count. */
export const OFFERS_END_ON_BLOCK = 'Active offers on these products end now; unblocking does not bring them back';

export interface BlockCandidate { id: string; isBlocked: boolean }

/** Which selected products a block changes: the not yet blocked ones; ids not in this store count as notFound. */
export function planBlock(selected: readonly BlockCandidate[], requested: number) {
  const toBlock = selected.filter(p => !p.isBlocked).map(p => p.id);
  return { toBlock, alreadyBlocked: selected.length - toBlock.length, notFound: requested - selected.length };
}

/** Which selected products an unblock changes: the blocked ones. */
export function planUnblock(selected: readonly BlockCandidate[], requested: number) {
  const toUnblock = selected.filter(p => p.isBlocked).map(p => p.id);
  return { toUnblock, notBlocked: selected.length - toUnblock.length, notFound: requested - selected.length };
}

/** What a block preview token hashes: the products it blocks and the offers it ends, sorted. */
export function blockSignature(toBlock: readonly string[], offerIds: readonly string[], reason: ProductBlockReason): string {
  return [reason, [...toBlock].sort().join(','), [...offerIds].sort().join(',')].join('\n');
}
