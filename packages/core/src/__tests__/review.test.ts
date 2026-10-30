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
  it('counts rows whose cost was ignored, once per kept row', () => {
    const r = buildErpReview([{ ...erp(2, '111', 10, 5), costIgnored: true }, erp(3, '999', 5, 1), { ...erp(4, '111', 10, 5), costIgnored: true }], 3, [], products, 'partial');
    expect(r.summary.costIgnored).toBe(1); // the duplicate row 4 is an error, not a kept row
    expect(buildErpReview([erp(2, '111', 10, 5)], 1, [], products, 'partial').summary.costIgnored).toBe(0);
  });
  it('partial files never flag missing products', () => {
    expect(buildErpReview([erp(2, '111', 10, 5)], 1, [], products, 'partial').summary.missingFromFile).toBe(0);
  });
  it('flags duplicate barcodes within a file', () => {
    const r = buildErpReview([erp(2, '111', 10, 5), erp(3, '111', 12, 5)], 2, [], products, 'partial');
    expect(r.errors).toHaveLength(1);
    expect(r.summary.matched).toBe(1);
  });
  it('names the file\'s own column in review errors, the field key only when nothing is mapped', () => {
    const rows = [erp(2, '111', 10, 5), erp(3, '111', 12, 5)];
    expect(buildErpReview(rows, 2, [], products, 'partial', { barcode: 'UPC', stock: 'Stock' }).errors).toEqual([
      { row: 3, column: 'UPC', value: '111', reason: 'Duplicate barcode in this file' },
    ]);
    expect(buildErpReview(rows, 2, [], products, 'partial').errors[0].column).toBe('barcode');
  });
  it('leaves the columns of row-validation errors as they are', () => {
    const input = [{ row: 4, column: 'barcode', value: '', reason: 'Barcode is empty' }];
    expect(buildErpReview([], 1, input, products, 'partial', { barcode: 'UPC' }).errors).toEqual(input);
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
  it('names the file\'s own column in review errors', () => {
    const dup = [mp(2, 'M1', ['111'], 10, true), mp(3, 'M1', ['999'], 10, true)];
    const talabat = { marketplaceProductId: 'sku', barcode1: 'barcode 1', price: 'price', available: 'active' };
    expect(buildMarketplaceReview(dup, 2, [], products, [], 'partial', talabat).errors[0]).toEqual(
      { row: 3, column: 'sku', value: 'M1', reason: 'Duplicate marketplace product ID in this file' },
    );
    // Snoonu has no ID column: the ID is the barcode, so the barcode column is named
    const snoonu = { barcode1: 'Barcode(UniqueIdentifier)', price: 'Price For Branch X(Update)', available: 'Availability for X(Update)' };
    expect(buildMarketplaceReview(dup, 2, [], products, [], 'partial', snoonu).errors[0].column).toBe('Barcode(UniqueIdentifier)');
    expect(buildMarketplaceReview(dup, 2, [], products, [], 'partial').errors[0].column).toBe('marketplaceProductId');
    const twoProducts = [mp(2, 'Z', ['111', '222'], 1, true)];
    expect(buildMarketplaceReview(twoProducts, 1, [], products, [], 'partial', talabat).errors[0].column).toBe('barcode 1');
    expect(buildMarketplaceReview(twoProducts, 1, [], products, [], 'partial').errors[0].column).toBe('barcode');
  });
  it('a product with no current listing is a change', () => {
    expect(buildMarketplaceReview([mp(2, 'M3', ['333'], 30, true)], 1, [], products, [], 'partial').rows[0].changeType).toBe('price_availability');
  });
});
