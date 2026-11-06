import ExcelJS from 'exceljs';
import { normalizeBarcode } from './barcode.js';
import type { MarketplaceId } from './constants.js';
import type { ReconReference } from './recon/status.js';
import { safeCell } from './upload/error-report.js';
import { headerRowIndex, headersForRow, type SpreadsheetValues } from './upload/parse.js';
import { str } from './upload/validate.js';

export type GeneratedKind = 'stock' | 'price' | 'stock_price';
export type GeneratedScope = 'mismatches' | 'all';
export interface GenerateParams { marketplaceId: MarketplaceId; kind: GeneratedKind; scope: GeneratedScope; reference: ReconReference }
export type PlainCell = string | number | boolean | null;
export interface FileReconRow {
  productId: string; name: string; marketplaceProductId: string | null;
  erpPrice: number | null; marketplacePrice: number | null;
  /** What the marketplace should show for the file's reference (ADR 017): catalogue stock (marketplace) or ERP stock (erp). */
  available: boolean | null;
  actualPrice: number | null;
  /** The stock issue for the same reference. */
  stockIssue: string | null;
  priceMismatchVsErp: boolean; priceMismatchVsMarketplace: boolean; status: string;
}
export class GenerationBlocked extends Error {
  constructor(message: string) { super(message); this.name = 'GenerationBlocked'; }
}

export function selectedForFile(row: FileReconRow, p: GenerateParams): boolean {
  if (row.actualPrice === null) return false; // not listed; G2 handles new listings
  if (p.scope === 'all') return row.status !== 'missing_from_erp';
  const price = p.reference === 'erp' ? row.priceMismatchVsErp : row.priceMismatchVsMarketplace;
  return p.kind === 'stock' ? !!row.stockIssue : p.kind === 'price' ? price : !!row.stockIssue || price;
}

function plain(v: unknown): PlainCell {
  if (typeof v === 'string') return safeCell(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Preserve text decimals (including trailing zeros); never round away a recon price's precision. */
function textNumber(original: string, value: number): string {
  const match = /^(\s*)([+-]?)(\d+(?:,\d{3})*)(?:\.(\d+))?(\s*)$/.exec(original);
  if (!match) throw new GenerationBlocked('A mapped price cell is not a plain number. Upload a fresh marketplace file.');
  const decimals = match[4]?.length ?? 0;
  if (decimals > 20) throw new GenerationBlocked('A mapped price cell has unsupported decimal precision.');
  const needed = (String(Math.round(value * 1000) / 1000).split('.')[1] ?? '').length;
  let rendered = value.toFixed(Math.max(decimals, needed));
  if (match[3].includes(',')) {
    const [integer, fraction] = rendered.split('.');
    rendered = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
  }
  return match[1] + (match[2] === '+' ? '+' : '') + rendered + match[5];
}

function writePrice(original: unknown, expected: number | null): PlainCell {
  if (expected === null || !Number.isFinite(expected) || expected < 0) throw new GenerationBlocked('A reconciliation row has no expected price. Reconcile the marketplace again.');
  if (typeof original === 'number') return expected;
  if (typeof original === 'string') return textNumber(original, expected);
  throw new GenerationBlocked('A mapped price cell has no supported cell type. Upload a fresh marketplace file.');
}

const BOOLEAN_PAIRS = [['true', 'false'], ['yes', 'no'], ['y', 'n'], ['active', 'inactive'], ['available', 'unavailable'], ['in stock', 'out of stock'], ['in stock', 'sold out']] as const;
function availabilityPair(v: unknown): readonly [string, string] | null {
  if (typeof v !== 'string') return null;
  const text = v.trim().toLowerCase();
  return BOOLEAN_PAIRS.find(pair => pair.some(item => item === text)) ?? null;
}
function isBooleanLike(v: unknown): boolean {
  if (typeof v === 'boolean') return true;
  if (v === 0 || v === 1) return true;
  if (typeof v !== 'string') return false;
  return !!availabilityPair(v) || /^[01](?:\.0+)?$/.test(v.trim());
}
function matchCase(original: string, next: string): string {
  if (original === original.toUpperCase()) return next.toUpperCase();
  if (original === original.toLowerCase()) return next;
  if (original === original[0].toUpperCase() + original.slice(1).toLowerCase()) return next[0].toUpperCase() + next.slice(1);
  // Title Case as used by some marketplace exports.
  return next.replace(/\b\w/g, c => c.toUpperCase());
}
function writeAvailable(original: unknown, available: boolean | null): PlainCell {
  if (available === null) throw new GenerationBlocked('A reconciliation row has no ERP availability. Reconcile the marketplace again.');
  if (typeof original === 'boolean') return available;
  if (typeof original === 'number' && isBooleanLike(original)) return available ? 1 : 0;
  if (typeof original === 'string' && isBooleanLike(original)) {
    const pair = availabilityPair(original);
    if (!pair) return textNumber(original, available ? 1 : 0);
    const value = matchCase(original.trim(), pair[available ? 0 : 1]);
    return original.replace(original.trim(), value);
  }
  throw new GenerationBlocked('The availability column holds quantities or values that are not boolean-like. Upload a file with boolean availability.');
}

export interface FilePlan {
  /** Products written. rowsToWrite is larger when a product appears on several source rows. */
  productCount: number; rowsToWrite: number; priceChanges: number; availabilityChanges: number; notInFile: number;
  largestPriceChange: { name: string; from: number; to: number } | null;
  /** Written products whose identifier is on more than one source row, and the rows beyond the first. */
  duplicateRows: { products: number; extraRows: number } | null;
  firstRows: Record<string, PlainCell>[];
  /** Original preamble + header, followed by selected rows in source order. Plain values only. */
  rows: PlainCell[][]; sheetName: string; delimiter: string;
}

/**
 * The columns a generated file relies on, from an upload's stored mapping: rows are matched by the marketplace
 * product ID when it is mapped, else by the first barcode. Shared with the Templates description.
 */
export function fileColumns(mapping: unknown) {
  const fields = mapping && typeof mapping === 'object' ? mapping as Record<string, unknown> : {};
  const header = (key: string) => typeof fields[key] === 'string' && fields[key] ? fields[key] as string : null;
  const identifierField = header('marketplaceProductId') ? 'marketplaceProductId' as const : 'barcode1' as const;
  return { identifierField, identifier: header(identifierField), price: header('price'), availability: header('available') };
}

/** Pure, shared plan: both preview and generation use recon flags and values, never recompute prices or stock. */
export function planGeneratedFile(sheet: SpreadsheetValues, mapping: unknown, storedHeaders: unknown, recon: FileReconRow[], p: GenerateParams): FilePlan {
  const fields = mapping && typeof mapping === 'object' ? mapping as Record<string, unknown> : {};
  const idField = fileColumns(mapping).identifierField;
  for (const field of [idField, 'price', 'available']) {
    if (typeof fields[field] !== 'string' || !fields[field]) throw new GenerationBlocked(`The ${field === 'available' ? 'availability' : field === 'price' ? 'price' : 'identifying'} column is not mapped.`);
  }
  const headerIndex = headerRowIndex(sheet.raw);
  const headers = headersForRow(sheet.raw[headerIndex]);
  const mapped = [idField, 'price', 'available'].map(field => fields[field] as string);
  if (mapped.some(h => !headers.includes(h) || !Array.isArray(storedHeaders) || !storedHeaders.includes(h))) {
    throw new GenerationBlocked("The source file's headers no longer include the mapped columns. Upload a fresh marketplace file.");
  }
  if (mapped.some(h => headers.filter(header => header === h).length !== 1)) throw new GenerationBlocked('The source file has ambiguous mapped headers. Upload a fresh marketplace file.');
  const [idColumn, priceColumn, availableColumn] = mapped.map(h => headers.indexOf(h));
  if (new Set([idColumn, priceColumn, availableColumn]).size !== 3) throw new GenerationBlocked('The identifying, price and availability mappings must use different columns.');

  // Quantity-like availability blocks every kind, even price-only. Do not silently convert a stock quantity.
  const sourceRows = sheet.raw.slice(headerIndex + 1);
  for (const row of sourceRows) {
    const v = row[availableColumn];
    if (v !== null && v !== undefined && str(v) !== '' && !isBooleanLike(v)) {
      throw new GenerationBlocked('The availability column holds quantities or values that are not boolean-like. Upload a file with boolean availability.');
    }
  }
  const identify = idField === 'barcode1' ? normalizeBarcode : str;
  // Rows sharing an identifier are the same product (e.g. a Snoonu export listing a barcode twice): all are written alike.
  const sourceById = new Map<string, number[]>();
  for (let i = 0; i < sourceRows.length; i++) {
    const id = identify(sourceRows[i][idColumn]);
    if (!id) continue;
    const indexes = sourceById.get(id);
    if (indexes) indexes.push(i); else sourceById.set(id, [i]);
  }
  const selected = recon.filter(r => selectedForFile(r, p));
  const targets = new Map<number, FileReconRow>();
  const matchedIds = new Set<string>();
  let notInFile = 0, duplicateProducts = 0, extraRows = 0;
  for (const row of selected) {
    const id = row.marketplaceProductId === null ? '' : identify(row.marketplaceProductId);
    const indexes = id ? sourceById.get(id) : undefined;
    if (!indexes) { notInFile++; continue; }
    if (matchedIds.has(id)) throw new GenerationBlocked('Multiple reconciliation rows match one file row. Reconcile the marketplace again.');
    matchedIds.add(id);
    for (const index of indexes) targets.set(index, row);
    if (indexes.length > 1) { duplicateProducts++; extraRows += indexes.length - 1; }
  }
  if (!targets.size) throw new GenerationBlocked('There is nothing to update for this selection.');
  const plan: FilePlan = {
    productCount: matchedIds.size, rowsToWrite: targets.size, priceChanges: 0, availabilityChanges: 0, notInFile, largestPriceChange: null,
    duplicateRows: duplicateProducts ? { products: duplicateProducts, extraRows } : null, firstRows: [],
    rows: sheet.raw.slice(0, headerIndex + 1).map(row => Array.from(row, plain)), sheetName: sheet.sheetName, delimiter: sheet.delimiter ?? ',',
  };
  // Change counts are per product: a product counts once even when several of its rows change.
  const priceChanged = new Set<FileReconRow>(), availabilityChanged = new Set<FileReconRow>();
  const aliases = headersForRow(sheet.raw[headerIndex].map(plain));
  const usedPreviewHeaders = new Set<string>();
  const previewHeaders = aliases.map((alias, i) => {
    const original = plan.rows[headerIndex][i];
    let key = typeof original === 'string' && original.trim() ? original : alias;
    if (usedPreviewHeaders.has(key)) key = alias;
    if (usedPreviewHeaders.has(key)) key = `${alias} [Column ${i + 1}]`;
    usedPreviewHeaders.add(key);
    return key;
  });
  let largest = -1;
  for (const [index, row] of [...targets].sort((a, b) => a[0] - b[0])) {
    const original = sourceRows[index];
    const values = Array.from(original, plain);
    const expected = p.reference === 'erp' ? row.erpPrice : row.marketplacePrice;
    if (p.kind !== 'stock') {
      values[priceColumn] = plain(writePrice(original[priceColumn], expected));
      const from = Number(String(original[priceColumn]).replaceAll(',', '').trim());
      if (!Number.isFinite(from)) throw new GenerationBlocked('A mapped price cell is not a plain number. Upload a fresh marketplace file.');
      const delta = Math.abs(expected! - from);
      if (Math.round(delta * 1000) !== 0) {
        priceChanged.add(row);
        if (delta > largest) { largest = delta; plan.largestPriceChange = { name: row.name, from, to: expected! }; }
      }
    }
    if (p.kind !== 'price') {
      values[availableColumn] = plain(writeAvailable(original[availableColumn], row.available));
      if (values[availableColumn] !== plain(original[availableColumn])) availabilityChanged.add(row);
    }
    plan.rows.push(values);
    if (plan.firstRows.length < 10) plan.firstRows.push(Object.fromEntries(previewHeaders.map((h, i) => [h, values[i] ?? null])));
  }
  plan.priceChanges = priceChanged.size;
  plan.availabilityChanges = availabilityChanged.size;
  return plan;
}

/** Preview/audit text for products that appear on several rows of the source file. */
export function duplicateRowsWarning(marketplace: string, duplicates: FilePlan['duplicateRows']): string | null {
  if (!duplicates) return null;
  const one = duplicates.products === 1;
  return `${duplicates.products} ${one ? 'product appears' : 'products appear'} on more than one row of the ${marketplace} file; all ${one ? 'its' : 'their'} rows are updated`;
}

export async function writeGeneratedFile(plan: FilePlan, format: 'xlsx' | 'csv'): Promise<Buffer> {
  if (format === 'csv') {
    const escape = (cell: PlainCell) => {
      const s = cell === null ? '' : String(cell);
      return s.includes(plan.delimiter) || /["\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    return Buffer.from(plan.rows.map(row => row.map(escape).join(plan.delimiter)).join('\r\n') + '\r\n', 'utf8');
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(plan.sheetName);
  for (const row of plan.rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function generatedFileName(marketplace: string, kind: GeneratedKind, at: Date, ext: '.xlsx' | '.csv'): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Qatar', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(part => [part.type, part.value]));
  const label = { stock: 'Stock', price: 'Price', stock_price: 'Update' }[kind];
  const safeName = marketplace.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50) || 'Marketplace';
  return `${safeName}_${label}_${parts.day}${parts.month.slice(0, 3)}${parts.year}_${parts.hour}${parts.minute}${ext}`;
}
