import { describe, expect, it } from '@jest/globals';
import {
  STOCK_IN_EFFECT_DURING_CONFLICT, catalogueStock, planBulkStockEdit, planConflictResolution, planErpStockConflicts, planStockEdit,
  stockAfterErpChange, stockPlanSignature, type StockEdit,
} from '../catalogue-stock.js';
import { erpChangeKind } from '../upload/apply.js';

const edit = (o: Partial<StockEdit> = {}): StockEdit => ({ stock: 3, erpStockAtEdit: 10, state: 'active', ...o });

describe('catalogueStock', () => {
  it('is the ERP stock without an edit, and the owner value with one', () => {
    expect(catalogueStock(10, null)).toEqual({ stock: 10, source: 'erp' });
    expect(catalogueStock(10, edit())).toEqual({ stock: 3, source: 'owner' });
  });
  it('D1: the owner value stays in effect while a conflict is open', () => {
    expect(STOCK_IN_EFFECT_DURING_CONFLICT).toBe('owner');
    expect(catalogueStock(12, edit({ state: 'conflict' }))).toEqual({ stock: 3, source: 'owner' });
    // the other policy, behind the one constant
    expect(catalogueStock(12, edit({ state: 'conflict' }), 'erp')).toEqual({ stock: 12, source: 'erp' });
    expect(catalogueStock(12, edit(), 'erp')).toEqual({ stock: 3, source: 'owner' });
  });
});

describe('stockAfterErpChange / planErpStockConflicts', () => {
  it('a new ERP stock different from the edit base is a conflict; equal to the owner value clears the edit', () => {
    expect(stockAfterErpChange(edit(), 12)).toBe('conflict');
    expect(stockAfterErpChange(edit(), 3)).toBe('erp_matches');
    expect(stockAfterErpChange(edit({ state: 'conflict' }), 10)).toBe('erp_reverted');
    expect(stockAfterErpChange(edit(), 10)).toBe('unchanged');
    expect(stockAfterErpChange(edit({ state: 'conflict' }), 15)).toBe('conflict');
  });
  it('only products whose ERP stock changed and that have an edit are planned', () => {
    const edits = new Map([['a', edit()], ['b', edit()], ['c', edit({ state: 'conflict' })], ['d', edit()]]);
    const plan = planErpStockConflicts([
      { productId: 'a', old: 10, new: 12 }, // conflict
      { productId: 'b', old: 10, new: 3 }, // ERP caught up
      { productId: 'c', old: 12, new: 10 }, // back to the base
      { productId: 'd', old: 10, new: 10 }, // not a change
      { productId: 'x', old: 1, new: 2 }, // no edit
    ], edits);
    expect(plan.conflicts).toEqual([{ productId: 'a', ownerStock: 3, erpStockAtEdit: 10, oldErpStock: 10, erpStock: 12, wasConflict: false }]);
    expect(plan.cleared.map(e => e.productId)).toEqual(['b']);
    expect(plan.reverted.map(e => e.productId)).toEqual(['c']);
  });
});

describe('planStockEdit', () => {
  const t = (e: StockEdit | null, erpStock = 10) => ({ id: 'p', erpStock, edit: e });
  it('sets an owner value against the current ERP stock', () => {
    expect(planStockEdit(t(null), { mode: 'set', stock: 4 })).toEqual({
      productId: 'p', op: 'set', erpStock: 10, old: { stock: 10, source: 'erp', state: null }, new: { stock: 4, source: 'owner' },
    });
  });
  it('setting the ERP value, or going back to ERP, clears an edit; without an edit nothing changes', () => {
    expect(planStockEdit(t(edit()), { mode: 'set', stock: 10 })?.op).toBe('clear');
    expect(planStockEdit(t(edit()), { mode: 'erp' })?.op).toBe('clear');
    expect(planStockEdit(t(null), { mode: 'erp' })).toBeNull();
    expect(planStockEdit(t(null), { mode: 'set', stock: 10 })).toBeNull();
  });
  it('the same active value is unchanged; on an open conflict it re-bases the edit ("keep mine")', () => {
    expect(planStockEdit(t(edit()), { mode: 'set', stock: 3 })).toBeNull();
    const keep = planStockEdit(t(edit({ state: 'conflict' }), 12), { mode: 'set', stock: 3 });
    expect(keep).toMatchObject({ op: 'set', erpStock: 12, old: { stock: 3, source: 'owner', state: 'conflict' } });
  });
  it('bulk counts unchanged and not-found products', () => {
    const plan = planBulkStockEdit([t(null), { ...t(edit()), id: 'q' }], 2, { mode: 'set', stock: 3 });
    expect(plan.changes.map(c => c.productId)).toEqual(['p']);
    expect(plan.unchanged).toBe(1);
    expect(plan.notFound).toBe(2);
  });
});

describe('planConflictResolution', () => {
  it('resolves open conflicts only', () => {
    const plan = planConflictResolution([
      { id: 'a', erpStock: 12, edit: edit({ state: 'conflict' }) },
      { id: 'b', erpStock: 10, edit: edit() },
      { id: 'c', erpStock: 10, edit: null },
    ], 1, 'keep');
    expect(plan.changes).toEqual([{ productId: 'a', choice: 'keep', ownerStock: 3, erpStock: 12, erpStockAtEdit: 10 }]);
    expect(plan.notInConflict).toBe(2);
    expect(plan.notFound).toBe(1);
  });
});

describe('stockPlanSignature', () => {
  it('ignores order and changes with any planned value', () => {
    const a = planStockEdit({ id: 'a', erpStock: 1, edit: null }, { mode: 'set', stock: 2 })!;
    const b = planStockEdit({ id: 'b', erpStock: 1, edit: null }, { mode: 'set', stock: 2 })!;
    expect(stockPlanSignature([a, b])).toBe(stockPlanSignature([b, a]));
    const c = planStockEdit({ id: 'b', erpStock: 1, edit: null }, { mode: 'set', stock: 3 })!;
    expect(stockPlanSignature([a, c])).not.toBe(stockPlanSignature([a, b]));
  });
});

describe('erpChangeKind', () => {
  it.each([
    ['erpPrice', 2, 'price'], ['costPrice', 1, 'cost'], ['erpStock', 3, 'stock'], ['nameEn', 'x', 'name'], ['erpActive', false, 'active'],
    ['inLatestErpFile', false, 'missing'], ['inLatestErpFile', true, 'returned'], ['sku', 'S', 'other'], ['brand', null, 'other'],
    ['erpCategory', 'D', 'other'], ['nameAr', 'ع', 'other'],
  ] as const)('%s -> %s', (field, next, kind) => {
    expect(erpChangeKind(field, next)).toBe(kind);
  });
});
