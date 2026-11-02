import type { MarketplaceId } from './constants.js';
import { toFils, toQar } from './money.js';
import { resolveMarketplacePrice, type CategoryRuleItem, type PriceRule, type PriceSource, type PricingSettingsSnapshot, type ProductPricingInput } from './pricing.js';
import { planPriceAdoption, type AdoptSkipReason } from './price-adoption.js';

/**
 * Changing prices by hand: the inline edit of one product and (bulk-pricing) many products at once. Both write the
 * product's own price rule (product_price_rules), which outranks the category, per-marketplace and default rules and
 * therefore applies on EVERY marketplace; the marketplace named in a request is the one validated, priced and shown.
 */

/**
 * The highest price (QAR) an inline or bulk change may set. Far above any grocery price, far below DECIMAL(12,3)
 * (the rule contract's own 1e9 limit), so a slipped digit (5000 instead of 5.000) is refused instead of published.
 */
export const PRICE_CHANGE_MAX = 100_000;
export const PRICE_CHANGE_MAX_FILS = PRICE_CHANGE_MAX * 1000;

export const MARKETPLACE_LABELS: Record<MarketplaceId, string> = { talabat: 'Talabat', snoonu: 'Snoonu', rafeeq: 'Rafeeq', keeta: 'Keeta' };

export type PriceBoundIssue = 'price_not_positive' | 'price_too_high';

/**
 * Whether a price (integer fils) may be set: above 0, and (when `upper`) at most PRICE_CHANGE_MAX. Removing a rule
 * checks only the lower bound: the price it falls back to comes from the ERP and the tenant's rules, not from the user.
 */
export function priceBoundIssue(fils: number, upper = true): PriceBoundIssue | null {
  if (!(fils > 0)) return 'price_not_positive';
  if (upper && fils > PRICE_CHANGE_MAX_FILS) return 'price_too_high';
  return null;
}

export const PRICE_BOUND_MESSAGES: Record<PriceBoundIssue, string> = {
  price_not_positive: 'The new price would be 0 or less',
  price_too_high: `The new price would be above ${PRICE_CHANGE_MAX.toLocaleString('en-US')} QAR`,
};

// ───────── Price maths (integer fils; BigInt so no product can leave the safe-integer range) ─────────

/** Products one bulk change may touch (selected, whatever the outcome). */
export const BULK_PRICE_LIMIT = 5_000;
/** Explicit ids per request: 500 UUIDs fit the API's 32 KB body limit; larger selections use a filter. */
export const BULK_PRODUCT_IDS_MAX = 500;
/** Relative changes. A decrease stops at 90 %, like the percent rule's -90 floor. */
export const BULK_PERCENT_INCREASE_MAX = 1000;
export const BULK_PERCENT_DECREASE_MAX = 90;

/** Rounding of a computed price: none keeps whole fils (0.001 QAR); otherwise the nearest step, halves up. */
export const BULK_ROUNDINGS = ['none', '0.05', '0.25'] as const;
export type BulkRounding = (typeof BULK_ROUNDINGS)[number];
const STEP_FILS: Record<BulkRounding, bigint> = { none: 1n, '0.05': 50n, '0.25': 250n };

/** num / den rounded to the nearest integer, halves away from zero; den > 0. Exact for any integers. */
export function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('den must be positive');
  if (num < 0n) return -divRoundHalfUp(-num, den);
  return (num * 2n + den) / (den * 2n);
}

const fils = (qar: number) => BigInt(toFils(qar));
/** A percent the contract allows (at most 3 decimals) as an exact integer of thousandths of a percent. */
const thousandths = (v: number) => BigInt(Math.round(v * 1000));

/** A price (QAR) rounded to the step, in integer fils. */
export function roundToStep(price: number, rounding: BulkRounding): number {
  const step = STEP_FILS[rounding];
  return toQar(Number(divRoundHalfUp(fils(price), step) * step));
}

/**
 * price x (100 +/- percent) / 100, rounded ONCE to the step (one exact division, no intermediate rounding), so
 * 4.40 + 5 % is 4.62 (none), 4.60 (0.05) or 4.50 (0.25), and 5.50 + 15 % is exactly 6.325.
 */
export function changeByPercent(price: number, percent: number, direction: 'increase' | 'decrease', rounding: BulkRounding): number {
  const p = thousandths(percent);
  const factor = 100_000n + (direction === 'increase' ? p : -p);
  const step = STEP_FILS[rounding];
  return toQar(Number(divRoundHalfUp(fils(price) * factor, 100_000n * step) * step));
}

/** price +/- amount, rounded to the step; may be 0 or negative (the caller refuses it). */
export function changeByAmount(price: number, amount: number, direction: 'increase' | 'decrease', rounding: BulkRounding): number {
  const raw = fils(price) + (direction === 'increase' ? fils(amount) : -fils(amount));
  const step = STEP_FILS[rounding];
  return toQar(Number(divRoundHalfUp(raw, step) * step));
}

// ───────── Bulk plan ─────────

export type BulkPriceAction =
  | { type: 'set_fixed'; price: number }
  | { type: 'increase_percent' | 'decrease_percent'; percent: number; rounding: BulkRounding }
  | { type: 'increase_amount' | 'decrease_amount'; amount: number; rounding: BulkRounding }
  /** The marketplace's current listing price as a fixed product rule (price adoption, replacing any rule). */
  | { type: 'match_marketplace' }
  /** Remove the product rule: the price follows the ERP price through the category, marketplace and default rules. */
  | { type: 'match_erp' };
export type BulkPriceActionType = BulkPriceAction['type'];

/** Why a selected product cannot take the change, in the order they are checked. */
export const BULK_BLOCK_REASONS = [
  'not_found', 'not_active', 'offer_active', 'no_listing', 'non_positive_listing_price', 'non_positive_erp_price',
  'price_not_positive', 'price_too_high', 'unverifiable',
] as const;
export type BulkBlockReason = (typeof BULK_BLOCK_REASONS)[number];

/** The plain reason a screen shows next to a blocked count. */
export function bulkBlockMessage(reason: BulkBlockReason, marketplaceId: MarketplaceId): string {
  const m = MARKETPLACE_LABELS[marketplaceId];
  switch (reason) {
    case 'not_found': return 'Not found in this store';
    case 'not_active': return 'Not active (only active products can be priced)';
    case 'offer_active': return 'A current offer sets the price; change or remove the offer first';
    case 'no_listing': return `Not listed on ${m}`;
    case 'non_positive_listing_price': return `Listed on ${m} at 0`;
    case 'non_positive_erp_price': return 'ERP price is 0';
    case 'unverifiable': return `The pricing rules cannot reach the ${m} price`;
    default: return PRICE_BOUND_MESSAGES[reason];
  }
}

export interface BulkPriceProduct {
  id: string;
  status: string;
  pricing: ProductPricingInput;
}

export interface BulkPriceContext {
  /** The marketplace the change is priced, compared and (match_marketplace) matched on. */
  marketplaceId: MarketplaceId;
  /** The tenant's other enabled marketplaces: how many changed products move there too (a product rule applies to all). */
  otherMarketplaces: readonly MarketplaceId[];
  pricing: { snapshot: PricingSettingsSnapshot; categoryRules: CategoryRuleItem[] };
  /** One latest listing per product, keyed `${marketplaceId}:${productId}` (match_marketplace only). */
  listings: ReadonlyMap<string, { price: number }>;
  now: Date;
}

export interface BulkPriceChange {
  productId: string;
  previousRule: PriceRule | null;
  /** The product rule to store; null = remove it (match_erp). */
  rule: PriceRule | null;
  /** The resolved price on the context marketplace, before and after. */
  oldPrice: number;
  oldSource: PriceSource;
  newPrice: number;
  newSource: PriceSource;
}

export interface BulkPricePlan {
  changes: BulkPriceChange[];
  unchanged: number;
  blocked: Record<BulkBlockReason, number>;
  /** Changed products whose price also moves on another enabled marketplace. */
  otherMarketplaces: Partial<Record<MarketplaceId, number>>;
}

const sameRule = (a: PriceRule, b: PriceRule) => a.mode === b.mode && toFils(a.value) === toFils(b.value);
const ADOPT_BLOCKS: Partial<Record<AdoptSkipReason, BulkBlockReason>> = {
  no_listing: 'no_listing', non_positive_erp_price: 'non_positive_erp_price', non_positive_listing_price: 'non_positive_listing_price',
  offer_active: 'offer_active', unverifiable: 'unverifiable',
};

/**
 * What a bulk change does to each selected product, in input order; pure (the caller loads the inputs and writes the
 * changes). `notFound` counts requested ids that are not products of this store. A product is, in this order:
 *   blocked   - not active; an offer decides its price now (a product rule would not show); the new price is not above
 *               0 or (when a price is set) above PRICE_CHANGE_MAX; match_marketplace: adoption's own skips;
 *   unchanged - it already has exactly the new rule (match_erp: it has no rule), or a percent/amount change that the
 *               rounding cancels out (same price): nothing is written;
 *   a change  - otherwise.
 * Percent and amount changes start from the resolved price on the context marketplace and store a FIXED rule.
 */
export function planBulkPriceChange(products: readonly BulkPriceProduct[], notFound: number, action: BulkPriceAction, ctx: BulkPriceContext): BulkPricePlan {
  const blocked = Object.fromEntries(BULK_BLOCK_REASONS.map(r => [r, 0])) as Record<BulkBlockReason, number>;
  blocked.not_found = notFound;
  const changes: BulkPriceChange[] = [];
  let unchanged = 0;
  const { snapshot, categoryRules } = ctx.pricing;
  const resolveOn = (input: ProductPricingInput, marketplace: MarketplaceId) =>
    resolveMarketplacePrice(input, snapshot, categoryRules, { marketplace, now: ctx.now });
  const active: BulkPriceProduct[] = [];
  for (const p of products) {
    if (p.status === 'active') active.push(p);
    else blocked.not_active++;
  }

  if (action.type === 'match_marketplace') {
    // Adoption's planner, fixed mode, replacing any rule: the same skips and the same engine verification.
    const adoption = planPriceAdoption(active, ctx.listings, ctx.pricing, {
      source: ctx.marketplaceId, mode: 'fixed', onlyWithoutRule: false, priceTolerance: 0, now: ctx.now,
    });
    for (const [reason, n] of Object.entries(adoption.skipped) as [AdoptSkipReason, number][]) {
      const block = ADOPT_BLOCKS[reason];
      if (block) blocked[block] += n;
      else unchanged += n; // 'unchanged'; has_rule and has_offer only occur with onlyWithoutRule
    }
    for (const r of adoption.adopt) {
      const issue = priceBoundIssue(toFils(r.listingPrice));
      if (issue) { blocked[issue]++; continue; }
      changes.push({
        productId: r.productId, previousRule: r.previousRule, rule: r.rule,
        oldPrice: r.currentPrice, oldSource: r.currentSource, newPrice: r.listingPrice, newSource: 'product',
      });
    }
  } else {
    for (const p of active) {
      const before = resolveOn(p.pricing, ctx.marketplaceId);
      if (before.source === 'offer') { blocked.offer_active++; continue; }
      const previousRule = p.pricing.productRule ?? null;
      let rule: PriceRule | null;
      switch (action.type) {
        case 'set_fixed': rule = { mode: 'fixed', value: toQar(toFils(action.price)) }; break;
        case 'increase_percent': case 'decrease_percent':
          rule = { mode: 'fixed', value: changeByPercent(before.price, action.percent, action.type === 'increase_percent' ? 'increase' : 'decrease', action.rounding) };
          break;
        case 'increase_amount': case 'decrease_amount':
          rule = { mode: 'fixed', value: changeByAmount(before.price, action.amount, action.type === 'increase_amount' ? 'increase' : 'decrease', action.rounding) };
          break;
        case 'match_erp': rule = null; break;
      }
      if (rule === null ? previousRule === null : previousRule !== null && sameRule(previousRule, rule)) { unchanged++; continue; }
      const after = resolveOn({ ...p.pricing, productRule: rule }, ctx.marketplaceId);
      const issue = priceBoundIssue(toFils(after.price), rule !== null);
      if (issue) { blocked[issue]++; continue; }
      const relative = action.type !== 'set_fixed' && action.type !== 'match_erp';
      if (relative && toFils(after.price) === toFils(before.price)) { unchanged++; continue; }
      changes.push({ productId: p.id, previousRule, rule, oldPrice: before.price, oldSource: before.source, newPrice: after.price, newSource: after.source });
    }
  }

  const otherMarketplaces: Partial<Record<MarketplaceId, number>> = {};
  if (ctx.otherMarketplaces.length && changes.length) {
    const byId = new Map(active.map(p => [p.id, p.pricing]));
    for (const c of changes) {
      const input = byId.get(c.productId)!;
      for (const m of ctx.otherMarketplaces) {
        if (toFils(resolveOn(input, m).price) !== toFils(resolveOn({ ...input, productRule: c.rule }, m).price)) {
          otherMarketplaces[m] = (otherMarketplaces[m] ?? 0) + 1;
        }
      }
    }
  }
  return { changes, unchanged, blocked, otherMarketplaces };
}

/** The change that raises the price most and the one that lowers it most (by fils; ties: the first). */
export function largestPriceMoves(changes: readonly BulkPriceChange[]) {
  let increase: BulkPriceChange | null = null;
  let decrease: BulkPriceChange | null = null;
  let up = 0, down = 0;
  for (const c of changes) {
    const d = toFils(c.newPrice) - toFils(c.oldPrice);
    if (d > up) { up = d; increase = c; }
    if (d < down) { down = d; decrease = c; }
  }
  return { increase, decrease };
}

const ruleKey = (r: PriceRule | null) => (r ? `${r.mode}:${toFils(r.value)}` : '-');
/**
 * The write set as one canonical string (sorted by product): what the API hashes into the preview token, so an apply
 * whose re-planned writes differ from the previewed ones is refused instead of applied.
 */
export function bulkPlanSignature(changes: readonly BulkPriceChange[]): string {
  return changes
    .map(c => `${c.productId}|${ruleKey(c.previousRule)}|${ruleKey(c.rule)}|${toFils(c.newPrice)}`)
    .sort()
    .join('\n');
}
