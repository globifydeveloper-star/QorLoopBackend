import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse';
import { UPLOAD_LIMITS } from './constants.js';
import type { FileFormat } from './safety.js';
import type { SheetRow } from './validate.js';

export class ParseError extends Error {
  constructor(
    public readonly code: 'too_many_rows' | 'no_header' | 'unreadable' | 'empty',
    message: string,
  ) {
    super(message);
  }
}

export interface ParsedSheet {
  sheetName: string;
  headers: string[];
  rows: SheetRow[];
  /** 1-based sheet row number of each entry in `rows` (blank lines are skipped, so this is not i+2) */
  rowNumbers: number[];
}

const HEADER_SCAN_ROWS = 10;

function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return cellValue(o.result); // formula: keep the computed value, never the formula
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((t) => t.text).join('');
    if ('text' in o) return cellValue(o.text); // hyperlink
    if ('error' in o) return null;
    return String(v);
  }
  return v;
}

function isFilled(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/** Turns raw row arrays into a header + keyed rows. The header is the first row with 2+ filled cells. */
export function rowsToSheet(sheetName: string, raw: unknown[][], rowOffset = 1): ParsedSheet {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(raw.length, HEADER_SCAN_ROWS); i++) {
    if (raw[i].filter(isFilled).length >= 2) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new ParseError('no_header', 'No header row was found in the first 10 rows');

  const seen = new Map<string, number>();
  const headers = raw[headerIdx].map((h, i) => {
    let name = isFilled(h) ? String(h).trim() : `Column ${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });

  const rows: SheetRow[] = [];
  const rowNumbers: number[] = [];
  for (let k = headerIdx + 1; k < raw.length; k++) {
    const r = raw[k];
    if (!r.some(isFilled)) continue; // blank line
    rowNumbers.push(rowOffset + k);
    const obj: SheetRow = {};
    headers.forEach((h, i) => (obj[h] = r[i] ?? null));
    rows.push(obj);
  }
  return { sheetName, headers, rows, rowNumbers };
}

export function guardRowCount(count: number) {
  if (count > UPLOAD_LIMITS.maxRows) {
    throw new ParseError('too_many_rows', `The file has more than ${UPLOAD_LIMITS.maxRows.toLocaleString('en')} rows`);
  }
}

async function parseXlsxFile(path: string): Promise<ParsedSheet> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
    entries: 'ignore',
  });
  for await (const ws of reader) {
    const sheet = ws as unknown as AsyncIterable<{ number: number; values: unknown[] }> & { id: number; name?: string; state?: string };
    if (sheet.state && sheet.state !== 'visible') continue;
    const raw: unknown[][] = [];
    for await (const row of sheet) {
      // exceljs omits empty rows: pad so raw[i] is always sheet row i+1
      while (raw.length < row.number - 1) raw.push([]);
      // row.values is 1-based (index 0 unused)
      raw.push((row.values as unknown[]).slice(1).map(cellValue));
      guardRowCount(raw.length - 1);
    }
    if (raw.length === 0) continue;
    return rowsToSheet(sheet.name ?? `Sheet${sheet.id}`, raw);
  }
  throw new ParseError('empty', 'The workbook has no data');
}

async function parseXlsFile(path: string): Promise<ParsedSheet> {
  // Legacy BIFF is the only place SheetJS is used; the file already passed inspectFile() and runs in the worker.
  const XLSX = await import('xlsx');
  const wb = XLSX.readFile(path, { cellDates: true, cellFormula: false, sheetStubs: false });
  const name = wb.SheetNames[0];
  if (!name) throw new ParseError('empty', 'The workbook has no data');
  const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
  guardRowCount(raw.length - 1);
  return rowsToSheet(name, raw.map((r) => r.map(cellValue)));
}

function detectDelimiter(sample: string): string {
  const first = sample.split(/\r?\n/).slice(0, 5).join('\n');
  const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

async function parseCsvBuffer(buf: Buffer): Promise<ParsedSheet> {
  const text = buf.toString('utf8');
  const raw: unknown[][] = [];
  const parser = Readable.from([text]).pipe(
    parseCsv({ bom: true, delimiter: detectDelimiter(text), relax_column_count: true, relax_quotes: true, skip_empty_lines: false }),
  );
  for await (const rec of parser) {
    raw.push(rec as unknown[]);
    guardRowCount(raw.length - 1);
  }
  return rowsToSheet('csv', raw);
}

/** Step "Read": parse a file already on disk (workers download to a temp file first). */
export async function parseSpreadsheet(
  source: { path: string; buffer?: Buffer },
  format: FileFormat,
): Promise<ParsedSheet> {
  try {
    if (format === 'xlsx') return await parseXlsxFile(source.path);
    if (format === 'xls') return await parseXlsFile(source.path);
    const fs = await import('node:fs/promises');
    return await parseCsvBuffer(source.buffer ?? (await fs.readFile(source.path)));
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError('unreadable', 'The file could not be read. It may be damaged or password-protected.');
  }
}
