import type { MarketplaceId } from './constants.js';

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
