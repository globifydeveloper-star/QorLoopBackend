import { describe, expect, it } from '@jest/globals';
import { planErpApply, planListingApply, productProblem, type ApplyProduct } from '../upload/apply.js';
import type { ErpRow } from '../upload/validate.js';

const product = (o: Partial<ApplyProduct> = {}): ApplyProduct => ({
  id: 'p1', normalizedBarcode: '111', sku: 'S1', nameEn: 'Laban', nameAr: null, brand: 'B', erpCategory: 'Dairy',
  erpPrice: 1.5, costPrice: 1, erpStock: 5, erpActive: true, inLatestErpFile: true, ...o,
});
const row = (o: Partial<ErpRow> = {}): ErpRow => ({ rowNumber: 2, barcode: '111', nameEn: 'Laban', price: 1.5, stock: 5, active: true, ...o });
const required = ['barcode', 'nameEn', 'price', 'stock'];

describe('planErpApply', () => {
  it('creates unknown barcodes with the given status and leaves unchanged products alone', () => {
    const plan = planErpApply([row(), row({ barcode: '222', nameEn: 'Milk', nameAr: 'حليب' })], [product()], required, 'new');
    expect(plan.create).toEqual([{ normalizedBarcode: '222', sku: null, nameEn: 'Milk', nameAr: 'حليب', brand: null, erpCategory: null, erpPrice: 1.5, costPrice: null, erpStock: 5, erpActive: true, status: 'new' }]);
    expect(plan.update).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.barcodes).toEqual(['111', '222']);
  });

  it('only writes mapped columns: an unmapped column keeps its value, a mapped empty cell clears it', () => {
    const plan = planErpApply([row({ brand: undefined, cost: undefined })], [product()], [...required, 'brand'], 'new');
    expect(plan.changes).toEqual([{ productId: 'p1', field: 'brand', old: 'B', new: null }]);
    expect(plan.update).toEqual([expect.objectContaining({ id: 'p1', brand: null, costPrice: 1, sku: 'S1' })]);
  });

  it('fills nameAr only when empty, re-marks a product as in the file, and compares money at 3 decimals', () => {
    const plan = planErpApply(
      [row({ nameAr: 'لبن', price: 1.5004 }), row({ barcode: '333', nameAr: 'new name' })],
      [product({ inLatestErpFile: false }), product({ id: 'p3', normalizedBarcode: '333', nameAr: 'kept' })],
      [...required, 'nameAr'], 'new',
    );
    expect(plan.changes).toEqual([
      { productId: 'p1', field: 'nameAr', old: null, new: 'لبن' },
      { productId: 'p1', field: 'inLatestErpFile', old: false, new: true },
    ]);
    expect(plan.update.map(u => u.id)).toEqual(['p1']);
  });
});

describe('planErpApply skips rows the database would refuse', () => {
  it('a negative cost staged before validation ignored it: blank on a new product, existing cost kept, nothing skipped', () => {
    const plan = planErpApply(
      [row({ barcode: '6291069207200', cost: -42.8 }), row({ cost: -1, price: 2 })],
      [product()], [...required, 'cost'], 'active',
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.create).toEqual([expect.objectContaining({ normalizedBarcode: '6291069207200', costPrice: null })]);
    expect(plan.update).toEqual([expect.objectContaining({ id: 'p1', erpPrice: 2, costPrice: 1 })]);
    expect(plan.changes.map(c => c.field)).toEqual(['erpPrice']);
  });

  it('each CHECK constraint and column limit: the row is skipped with its row number and a reason, the rest still applies', () => {
    const plan = planErpApply([
      row({ rowNumber: 2, barcode: '0123' }),
      row({ rowNumber: 3, barcode: '12a' }),
      row({ rowNumber: 4, barcode: '444', price: -1 }),
      row({ rowNumber: 5, barcode: '555', price: 1e12 }),
      row({ rowNumber: 6, barcode: '666', stock: -3 }),
      row({ rowNumber: 7, barcode: '777', stock: 1.5 }),
      row({ rowNumber: 8, barcode: '888', nameEn: '' }),
      row({ rowNumber: 9, price: 1e12 }), // an update of p1
      row({ rowNumber: 10, barcode: '999' }),
    ], [product()], required, 'new');
    expect(plan.skipped).toEqual([
      { rowNumber: 2, reason: 'Barcode must be digits only and not start with 0' },
      { rowNumber: 3, reason: 'Barcode must be digits only and not start with 0' },
      { rowNumber: 4, reason: 'Price must be 0 or more and below 1,000,000,000' },
      { rowNumber: 5, reason: 'Price must be 0 or more and below 1,000,000,000' },
      { rowNumber: 6, reason: 'Stock must be a whole number, 0 or more' },
      { rowNumber: 7, reason: 'Stock must be a whole number, 0 or more' },
      { rowNumber: 8, reason: 'Product name is empty' },
      { rowNumber: 9, reason: 'Price must be 0 or more and below 1,000,000,000' },
    ]);
    expect(plan.create.map(c => c.normalizedBarcode)).toEqual(['999']);
    // a skipped update writes nothing and records no change
    expect(plan.update).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it('productProblem mirrors product_status_valid and product_money_valid on cost', () => {
    const ok = { normalizedBarcode: '1', nameEn: 'A', erpPrice: 0, costPrice: null, erpStock: 0 };
    expect(productProblem(ok)).toBeNull();
    expect(productProblem({ ...ok, costPrice: 0 })).toBeNull();
    expect(productProblem({ ...ok, costPrice: -0.001 })).toBe('Cost must be 0 or more and below 1,000,000,000');
    expect(productProblem({ ...ok, status: 'archived' })).toBe('Product status is not valid');
    expect(productProblem({ ...ok, status: 'inactive' })).toBeNull();
  });
});

describe('planListingApply', () => {
  it('keeps unmatched rows with a null product', () => {
    expect(planListingApply([{ parsed: { rowNumber: 2, marketplaceProductId: 'K1', barcodes: ['9'], name: '', price: 2, available: false }, productId: null }]))
      .toEqual({ listings: [{ marketplaceProductId: 'K1', productId: null, barcodes: ['9'], name: null, price: 2, available: false }], skipped: [] });
  });
  it('skips a listing that breaks listing_price_valid or has no ID', () => {
    const r = (rowNumber: number, o: object) => ({ parsed: { rowNumber, marketplaceProductId: `K${rowNumber}`, barcodes: ['9'], name: 'n', price: 2, available: true, ...o }, productId: null });
    const plan = planListingApply([r(2, { price: -1 }), r(3, { marketplaceProductId: '' }), r(4, {})]);
    expect(plan.listings.map(l => l.marketplaceProductId)).toEqual(['K4']);
    expect(plan.skipped).toEqual([
      { rowNumber: 2, reason: 'Price must be 0 or more and below 1,000,000,000' },
      { rowNumber: 3, reason: 'Marketplace product ID is empty' },
    ]);
  });
});
