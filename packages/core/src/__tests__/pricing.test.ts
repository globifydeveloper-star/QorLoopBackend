import { describe, it, expect } from '@jest/globals';
import {
  applyRule,
  resolveMarketplacePrice,
  type PricingSettingsSnapshot,
  type CategoryRuleItem
} from '../pricing.js';

describe('Pricing Calculation & Precedence Engine', () => {
  const baseSettings: PricingSettingsSnapshot = {
    defaultRule: { mode: 'percent', value: 10 }, // 10% markup default
    rounding: '0.25',
    perMarketplaceEnabled: true,
    marketplaceRules: {
      talabat: { active: true, markup: 15, rounding: '0.25' }
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
        offerPrice: 14.5,
        productRule: { mode: 'fixed', value: 18 },
        categoryId: 'cat-beverages',
        subcategoryId: 'subcat-juices'
      },
      baseSettings,
      categoryRules,
      'talabat'
    );

    expect(res.source).toBe('offer');
    expect(res.price).toBe(14.5);
  });

  it('Tier 2: product-specific rule overrides category, marketplace, and default', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 20,
        offerPrice: null,
        productRule: { mode: 'fixed', value: 17.5 },
        categoryId: 'cat-beverages',
        subcategoryId: 'subcat-juices'
      },
      baseSettings,
      categoryRules,
      'talabat'
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
      'talabat'
    );

    // subcat-juices has amount: +2.0 => 10 + 2 = 12
    expect(res.source).toBe('subcategory');
    expect(res.price).toBe(12.0);
  });

  it('Tier 4: category rule overrides marketplace and default', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 10,
        categoryId: 'cat-beverages'
      },
      baseSettings,
      categoryRules,
      'talabat'
    );

    // cat-beverages has percent: 8% => 10 * 1.08 = 10.8 => rounded to 0.25 => 10.75
    expect(res.source).toBe('category');
    expect(res.price).toBe(10.75);
  });

  it('Tier 5: marketplace-specific rule applies when perMarketplaceEnabled', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 10,
        categoryId: 'cat-bakery' // no category rule
      },
      baseSettings,
      categoryRules,
      'talabat'
    );

    // talabat has markup: 15% => 10 * 1.15 = 11.5 => rounded to 0.25 => 11.5
    expect(res.source).toBe('marketplace');
    expect(res.price).toBe(11.5);
  });

  it('Tier 6: fallback to default tenant rule', () => {
    const res = resolveMarketplacePrice(
      {
        erpPrice: 10,
        categoryId: 'cat-bakery'
      },
      baseSettings,
      categoryRules,
      'snoonu' // no snoonu rule in marketplaceRules
    );

    // default rule is 10% => 10 * 1.10 = 11.0 => rounded to 0.25 => 11.0
    expect(res.source).toBe('default');
    expect(res.price).toBe(11.0);
  });
});

