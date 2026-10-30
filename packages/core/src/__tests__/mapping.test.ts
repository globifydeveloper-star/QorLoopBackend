import { describe, it, expect } from '@jest/globals';
import { detectTemplate, headerKey, looksLikeOtherSource, suggestMapping, validateMapping, signatureFor } from '../upload/mapping.js';
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

describe('saved layouts across Snoonu branch names', () => {
  const snoonuHeaders = (branch: string) => [
    'Barcode(UniqueIdentifier)', 'Product Name (En)(Update)', `Availability for ${branch}(Update)`, `Price For Branch ${branch}(Update)`,
  ];
  const A = snoonuHeaders('Shaklaan Food Center Gharrafat Al Rayyan');
  const B = snoonuHeaders('Al Meera Hypermarket Al Wakra');
  const fieldsA = { barcode1: A[0], name: A[1], available: A[2], price: A[3] };
  // what the API stores today: literal headers from signatureFor
  const savedA = { id: 'snoonuA', source: 'snoonu', name: 'Snoonu', version: 1, fields: fieldsA, signature: signatureFor(fieldsA, A) };

  it('keys the branch name out for Snoonu only', () => {
    expect(headerKey('snoonu', A[2])).toBe('availability for *(update)');
    expect(headerKey('snoonu', B[3])).toBe('price for branch *(update)');
    expect(headerKey('snoonu', 'Price For Branch  X (Update)')).toBe('price for branch *(update)');
    expect(headerKey('snoonu', A[0])).toBe('barcode(uniqueidentifier)');
    expect(headerKey('talabat', A[3])).toBe(A[3].toLowerCase());
  });

  it('a layout saved before this change still matches an identical file', () => {
    expect(savedA.signature).toEqual(A);
    expect(detectTemplate([savedA], 'snoonu', A)).toEqual(savedA);
  });

  it('recognises branch B with a layout saved for branch A and remaps its fields', () => {
    const hit = detectTemplate([savedA], 'snoonu', B);
    expect(hit?.id).toBe('snoonuA');
    expect(hit?.fields).toEqual({ barcode1: B[0], name: B[1], available: B[2], price: B[3] });
    expect(validateMapping('snoonu', hit!.fields, B)).toEqual([]);
    expect(savedA.fields).toEqual(fieldsA); // the saved template is not modified
  });

  it('two headers with the same key give no match', () => {
    expect(detectTemplate([savedA], 'snoonu', [...B, 'Availability for Al Meera Hypermarket Al Khor(Update)'])).toBeNull();
    expect(detectTemplate([savedA], 'snoonu', [...A, B[3]])).toBeNull();
  });

  it('other sources still compare the literal header', () => {
    const talabat = { id: 't', source: 'talabat', name: 't', version: 1, fields: { price: A[3] }, signature: [A[3]] };
    expect(detectTemplate([talabat], 'talabat', [A[3]])?.id).toBe('t');
    expect(detectTemplate([talabat], 'talabat', [B[3]])).toBeNull();
    expect(looksLikeOtherSource([savedA], 'rafeeq', B)).toBe('snoonu');
  });

  it('ERP and Talabat layouts match and keep their fields', () => {
    const erpFields = { barcode: 'UPC', nameEn: 'Item', price: 'Price', stock: 'Stock' };
    const erp = { id: 'e', source: 'erp', name: 'e', version: 1, fields: erpFields, signature: signatureFor(erpFields, Object.values(erpFields)) };
    expect(detectTemplate([erp], 'erp', ['UPC', 'Item', 'Price', 'Stock', 'Cost'])).toEqual(erp);
    expect(detectTemplate([erp], 'erp', ['UPC', 'Item', 'Price'])).toBeNull();
    const tFields = { marketplaceProductId: 'sku', barcode1: 'barcode 1', price: 'price', available: 'active' };
    const tal = { id: 't', source: 'talabat', name: 't', version: 1, fields: tFields, signature: Object.values(tFields) };
    expect(detectTemplate([tal], 'talabat', ['sku', 'barcode 1', 'barcode 2', 'name', 'price', 'active'])).toEqual(tal);
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
