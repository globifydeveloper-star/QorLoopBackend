import { describe, it, expect } from '@jest/globals';
import { buildErpReview, buildMarketplaceReview, type CatalogProduct } from '../upload/review.js';
import type { ErpRow, MarketplaceRow } from '../upload/validate.js';

const products: CatalogProduct[] = [
  { id: 'p1', normalizedBarcode: '111', sku: 'S1', nameEn: 'One', erpPrice: 10, erpStock: 5, inLatestErpFile: true },
  { id: 'p2', normalizedBarcode: '222', sku: 'S2', nameEn: 'Two', erpPrice: 20, erpStock: 0, inLatestErpFile: true },
  { id: 'p3', normalizedBarcode: '333', sku: null, nameEn: 'Three', erpPrice: 30, erpStock: 1, inLatestErpFile: true },
];
const erp = (rowNumber: number, barcode: string, price: number, stock: number): ErpRow => ({ rowNumber, barcode, nameEn: 'x', price, stock, active: true });

describe('buildErpReview', () => {
  it('finds price/stock changes, new products and (for full files) missing products', () => {
    const r = buildErpReview([erp(2, '111', 11, 5), erp(3, '222', 20, 4), erp(4, '999', 5, 1)], 3, [], products, 'full');
    expect(r.summary).toMatchObject({ rowsRead: 3, matched: 2, newProducts: 1, priceChanges: 1, stockChanges: 1, missingFromFile: 1 });
    expect(r.missing).toEqual([{ productId: 'p3', barcode: '333' }]);
    expect(r.rows.map((x) => x.changeType)).toEqual(['price', 'stock', 'new']);
  });
  it('partial files never flag missing products', () => {
    expect(buildErpReview([erp(2, '111', 10, 5)], 1, [], products, 'partial').summary.missingFromFile).toBe(0);
  });
  it('flags duplicate barcodes within a file', () => {
    const r = buildErpReview([erp(2, '111', 10, 5), erp(3, '111', 12, 5)], 2, [], products, 'partial');
    expect(r.errors).toHaveLength(1);
    expect(r.summary.matched).toBe(1);
  });
});

describe('buildMarketplaceReview', () => {
  const mp = (rowNumber: number, id: string, barcodes: string[], price: number, available: boolean): MarketplaceRow => ({ rowNumber, marketplaceProductId: id, barcodes, name: '', price, available });
  const listings = [{ productId: 'p1', marketplaceProductId: 'M1', price: 10, available: true }, { productId: 'p2', marketplaceProductId: 'M2', price: 20, available: true }];
  it('matches on any barcode, detects changes, unmatched, missing', () => {
    const r = buildMarketplaceReview([mp(2, 'M1', ['000', '111'], 12, true), mp(3, 'MX', ['555'], 1, true)], 2, [], products, listings, 'full');
    expect(r.rows[0]).toMatchObject({ productId: 'p1', changeType: 'price' });
    expect(r.rows[1].changeType).toBe('unmatched');
    expect(r.summary).toMatchObject({ matched: 1, unmatched: 1, priceChanges: 1, missingFromFile: 1 });
  });
  it('falls back to SKU when no barcode matches', () => {
    expect(buildMarketplaceReview([mp(2, 'S2', ['000'], 20, false)], 1, [], products, listings, 'partial').rows[0]).toMatchObject({ productId: 'p2', changeType: 'availability' });
  });
  it('refuses to guess when a row matches two products', () => {
    const r = buildMarketplaceReview([mp(2, 'Z', ['111', '222'], 1, true)], 1, [], products, [], 'partial');
    expect(r.errors[0].reason).toMatch(/more than one product/);
    expect(r.rows).toHaveLength(0);
  });
  it('a product with no current listing is a change', () => {
    expect(buildMarketplaceReview([mp(2, 'M3', ['333'], 30, true)], 1, [], products, [], 'partial').rows[0].changeType).toBe('price_availability');
  });
});
