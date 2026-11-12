import { describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import { GenerationBlocked, duplicateRowsWarning, generatedFileName, planGeneratedFile, writeGeneratedFile, type GenerateParams } from '../generated-files.js';
import { readSpreadsheetValues } from '../upload/parse.js';
import { talabatHeaders, talabatMapping, talabatRows, snoonuHeaders, snoonuMapping, snoonuRows, snoonuRowsWithDuplicate, barcodes, fixtureRecon, marketplaceWorkbook } from './fixtures/marketplace-files.js';

const params: GenerateParams = { marketplaceId: 'talabat', kind: 'stock_price', scope: 'mismatches', reference: 'marketplace' };
const read = (buffer: Buffer, format: 'xlsx' | 'csv' = 'xlsx') => readSpreadsheetValues({ path: '', buffer }, format);

describe('marketplace round trip', () => {
  it.each(['talabat', 'snoonu'] as const)('keeps the real %s layout, selects recon rows and preserves types and every other cell', async source => {
    const snoonu = source === 'snoonu';
    const headers = snoonu ? snoonuHeaders : talabatHeaders, mapping = snoonu ? snoonuMapping : talabatMapping;
    const original = await read(await marketplaceWorkbook(headers, snoonu ? snoonuRows : talabatRows, true));
    const plan = planGeneratedFile(original, mapping, headers, fixtureRecon(snoonu), { ...params, marketplaceId: source });
    expect(plan).toMatchObject({ productCount: 3, rowsToWrite: 3, duplicateRows: null, priceChanges: 2, availabilityChanges: 3, notInFile: 1, largestPriceChange: { name: 'Milk', from: 1.75, to: 2.5 } });
    const written = await read(await writeGeneratedFile(plan, 'xlsx'));
    expect(written.sheetName).toBe('Marketplace');
    expect(written.raw[0]).toEqual(original.raw[0]); // preamble
    expect(written.raw[1]).toEqual(original.raw[1]); // all original headers
    expect(written.raw).toHaveLength(5);
    const price = snoonu ? 3 : 2, available = snoonu ? 2 : 3;
    [0, 1, 3].forEach((sourceIndex, resultIndex) => {
      const before = original.raw[sourceIndex + 2], after = written.raw[resultIndex + 2];
      for (let column = 0; column < headers.length; column++) {
        if (column !== price && column !== available) expect(after[column] ?? null).toEqual(before[column] ?? null);
      }
      expect(typeof after[price]).toBe('string');
      expect(typeof after[available]).toBe(snoonu ? 'string' : 'boolean');
    });
    expect(written.raw[2][price]).toBe('2.50');
    expect(written.raw[2][available]).toBe(snoonu ? 'False' : false);
    expect(plan.firstRows).toHaveLength(plan.productCount);
    expect(plan.firstRows[0][headers[price]]).toBe(written.raw[2][price]);
  });

  it('stock changes only availability, price changes only price, and the ERP reference uses stored ERP prices', async () => {
    const original = await read(await marketplaceWorkbook(talabatHeaders, talabatRows));
    const stock = planGeneratedFile(original, talabatMapping, talabatHeaders, fixtureRecon(), { ...params, kind: 'stock' });
    expect(stock).toMatchObject({ productCount: 3, priceChanges: 0, availabilityChanges: 3 });
    expect(stock.rows.slice(1).map(row => row[2])).toEqual(['1.75', '3.00', '5.00']);
    const price = planGeneratedFile(original, talabatMapping, talabatHeaders, fixtureRecon(), { ...params, kind: 'price', reference: 'erp' });
    expect(price).toMatchObject({ productCount: 1, priceChanges: 1, availabilityChanges: 0, notInFile: 1 });
    expect(price.rows[1].slice(2, 4)).toEqual(['2.00', true]);
    const all = planGeneratedFile(original, talabatMapping, talabatHeaders, fixtureRecon(), { ...params, scope: 'all' });
    expect(all.productCount).toBe(3); // listed, excluding missing_from_erp; missing source row still skipped
    expect(all.notInFile).toBe(1);
    expect(all.rows.slice(1).map(row => row[0])).toEqual(['T0', 'T1', 'T2']);
  });

  it('preserves numeric prices and numeric boolean availability', async () => {
    const sheet = { sheetName: 'S', raw: [['id', 'p', 'a'], ['T0', 1.75, 1]] };
    const plan = planGeneratedFile(sheet, { marketplaceProductId: 'id', price: 'p', available: 'a' }, ['id', 'p', 'a'], fixtureRecon().slice(0, 1), params);
    expect(plan.rows[1]).toEqual(['T0', 2.5, 0]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await writeGeneratedFile(plan, 'xlsx') as unknown as ArrayBuffer);
    expect(wb.worksheets[0].getCell('B2').type).toBe(ExcelJS.ValueType.Number);
    expect(wb.worksheets[0].getCell('C2').type).toBe(ExcelJS.ValueType.Number);
  });

  it('CSV round trip preserves quoting, semicolon delimiters, UTF-8, newlines, text prices and boolean text', async () => {
    const buffer = Buffer.from('\uFEFFid;name;price;active;other\r\nT0;"حليب; \"\"fresh\"\"\nMilk";1.750;True;"a;b"\r\n');
    const original = await read(buffer, 'csv');
    const plan = planGeneratedFile(original, { marketplaceProductId: 'id', price: 'price', available: 'active' }, ['id', 'name', 'price', 'active', 'other'], fixtureRecon().slice(0, 1), params);
    const body = await writeGeneratedFile(plan, 'csv');
    const output = await read(body, 'csv');
    expect(output.raw[1]).toEqual(['T0', 'حليب; "fresh"\nMilk', '2.500', 'False', 'a;b']);
    expect(body.toString('utf8')).toContain('"a;b"');
  });

  it('flattens formulas, hyperlinks and rich text and neutralises dangerous text, including headers', async () => {
    const headers = ['id', 'price', 'active', 'formula', 'link', 'rich', 'danger', '-2'];
    const original = await read(await marketplaceWorkbook(headers, [['T0', '1.75', true, { formula: '1+1', result: 2 },
      { text: 'click', hyperlink: 'https://example.test' }, { richText: [{ text: 'plain ' }, { text: 'text', font: { bold: true } }] }, '=HYPERLINK("bad")', '-2']]));
    const plan = planGeneratedFile(original, { marketplaceProductId: 'id', price: 'price', available: 'active' }, headers, fixtureRecon().slice(0, 1), params);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await writeGeneratedFile(plan, 'xlsx') as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getRow(2).values).toEqual([undefined, 'T0', '2.50', false, 2, 'click', 'plain text', '\'=HYPERLINK("bad")', '-2']);
    ws.eachRow(row => row.eachCell(cell => expect([ExcelJS.ValueType.Formula, ExcelJS.ValueType.Hyperlink, ExcelJS.ValueType.RichText]).not.toContain(cell.type)));
  });

  it.each(['=cmd', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd'])('neutralises %j in CSV output too', async dangerous => {
    const original = { sheetName: 'csv', raw: [['id', 'price', 'active', 'extra'], ['T0', '1.75', '1', dangerous]] };
    const plan = planGeneratedFile(original, { marketplaceProductId: 'id', price: 'price', available: 'active' }, original.raw[0], fixtureRecon().slice(0, 1), params);
    expect((await read(await writeGeneratedFile(plan, 'csv'), 'csv')).raw[1][3]).toBe(`'${dangerous}`);
  });

  it('uses barcode normalisation only for the saved barcode identifier mapping', async () => {
    const original = await read(await marketplaceWorkbook(snoonuHeaders, [['006281000000011', 'Milk', 'True', '1.75']]));
    expect(planGeneratedFile(original, snoonuMapping, snoonuHeaders, fixtureRecon(true).slice(0, 1), { ...params, marketplaceId: 'snoonu' }).productCount).toBe(1);
  });

  it('neutralises changed text cells too and retains literal header whitespace in the preview', () => {
    const original = { sheetName: 'S', raw: [[' id ', ' price ', ' active '], ['T0', '\r1.75', '\rTrue']] };
    const plan = planGeneratedFile(original, { marketplaceProductId: 'id', price: 'price', available: 'active' }, ['id', 'price', 'active'], fixtureRecon().slice(0, 1), params);
    expect(plan.rows[1]).toEqual(['T0', "'\r2.50", "'\rFalse"]);
    expect(plan.firstRows[0]).toEqual({ ' id ': 'T0', ' price ': "'\r2.50", ' active ': "'\rFalse" });
  });

  it('blocks unmapped or missing headers, quantities even for price files, two recon rows for one identifier, and empty selections', () => {
    const sheet = { sheetName: 'S', raw: [['id', 'price', 'active'], ['T0', '1.75', true]] };
    const mapping = { marketplaceProductId: 'id', price: 'price', available: 'active' };
    const plan = (m: unknown, headers: string[] = sheet.raw[0] as string[], raw = sheet.raw, rows = fixtureRecon().slice(0, 1)) => planGeneratedFile({ ...sheet, raw }, m, headers, rows, params);
    expect(() => plan({ ...mapping, price: '' })).toThrow('price column is not mapped');
    expect(() => plan({ ...mapping, available: '' })).toThrow('availability column is not mapped');
    expect(() => plan({ price: 'price', available: 'active' })).toThrow('identifying column is not mapped');
    expect(() => plan(mapping, ['id', 'active'])).toThrow('headers no longer include');
    expect(() => plan({ ...mapping, price: 'old' })).toThrow('headers no longer include');
    expect(() => plan(mapping, undefined, [sheet.raw[0], ['T0', '1.75', 4]])).toThrow('quantities');
    expect(() => planGeneratedFile({ ...sheet, raw: [sheet.raw[0], ['T0', '1.75', '6']] }, mapping, sheet.raw[0], fixtureRecon().slice(0, 1), { ...params, kind: 'price' })).toThrow('quantities');
    expect(() => plan(mapping, undefined, undefined, [])).toThrow(GenerationBlocked);
    expect(() => plan(mapping, undefined, undefined, [...fixtureRecon().slice(0, 1), { ...fixtureRecon()[0], productId: 'other' }])).toThrow('Multiple reconciliation rows');
  });

  it('writes the same expected values to every row of a duplicated identifier and leaves other rows and cells untouched', async () => {
    const original = await read(await marketplaceWorkbook(snoonuHeaders, snoonuRowsWithDuplicate, true));
    const plan = planGeneratedFile(original, snoonuMapping, snoonuHeaders, fixtureRecon(true), { ...params, marketplaceId: 'snoonu' });
    // Same selection as the unique-identifier Snoonu file: Milk, Fruit, Missing ERP. Milk now has two rows.
    expect(plan).toMatchObject({ productCount: 3, rowsToWrite: 4, priceChanges: 2, availabilityChanges: 3, notInFile: 1, duplicateRows: { products: 1, extraRows: 1 } });
    expect(duplicateRowsWarning('Snoonu', plan.duplicateRows)).toBe('1 product appears on more than one row of the Snoonu file; all its rows are updated');
    expect(duplicateRowsWarning('Snoonu', { products: 37, extraRows: 37 })).toBe('37 products appear on more than one row of the Snoonu file; all their rows are updated');
    const written = await read(await writeGeneratedFile(plan, 'xlsx'));
    expect(written.raw.slice(0, 2)).toEqual(original.raw.slice(0, 2));
    expect(written.raw).toHaveLength(2 + plan.rowsToWrite);
    // Source rows 0 (Milk), 1 (Fruit), 2 (Milk again), 4 (Missing ERP) in source order; Bread (3) is in sync.
    const sourceIndexes = [0, 1, 2, 4];
    sourceIndexes.forEach((sourceIndex, resultIndex) => {
      const before = original.raw[sourceIndex + 2], after = written.raw[resultIndex + 2];
      for (let column = 0; column < snoonuHeaders.length; column++) {
        if (column !== 2 && column !== 3) expect(after[column] ?? null).toEqual(before[column] ?? null);
      }
      expect(typeof after[2]).toBe('string');
      expect(typeof after[3]).toBe('string');
    });
    const [milk, , milkAgain] = written.raw.slice(2);
    expect(milk.slice(2)).toEqual(['False', '2.50']);
    expect(milkAgain).toEqual(['00' + barcodes[0], 'Milk 1L (second listing)', 'FALSE', '2.500']); // own casing and decimals
    expect(Number(milkAgain[3])).toBe(Number(milk[3]));
    expect(plan.firstRows).toHaveLength(plan.rowsToWrite);
  });

  it('reports no duplicates and equal product and row counts for unique identifiers', async () => {
    for (const [headers, rows, mapping, snoonu] of [[talabatHeaders, talabatRows, talabatMapping, false], [snoonuHeaders, snoonuRows, snoonuMapping, true]] as const) {
      const plan = planGeneratedFile(await read(await marketplaceWorkbook([...headers], rows.map(r => [...r]))), mapping, headers, fixtureRecon(snoonu), params);
      expect(plan).toMatchObject({ productCount: 3, rowsToWrite: 3, duplicateRows: null });
      expect(duplicateRowsWarning('Talabat', plan.duplicateRows)).toBeNull();
    }
  });

  it('counts a duplicated product once for price changes even when only one of its rows already had the new price', () => {
    const sheet = { sheetName: 'S', raw: [['id', 'price', 'active'], ['T0', '2.50', false], ['T0', '1.75', true], [' T0 ', '2.5', false]] };
    const plan = planGeneratedFile(sheet, { marketplaceProductId: 'id', price: 'price', available: 'active' }, ['id', 'price', 'active'], fixtureRecon().slice(0, 1), params);
    expect(plan).toMatchObject({ productCount: 1, rowsToWrite: 3, priceChanges: 1, availabilityChanges: 1, duplicateRows: { products: 1, extraRows: 2 } });
    expect(plan.rows.slice(1)).toEqual([['T0', '2.50', false], ['T0', '2.50', false], [' T0 ', '2.5', false]]);
  });

  it('uses Qatar time, the requested label and a safe file name', () => {
    const at = new Date('2026-11-02T21:07:00Z');
    expect(generatedFileName('Talabat', 'price', at, '.xlsx')).toBe('Talabat_Price_03Nov2026_0007.xlsx');
    expect(generatedFileName('../Snoonu"\r\n', 'stock_price', at, '.csv')).toBe('Snoonu_Update_03Nov2026_0007.csv');
  });
});

describe('export values (migration 202611100001, owner decision C)', () => {
  it('a pending export value is written in every file, even when the comparison is in sync; a value the marketplace shows is left alone', async () => {
    const original = await read(await marketplaceWorkbook(talabatHeaders, talabatRows));
    const rows = fixtureRecon().map(r => r.productId === 'p2'
      ? { ...r, exportPrice: 4.5, exportAvailable: false, overridesPrice: true, overridesAvailability: true, pendingPrice: true, pendingAvailability: true }
      : r.productId === 'p0' ? { ...r, exportPrice: 1.75, overridesPrice: true } : r);
    const price = planGeneratedFile(original, talabatMapping, talabatHeaders, rows, { ...params, kind: 'price' });
    // T0: pinned at the price the marketplace shows (no rewrite); T1: catalogue mismatch; T2: in sync but a pending 4.50
    expect(price.rows.slice(1).map(row => [row[0], row[2]])).toEqual([['T1', '3.30'], ['T2', '4.50']]);
    expect(price.exportValueProducts).toBe(1);
    // the ERP-reference file writes the export value too; rows without one keep the ERP value as before
    const erp = planGeneratedFile(original, talabatMapping, talabatHeaders, rows, { ...params, reference: 'erp' });
    expect(erp.rows.find(row => row[0] === 'T2')!.slice(2, 4)).toEqual(['4.50', false]);
    expect(erp.rows.find(row => row[0] === 'T1')![2]).toBe('3.00');
  });
});
