import { describe, it, expect } from '@jest/globals';
import { detectTemplate, looksLikeOtherSource, suggestMapping, validateMapping, signatureFor } from '../upload/mapping.js';
import { mapRows, exceedsInvalidShare } from '../upload/validate.js';

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
  it('short hints only match whole words', () => {
    expect(suggestMapping('talabat', ['UniqueIdentifier', 'Paid', 'Item ID']).fields.marketplaceProductId).toBe('Item ID');
    expect(suggestMapping('talabat', ['UniqueIdentifier', 'Paid']).fields.marketplaceProductId).toBeUndefined();
    expect(suggestMapping('erp', ['Upcoming', 'UPC']).fields.barcode).toBe('UPC');
  });
  it('the product ID is required for Talabat only', () => {
    const noId = { barcode1: 'b', price: 'p', available: 'a' };
    expect(validateMapping('talabat', noId, ['b', 'p', 'a'])).toEqual(['Marketplace product ID must be mapped']);
    for (const source of ['snoonu', 'rafeeq', 'keeta']) expect(validateMapping(source, noId, ['b', 'p', 'a'])).toEqual([]);
  });
});

describe('real file headers', () => {
  // Snoonu names the availability and price columns after the branch, so the branch part varies per customer.
  const snoonu = (branch: string) => [
    'Barcode(UniqueIdentifier)',
    'Product Name (En)(Update)',
    `Availability for ${branch}(Update)`,
    `Price For Branch ${branch}(Update)`,
  ];

  it.each(['Shaklaan Food Center Gharrafat Al Rayyan', 'Al Meera Hypermarket Al Wakra'])('Snoonu (%s)', (branch) => {
    const headers = snoonu(branch);
    const s = suggestMapping('snoonu', headers);
    expect(s.fields).toEqual({ barcode1: headers[0], name: headers[1], available: headers[2], price: headers[3] });
    expect(s.fields).not.toHaveProperty('marketplaceProductId');
    expect(s.missingRequired).toEqual([]);
    expect(s.confidence).toBe(1);
    expect(validateMapping('snoonu', s.fields, headers)).toEqual([]);

    const r = mapRows('snoonu', [
      { [headers[0]]: '6281000000011', [headers[1]]: 'Laban 1L', [headers[2]]: 'True', [headers[3]]: '1.75' },
      { [headers[0]]: '6281000000028', [headers[1]]: 'Milk 2L', [headers[2]]: 'False', [headers[3]]: 4.5 },
    ], s.fields);
    expect(r.errors).toEqual([]);
    expect(r.marketplaceRows.map((x) => [x.marketplaceProductId, x.barcodes, x.name, x.price, x.available])).toEqual([
      ['6281000000011', ['6281000000011'], 'Laban 1L', 1.75, true],
      ['6281000000028', ['6281000000028'], 'Milk 2L', 4.5, false],
    ]);
  });

  it('Talabat', () => {
    const headers = ['sku', 'barcode 1', 'barcode 2', 'barcode 3', 'name', 'price', 'active'];
    const s = suggestMapping('talabat', headers);
    expect(s.fields).toEqual({
      marketplaceProductId: 'sku', barcode1: 'barcode 1', barcode2: 'barcode 2', barcode3: 'barcode 3',
      name: 'name', price: 'price', available: 'active',
    });
    expect(s.missingRequired).toEqual([]);
    expect(s.confidence).toBe(1);
    expect(validateMapping('talabat', s.fields, headers)).toEqual([]);
  });

  it('ERP', () => {
    const headers = ['UPC', 'Item', 'Price', 'Cost', 'Stock', 'Tag 1', 'Item Code'];
    const s = suggestMapping('erp', headers);
    expect(s.fields).toEqual({
      barcode: 'UPC', nameEn: 'Item', price: 'Price', cost: 'Cost', stock: 'Stock', category: 'Tag 1', sku: 'Item Code',
    });
    expect(s.missingRequired).toEqual([]);
    expect(s.confidence).toBe(1);
    expect(validateMapping('erp', s.fields, headers)).toEqual([]);
  });
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
