import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { MarketplaceId } from '../../../../packages/core/src/constants.js';
import {
  BULK_OFFER_ITEMS_MAX, bulkOfferRemoveSignature, bulkOfferRemoveTotals, bulkOfferSignature, bulkOfferTotals, planBulkOfferRemoval, planBulkOffers,
  type BulkOfferPlan, type BulkOfferProduct, type BulkOfferRemovePlan, type BulkOfferRemoveRow, type BulkOfferRow, type PlannedOffer,
} from '../../../../packages/core/src/bulk-offers.js';
import { canonical } from './bulk-pricing.js';
import { enabledMarketplaceIds, loadPricing, productInputs } from './pricing.data.js';

export type BulkOfferInput = z.infer<typeof contracts.bulkOfferPreview>;

/**
 * Plans a bulk offer from current data inside the request's transaction (preview and apply both call it; apply never
 * reuses a preview). A fixed number of queries whatever the item count: the products, their rules and offers, the
 * pricing snapshot, the enabled marketplaces and the pending price export values.
 */
export async function planOffers(data: TenantData, input: BulkOfferInput, now = new Date()) {
  const ids = [...new Set(input.items.map(i => i.productId))];
  const [found, pricing, enabled] = await Promise.all([data.products.pricingProducts(ids), loadPricing(data), enabledMarketplaceIds(data)]);
  const [inputs, exportPrices] = await Promise.all([productInputs(data, found), data.pricing.pendingExportPrices(found.map(p => p.id), enabled)]);
  const products = new Map(found.map((p): [string, BulkOfferProduct] => {
    const { input: pricingInput, offers } = inputs.get(p.id)!;
    return [p.id, {
      id: p.id, status: p.status, isBlocked: p.blockedAt !== null, pricing: pricingInput,
      offers: offers.map(o => ({ price: o.price.toNumber(), validFrom: o.validFrom, validUntil: o.validUntil })),
    }];
  }));
  const plan = planBulkOffers(input.items, products, {
    settings: pricing.snapshot, categoryRules: pricing.categoryRules, enabled,
    exportPrices: exportPrices as Map<string, MarketplaceId[]>, now,
  });
  const labels = new Map(found.map(p => [p.id, { nameEn: p.nameEn, barcode: p.barcode }]));
  return { plan, labels };
}
export type PlannedOffers = Awaited<ReturnType<typeof planOffers>>;

export const offerPreviewToken = (plan: BulkOfferPlan) => createHash('sha256').update(bulkOfferSignature(plan.sets)).digest('hex');

/** What an idempotency key is bound to: the items as sent (order kept: it names the rows), without key and token. */
export const offerRequestHash = (input: BulkOfferInput) => createHash('sha256').update(canonical({ items: input.items })).digest('hex');

const planned = (o: PlannedOffer | null) => (o ? { price: o.price, validFrom: o.validFrom?.toISOString() ?? null, validUntil: o.validUntil?.toISOString() ?? null } : null);

/** One row as preview returns it. */
export function offerRow(r: BulkOfferRow, labels: PlannedOffers['labels']) {
  return {
    ...appliedRow(r, labels),
    normalPrice: r.normalPrice, ...(r.normalPrices ? { normalPrices: r.normalPrices } : {}), lowestNormalPrice: r.lowestNormalPrice,
    currentOffer: r.currentOffer, offer: planned(r.offer),
  };
}

/** One row as apply returns (and stores) it: the preview row without the prices and offers. */
export function appliedRow(r: BulkOfferRow, labels: PlannedOffers['labels']) {
  const label = labels.get(r.productId);
  return {
    index: r.index, productId: r.productId, nameEn: label?.nameEn ?? null, barcode: label?.barcode ?? null,
    outcome: r.outcome, reason: r.reason, message: r.message, warnings: r.warnings,
  };
}

/**
 * Every row (never a sample: the panel lists each rejected row), the counts the Bulk offer table reads
 * (willChange / unchanged / rejected), the fuller totals and the token. Apply answers the same, plus its own fields.
 */
export function offersPreview({ plan, labels }: PlannedOffers) {
  const totals = bulkOfferTotals(plan);
  return {
    willChange: totals.set, unchanged: totals.unchanged, rejected: totals.rejected,
    rows: plan.rows.map(r => offerRow(r, labels)), totals, limit: BULK_OFFER_ITEMS_MAX, previewToken: offerPreviewToken(plan),
  };
}

/** The columns of each entry of the audit event's `changes` (compact arrays, product id first). */
export const OFFER_CHANGE_COLUMNS = ['productId', 'oldPrice', 'oldFrom', 'oldUntil', 'newPrice', 'newFrom', 'newUntil'] as const;
export const offerChangeEntry = (r: BulkOfferRow) => [
  r.productId, r.previous?.price ?? null, r.previous?.validFrom?.toISOString() ?? null, r.previous?.validUntil?.toISOString() ?? null,
  r.offer!.price, r.offer!.validFrom?.toISOString() ?? null, r.offer!.validUntil?.toISOString() ?? null,
];

// ───────── Bulk remove ─────────
export type BulkOfferRemoveInput = z.infer<typeof contracts.bulkOfferRemovePreview>;

/** Plans a bulk remove from current data (preview and apply both call it): products, rules, offers, pricing. */
export async function planOfferRemoval(data: TenantData, input: BulkOfferRemoveInput, now = new Date()) {
  const ids = [...new Set(input.productIds)];
  const [found, pricing] = await Promise.all([data.products.pricingProducts(ids), loadPricing(data)]);
  const inputs = await productInputs(data, found);
  const products = new Map(found.map((p): [string, BulkOfferProduct] => {
    const { input: pricingInput, offers } = inputs.get(p.id)!;
    return [p.id, { id: p.id, status: p.status, isBlocked: p.blockedAt !== null, pricing: pricingInput, offers: offers.map(o => ({ price: o.price.toNumber(), validFrom: o.validFrom, validUntil: o.validUntil })) }];
  }));
  const plan = planBulkOfferRemoval(input.productIds, products, { settings: pricing.snapshot, categoryRules: pricing.categoryRules, now });
  const labels = new Map(found.map(p => [p.id, { nameEn: p.nameEn, barcode: p.barcode }]));
  return { plan, labels };
}
export type PlannedOfferRemoval = Awaited<ReturnType<typeof planOfferRemoval>>;

export const removePreviewToken = (plan: BulkOfferRemovePlan) => createHash('sha256').update(bulkOfferRemoveSignature(plan.removes)).digest('hex');
/** Ids deduplicated and sorted: the same set of products is the same request. */
export const removeRequestHash = (input: BulkOfferRemoveInput) =>
  createHash('sha256').update(canonical({ productIds: [...new Set(input.productIds)].sort() })).digest('hex');

export function removeRow(r: BulkOfferRemoveRow, labels: PlannedOfferRemoval['labels']) {
  const label = labels.get(r.productId);
  return {
    productId: r.productId, nameEn: label?.nameEn ?? null, barcode: label?.barcode ?? null,
    outcome: r.outcome, reason: r.reason, message: r.message, currentOffer: r.currentOffer, normalPrice: r.normalPrice,
  };
}
export function removalPreview({ plan, labels }: PlannedOfferRemoval) {
  return { items: plan.rows.map(r => removeRow(r, labels)), totals: bulkOfferRemoveTotals(plan), limit: BULK_OFFER_ITEMS_MAX, previewToken: removePreviewToken(plan) };
}
export const REMOVE_CHANGE_COLUMNS = ['productId', 'oldPrice', 'oldFrom', 'oldUntil'] as const;
export const removeChangeEntry = (r: BulkOfferRemoveRow) =>
  [r.productId, r.previous!.price, r.previous!.validFrom?.toISOString() ?? null, r.previous!.validUntil?.toISOString() ?? null];
