import { describe, expect, it } from '@jest/globals';
import {
  adoptionPercent, largestAdoptionChanges, planPriceAdoption, ADOPT_CONFLICT_EXAMPLES,
  type AdoptionOptions, type AdoptionProduct,
} from '../price-adoption.js';
import { resolveMarketplacePrice, type PricingSettingsSnapshot, type ProductPricingInput } from '../pricing.js';

const now = new Date('2026-11-02T12:00:00Z');
const day = 86_400_000;
const exact: PricingSettingsSnapshot = { defaultRule: { mode: 'same', value: 0 }, rounding: 'exact' };
const quarter: PricingSettingsSnapshot = { defaultRule: { mode: 'percent', value: 10 }, rounding: '0.25' };
const opts = (o: Partial<AdoptionOptions> = {}): AdoptionOptions => ({ source: 'talabat', mode: 'fixed', onlyWithoutRule: true, priceTolerance: 0, now, ...o });
const product = (id: string, erpPrice: number, extra: Partial<ProductPricingInput> = {}): AdoptionProduct => ({ id, pricing: { erpPrice, ...extra } });
const listed = (entries: [string, string, number][]) => new Map(entries.map(([m, id, price]) => [`${m}:${id}`, { price }]));
const plan = (products: AdoptionProduct[], listings: Map<string, { price: number }>, o: Partial<AdoptionOptions> = {}, settings = exact) =>
  planPriceAdoption(products, listings, { snapshot: settings, categoryRules: [] }, opts(o));

describe('adoptionPercent', () => {
  it('is (listing / erp - 1) x 100 from integer fils, to 3 decimals', () => {
    expect(adoptionPercent(4, 5.75)).toBe(43.75);
    expect(adoptionPercent(3, 3.5)).toBe(16.667);
    expect(adoptionPercent(1.1, 1.65)).toBe(50); // 1.65 / 1.1 is 1.4999999999999998 in floats
    expect(adoptionPercent(10, 8.5)).toBe(-15);
    expect(adoptionPercent(2.5, 2.5)).toBe(0);
  });
});

describe('planPriceAdoption', () => {
  it('fixed: the rule is the listing price, and the current price is what the rules say today', () => {
    const p = plan([product('a', 5), product('b', 2.5)], listed([['talabat', 'a', 7.25], ['talabat', 'b', 3]]), {}, quarter);
    expect(p.adopt).toEqual([
      { productId: 'a', erpPrice: 5, listingPrice: 7.25, rule: { mode: 'fixed', value: 7.25 }, fallback: null, previousRule: null, currentPrice: 5.5, currentSource: 'default' },
      { productId: 'b', erpPrice: 2.5, listingPrice: 3, rule: { mode: 'fixed', value: 3 }, fallback: null, previousRule: null, currentPrice: 2.75, currentSource: 'default' },
    ]);
    expect(p.fallbacks).toEqual({ rounding: 0, range: 0 });
  });

  it('percent: the rule resolves to the listing price through the engine, with the tenant rounding', () => {
    const products = [product('a', 4), product('b', 3), product('c', 1.1)];
    const p = plan(products, listed([['talabat', 'a', 5.75], ['talabat', 'b', 3.5], ['talabat', 'c', 1.65]]), { mode: 'percent' });
    expect(p.adopt.map(r => [r.productId, r.rule, r.fallback])).toEqual([
      ['a', { mode: 'percent', value: 43.75 }, null],
      ['b', { mode: 'percent', value: 16.667 }, null],
      ['c', { mode: 'percent', value: 50 }, null],
    ]);
    for (const r of p.adopt) {
      const input = { ...products.find(x => x.id === r.productId)!.pricing, productRule: r.rule };
      expect(resolveMarketplacePrice(input, exact, [], { marketplace: 'talabat', now }).price).toBe(r.listingPrice);
    }
  });

  it('percent falls back to fixed when the rounding step cannot reach the listing price, and when outside -90..1000 %', () => {
    // 0.25 steps: 4 x 1.275 = 5.10 rounds to 5.00; exact (0.01): 2.345 cannot be reached; 0.10 -> 2.00 is +1900 %
    const quarterly = plan([product('a', 4), product('b', 2)], listed([['talabat', 'a', 5.1], ['talabat', 'b', 5.25]]), { mode: 'percent' }, quarter);
    expect(quarterly.adopt.map(r => [r.rule, r.fallback])).toEqual([[{ mode: 'fixed', value: 5.1 }, 'rounding'], [{ mode: 'percent', value: 162.5 }, null]]);
    const cents = plan([product('a', 2), product('b', 0.1), product('c', 100)], listed([['talabat', 'a', 2.345], ['talabat', 'b', 2], ['talabat', 'c', 5]]), { mode: 'percent' });
    expect(cents.adopt.map(r => [r.rule, r.fallback])).toEqual([
      [{ mode: 'fixed', value: 2.345 }, 'rounding'], [{ mode: 'fixed', value: 2 }, 'range'], [{ mode: 'fixed', value: 5 }, 'range'],
    ]);
    expect(cents.fallbacks).toEqual({ rounding: 1, range: 2 });
  });

  it('skips by reason, and never touches a product rule or offer while onlyWithoutRule is on', () => {
    const products = [
      product('none', 5), product('zero', 0), product('free', 5), product('rule', 5, { productRule: { mode: 'fixed', value: 9 } }),
      product('expired', 5, { offers: [{ price: 4, validUntil: new Date(now.getTime() - day) }] }), product('ok', 5),
    ];
    const listings = listed([['talabat', 'zero', 3], ['talabat', 'free', 0], ['talabat', 'rule', 6], ['talabat', 'expired', 6], ['talabat', 'ok', 6], ['snoonu', 'none', 6]]);
    const p = plan(products, listings);
    expect(p.adopt.map(r => r.productId)).toEqual(['ok']);
    expect(p.skipped).toEqual({
      no_listing: 1, non_positive_erp_price: 1, non_positive_listing_price: 1, has_rule: 1, has_offer: 1, offer_active: 0, unchanged: 0, unverifiable: 0,
    });
  });

  it('onlyWithoutRule off: replaces a different rule, skips an identical one, and a valid offer (it outranks any rule)', () => {
    const products = [
      product('replace', 5, { productRule: { mode: 'percent', value: 10 } }), product('same', 5, { productRule: { mode: 'fixed', value: 6 } }),
      product('valid', 5, { offers: [{ price: 4 }] }), product('later', 5, { offers: [{ price: 4, validFrom: new Date(now.getTime() + day) }] }),
    ];
    const p = plan(products, listed(products.map(x => ['talabat', x.id, 6] as [string, string, number])), { onlyWithoutRule: false });
    expect(p.adopt.map(r => [r.productId, r.previousRule])).toEqual([['replace', { mode: 'percent', value: 10 }], ['later', null]]);
    expect(p.adopt[0]).toMatchObject({ currentPrice: 5.5, currentSource: 'product' });
    expect(p.skipped).toMatchObject({ unchanged: 1, offer_active: 1, has_rule: 0, has_offer: 0 });
  });

  it('is idempotent: the rules it plans, applied, plan nothing more', () => {
    const products = [product('a', 4), product('b', 4)];
    const listings = listed([['talabat', 'a', 5.75], ['talabat', 'b', 5.1]]);
    for (const onlyWithoutRule of [true, false]) {
      const first = plan(products, listings, { mode: 'percent', onlyWithoutRule }, quarter);
      const applied = products.map(p => ({ ...p, pricing: { ...p.pricing, productRule: first.adopt.find(r => r.productId === p.id)!.rule } }));
      expect(plan(applied, listings, { mode: 'percent', onlyWithoutRule }, quarter).adopt).toEqual([]);
    }
  });

  it('counts conflicts: another marketplace listing the adopted product at a price beyond the recon tolerance', () => {
    const products = [product('a', 5), product('b', 5), product('c', 5), product('d', 5)];
    const listings = listed([
      ['talabat', 'a', 6], ['snoonu', 'a', 6.5], ['keeta', 'a', 7],
      ['talabat', 'b', 6], ['snoonu', 'b', 6.04],
      ['talabat', 'c', 6], ['snoonu', 'c', 6],
      ['snoonu', 'd', 9],
    ]);
    const p = plan(products, listings, { priceTolerance: 0.05 });
    expect(p.conflicts).toEqual({
      products: 1, byMarketplace: { snoonu: 1, keeta: 1 },
      examples: [
        { productId: 'a', marketplaceId: 'snoonu', sourcePrice: 6, otherPrice: 6.5 },
        { productId: 'a', marketplaceId: 'keeta', sourcePrice: 6, otherPrice: 7 },
      ],
    });
    const many = Array.from({ length: 30 }, (_, i) => product('p' + i, 5));
    const crowded = plan(many, listed(many.flatMap(x => [['talabat', x.id, 6], ['snoonu', x.id, 7]] as [string, string, number][])));
    expect(crowded.conflicts.products).toBe(30);
    expect(crowded.conflicts.examples).toHaveLength(ADOPT_CONFLICT_EXAMPLES);
  });

  it('largestAdoptionChanges: by absolute change, ties in input order', () => {
    const p = plan([product('a', 5), product('b', 5), product('c', 5), product('d', 5)],
      listed([['talabat', 'a', 5.5], ['talabat', 'b', 2], ['talabat', 'c', 8], ['talabat', 'd', 7]]));
    expect(largestAdoptionChanges(p.adopt, 3).map(r => r.productId)).toEqual(['b', 'c', 'd']);
  });
});
