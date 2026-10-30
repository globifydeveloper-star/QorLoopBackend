import { describe, it, expect } from '@jest/globals';
import ExcelJS from 'exceljs';
import { buildErrorWorkbook, errorReportFileName, safeCell } from '../upload/error-report.js';

async function read(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe('safeCell', () => {
  it.each(['=1+2', '=A1', '-5+cmd', '+1+1', '-', '-1e5', '-2,5', '@SUM(A1)', '\tx', '\rx', '\t-2', '=HYPERLINK("http://evil.test","x")'])('neutralises %j', (v) => {
    expect(safeCell(v)).toBe(`'${v}`);
  });
  it.each(['-2', '+3', '-1.5', '12', '0', 'abc', '1.5', ' =x', "'quoted", ''])('leaves %j alone', (v) => expect(safeCell(v)).toBe(v));
  it('treats null as empty', () => expect(safeCell(null)).toBe(''));
});

describe('errorReportFileName', () => {
  it.each([
    ['Daily stock (v2).csv', 'Dailystockv2-errors.xlsx'],
    ['erp_export-2026.10.30.xlsx', 'erp_export-2026.10.30-errors.xlsx'],
    ['a"; filename*=evil\r\n.xlsx', 'afilenameevil-errors.xlsx'],
    ['مخزون.xlsx', 'upload-errors.xlsx'],
    ['..hidden.csv', 'hidden-errors.xlsx'],
  ])('%j -> %j', (input, out) => expect(errorReportFileName(input)).toBe(out));
});

describe('buildErrorWorkbook', () => {
  it('writes a Summary sheet and a Row errors sheet, with formulas as plain text', async () => {
    const wb = await read(await buildErrorWorkbook({
      fileName: '=evil.csv', source: 'erp', total: 2,
      errors: [
        { row: 3, column: 'Barcode', value: null, reason: 'Barcode is empty' },
        { row: 4, column: 'Price', value: '=HYPERLINK("http://evil.test","x")', reason: 'Price must be a number above 0' },
        { row: 5, column: 'Stock', value: '-2', reason: 'Stock must be 0 or more' },
      ],
    }));
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Summary', 'Row errors']);
    const summary = wb.getWorksheet('Summary')!;
    expect(summary.getRow(1).values).toEqual([undefined, 'File', "'=evil.csv"]);
    expect(summary.getRow(3).values).toEqual([undefined, 'Total errors', 2]);
    expect(summary.rowCount).toBe(3);
    const sheet = wb.getWorksheet('Row errors')!;
    expect(sheet.getRow(1).values).toEqual([undefined, 'Row', 'Column', 'Value', 'Problem']);
    expect(sheet.getRow(2).values).toEqual([undefined, 3, 'Barcode', '', 'Barcode is empty']);
    const cell = sheet.getCell('C3');
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.formula).toBeUndefined();
    expect(cell.value).toBe('\'=HYPERLINK("http://evil.test","x")');
    const negative = sheet.getCell('C4');
    expect(negative.type).toBe(ExcelJS.ValueType.String);
    expect(negative.value).toBe('-2');
  });

  it('notes a truncated list', async () => {
    const errors = [{ row: 2, column: 'A', value: 'x', reason: 'bad' }];
    const cut = await read(await buildErrorWorkbook({ fileName: 'f.csv', source: 'snoonu', total: 7000, errors }));
    expect(cut.getWorksheet('Summary')!.getRow(4).values).toEqual([undefined, 'Note', 'Showing the first 1 of 7000 errors']);
    const unknown = await read(await buildErrorWorkbook({ fileName: 'f.csv', source: 'snoonu', total: 1, errors, mayHaveMore: true }));
    expect(unknown.getWorksheet('Summary')!.getRow(4).values).toEqual([undefined, 'Note', 'Showing the first 1 errors; the file may have more']);
  });

  it('has only the header row when there are no errors', async () => {
    const wb = await read(await buildErrorWorkbook({ fileName: 'f.xlsx', source: 'erp', total: 0, errors: [] }));
    expect(wb.getWorksheet('Row errors')!.rowCount).toBe(1);
  });
});
