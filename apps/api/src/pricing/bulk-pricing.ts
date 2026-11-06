import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { MarketplaceId } from '../../../../packages/core/src/constants.js';
import { toFils, toQar } from '../../../../packages/core/src/money.js';
import type { PriceRule } from '../../../../packages/core/src/pricing.js';
import {
  BULK_BLOCK_REASONS, BULK_PRICE_LIMIT, MARKETPLACE_LABELS,
  bulkBlockMessage, bulkPlanSignature, largestPriceMoves, planBulkPriceChange,
  type BulkPriceChange, type BulkPricePlan,
} from '../../../../packages/core/src/price-change.js';
import { searchFilter } from '../products/products.service.js';
import { enabledMarketplaceIds, loadPricing, productInputs, ruleView } from './pricing.data.js';

export type BulkInput = z.infer<typeof contracts.bulkPricePreview>;
export const BULK_PREVIEW_ROWS = 10;

const invalid = (path: string, message: string) => new BadRequestException({ message: 'Validation failed', details: [{ path, message }] });
const count = (n: number) => n.toLocaleString('en-US');

/**
 * The selected products: explicit ids (any status; the planner blocks the inactive ones, absent ids count as
 * not_found), or every active product matching the filter, in list order. More than BULK_PRICE_LIMIT is refused.
 */
async function select(data: TenantData, input: BulkInput, compareReferenceDefault: string | undefined) {
  const { selection, marketplaceId } = input;
  if ('productIds' in selection) {
    const ids = [...new Set(selection.productIds)];
    const products = await data.products.pricingProducts(ids);
    return { products, selected: ids.length, notFound: ids.length - products.length, reference: null };
  }
  const f = selection.filter;
  const reference = f.reconStatus ? f.reference ?? (compareReferenceDefault === 'erp' ? 'erp' as const : 'marketplace' as const) : null;
  const where = {
    ...searchFilter({ q: f.q, categoryId: f.categoryId, subcategoryId: f.subcategoryId }), marketplaceId, listed: f.listed,
    ...(f.reconStatus ? { recon: { status: f.reconStatus, reference: reference! } } : {}),
  };
  const products = await data.products.pricingSelection(where, BULK_PRICE_LIMIT + 1);
  const selected = products.length > BULK_PRICE_LIMIT ? await data.products.pricingSelectionCount(where) : products.length;
  return { products, selected, notFound: 0, reference };
}

/**
 * Plans a bulk change from the current data, inside the request's transaction: preview and apply both call it, and
 * apply never reuses a preview's answer. The marketplace must be enabled for the store.
 */
export async function planBulk(data: TenantData, input: BulkInput, now = new Date()) {
  const { marketplaceId, action } = input;
  const enabled = await enabledMarketplaceIds(data);
  if (!enabled.includes(marketplaceId)) throw invalid('marketplaceId', `${MARKETPLACE_LABELS[marketplaceId]} is not enabled for this store`);
  const pricing = await loadPricing(data);
  const { products, selected, notFound, reference } = await select(data, input, pricing.settings?.compareReferenceDefault);
  if (selected > BULK_PRICE_LIMIT) {
    throw invalid('selection', `This selection has ${count(selected)} products; one change can price at most ${count(BULK_PRICE_LIMIT)}. Narrow the filter.`);
  }
  const [inputs, listings] = await Promise.all([
    productInputs(data, products),
    action.type === 'match_marketplace' ? data.recon.listings([marketplaceId]) : Promise.resolve(new Map<string, { price: number }>()),
  ]);
  const plan = planBulkPriceChange(
    products.map(p => ({ id: p.id, status: p.status, pricing: inputs.get(p.id)!.input })), notFound, action,
    { marketplaceId, otherMarketplaces: enabled.filter(m => m !== marketplaceId), pricing, listings, now },
  );
  const labels = new Map(products.map(p => [p.id, { nameEn: p.nameEn, barcode: p.barcode }]));
  return { plan, selected, reference, labels };
}
export type PlannedBulk = Awaited<ReturnType<typeof planBulk>>;

/** sha256 of the planned writes (core bulkPlanSignature): the preview hands it out, apply compares it. */
export const previewToken = (plan: BulkPricePlan) => createHash('sha256').update(bulkPlanSignature(plan.changes)).digest('hex');

/** JSON with sorted keys, so the same request always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
/** What an idempotency key is bound to: the request without the key and token, ids deduplicated and sorted. */
export function requestHash(input: BulkInput) {
  const selection = 'productIds' in input.selection ? { productIds: [...new Set(input.selection.productIds)].sort() } : input.selection;
  return createHash('sha256').update(canonical({ ...input, selection })).digest('hex');
}

const rule = (r: PriceRule | null) => (r ? ruleView(r.mode, r.value) : null);

/** The counts preview and apply both report; selected = willChange + unchanged + blocked. */
export function bulkCounts(planned: PlannedBulk, marketplaceId: MarketplaceId) {
  const { plan, selected } = planned;
  const blocked = BULK_BLOCK_REASONS.filter(r => plan.blocked[r] > 0).map(reason => ({ reason, message: bulkBlockMessage(reason, marketplaceId), count: plan.blocked[reason] }));
  return {
    selected, willChange: plan.changes.length, unchanged: plan.unchanged, blocked: blocked.reduce((n, b) => n + b.count, 0),
    blockedReasons: blocked,
    otherMarketplaces: Object.entries(plan.otherMarketplaces).map(([m, products]) => ({ marketplaceId: m, products })),
  };
}

/** Counts, the largest increase and decrease, the first rows with names and barcodes, and the token; reads only. */
export function bulkPreview(input: BulkInput, planned: PlannedBulk) {
  const { plan, labels, reference } = planned;
  const row = (c: BulkPriceChange) => ({
    productId: c.productId, ...(labels.get(c.productId) ?? { nameEn: '', barcode: '' }), marketplaceId: input.marketplaceId,
    oldPrice: c.oldPrice, oldSource: c.oldSource, newPrice: c.newPrice, newSource: c.newSource,
    difference: toQar(toFils(c.newPrice) - toFils(c.oldPrice)), previousRule: rule(c.previousRule), rule: rule(c.rule),
  });
  const { increase, decrease } = largestPriceMoves(plan.changes);
  return {
    marketplaceId: input.marketplaceId, action: input.action, selection: input.selection, ...(reference ? { reference } : {}),
    limit: BULK_PRICE_LIMIT,
    ...bulkCounts(planned, input.marketplaceId),
    largestIncrease: increase ? row(increase) : null,
    largestDecrease: decrease ? row(decrease) : null,
    rows: plan.changes.slice(0, BULK_PREVIEW_ROWS).map(row),
    previewToken: previewToken(plan),
  };
}

/** The columns of each entry of the audit event's `changes` (compact arrays, up to BULK_PRICE_LIMIT of them). */
export const BULK_CHANGE_COLUMNS = ['productId', 'oldMode', 'oldValue', 'newMode', 'newValue', 'oldPrice', 'newPrice'] as const;
export const changeEntry = (c: BulkPriceChange) =>
  [c.productId, c.previousRule?.mode ?? null, c.previousRule?.value ?? null, c.rule?.mode ?? null, c.rule?.value ?? null, c.oldPrice, c.newPrice];
