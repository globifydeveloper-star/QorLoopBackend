import { describe, expect, it } from '@jest/globals';
import { planErpApply, planListingApply, type ApplyProduct } from '../upload/apply.js';
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

describe('planListingApply', () => {
  it('keeps unmatched rows with a null product', () => {
    expect(planListingApply([{ parsed: { rowNumber: 2, marketplaceProductId: 'K1', barcodes: ['9'], name: '', price: 2, available: false }, productId: null }]))
      .toEqual([{ marketplaceProductId: 'K1', productId: null, barcodes: ['9'], name: null, price: 2, available: false }]);
  });
});
