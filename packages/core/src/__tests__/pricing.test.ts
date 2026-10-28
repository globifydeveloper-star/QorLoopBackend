import { resolveMarketplacePrice, priceFromRule, type PricingSettingsSnapshot } from '../pricing';
import { roundFils, round2, toFils } from '../money';

const settings: PricingSettingsSnapshot = { defaultRule: { mode: 'percent', value: 10 }, rounding: 'exact' };

describe('money', () => {
  it('avoids float noise (5.5 x 1.15 = 6.325, not 6.3249999)', () => {
    expect(priceFromRule(5.5, { mode: 'percent', value: 15 }, 'exact')).toBe(6.33);
  });
  it('rounds to steps', () => {
    expect(roundFils(toFils(6.33), '0.05') / 1000).toBe(6.35);
    expect(roundFils(toFils(6.33), '0.25') / 1000).toBe(6.25);
    expect(roundFils(toFils(6.4), '0.50') / 1000).toBe(6.5);
  });
  it('round2 is half-up', () => expect(round2(1.005)).toBe(1.01));
});

describe('resolveMarketplacePrice precedence', () => {
  const base = { erpPrice: 10, categoryId: 'c1', subcategoryId: 's1' };
  const catRules = [
    { categoryId: 'c1', rule: { mode: 'amount' as const, value: 1 } },
    { categoryId: 'c1', subcategoryId: 's1', rule: { mode: 'amount' as const, value: 2 } },
  ];
  it('offer wins and is used exactly as typed', () => {
    expect(resolveMarketplacePrice({ ...base, offerPrice: 1.25, productRule: { mode: 'same', value: 0 } }, settings, catRules)).toEqual({ price: 1.25, source: 'offer' });
  });
  it('product rule beats category', () => {
    expect(resolveMarketplacePrice({ ...base, productRule: { mode: 'fixed', value: 12.5 } }, settings, catRules).source).toBe('product');
  });
  it('subcategory beats category', () => {
    const r = resolveMarketplacePrice(base, settings, catRules);
    expect(r).toMatchObject({ price: 12, source: 'subcategory' });
  });
  it('category beats default', () => {
    expect(resolveMarketplacePrice({ erpPrice: 10, categoryId: 'c1' }, settings, catRules)).toMatchObject({ price: 11, source: 'category' });
  });
  it('per-marketplace only applies when enabled', () => {
    const s: PricingSettingsSnapshot = { ...settings, marketplaceRules: { talabat: { active: true, rule: { mode: 'percent', value: 20 }, rounding: 'exact' } } };
    expect(resolveMarketplacePrice({ erpPrice: 10 }, s, [], 'talabat').source).toBe('default');
    expect(resolveMarketplacePrice({ erpPrice: 10 }, { ...s, perMarketplaceEnabled: true }, [], 'talabat')).toMatchObject({ price: 12, source: 'marketplace' });
  });
  it('default rule', () => expect(resolveMarketplacePrice({ erpPrice: 10 }, settings)).toMatchObject({ price: 11, source: 'default' }));
  it('fixed and same ignore rounding', () => {
    expect(priceFromRule(10, { mode: 'fixed', value: 9.99 }, '0.50')).toBe(9.99);
    expect(priceFromRule(10.07, { mode: 'same', value: 0 }, '0.50')).toBe(10.07);
  });
});
