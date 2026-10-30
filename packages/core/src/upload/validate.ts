import { normalizeBarcode } from '../barcode.js';
import { round2 } from '../money.js';

export type SheetRow = Record<string, unknown>;

export interface RowError {
  row: number;
  column: string;
  value: string;
  reason: string;
}

export interface ErpRow {
  rowNumber: number;
  barcode: string;
  sku?: string;
  nameEn: string;
  nameAr?: string;
  brand?: string;
  category?: string;
  price: number;
  /** never negative: a negative or unreadable cost becomes unknown (see costIgnored) */
  cost?: number;
  /** never negative: a negative stock becomes 0 (see negativeStockClamped) */
  stock: number;
  active: boolean;
  /** the Cost cell had a value that is not a cost (negative or not a number); the row stays valid without it */
  costIgnored?: true;
  /** the Stock cell was negative (the ERP sold more than it had); stored as 0 and the row stays valid */
  negativeStockClamped?: true;
}

export interface MarketplaceRow {
  rowNumber: number;
  marketplaceProductId: string;
  barcodes: string[];
  name: string;
  price: number;
  available: boolean;
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True/False, Yes/No, 1/0 and quantities (>0 = available) are all accepted. */
export function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'active', 'available', 'in stock'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'inactive', 'unavailable', 'out of stock', 'sold out'].includes(s)) return false;
  const n = toNum(v);
  return n === null ? null : n > 0;
}

export interface MapResult {
  erpRows: ErpRow[];
  marketplaceRows: MarketplaceRow[];
  errors: RowError[];
}

/** Apply a field->column mapping to raw sheet rows and validate each row. Invalid rows are skipped. */
export function mapRows(source: string, rows: SheetRow[], fields: Record<string, string>, rowNumbers?: number[]): MapResult {
  const errors: RowError[] = [];
  const erpRows: ErpRow[] = [];
  const marketplaceRows: MarketplaceRow[] = [];

  rows.forEach((r, i) => {
    const rowNumber = rowNumbers?.[i] ?? i + 2; // header is row 1
    const err = (column: string | undefined, reason: string) =>
      errors.push({ row: rowNumber, column: column ?? '', value: column ? str(r[column]) : '', reason });

    if (source === 'erp') {
      const barcode = normalizeBarcode(r[fields.barcode]);
      const price = toNum(r[fields.price]);
      const stock = toNum(r[fields.stock]);
      const nameEn = str(r[fields.nameEn]);
      if (!barcode) return err(fields.barcode, 'Barcode is empty');
      if (!nameEn) return err(fields.nameEn, 'Product name is empty');
      if (price === null || price <= 0) return err(fields.price, 'Price must be a number above 0');
      if (stock === null) return err(fields.stock, 'Stock must be a number');
      // Cost is optional, so a negative or unreadable one does not reject the row: it becomes unknown and is counted.
      const costCell = fields.cost ? r[fields.cost] : undefined;
      const cost = toNum(costCell);
      const costIgnored = str(costCell) !== '' && (cost === null || cost < 0);
      // A negative stock means none on hand, so it is stored as 0 and counted rather than rejecting the row.
      const negativeStock = stock < 0;
      erpRows.push({
        rowNumber,
        barcode,
        sku: fields.sku ? str(r[fields.sku]) || undefined : undefined,
        nameEn,
        nameAr: fields.nameAr ? str(r[fields.nameAr]) || undefined : undefined,
        brand: fields.brand ? str(r[fields.brand]) || undefined : undefined,
        category: fields.category ? str(r[fields.category]) || undefined : undefined,
        price: round2(price),
        cost: cost !== null && cost >= 0 ? cost : undefined,
        stock: negativeStock ? 0 : Math.floor(stock),
        active: fields.active ? toBool(r[fields.active]) ?? true : true,
        ...(costIgnored ? { costIgnored: true as const } : {}),
        ...(negativeStock ? { negativeStockClamped: true as const } : {}),
      });
      return;
    }

    const barcodes = [fields.barcode1, fields.barcode2, fields.barcode3]
      .filter(Boolean)
      .map((c) => normalizeBarcode(r[c]))
      .filter(Boolean);
    const id = str(r[fields.marketplaceProductId]);
    const price = toNum(r[fields.price]);
    const available = toBool(r[fields.available]);
    // a row needs a barcode even when it has an ID: the ID fallback is only for barcodes that match no product
    if (!barcodes.length) return err(fields.barcode1, 'Barcode is empty');
    if (price === null || price < 0) return err(fields.price, 'Price is not a number');
    if (available === null) return err(fields.available, 'Availability must be True/False or a quantity');
    marketplaceRows.push({
      rowNumber,
      marketplaceProductId: id || barcodes[0]!,
      barcodes,
      name: fields.name ? str(r[fields.name]) : '',
      price: round2(price),
      available,
    });
  });

  return { erpRows, marketplaceRows, errors };
}

/** Upload is rejected when more than `maxShare` of the rows are invalid (blueprint J1 error case). */
export function exceedsInvalidShare(rowsRead: number, errorCount: number, maxShare: number): boolean {
  return rowsRead > 0 && errorCount / rowsRead > maxShare;
}
