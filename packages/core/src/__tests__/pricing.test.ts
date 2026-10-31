import { describe, it, expect } from '@jest/globals';
import {
  applyRule,
  priceFromRule,
  priceRuleChain,
  resolveMarketplacePrice,
  PRICE_RULE_ORDER,
  type PricingSettingsSnapshot,
  type CategoryRuleItem
} from '../pricing.js';

const now = new Date('2026-10-31T12:00:00Z');
const hours = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('Pricing Calculation & Precedence Engine', () => {
  const baseSettings: PricingSettingsSnapshot = {
    defaultRule: { mode: 'percent', value: 10 }, // 10% markup default
    rounding: '0.25',
    perMarketplaceEnabled: true,
    marketplaceRules: {
      talabat: { mode: 'percent', value: 15, rounding: '0.25' }
    }
  };

  const categoryRules: CategoryRuleItem[] = [
    {
      categoryId: 'cat-beverages',
      rule: { mode: 'percent', value: 8 }
    },
    {
      categoryId: 'cat-beverages',
      subcategoryId: 'subcat-juices',
      rule: { mode: 'amount', value: 2.0 }
    }
  ];

  it('documents the order in one constant', () => {
    expect(PRICE_RULE_ORDER).toEqual(['offer', 'product', 'subcategory', 'category', 'marketplace', 'default']);
  });

  it('calculates applyRule across all rule modes', () => {
    expect(applyRule(10, { mode: 'percent', value: 20 })).toBe(12);
    expect(applyRule(10, { mode: 'amount', value: 3.5 })).toBe(13.5);
    expect(applyRule(10, { mode: 'fixed', value: 15 })).toBe(15);
    expect(applyRule(10, { mode: 'same', value: 0 })).toBe(10);
  });

  it('Tier 1: active offer takes absolute priority', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 20,
        offers: [{ price: 14.5 }],
        productRule: { mode: 'fixed', value: 18 },
        categoryId: 'cat-beverages',
        subcategoryId: 'subcat-juices'
      },
      baseSettings,
      categoryRules,
      { marketplace: 'talabat', now }
    );

    expect(res.source).toBe('offer');
    expect(res.price).toBe(14.5);
  });

  it('Tier 1: an offer inside its dates applies, including on its exact start and end', () => {
    const product = { erpPrice: 20, productRule: { mode: 'fixed' as const, value: 18 } };
    for (const offer of [{ price: 9, validFrom: hours(-1), validUntil: hours(1) }, { price: 9, validFrom: now }, { price: 9, validUntil: now }]) {
      expect(resolveMarketplacePrice({ ...product, offers: [offer] }, baseSettings, [], { now })).toEqual({ price: 9, source: 'offer' });
    }
  });

  it('Tier 1: expired and future offers are ignored and the next step applies', () => {
    const product = { erpPrice: 20, productRule: { mode: 'fixed' as const, value: 18 } };
    const expired = resolveMarketplacePrice({ ...product, offers: [{ price: 9, validFrom: hours(-48), validUntil: hours(-1) }] }, baseSettings, [], { now });
    const future = resolveMarketplacePrice({ ...product, offers: [{ price: 9, validFrom: hours(1), validUntil: hours(48) }] }, baseSettings, [], { now });
    expect(expired).toMatchObject({ price: 18, source: 'product' });
    expect(future).toMatchObject({ price: 18, source: 'product' });
  });

  it('Tier 1: the valid offer wins over an expired one; offers are never rounded', () => {
    const res = resolveMarketplacePrice(
      { erpPrice: 20, offers: [{ price: 5, validUntil: hours(-1) }, { price: 12.345, validFrom: hours(-2) }] },
      baseSettings, [], { now }
    );
    expect(res).toEqual({ price: 12.345, source: 'offer' });
  });

  it('Tier 2: product-specific rule overrides category, marketplace, and default', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 20,
        offers: null,
        productRule: { mode: 'fixed', value: 17.5 },
        categoryId: 'cat-beverages',
        subcategoryId: 'subcat-juices'
      },
      baseSettings,
      categoryRules,
      { marketplace: 'talabat' }
    );

    expect(res.source).toBe('product');
    expect(res.price).toBe(17.5);
  });

  it('Tier 3: subcategory rule overrides category, marketplace, and default', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 10,
        categoryId: 'cat-beverages',
        subcategoryId: 'subcat-juices'
      },
      baseSettings,
      categoryRules,
      { marketplace: 'talabat' }
    );

    // subcat-juices has amount: +2.0 => 10 + 2 = 12
    expect(res.source).toBe('subcategory');
    expect(res.price).toBe(12.0);
  });

  it('Tier 3: a subcategory rule beats its category rule whatever order the rules are listed in', () => {
    const product = { erpPrice: 10, categoryId: 'cat-beverages', subcategoryId: 'subcat-juices' };
    expect(resolveMarketplacePrice(product, baseSettings, [...categoryRules].reverse()).source).toBe('subcategory');
  });

  it('Tier 4: a product in a subcategory without a rule falls back to its category rule', () => {
    const res = resolveMarketplacePrice({ erpPrice: 10, categoryId: 'cat-beverages', subcategoryId: 'subcat-water' }, baseSettings, categoryRules);
    expect(res).toMatchObject({ source: 'category', price: 10.75 });
  });

  it('Tier 4: category rule overrides marketplace and default', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 10,
        categoryId: 'cat-beverages'
      },
      baseSettings,
      categoryRules,
      { marketplace: 'talabat' }
    );

    // cat-beverages has percent: 8% => 10 * 1.08 = 10.8 => rounded to 0.25 => 10.75
    expect(res.source).toBe('category');
    expect(res.price).toBe(10.75);
  });

  it('Tier 4: a subcategory rule is never read as its category rule', () => {
    const onlySub: CategoryRuleItem[] = [categoryRules[1]!];
    expect(resolveMarketplacePrice({ erpPrice: 10, categoryId: 'cat-beverages' }, baseSettings, onlySub).source).toBe('default');
  });

  it('Tier 5: marketplace-specific rule applies when perMarketplaceEnabled', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 10,
        categoryId: 'cat-bakery' // no category rule
      },
      baseSettings,
      categoryRules,
      { marketplace: 'talabat' }
    );

    // talabat has markup: 15% => 10 * 1.15 = 11.5 => rounded to 0.25 => 11.5
    expect(res.source).toBe('marketplace');
    expect(res.price).toBe(11.5);
  });

  it('Tier 5: uses the per-marketplace rounding, not the tenant one', () => {
    const settings: PricingSettingsSnapshot = { ...baseSettings, marketplaceRules: { talabat: { mode: 'amount', value: 0.13, rounding: 'exact' } } };
    expect(resolveMarketplacePrice({ erpPrice: 10 }, settings, [], { marketplace: 'talabat' })).toMatchObject({ source: 'marketplace', price: 10.13 });
  });

  it('Tier 5: skipped when perMarketplaceEnabled is off or no marketplace is named', () => {
    const off = { ...baseSettings, perMarketplaceEnabled: false };
    expect(resolveMarketplacePrice({ erpPrice: 10 }, off, [], { marketplace: 'talabat' }).source).toBe('default');
    expect(resolveMarketplacePrice({ erpPrice: 10 }, baseSettings, []).source).toBe('default');
  });

  it('Tier 6: fallback to default tenant rule', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 10,
        categoryId: 'cat-bakery'
      },
      baseSettings,
      categoryRules,
      { marketplace: 'snoonu' } // no snoonu rule in marketplaceRules
    );

    // default rule is 10% => 10 * 1.10 = 11.0 => rounded to 0.25 => 11.0
    expect(res.source).toBe('default');
    expect(res.price).toBe(11.0);
  });
});

describe('rounding applies only to calculated prices', () => {
  it('rounds percent and amount to the step', () => {
    expect(priceFromRule(10, { mode: 'percent', value: 8 }, '0.25')).toBe(10.75);
    expect(priceFromRule(10, { mode: 'amount', value: 0.13 }, '0.05')).toBe(10.15);
    expect(priceFromRule(10, { mode: 'amount', value: 0.12 }, '0.50')).toBe(10);
  });
  it('never rounds fixed or same', () => {
    expect(priceFromRule(10, { mode: 'fixed', value: 7.123 }, '0.50')).toBe(7.123);
    expect(priceFromRule(10.123, { mode: 'same', value: 0 }, '0.50')).toBe(10.123);
  });
  it('never rounds an offer', () => {
    const settings: PricingSettingsSnapshot = { defaultRule: { mode: 'same', value: 0 }, rounding: '0.50' };
    expect(resolveMarketplacePrice({ erpPrice: 10, offers: [{ price: 7.37 }] }, settings).price).toBe(7.37);
  });
  it('a calculated price never goes below zero', () => {
    expect(priceFromRule(2, { mode: 'amount', value: -5 }, 'exact')).toBe(0);
  });
});

describe('float traps (integer fils maths)', () => {
  it.each([
    // [erp, rule, rounding, expected]   naive float maths in the comment
    [5.5, { mode: 'percent', value: 15 }, 'exact', 6.33],   // 5.5 * 1.15 = 6.324999999999999
    [19.99, { mode: 'percent', value: 10 }, 'exact', 21.99], // 21.989000000000004
    [1.1, { mode: 'percent', value: 3 }, 'exact', 1.13],     // 1.1330000000000002
    [0.1, { mode: 'amount', value: 0.2 }, 'exact', 0.3],     // 0.30000000000000004
    [1.005, { mode: 'amount', value: 0 }, 'exact', 1.01],    // Math.round(1.005 * 100) / 100 = 1
    [4.35, { mode: 'percent', value: 12.5 }, '0.05', 4.9],   // 4.89375
    [2.675, { mode: 'amount', value: 0 }, 'exact', 2.68],    // 2.675.toFixed(2) = 2.67
    [8.2, { mode: 'percent', value: 15 }, '0.25', 9.5],      // 9.43 -> 9.50
  ] as const)('%s with %j at %s = %s', (erp, rule, rounding, expected) => {
    expect(priceFromRule(erp, rule, rounding)).toBe(expected);
  });
});

describe('priceRuleChain', () => {
  const settings: PricingSettingsSnapshot = {
    defaultRule: { mode: 'percent', value: 10 }, rounding: 'exact', perMarketplaceEnabled: false,
  };
  const rules: CategoryRuleItem[] = [
    { categoryId: 'c', rule: { mode: 'percent', value: 5 } },
    { categoryId: 'c', subcategoryId: 's', rule: { mode: 'amount', value: 1 } },
  ];

  it('marks the winner applied, later existing rules overridden, and the rest as not set, expired, scheduled or disabled', () => {
    const { resolved, steps } = priceRuleChain(
      { erpPrice: 10, offers: [{ price: 8, validUntil: hours(-1) }], categoryId: 'c', subcategoryId: 's' }, settings, rules, { now },
    );
    expect(resolved).toMatchObject({ source: 'subcategory', price: 11 });
    expect(steps.map(s => [s.source, s.status])).toEqual([
      ['offer', 'expired'], ['product', 'not_set'], ['subcategory', 'applied'], ['category', 'overridden'], ['marketplace', 'disabled'], ['default', 'overridden'],
    ]);
    expect(steps[3]).toMatchObject({ price: 10.5, rule: { mode: 'percent', value: 5 } });
  });

  it('shows a future offer as scheduled', () => {
    const { steps } = priceRuleChain({ erpPrice: 10, offers: [{ price: 8, validFrom: hours(2) }] }, settings, [], { now });
    expect(steps[0]).toMatchObject({ source: 'offer', status: 'scheduled' });
    expect(steps[5]).toMatchObject({ source: 'default', status: 'applied', price: 11 });
  });

  it('agrees with resolveMarketplacePrice', () => {
    const product = { erpPrice: 7.3, productRule: { mode: 'amount' as const, value: 1.25 }, categoryId: 'c' };
    expect(priceRuleChain(product, settings, rules).resolved).toEqual(resolveMarketplacePrice(product, settings, rules));
  });
});
