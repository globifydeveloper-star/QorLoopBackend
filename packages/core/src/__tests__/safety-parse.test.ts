import { describe, it, expect } from '@jest/globals';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectFile } from '../upload/safety.js';
import { parseSpreadsheet, ParseError, rowsToSheet } from '../upload/parse.js';

async function xlsxBuffer(rows: unknown[][], sheet = 'Sheet1') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const tmp = (name: string, data: Buffer | string) => {
  const dir = mkdtempSync(join(tmpdir(), 'qorloop-test-'));
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

describe('inspectFile', () => {
  it('accepts a real xlsx, csv and xls', async () => {
    expect(inspectFile(await xlsxBuffer([['a', 'b'], [1, 2]]), 'a.xlsx')).toEqual({ ok: true, format: 'xlsx' });
    expect(inspectFile(Buffer.from('a,b\n1,2\n'), 'a.csv')).toEqual({ ok: true, format: 'csv' });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'S');
    expect(inspectFile(Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'biff8' })), 'a.xls')).toEqual({ ok: true, format: 'xls' });
  });
  it('rejects other extensions, empty and oversized files', () => {
    expect(inspectFile(Buffer.from('x'), 'a.exe')).toMatchObject({ ok: false, code: 'bad_extension' });
    expect(inspectFile(Buffer.alloc(0), 'a.csv')).toMatchObject({ ok: false, code: 'empty' });
    expect(inspectFile(Buffer.alloc(25 * 1024 * 1024 + 1, 97), 'a.csv')).toMatchObject({ ok: false, code: 'too_large' });
  });
  it('does not trust the extension: an exe renamed .xlsx is rejected', () => {
    expect(inspectFile(Buffer.from('MZ\x90\x00 not a workbook'), 'a.xlsx')).toMatchObject({ ok: false, code: 'wrong_type' });
  });
  it('rejects binary content with a .csv name', () => {
    expect(inspectFile(Buffer.from([0x61, 0x2c, 0x00, 0x01, 0x02]), 'a.csv')).toMatchObject({ ok: false, code: 'binary_csv' });
  });
  it('rejects a macro-enabled workbook', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await xlsxBuffer([['a']]));
    zip.file('xl/vbaProject.bin', Buffer.from('macro'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    expect(inspectFile(buf, 'a.xlsx')).toMatchObject({ ok: false, code: 'macros' });
  });
  it('rejects a zip bomb (tiny file, huge expansion)', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await xlsxBuffer([['a']]));
    zip.file('xl/worksheets/bomb.xml', Buffer.alloc(300 * 1024 * 1024, 0), { compression: 'DEFLATE', compressionOptions: { level: 9 } });
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    expect(buf.length).toBeLessThan(25 * 1024 * 1024);
    expect(inspectFile(buf, 'a.xlsx')).toMatchObject({ ok: false, code: 'zip_bomb' });
  });
  it('rejects an OLE container named .xlsx (password-protected workbooks look like this)', () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('EncryptedPackage', 'utf16le'), Buffer.alloc(64)]);
    expect(inspectFile(ole, 'a.xlsx')).toMatchObject({ ok: false, code: 'encrypted' });
  });
});

describe('parseSpreadsheet', () => {
  it('reads xlsx with real row numbers, skipping title rows and blank lines', async () => {
    const buf = await xlsxBuffer([['Stock report'], ['Barcode', 'Price'], ['111', 1.5], [], ['222', '=1+1']]);
    const r = await parseSpreadsheet({ path: tmp('a.xlsx', buf) }, 'xlsx');
    expect(r.headers).toEqual(['Barcode', 'Price']);
    expect(r.rows).toHaveLength(2);
    expect(r.rowNumbers).toEqual([3, 5]);
  });
  it('keeps formula results, never the formula', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['a', 'b']);
    ws.addRow([1, { formula: 'A2*2', result: 2 }]);
    const r = await parseSpreadsheet({ path: tmp('f.xlsx', Buffer.from(await wb.xlsx.writeBuffer())) }, 'xlsx');
    expect(r.rows[0]).toEqual({ a: 1, b: 2 });
  });
  it('reads csv (semicolon delimiter, BOM, quotes)', async () => {
    const csv = '﻿Barcode;Name\n111;"A; B"\n222;C\n';
    const r = await parseSpreadsheet({ path: tmp('a.csv', csv) }, 'csv');
    expect(r.headers).toEqual(['Barcode', 'Name']);
    expect(r.rows[0].Name).toBe('A; B');
  });
  it('reads legacy xls', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Barcode', 'Price'], ['111', 2]]), 'S');
    const r = await parseSpreadsheet({ path: tmp('a.xls', Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }))) }, 'xls');
    expect(r.rows).toEqual([{ Barcode: '111', Price: 2 }]);
  });
  it('renames blank and duplicate headers', () => {
    expect(rowsToSheet('s', [['a', 'a', '', 'b'], [1, 2, 3, 4]]).headers).toEqual(['a', 'a (2)', 'Column 3', 'b']);
  });
  it('rejects a sheet with no header', () => {
    expect(() => rowsToSheet('s', [['only one']])).toThrow(ParseError);
  });
  it('rejects a file with more than 50,000 rows', async () => {
    const lines = ['a,b'];
    for (let i = 0; i < 50_001; i++) lines.push(`${i},x`);
    await expect(parseSpreadsheet({ path: tmp('big.csv', lines.join('\n')) }, 'csv')).rejects.toMatchObject({ code: 'too_many_rows' });
  });
  it('handles exactly 50,000 rows', async () => {
    const lines = ['a,b'];
    for (let i = 0; i < 50_000; i++) lines.push(`${i},x`);
    const r = await parseSpreadsheet({ path: tmp('ok.csv', lines.join('\n')) }, 'csv');
    expect(r.rows).toHaveLength(50_000);
  });
  it('reports a corrupt workbook as unreadable', async () => {
    await expect(parseSpreadsheet({ path: tmp('bad.xlsx', Buffer.from('PK\x03\x04garbage')) }, 'xlsx')).rejects.toMatchObject({ code: 'unreadable' });
  });
});
