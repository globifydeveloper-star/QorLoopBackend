import { detectTemplate, looksLikeOtherSource, suggestMapping, validateMapping, signatureFor } from '../upload/mapping';
import { mapRows, exceedsInvalidShare } from '../upload/validate';

const tpl = (id: string, source: string, signature: string[]) => ({ id, source, name: id, version: 1, fields: {}, signature });

describe('layout detection', () => {
  const templates = [tpl('erp1', 'erp', ['Barcode', 'Sale Price']), tpl('snoonu1', 'snoonu', ['Barcode(UniqueIdentifier)', 'Price(Update)'])];
  it('matches when all signature headers are present, ignoring case and spacing', () => {
    expect(detectTemplate(templates, 'erp', ['  barcode ', 'SALE   price', 'Qty'])?.id).toBe('erp1');
  });
  it('does not match when one is missing', () => expect(detectTemplate(templates, 'erp', ['Barcode'])).toBeNull());
  it('does not match another source', () => expect(detectTemplate(templates, 'rafeeq', ['Barcode', 'Sale Price'])).toBeNull());
  it('wrong-file guard names the other source', () => {
    expect(looksLikeOtherSource(templates, 'rafeeq', ['Barcode(UniqueIdentifier)', 'Price(Update)', 'x'])).toBe('snoonu');
    expect(looksLikeOtherSource(templates, 'snoonu', ['Barcode(UniqueIdentifier)', 'Price(Update)'])).toBeNull();
  });
});

describe('suggestMapping', () => {
  it('maps an ERP export', () => {
    const s = suggestMapping('erp', ['Barcode', 'Item Name', 'Sale Price', 'Cost', 'Qty', 'Brand', 'Category']);
    expect(s.fields).toMatchObject({ barcode: 'Barcode', price: 'Sale Price', stock: 'Qty', cost: 'Cost', brand: 'Brand' });
    expect(s.missingRequired).toEqual([]);
  });
  it('reports missing required fields', () => {
    expect(suggestMapping('erp', ['Foo', 'Bar']).missingRequired).toEqual(expect.arrayContaining(['barcode', 'price', 'stock']));
  });
  it('never maps one column twice', () => {
    const vals = Object.values(suggestMapping('talabat', ['sku', 'barcode 1', 'name', 'price', 'active']).fields);
    expect(new Set(vals).size).toBe(vals.length);
  });
  it('validateMapping flags unknown columns and duplicates', () => {
    const headers = ['A', 'B'];
    expect(validateMapping('erp', { barcode: 'A', nameEn: 'A', price: 'B', stock: 'Z' }, headers).join('|')).toMatch(/Z.*not in the file/);
    expect(validateMapping('erp', { barcode: 'A', nameEn: 'A', price: 'B', stock: 'B' }, headers).join('|')).toMatch(/only be mapped to one/);
  });
  it('signatureFor keeps only existing headers', () => expect(signatureFor({ barcode: 'A', x: 'Z' }, ['A'])).toEqual(['A']));
});

describe('mapRows validation', () => {
  const fields = { barcode: 'bc', nameEn: 'name', price: 'price', stock: 'qty', active: 'active' };
  it('keeps valid rows and reports each bad one with row/column/value/reason', () => {
    const rows = [
      { bc: '0123', name: 'A', price: '1,250.50', qty: '3', active: 'yes' },
      { bc: '', name: 'B', price: 2, qty: 1 },
      { bc: '99', name: 'C', price: 'abc', qty: 1 },
      { bc: '98', name: 'D', price: 3, qty: -1 },
      { bc: '97', name: '', price: 3, qty: 1 },
    ];
    const r = mapRows('erp', rows, fields, [2, 3, 5, 6, 7]);
    expect(r.erpRows).toHaveLength(1);
    expect(r.erpRows[0]).toMatchObject({ barcode: '123', price: 1250.5, stock: 3, active: true, rowNumber: 2 });
    expect(r.errors.map((e) => [e.row, e.column, e.reason])).toEqual([
      [3, 'bc', 'Barcode is empty'],
      [5, 'price', 'Price must be a number above 0'],
      [6, 'qty', 'Stock must be 0 or more'],
      [7, 'name', 'Product name is empty'],
    ]);
  });
  it('marketplace rows accept True/False and quantities', () => {
    const f = { marketplaceProductId: 'id', barcode1: 'b1', barcode2: 'b2', price: 'p', available: 'a' };
    const r = mapRows('talabat', [
      { id: 'X1', b1: '0628', b2: '', p: 5, a: 'TRUE' },
      { id: 'X2', b1: '629', p: 5, a: 0 },
      { id: 'X3', b1: '630', p: 5, a: 12 },
      { id: 'X4', b1: '631', p: 5, a: 'maybe' },
    ], f);
    expect(r.marketplaceRows.map((x) => x.available)).toEqual([true, false, true]);
    expect(r.errors).toHaveLength(1);
  });
  it('20% invalid threshold', () => {
    expect(exceedsInvalidShare(10, 2, 0.2)).toBe(false);
    expect(exceedsInvalidShare(10, 3, 0.2)).toBe(true);
    expect(exceedsInvalidShare(0, 0, 0.2)).toBe(false);
  });
});
