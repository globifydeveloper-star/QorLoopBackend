import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import * as ref from './reference.js';

// The reference must stand alone: hand-checked examples from the documents, and a guard that it never imports product code.
const base = (over: Partial<ref.CatalogueProduct> = {}): ref.CatalogueProduct => ({
  key: 'p', barcode: '6281000000011', sku: null, nameEn: 'Milk', priceFils: 5500, stock: 10, erpActive: true, inLatestErpFile: true,
  status: 'active', blocked: false, categoryKey: null, subcategoryKey: null, ...over,
});
const pricing = (over: Partial<ref.PricingInput> = {}): ref.PricingInput => ({
  defaultRule: { mode: 'same' }, rounding: 'exact', perMarketplaceEnabled: false, marketplaceRules: {}, categoryRules: {}, subcategoryRules: {},
  productRules: {}, offers: {}, ...over,
});
const now = new Date('2026-11-19T10:00:00Z');
const settings = { tolerance: 0, threshold: 0, staleHours: 12 };

describe('reference calculator (hand-checked against the documents)', () => {
  it('imports no product code', () => {
    for (const file of readdirSync('apps/api/src/__tests__/verification').filter(f => /^reference\.ts$/.test(f))) {
      const source = readFileSync('apps/api/src/__tests__/verification/' + file, 'utf8');
      expect(source).not.toMatch(/^\s*import\s/m);
      expect(source).not.toMatch(/require\(/);
    }
  });

  it('R01/R02 barcodes', () => {
    expect(ref.refBarcode('06281000000011')).toBe('6281000000011'); // GTIN-14 equals EAN-13
    expect(ref.refBarcode('6281000000011.0')).toBe('6281000000011');
    expect(ref.refBarcode(' 0012-34 ')).toBe('1234');
    expect(ref.refBarcode(6281000000011)).toBe('6281000000011');
    expect(ref.refBarcode('000')).toBe('');
    expect(ref.refBarcode(null)).toBe('');
  });

  it('R09/R12 integer fils: 5.5 x 1.15 = 6.325, never 6.3249999', () => {
    expect(ref.refFils('5.5')).toBe(5500);
    expect(ref.refFils('1.2345')).toBe(1235);
    expect(ref.refFils('1.2344')).toBe(1234);
    expect(ref.refFils(0.1 + 0.2)).toBe(300);
    expect(ref.refFils('abc')).toBeNull();
    expect(ref.refApplyRule(5500, { mode: 'percent', value: '15' }, 'exact')).toBe(6325);
    expect(ref.refApplyRule(5500, { mode: 'amount', value: '-0.5' }, 'exact')).toBe(5000);
    expect(ref.refApplyRule(5500, { mode: 'fixed', value: '4.2' }, '0.25')).toBe(4200); // fixed is never rounded
    expect(ref.refApplyRule(5500, { mode: 'percent', value: '15' }, '0.25')).toBe(6250); // 6.325 -> 6.25 (nearest step)
    expect(ref.refApplyRule(5500, { mode: 'percent', value: '17.5' }, '0.05')).toBe(6450); // 6.4625 -> 6.45
    expect(ref.refApplyRule(1005, { mode: 'percent', value: '50' }, 'exact')).toBe(1508); // 1507.5 fils, half up
  });

  it('R10/R11 rule order and offer windows', () => {
    const p = base({ categoryKey: 'c', subcategoryKey: 's' });
    const all = pricing({
      offers: { p: { priceFils: 1250, validFrom: null, validUntil: null } }, productRules: { p: { mode: 'fixed', value: '6' } },
      subcategoryRules: { 'c/s': { mode: 'amount', value: '1' } }, categoryRules: { c: { mode: 'amount', value: '2' } },
      perMarketplaceEnabled: true, marketplaceRules: { talabat: { mode: 'amount', value: '3', rounding: 'exact' } }, defaultRule: { mode: 'percent', value: '10' },
    });
    expect(ref.refMarketplacePrice(p, 'talabat', all, now)).toEqual({ fils: 1250, source: 'offer' });
    delete all.offers.p; expect(ref.refMarketplacePrice(p, 'talabat', all, now)).toEqual({ fils: 6000, source: 'product' });
    delete all.productRules.p; expect(ref.refMarketplacePrice(p, 'talabat', all, now)).toEqual({ fils: 6500, source: 'category' });
    delete all.subcategoryRules['c/s']; expect(ref.refMarketplacePrice(p, 'talabat', all, now)).toEqual({ fils: 7500, source: 'category' });
    delete all.categoryRules.c; expect(ref.refMarketplacePrice(p, 'talabat', all, now)).toEqual({ fils: 8500, source: 'marketplace' });
    expect(ref.refMarketplacePrice(p, 'snoonu', all, now)).toEqual({ fils: 6050, source: 'default' });
    all.perMarketplaceEnabled = false; expect(ref.refMarketplacePrice(p, 'talabat', all, now)).toEqual({ fils: 6050, source: 'default' });
    expect(ref.refOfferActive({ priceFils: 1, validFrom: new Date('2026-11-20T00:00:00Z'), validUntil: null }, now)).toBe(false);
    expect(ref.refOfferActive({ priceFils: 1, validFrom: null, validUntil: new Date('2026-11-18T00:00:00Z') }, now)).toBe(false);
  });

  it('R15/R17/R18 availability and the status order', () => {
    const listing = { priceFils: 5500, available: true };
    expect(ref.refReconcile(base(), 'talabat', listing, false, pricing(), settings, now)!.status).toBe('no_data');
    expect(ref.refReconcile(base({ status: 'new' }), 'talabat', listing, true, pricing(), settings, now)!.status).toBe('new');
    expect(ref.refReconcile(base(), 'talabat', null, true, pricing(), settings, now)!.status).toBe('not_listed');
    expect(ref.refReconcile(base({ erpActive: false }), 'talabat', null, true, pricing(), settings, now)!.status).toBe('in_sync');
    expect(ref.refReconcile(base({ inLatestErpFile: false }), 'talabat', listing, true, pricing(), settings, now)).toMatchObject({ status: 'missing_from_erp', stockIssue: 'available_but_out_of_stock' });
    expect(ref.refReconcile(base({ stock: 0 }), 'talabat', listing, true, pricing(), settings, now)).toMatchObject({ status: 'mismatch', stockIssue: 'available_but_out_of_stock' });
    expect(ref.refReconcile(base(), 'talabat', { priceFils: 5500, available: false }, true, pricing(), settings, now)).toMatchObject({ status: 'mismatch', stockIssue: 'unavailable_but_in_stock' });
    expect(ref.refReconcile(base(), 'talabat', { priceFils: 5501, available: true }, true, pricing(), settings, now)).toMatchObject({ status: 'mismatch', priceMismatch: true });
    expect(ref.refReconcile(base(), 'talabat', { priceFils: 5501, available: true }, true, pricing(), { ...settings, tolerance: 1 }, now)!.status).toBe('in_sync');
    expect(ref.refReconcile(base({ stock: 5 }), 'talabat', listing, true, pricing(), { ...settings, threshold: 5 }, now)!.stockIssue).toBe('available_but_out_of_stock');
    expect(ref.refReconcile(base({ blocked: true }), 'talabat', listing, true, pricing(), settings, now)).toBeNull();
  });

  it('R06 rejects more than 20% invalid rows, accepts exactly 20%', () => {
    const good = { barcode: '1', nameEn: 'x', price: '1', stock: '1' };
    const bad = { barcode: '', nameEn: 'x', price: '1', stock: '1' };
    const rows = (b: number, g: number) => [...Array(b).fill(bad), ...Array.from({ length: g }, (_, i) => ({ ...good, barcode: String(i + 1) }))];
    expect(ref.refValidateErp(rows(2, 8)).rejected).toBe(false);
    expect(ref.refValidateErp(rows(3, 8)).rejected).toBe(true);
  });

  it('R20 stale only when older than stale hours', () => {
    expect(ref.refStale(new Date(now.getTime() - 12 * 3_600_000), now, 12)).toBe(false);
    expect(ref.refStale(new Date(now.getTime() - 12 * 3_600_000 - 1), now, 12)).toBe(true);
  });

  it('R23/R24 cell spelling and formula safety', () => {
    expect(ref.refPriceText(2200, '1.75')).toBe('2.20');
    expect(ref.refPriceText(2205, '1.75')).toBe('2.205');
    expect(ref.refBoolText(false, 'True')).toBe('False');
    expect(ref.refBoolText(true, 'NO')).toBe('YES');
    expect(ref.refSafeCell('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    expect(ref.refSafeCell('-5')).toBe('\'-5');
  });
});
