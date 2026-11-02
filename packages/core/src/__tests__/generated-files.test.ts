import { describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import { GenerationBlocked, generatedFileName, planGeneratedFile, writeGeneratedFile, type GenerateParams } from '../generated-files.js';
import { readSpreadsheetValues } from '../upload/parse.js';
import { talabatHeaders, talabatMapping, talabatRows, snoonuHeaders, snoonuMapping, snoonuRows, fixtureRecon, marketplaceWorkbook } from './fixtures/marketplace-files.js';

const params: GenerateParams = { marketplaceId: 'talabat', kind: 'stock_price', scope: 'mismatches', reference: 'marketplace' };
const read = (buffer: Buffer, format: 'xlsx' | 'csv' = 'xlsx') => readSpreadsheetValues({ path: '', buffer }, format);

describe('marketplace round trip', () => {
  it.each(['talabat', 'snoonu'] as const)('keeps the real %s layout, selects recon rows and preserves types and every other cell', async source => {
    const snoonu = source === 'snoonu';
    const headers = snoonu ? snoonuHeaders : talabatHeaders, mapping = snoonu ? snoonuMapping : talabatMapping;
    const original = await read(await marketplaceWorkbook(headers, snoonu ? snoonuRows : talabatRows, true));
    const plan = planGeneratedFile(original, mapping, headers, fixtureRecon(snoonu), { ...params, marketplaceId: source });
    expect(plan).toMatchObject({ productCount: 3, priceChanges: 2, availabilityChanges: 3, notInFile: 1, largestPriceChange: { name: 'Milk', from: 1.75, to: 2.5 } });
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

  it('blocks unmapped or missing headers, quantities even for price files, duplicate identifiers, and empty selections', () => {
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
    expect(() => plan(mapping, undefined, [sheet.raw[0], sheet.raw[1], sheet.raw[1]])).toThrow('duplicate');
    expect(() => plan(mapping, undefined, undefined, [])).toThrow(GenerationBlocked);
  });

  it('uses Qatar time, the requested label and a safe file name', () => {
    const at = new Date('2026-11-02T21:07:00Z');
    expect(generatedFileName('Talabat', 'price', at, '.xlsx')).toBe('Talabat_Price_03Nov2026_0007.xlsx');
    expect(generatedFileName('../Snoonu"\r\n', 'stock_price', at, '.csv')).toBe('Snoonu_Update_03Nov2026_0007.csv');
  });
});
