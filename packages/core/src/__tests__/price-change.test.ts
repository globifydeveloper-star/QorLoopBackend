import { describe, expect, it } from '@jest/globals';
import { toFils } from '../money.js';
import type { PriceRule, PricingSettingsSnapshot, ProductPricingInput } from '../pricing.js';
import {
  BULK_PRICE_LIMIT, PRICE_CHANGE_MAX, PRICE_CHANGE_MAX_FILS,
  bulkBlockMessage, bulkPlanSignature, changeByAmount, changeByPercent, divRoundHalfUp, largestPriceMoves,
  planBulkPriceChange, priceBoundIssue, roundToStep,
  type BulkPriceAction, type BulkPriceContext, type BulkPriceProduct,
} from '../price-change.js';

const now = new Date('2026-11-02T12:00:00Z');

describe('integer price maths', () => {
  it('divides with halves rounded away from zero, exactly', () => {
    expect([5n, 4n, 3n, 2n, 1n, 0n].map(n => divRoundHalfUp(n, 2n))).toEqual([3n, 2n, 2n, 1n, 1n, 0n]);
    expect([1n, 2n, 3n].map(n => divRoundHalfUp(n, 4n))).toEqual([0n, 1n, 1n]);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(-1n, 4n)).toBe(0n);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
    // beyond Number's safe range: still exact
    expect(divRoundHalfUp(2n ** 60n + 1n, 2n)).toBe(2n ** 59n + 1n);
  });

  it('rounds a price to none (whole fils), 0.05 or 0.25, halves up', () => {
    expect(roundToStep(5.125, '0.25')).toBe(5.25);
    expect(roundToStep(5.124, '0.25')).toBe(5);
    expect(roundToStep(5.375, '0.25')).toBe(5.5);
    expect(roundToStep(5.025, '0.05')).toBe(5.05);
    expect(roundToStep(5.024, '0.05')).toBe(5);
    expect(roundToStep(5.1234, 'none')).toBe(5.123);
    expect(roundToStep(0.1 + 0.2, 'none')).toBe(0.3);
  });

  it('changes by a percent with one exact rounding, never float noise', () => {
    // the float trap: 5.5 * 1.15 is 6.324999... in binary floating point
    expect(changeByPercent(5.5, 15, 'increase', 'none')).toBe(6.325);
    expect(changeByPercent(4.4, 5, 'increase', 'none')).toBe(4.62);
    expect(changeByPercent(4.4, 5, 'increase', '0.05')).toBe(4.6);
    expect(changeByPercent(4.4, 5, 'increase', '0.25')).toBe(4.5);
    expect(changeByPercent(10, 10, 'decrease', 'none')).toBe(9);
    expect(changeByPercent(100, 12.345, 'increase', 'none')).toBe(112.345);
    expect(changeByPercent(100, 12.345, 'decrease', 'none')).toBe(87.655);
    // fractional fils are rounded once, at the end: 1.001 x 1.0005 = 1.0015005 -> 1.002
    expect(changeByPercent(1.001, 0.05, 'increase', 'none')).toBe(1.002);
    // ... not twice (to fils, then to the step): 1.0015005 -> 1.00 at 0.05
    expect(changeByPercent(1.001, 0.05, 'increase', '0.05')).toBe(1);
    // 90 % off a fils still leaves whole fils
    expect(changeByPercent(0.001, 90, 'decrease', 'none')).toBe(0);
    expect(changeByPercent(0.01, 90, 'decrease', 'none')).toBe(0.001);
  });

  it('keeps exact beyond the safe-integer range of a fils x factor product', () => {
    const big = 999_999_999.999; // DECIMAL(12,3) maximum; x 1,100,000 is ~1.1e18
    expect(toFils(changeByPercent(big, 1000, 'increase', 'none'))).toBe(10_999_999_999_989);
  });

  it('changes by an amount in fils; a decrease may go to 0 or below', () => {
    expect(changeByAmount(0.1, 0.2, 'increase', 'none')).toBe(0.3);
    expect(changeByAmount(5.1, 0.15, 'increase', 'none')).toBe(5.25);
    expect(changeByAmount(5.1, 0.1, 'increase', '0.25')).toBe(5.25);
    expect(changeByAmount(5.1, 0.1, 'decrease', '0.05')).toBe(5);
    expect(changeByAmount(5.1, 5.1, 'decrease', 'none')).toBe(0);
    expect(changeByAmount(5.1, 6, 'decrease', 'none')).toBe(-0.9);
  });

  it('bounds: above 0, at most PRICE_CHANGE_MAX (upper bound optional)', () => {
    expect(PRICE_CHANGE_MAX_FILS).toBe(PRICE_CHANGE_MAX * 1000);
    expect(priceBoundIssue(0)).toBe('price_not_positive');
    expect(priceBoundIssue(-10)).toBe('price_not_positive');
    expect(priceBoundIssue(Number.NaN)).toBe('price_not_positive');
    expect(priceBoundIssue(1)).toBeNull();
    expect(priceBoundIssue(PRICE_CHANGE_MAX_FILS)).toBeNull();
    expect(priceBoundIssue(PRICE_CHANGE_MAX_FILS + 1)).toBe('price_too_high');
    expect(priceBoundIssue(PRICE_CHANGE_MAX_FILS + 1, false)).toBeNull();
  });
});

describe('bulk plan', () => {
  // Default +10 % rounded to 0.25; Talabat has its own +20 % rule (per-marketplace pricing on).
  const snapshot: PricingSettingsSnapshot = {
    defaultRule: { mode: 'percent', value: 10 }, rounding: '0.25', perMarketplaceEnabled: true,
    marketplaceRules: { talabat: { mode: 'percent', value: 20, rounding: 'exact' } },
  };
  const product = (id: string, erpPrice: number, extra: Partial<ProductPricingInput> = {}, status = 'active'): BulkPriceProduct =>
    ({ id, status, pricing: { erpPrice, productRule: null, offers: [], ...extra } });
  const ctx = (extra: Partial<BulkPriceContext> = {}): BulkPriceContext =>
    ({ marketplaceId: 'talabat', otherMarketplaces: ['snoonu'], pricing: { snapshot, categoryRules: [] }, listings: new Map(), now, ...extra });
  const fixed = (value: number): PriceRule => ({ mode: 'fixed', value });
  const plan = (products: BulkPriceProduct[], action: BulkPriceAction, c = ctx(), notFound = 0) => planBulkPriceChange(products, notFound, action, c);

  it('set_fixed: changes, unchanged (same rule) and blocked (not found, not active, active offer)', () => {
    const p = plan([
      product('a', 10), product('b', 10, { productRule: fixed(7) }), product('c', 10, { productRule: { mode: 'percent', value: 5 } }),
      product('d', 10, {}, 'new'), product('e', 10, { offers: [{ price: 8 }] }),
      product('f', 10, { offers: [{ price: 8, validUntil: new Date('2026-11-01T00:00:00Z') }] }),
    ], { type: 'set_fixed', price: 7 }, ctx(), 2);
    expect(p.changes.map(c => c.productId)).toEqual(['a', 'c', 'f']);
    expect(p.changes[0]).toEqual({ productId: 'a', previousRule: null, rule: fixed(7), oldPrice: 12, oldSource: 'marketplace', newPrice: 7, newSource: 'product' });
    expect(p.changes[1]).toMatchObject({ previousRule: { mode: 'percent', value: 5 }, oldPrice: 10.5, oldSource: 'product', newPrice: 7 });
    expect(p.unchanged).toBe(1);
    expect(p.blocked).toMatchObject({ not_found: 2, not_active: 1, offer_active: 1, price_not_positive: 0 });
    // both changed products without an own rule move on Snoonu too (11 by default -> 7); c moved from 10.5 there as well
    expect(p.otherMarketplaces).toEqual({ snoonu: 3 });
  });

  it('a percent change starts from the price on the chosen marketplace and stores a fixed rule', () => {
    const talabat = plan([product('a', 10)], { type: 'increase_percent', percent: 10, rounding: 'none' });
    expect(talabat.changes[0]).toMatchObject({ oldPrice: 12, newPrice: 13.2, rule: fixed(13.2) });
    const snoonu = plan([product('a', 10)], { type: 'increase_percent', percent: 10, rounding: 'none' }, ctx({ marketplaceId: 'snoonu', otherMarketplaces: ['talabat'] }));
    expect(snoonu.changes[0]).toMatchObject({ oldPrice: 11, oldSource: 'default', newPrice: 12.1, rule: fixed(12.1) });
    expect(snoonu.otherMarketplaces).toEqual({ talabat: 1 });
  });

  it('a percent or amount change that the rounding cancels writes nothing (unchanged)', () => {
    // 12 + 1 % = 12.12 -> 12.00 at 0.25
    const p = plan([product('a', 10)], { type: 'increase_percent', percent: 1, rounding: '0.25' });
    expect(p.changes).toEqual([]);
    expect(p.unchanged).toBe(1);
    const q = plan([product('a', 10)], { type: 'decrease_amount', amount: 0.1, rounding: '0.25' });
    expect(q.unchanged).toBe(1);
  });

  it('refuses prices at or below 0 and above the maximum', () => {
    const down = plan([product('a', 10), product('b', 0.2, { productRule: fixed(0.2) })], { type: 'decrease_amount', amount: 0.25, rounding: 'none' });
    expect(down.changes.map(c => c.productId)).toEqual(['a']);
    expect(down.blocked.price_not_positive).toBe(1);
    const up = plan([product('a', 90_000, { productRule: fixed(90_000) })], { type: 'increase_percent', percent: 20, rounding: 'none' });
    expect(up.blocked.price_too_high).toBe(1);
    const tiny = plan([product('a', 0.01, { productRule: fixed(0.01) })], { type: 'decrease_percent', percent: 90, rounding: '0.25' });
    expect(tiny.blocked.price_not_positive).toBe(1);
  });

  it('match_erp removes the rule: the price follows the next rule; no rule is unchanged; a fallback of 0 is blocked', () => {
    const p = plan([product('a', 10, { productRule: fixed(15) }), product('b', 10), product('c', 0, { productRule: fixed(1) })], { type: 'match_erp' });
    expect(p.changes).toEqual([{ productId: 'a', previousRule: fixed(15), rule: null, oldPrice: 15, oldSource: 'product', newPrice: 12, newSource: 'marketplace' }]);
    expect(p.unchanged).toBe(1);
    expect(p.blocked.price_not_positive).toBe(1);
    expect(p.otherMarketplaces).toEqual({ snoonu: 1 });
  });

  it('match_marketplace reuses the adoption planner (fixed, replacing rules) and its skips', () => {
    const listings = new Map([['talabat:a', { price: 12.5 }], ['talabat:b', { price: 7 }], ['talabat:c', { price: 0 }], ['talabat:e', { price: 200_000 }], ['snoonu:d', { price: 5 }]]);
    const p = plan([
      product('a', 10), product('b', 10, { productRule: fixed(7) }), product('c', 10), product('d', 10),
      product('e', 10), product('f', 10, { offers: [{ price: 9 }] }), product('g', 0),
    ], { type: 'match_marketplace' }, ctx({ listings: new Map([...listings, ['talabat:f', { price: 9 }], ['talabat:g', { price: 3 }]]) }));
    expect(p.changes).toEqual([{ productId: 'a', previousRule: null, rule: fixed(12.5), oldPrice: 12, oldSource: 'marketplace', newPrice: 12.5, newSource: 'product' }]);
    expect(p.unchanged).toBe(1);
    expect(p.blocked).toMatchObject({ no_listing: 1, non_positive_listing_price: 1, offer_active: 1, non_positive_erp_price: 1, price_too_high: 1 });
  });

  it('counts sum to the selection, whatever the action', () => {
    const products = [product('a', 10), product('b', 10, { productRule: fixed(7) }), product('c', 10, {}, 'inactive'), product('d', 10, { offers: [{ price: 1 }] })];
    const actions: BulkPriceAction[] = [
      { type: 'set_fixed', price: 7 }, { type: 'increase_percent', percent: 5, rounding: '0.05' }, { type: 'decrease_percent', percent: 90, rounding: 'none' },
      { type: 'increase_amount', amount: 1, rounding: 'none' }, { type: 'decrease_amount', amount: 50, rounding: 'none' }, { type: 'match_marketplace' }, { type: 'match_erp' },
    ];
    for (const action of actions) {
      const p = plan(products, action, ctx(), 3);
      const blocked = Object.values(p.blocked).reduce((n, b) => n + b, 0);
      expect([action.type, p.changes.length + p.unchanged + blocked]).toEqual([action.type, products.length + 3]);
    }
  });

  it('the largest increase and decrease, by fils', () => {
    const p = plan([product('a', 10), product('b', 10, { productRule: fixed(20) }), product('c', 10, { productRule: fixed(5) })], { type: 'set_fixed', price: 11 });
    const { increase, decrease } = largestPriceMoves(p.changes);
    expect(increase?.productId).toBe('c');
    expect(decrease?.productId).toBe('b');
    expect(largestPriceMoves([])).toEqual({ increase: null, decrease: null });
  });

  it('the plan signature depends on the writes, not on their order', () => {
    const a = plan([product('a', 10), product('b', 10)], { type: 'set_fixed', price: 7 });
    const b = plan([product('b', 10), product('a', 10)], { type: 'set_fixed', price: 7 });
    const c = plan([product('a', 10), product('b', 10, { productRule: fixed(6) })], { type: 'set_fixed', price: 7 });
    const d = plan([product('a', 10), product('b', 10)], { type: 'set_fixed', price: 7.001 });
    expect(bulkPlanSignature(a.changes)).toBe(bulkPlanSignature(b.changes));
    expect(bulkPlanSignature(c.changes)).not.toBe(bulkPlanSignature(a.changes));
    expect(bulkPlanSignature(d.changes)).not.toBe(bulkPlanSignature(a.changes));
  });

  it('plain messages name the marketplace', () => {
    expect(bulkBlockMessage('no_listing', 'talabat')).toBe('Not listed on Talabat');
    expect(bulkBlockMessage('price_too_high', 'snoonu')).toBe('The new price would be above 100,000 QAR');
    expect(BULK_PRICE_LIMIT).toBe(5000);
  });
});
