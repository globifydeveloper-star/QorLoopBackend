import type { MarketplaceId } from './constants.js';
import { toFils, toQar } from './money.js';
import { MARKETPLACE_LABELS, PRICE_CHANGE_MAX } from './price-change.js';
import { PRODUCT_BLOCKED_MESSAGE } from './products/blocking.js';
import {
  offerState, resolveMarketplacePrice,
  type CategoryRuleItem, type OfferInput, type PricingSettingsSnapshot, type ProductPricingInput,
} from './pricing.js';

/**
 * Bulk offers (offers v1, step 5): the in-app Bulk offer table sends one row per product with its own price and dates.
 * Every row is judged on its own; a rejected row is reported and never written, the valid rows are written together.
 * Dates are instants. The UI turns a Qatar calendar day D into D 00:00:00.000+03:00 (start) and an end day E into
 * E 23:59:59.999+03:00 (the whole end day, inclusive); the API accepts any ISO instant with an offset.
 */
export const BULK_OFFER_ITEMS_MAX = 500;
/** The highest offer price a bulk row accepts (the bulk price change cap). */
export const OFFER_PRICE_MAX = PRICE_CHANGE_MAX;

/** Rejection reasons in the order they are checked: the first one that applies is the row's reason. */
export const BULK_OFFER_REJECT_REASONS = [
  'duplicate_row', 'not_found', 'product_blocked', 'product_not_active', 'invalid_price', 'end_required', 'end_before_start', 'already_ended', 'price_not_below_normal',
] as const;
export type BulkOfferRejectReason = (typeof BULK_OFFER_REJECT_REASONS)[number];
export const BULK_OFFER_WARNINGS = ['replaces_offer', 'export_value_outranks'] as const;
export type BulkOfferWarningCode = (typeof BULK_OFFER_WARNINGS)[number];
export const BULK_OFFER_OUTCOMES = ['set', 'unchanged', 'rejected'] as const;
export type BulkOfferOutcome = (typeof BULK_OFFER_OUTCOMES)[number];

/** The offer states the offer views show (core offerState's valid / expired, renamed for the screens). */
export const OFFER_VIEW_STATES = ['scheduled', 'active', 'ended'] as const;
export type OfferViewState = (typeof OFFER_VIEW_STATES)[number];
export function offerViewState(offer: Pick<OfferInput, 'validFrom' | 'validUntil'>, now: Date): OfferViewState {
  const s = offerState({ price: 0, ...offer }, now);
  return s === 'valid' ? 'active' : s === 'expired' ? 'ended' : 'scheduled';
}
export interface StoredOffer { price: number; validFrom: Date | null; validUntil: Date | null }
export interface OfferView { price: number; validFrom: string | null; validUntil: string | null; state: OfferViewState }
export const offerView = (o: StoredOffer, now: Date): OfferView => ({
  price: o.price, validFrom: o.validFrom?.toISOString() ?? null, validUntil: o.validUntil?.toISOString() ?? null, state: offerViewState(o, now),
});

const qar = (n: number) => `QAR ${n.toFixed(3)}`;
export function bulkOfferRejectMessage(reason: BulkOfferRejectReason, normalPrice?: number | null): string {
  switch (reason) {
    case 'duplicate_row': return 'This product is in more than one row; keep one row per product';
    case 'not_found': return 'No product with this id in this store';
    case 'product_blocked': return PRODUCT_BLOCKED_MESSAGE;
    case 'product_not_active': return 'Offers apply to active products only';
    case 'invalid_price': return `The offer price must be more than 0 and at most ${OFFER_PRICE_MAX.toLocaleString('en-US')}, with at most 3 decimals`;
    case 'end_required': return 'An offer needs an end date';
    case 'end_before_start': return 'The offer must end after it starts';
    case 'already_ended': return 'This offer would already have ended';
    case 'price_not_below_normal': return normalPrice == null
      ? 'The offer price must be below the normal price'
      : `The offer price must be below the normal price (${qar(normalPrice)})`;
  }
}

/** One row of the request, as validated for shape (any number; dates are ISO instants or absent). */
export interface BulkOfferItem { productId: string; price: number; validFrom?: string | null; validUntil?: string | null }
/** A product the request names, with what the resolver needs and its stored offers. */
export interface BulkOfferProduct {
  id: string;
  status: string;
  /** Blocked (migration 202611170001): rejected (set) or skipped (remove) as product_blocked. */
  isBlocked?: boolean;
  pricing: ProductPricingInput;
  /** The product's offers as stored (the API keeps one; legacy duplicates count as "replace"). */
  offers: StoredOffer[];
}
export interface BulkOfferContext {
  settings: PricingSettingsSnapshot;
  categoryRules: CategoryRuleItem[];
  /** The store's enabled marketplaces: the offer must be below the normal price on every one of them. */
  enabled: readonly MarketplaceId[];
  /** Products with a pending (or pinned) price export value, per marketplace: it outranks the offer there (O5). */
  exportPrices: ReadonlyMap<string, readonly MarketplaceId[]>;
  now: Date;
}

/** One warning per fact: replaces_offer once, export_value_outranks once per marketplace whose export price wins. */
export type BulkOfferWarning =
  | { code: 'replaces_offer'; message: string; offer: OfferView }
  | { code: 'export_value_outranks'; message: string; marketplaceId: MarketplaceId };

/** The Qatar calendar day (UTC+3, no daylight saving) of an instant, as YYYY-MM-DD. */
const qatarDay = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
export const replacesOfferMessage = (o: StoredOffer) =>
  `Replaces the current offer (${qar(o.price)}${o.validUntil ? `, until ${qatarDay(o.validUntil)}` : ''})`;
export const exportValueOutranksMessage = (m: MarketplaceId) =>
  `A pending ${MARKETPLACE_LABELS[m]} export price stays in place and outranks the offer on ${MARKETPLACE_LABELS[m]}`;

export interface PlannedOffer { price: number; validFrom: Date | null; validUntil: Date | null }
export interface BulkOfferRow {
  index: number;
  productId: string;
  outcome: BulkOfferOutcome;
  reason: BulkOfferRejectReason | null;
  message: string | null;
  warnings: BulkOfferWarning[];
  /** The price without the offer (no per-marketplace step); null when the product was not found. */
  normalPrice: number | null;
  /** Per enabled marketplace, only when per-marketplace rules are on. */
  normalPrices?: Partial<Record<MarketplaceId, number>>;
  /** The lowest normal price across the enabled marketplaces: the offer must be below it. */
  lowestNormalPrice: number | null;
  currentOffer: OfferView | null;
  /** What is written for a set row (and what already stands for an unchanged one); null when rejected. */
  offer: PlannedOffer | null;
  /** The offer this row replaces (a set row of a product that had one). */
  previous: StoredOffer | null;
}
export interface BulkOfferPlan {
  rows: BulkOfferRow[];
  /** The writes: one per set row, in request order. */
  sets: BulkOfferRow[];
}

function validPrice(p: number) {
  return Number.isFinite(p) && p > 0 && p <= OFFER_PRICE_MAX && Math.abs(p * 1000 - Math.round(p * 1000)) < 1e-6;
}
const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
const parse = (v: string | null | undefined) => (v ? new Date(v) : null);

/** The normal price (no offer), per enabled marketplace, and the lowest of them. */
export function normalPrices(product: ProductPricingInput, ctx: Pick<BulkOfferContext, 'settings' | 'categoryRules' | 'enabled' | 'now'>): {
  normalPrice: number; lowest: number; byMarketplace?: Partial<Record<MarketplaceId, number>>;
} {
  const input = { ...product, offers: [] };
  const plain = resolveMarketplacePrice(input, ctx.settings, ctx.categoryRules, { now: ctx.now }).price;
  const per = ctx.enabled.map(m => [m, resolveMarketplacePrice(input, ctx.settings, ctx.categoryRules, { marketplace: m, now: ctx.now }).price] as const);
  const lowest = per.length ? Math.min(...per.map(([, p]) => p)) : plain;
  return { normalPrice: plain, lowest, ...(ctx.settings.perMarketplaceEnabled ? { byMarketplace: Object.fromEntries(per) as Partial<Record<MarketplaceId, number>> } : {}) };
}

/**
 * Plans a bulk offer from current data: pure, so preview and apply (which plans again inside its transaction) agree.
 * Rows are checked in BULK_OFFER_REJECT_REASONS order; a row that passes is unchanged when the product's single offer
 * has the same price and the same dates to the millisecond, otherwise set (with replaces_offer when it had one).
 */
export function planBulkOffers(items: readonly BulkOfferItem[], products: ReadonlyMap<string, BulkOfferProduct>, ctx: BulkOfferContext): BulkOfferPlan {
  const seen = new Map<string, number>();
  for (const it of items) seen.set(it.productId, (seen.get(it.productId) ?? 0) + 1);
  const rows = items.map((it, index): BulkOfferRow => {
    const product = products.get(it.productId);
    const prices = product ? normalPrices(product.pricing, ctx) : null;
    const stored = product?.offers ?? [];
    const latest = stored.at(-1) ?? null;
    const base = {
      index, productId: it.productId, warnings: [] as BulkOfferWarning[],
      normalPrice: prices?.normalPrice ?? null, ...(prices?.byMarketplace ? { normalPrices: prices.byMarketplace } : {}),
      lowestNormalPrice: prices?.lowest ?? null, currentOffer: latest ? offerView(latest, ctx.now) : null,
    };
    const reject = (reason: BulkOfferRejectReason): BulkOfferRow =>
      ({ ...base, outcome: 'rejected', reason, message: bulkOfferRejectMessage(reason, prices?.lowest), offer: null, previous: null });
    const validFrom = parse(it.validFrom);
    const validUntil = parse(it.validUntil);
    if (seen.get(it.productId)! > 1) return reject('duplicate_row');
    if (!product) return reject('not_found');
    if (product.isBlocked) return reject('product_blocked');
    if (product.status !== 'active') return reject('product_not_active');
    if (!validPrice(it.price)) return reject('invalid_price');
    if (!validUntil) return reject('end_required');
    if (validFrom && validUntil.getTime() <= validFrom.getTime()) return reject('end_before_start');
    if (validUntil.getTime() < ctx.now.getTime()) return reject('already_ended');
    if (toFils(it.price) >= toFils(prices!.lowest)) return reject('price_not_below_normal');
    const offer: PlannedOffer = { price: toQar(toFils(it.price)), validFrom, validUntil };
    const unchanged = stored.length === 1 && toFils(latest!.price) === toFils(offer.price)
      && sameTime(latest!.validFrom, validFrom) && sameTime(latest!.validUntil, validUntil);
    if (unchanged) return { ...base, outcome: 'unchanged', reason: null, message: null, offer, previous: null };
    if (latest) base.warnings.push({ code: 'replaces_offer', message: replacesOfferMessage(latest), offer: offerView(latest, ctx.now) });
    for (const m of ctx.exportPrices.get(it.productId)?.filter(m => ctx.enabled.includes(m)) ?? []) {
      base.warnings.push({ code: 'export_value_outranks', message: exportValueOutranksMessage(m), marketplaceId: m });
    }
    return { ...base, outcome: 'set', reason: null, message: null, offer, previous: latest };
  });
  return { rows, sets: rows.filter(r => r.outcome === 'set') };
}

/** Totals of a plan; items = set + unchanged + rejected. */
export function bulkOfferTotals(plan: BulkOfferPlan) {
  const count = (o: BulkOfferOutcome) => plan.rows.filter(r => r.outcome === o).length;
  const warning = (code: BulkOfferWarningCode) => plan.rows.filter(r => r.warnings.some(w => w.code === code)).length;
  const rejectedReasons = BULK_OFFER_REJECT_REASONS.map(reason => ({ reason, count: plan.rows.filter(r => r.reason === reason).length }))
    .filter(r => r.count > 0)
    .map(r => ({ ...r, message: bulkOfferRejectMessage(r.reason) }));
  return {
    items: plan.rows.length, set: count('set'), unchanged: count('unchanged'), rejected: count('rejected'),
    warnings: { replaces_offer: warning('replaces_offer'), export_value_outranks: warning('export_value_outranks') },
    rejectedReasons,
  };
}

/** What the preview token hashes: the planned writes, sorted, in fils and milliseconds. */
export function bulkOfferSignature(sets: readonly BulkOfferRow[]): string {
  return sets.map(r => `${r.productId}|${toFils(r.offer!.price)}|${r.offer!.validFrom?.getTime() ?? ''}|${r.offer!.validUntil?.getTime() ?? ''}`)
    .sort().join('\n');
}

// ───────── Bulk remove: the ticked products lose their offer (any state) ─────────
export const BULK_OFFER_REMOVE_SKIP_REASONS = ['not_found', 'product_blocked', 'no_offer'] as const;
export type BulkOfferRemoveSkipReason = (typeof BULK_OFFER_REMOVE_SKIP_REASONS)[number];
export const bulkOfferRemoveSkipMessage = (reason: BulkOfferRemoveSkipReason) =>
  reason === 'not_found' ? 'No product with this id in this store' : reason === 'product_blocked' ? PRODUCT_BLOCKED_MESSAGE : 'This product has no offer';

export interface BulkOfferRemoveRow {
  productId: string;
  outcome: 'remove' | 'skipped';
  reason: BulkOfferRemoveSkipReason | null;
  message: string | null;
  /** The offer that is removed (the last one when legacy duplicates exist; all of them are removed). */
  currentOffer: OfferView | null;
  previous: StoredOffer | null;
  /** The price without the offer, i.e. the price after removal (no per-marketplace step); null when not found. */
  normalPrice: number | null;
}
export interface BulkOfferRemovePlan { rows: BulkOfferRemoveRow[]; removes: BulkOfferRemoveRow[] }

/**
 * Plans a bulk remove: ids are deduplicated (first occurrence kept). A product of any status loses its offer, whatever
 * the offer's state (scheduled, active or ended); a product without one, or not in this store, is skipped.
 */
export function planBulkOfferRemoval(productIds: readonly string[], products: ReadonlyMap<string, BulkOfferProduct>, ctx: Pick<BulkOfferContext, 'settings' | 'categoryRules' | 'now'>): BulkOfferRemovePlan {
  const rows = [...new Set(productIds)].map((productId): BulkOfferRemoveRow => {
    const product = products.get(productId);
    if (!product) return { productId, outcome: 'skipped', reason: 'not_found', message: bulkOfferRemoveSkipMessage('not_found'), currentOffer: null, previous: null, normalPrice: null };
    if (product.isBlocked) return { productId, outcome: 'skipped', reason: 'product_blocked', message: bulkOfferRemoveSkipMessage('product_blocked'), currentOffer: null, previous: null, normalPrice: null };
    const normalPrice = resolveMarketplacePrice({ ...product.pricing, offers: [] }, ctx.settings, ctx.categoryRules, { now: ctx.now }).price;
    const latest = product.offers.at(-1) ?? null;
    if (!latest) return { productId, outcome: 'skipped', reason: 'no_offer', message: bulkOfferRemoveSkipMessage('no_offer'), currentOffer: null, previous: null, normalPrice };
    return { productId, outcome: 'remove', reason: null, message: null, currentOffer: offerView(latest, ctx.now), previous: latest, normalPrice };
  });
  return { rows, removes: rows.filter(r => r.outcome === 'remove') };
}

export function bulkOfferRemoveTotals(plan: BulkOfferRemovePlan) {
  const skippedReasons = BULK_OFFER_REMOVE_SKIP_REASONS.map(reason => ({ reason, count: plan.rows.filter(r => r.reason === reason).length, message: bulkOfferRemoveSkipMessage(reason) }))
    .filter(r => r.count > 0);
  return { products: plan.rows.length, remove: plan.removes.length, skipped: plan.rows.length - plan.removes.length, skippedReasons };
}

/** The preview token of a remove hashes the offers that will be removed, so an offer changed since the preview is a 409. */
export function bulkOfferRemoveSignature(removes: readonly BulkOfferRemoveRow[]): string {
  return removes.map(r => `${r.productId}|${toFils(r.previous!.price)}|${r.previous!.validFrom?.getTime() ?? ''}|${r.previous!.validUntil?.getTime() ?? ''}`)
    .sort().join('\n');
}
