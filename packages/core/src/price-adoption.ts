import { MARKETPLACES, type MarketplaceId } from './constants.js';
import { toFils, toQar } from './money.js';
import {
  offerState, resolveMarketplacePrice,
  type CategoryRuleItem, type PriceRule, type PriceSource, type PricingSettingsSnapshot, type ProductPricingInput,
} from './pricing.js';
import { priceMismatch } from './recon/status.js';

/**
 * Adopting the current marketplace prices: a product rule per product so that the resolved Marketplace price equals
 * the price the source marketplace lists today. Pure: the caller loads the same inputs as the recon (one latest
 * listing per product and marketplace) and writes the rules.
 */

export const ADOPT_MODES = ['fixed', 'percent'] as const;
export type AdoptMode = (typeof ADOPT_MODES)[number];

export const ADOPT_SKIP_REASONS = [
  'no_listing', 'non_positive_erp_price', 'non_positive_listing_price', 'has_rule', 'has_offer', 'offer_active', 'unchanged', 'unverifiable',
] as const;
export type AdoptSkipReason = (typeof ADOPT_SKIP_REASONS)[number];

/** Why a percent rule was replaced by a fixed one. */
export type AdoptFallback = 'rounding' | 'range';

/** The range the product-rule contract accepts for a percent value. */
export const ADOPT_PERCENT_MIN = -90;
export const ADOPT_PERCENT_MAX = 1000;

export interface AdoptionProduct {
  id: string;
  pricing: ProductPricingInput;
}

export interface AdoptionOptions {
  source: MarketplaceId;
  mode: AdoptMode;
  /** Skip every product that has its own rule or any offer. */
  onlyWithoutRule: boolean;
  /** Recon tolerance (QAR): another marketplace further than this from the adopted price is a conflict. */
  priceTolerance: number;
  now: Date;
}

export interface AdoptionRow {
  productId: string;
  erpPrice: number;
  listingPrice: number;
  /** The product rule to store; its resolved price equals listingPrice. */
  rule: PriceRule;
  fallback: AdoptFallback | null;
  previousRule: PriceRule | null;
  /** The resolved Marketplace price before adoption, for the source marketplace. */
  currentPrice: number;
  currentSource: PriceSource;
}

export interface AdoptionConflict {
  productId: string;
  marketplaceId: MarketplaceId;
  sourcePrice: number;
  otherPrice: number;
}

export interface AdoptionPlan {
  adopt: AdoptionRow[];
  skipped: Record<AdoptSkipReason, number>;
  fallbacks: Record<AdoptFallback, number>;
  /** Adopted products whose price on another marketplace differs from the source beyond the tolerance. */
  conflicts: { products: number; byMarketplace: Partial<Record<MarketplaceId, number>>; examples: AdoptionConflict[] };
}

export const ADOPT_CONFLICT_EXAMPLES = 20;

/** listingPrice / erpPrice - 1, in percent, from integer fils, rounded to 3 decimals (the stored precision). */
export function adoptionPercent(erpPrice: number, listingPrice: number): number {
  const erp = toFils(erpPrice);
  return Math.round((toFils(listingPrice) - erp) * 100_000 / erp) / 1000;
}

const sameRule = (a: PriceRule, b: PriceRule) => a.mode === b.mode && toFils(a.value) === toFils(b.value);

/**
 * One row per product that can be adopted, in input order. Each rule is verified with the pricing engine for the
 * source marketplace: a percent rule whose rounded price misses the listing price (the tenant rounding step cannot
 * reach it) or that falls outside the percent range becomes a fixed rule. `listings` is keyed `${marketplaceId}:${productId}`.
 */
export function planPriceAdoption(
  products: readonly AdoptionProduct[],
  listings: ReadonlyMap<string, { price: number }>,
  pricing: { snapshot: PricingSettingsSnapshot; categoryRules: CategoryRuleItem[] },
  options: AdoptionOptions,
): AdoptionPlan {
  const { source, mode, onlyWithoutRule, now } = options;
  const skipped = Object.fromEntries(ADOPT_SKIP_REASONS.map(r => [r, 0])) as Record<AdoptSkipReason, number>;
  const fallbacks: Record<AdoptFallback, number> = { rounding: 0, range: 0 };
  const conflicts: AdoptionPlan['conflicts'] = { products: 0, byMarketplace: {}, examples: [] };
  const others = MARKETPLACES.filter(m => m !== source);
  const adopt: AdoptionRow[] = [];
  const resolve = (input: ProductPricingInput) => resolveMarketplacePrice(input, pricing.snapshot, pricing.categoryRules, { marketplace: source, now });

  for (const p of products) {
    const listing = listings.get(`${source}:${p.id}`);
    const offers = p.pricing.offers ?? [];
    const previousRule = p.pricing.productRule ?? null;
    const reason: AdoptSkipReason | null =
      !listing ? 'no_listing'
        : toFils(p.pricing.erpPrice) <= 0 ? 'non_positive_erp_price'
          : toFils(listing.price) <= 0 ? 'non_positive_listing_price'
            : onlyWithoutRule && previousRule ? 'has_rule'
              : onlyWithoutRule && offers.length ? 'has_offer'
                // a valid offer outranks the product rule: no rule could set this price
                : offers.some(o => offerState(o, now) === 'valid') ? 'offer_active'
                  : null;
    if (reason) { skipped[reason]++; continue; }

    const listingPrice = toQar(toFils(listing!.price));
    const fixed: PriceRule = { mode: 'fixed', value: listingPrice };
    const verifies = (rule: PriceRule) => toFils(resolve({ ...p.pricing, productRule: rule }).price) === toFils(listingPrice);
    let rule: PriceRule | null = null;
    let fallback: AdoptFallback | null = null;
    if (mode === 'percent') {
      const value = adoptionPercent(p.pricing.erpPrice, listingPrice);
      const percent: PriceRule = { mode: 'percent', value };
      if (value < ADOPT_PERCENT_MIN || value > ADOPT_PERCENT_MAX) fallback = 'range';
      else if (verifies(percent)) rule = percent;
      else fallback = 'rounding';
    }
    if (!rule) {
      if (!verifies(fixed)) { skipped.unverifiable++; continue; }
      rule = fixed;
    }
    if (previousRule && sameRule(previousRule, rule)) { skipped.unchanged++; continue; }
    if (fallback) fallbacks[fallback]++;

    const current = resolve(p.pricing);
    adopt.push({ productId: p.id, erpPrice: p.pricing.erpPrice, listingPrice, rule, fallback, previousRule, currentPrice: current.price, currentSource: current.source });

    let conflicted = false;
    for (const m of others) {
      const other = listings.get(`${m}:${p.id}`);
      if (!other || !priceMismatch(other.price, listingPrice, options.priceTolerance)) continue;
      conflicted = true;
      conflicts.byMarketplace[m] = (conflicts.byMarketplace[m] ?? 0) + 1;
      if (conflicts.examples.length < ADOPT_CONFLICT_EXAMPLES) {
        conflicts.examples.push({ productId: p.id, marketplaceId: m, sourcePrice: listingPrice, otherPrice: toQar(toFils(other.price)) });
      }
    }
    if (conflicted) conflicts.products++;
  }
  return { adopt, skipped, fallbacks, conflicts };
}

/** The `n` rows whose price moves most (adopted minus current, by absolute fils), ties in input order. */
export function largestAdoptionChanges(rows: readonly AdoptionRow[], n = 10) {
  return rows
    .map((r, i) => ({ r, i, d: Math.abs(toFils(r.listingPrice) - toFils(r.currentPrice)) }))
    .sort((x, y) => y.d - x.d || x.i - y.i)
    .slice(0, n)
    .map(x => x.r);
}
