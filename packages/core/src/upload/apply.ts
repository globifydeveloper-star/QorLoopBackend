import type { ErpRow, MarketplaceRow } from './validate.js';
import { marketplaceMatcher, type MatchProduct } from './review.js';

/** The catalogue as it is at apply time (not as the review saw it). Money as numbers. */
export interface ApplyProduct {
  id: string;
  normalizedBarcode: string;
  sku: string | null;
  nameEn: string;
  nameAr: string | null;
  brand: string | null;
  erpCategory: string | null;
  erpPrice: number;
  costPrice: number | null;
  erpStock: number;
  erpActive: boolean;
  inLatestErpFile: boolean;
}

/** Every field an ERP upload may write on an existing product. Absolute values, so a retry writes the same. */
export type ProductWrite = Omit<ApplyProduct, 'normalizedBarcode'>;

export type NewProduct = Omit<ProductWrite, 'id' | 'inLatestErpFile'> & { normalizedBarcode: string; status: 'active' | 'new' };

export type FieldValue = string | number | boolean | null;
export interface FieldChange { productId: string; field: string; old: FieldValue; new: FieldValue }

export interface ErpApplyPlan {
  create: NewProduct[];
  /** only products where at least one field changes */
  update: ProductWrite[];
  /** one entry per changed field on an existing product, for the audit trail */
  changes: FieldChange[];
  /** every barcode in the file (new and existing), for flagging products missing from a full list */
  barcodes: string[];
  /** rows the database would refuse; left out so the rest of the file still applies */
  skipped: SkippedRow[];
}

/** A row left out of an apply: its file row number and a plain reason, never its values. */
export interface SkippedRow { rowNumber: number; reason: string }

/**
 * The database's rules for what an apply writes, checked first so one bad row cannot roll back the whole file.
 * Mirrors packages/db/prisma/migrations: CHECK product_status_valid, product_barcode_normalized, product_money_valid,
 * listing_price_valid, the NOT NULL text columns, and the column types numeric(12,3) and int.
 */
const MONEY_LIMIT = 1_000_000_000; // numeric(12,3) holds up to 999,999,999.999
const INT_MAX = 2_147_483_647;
const PRODUCT_STATUSES = new Set(['active', 'inactive', 'new']);
const money = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < MONEY_LIMIT;

export function productProblem(p: { normalizedBarcode: string; nameEn: string; erpPrice: number; costPrice: number | null; erpStock: number; status?: string }): string | null {
  if (typeof p.normalizedBarcode !== 'string' || !/^[0-9]+$/.test(p.normalizedBarcode) || p.normalizedBarcode.startsWith('0')) return 'Barcode must be digits only and not start with 0';
  if (p.status !== undefined && !PRODUCT_STATUSES.has(p.status)) return 'Product status is not valid';
  if (typeof p.nameEn !== 'string' || !p.nameEn) return 'Product name is empty';
  if (!money(p.erpPrice)) return 'Price must be 0 or more and below 1,000,000,000';
  if (p.costPrice !== null && !money(p.costPrice)) return 'Cost must be 0 or more and below 1,000,000,000';
  if (!Number.isInteger(p.erpStock) || p.erpStock < 0 || p.erpStock > INT_MAX) return 'Stock must be a whole number, 0 or more';
  return null;
}

export function listingProblem(l: ListingWrite): string | null {
  if (typeof l.marketplaceProductId !== 'string' || !l.marketplaceProductId) return 'Marketplace product ID is empty';
  if (!money(l.price)) return 'Price must be 0 or more and below 1,000,000,000';
  return null;
}

/** ERP-owned product fields and the mapping key that feeds each one (docs 5.6). */
const ERP_FIELDS = [
  ['sku', 'sku'], ['nameEn', 'nameEn'], ['brand', 'brand'], ['category', 'erpCategory'],
  ['price', 'erpPrice'], ['cost', 'costPrice'], ['stock', 'erpStock'], ['active', 'erpActive'],
] as const satisfies readonly (readonly [string, keyof ProductWrite])[];

const MONEY = new Set<keyof ProductWrite>(['erpPrice', 'costPrice']);
/** Product money columns are numeric(12,3). */
const money3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);

function fileValue(r: ErpRow, key: (typeof ERP_FIELDS)[number][0]): FieldValue {
  switch (key) {
    case 'sku': return r.sku ?? null;
    case 'nameEn': return r.nameEn;
    case 'brand': return r.brand ?? null;
    case 'category': return r.category ?? null;
    case 'price': return money3(r.price);
    case 'cost': return money3(r.cost ?? null);
    case 'stock': return r.stock;
    case 'active': return r.active;
  }
}

/**
 * What an ERP upload changes, computed against the catalogue at apply time. Pure.
 * - A row whose barcode is not in the catalogue creates a product; otherwise it updates the ERP-owned fields.
 * - A field whose column is not in the confirmed mapping is left alone (an empty mapped cell clears it).
 * - Qorloop-owned fields are never written, except nameAr, which is filled only when currently empty.
 * - Every row in the file marks its product as in the latest ERP file.
 * - A negative cost (staged before validation ignored it) is treated as unknown: blank on a new product, kept on an existing one.
 * - A row the database would refuse (productProblem) is skipped and reported; the rest still applies.
 */
export function planErpApply(rows: ErpRow[], products: ApplyProduct[], mappedKeys: Iterable<string>, newStatus: 'active' | 'new'): ErpApplyPlan {
  const mapped = new Set(mappedKeys);
  const fields = ERP_FIELDS.filter(([key]) => mapped.has(key));
  const byBarcode = new Map(products.map(p => [p.normalizedBarcode, p] as const));
  const plan: ErpApplyPlan = { create: [], update: [], changes: [], barcodes: [], skipped: [] };
  const seen = new Set<string>();

  for (const staged of rows) {
    // the review already rejects duplicate barcodes; first row wins if one slips through
    if (seen.has(staged.barcode)) continue;
    seen.add(staged.barcode);
    plan.barcodes.push(staged.barcode);
    const costIgnored = staged.costIgnored === true || (staged.cost !== undefined && !(staged.cost >= 0));
    const r: ErpRow = costIgnored ? { ...staged, cost: undefined } : staged;
    const p = byBarcode.get(r.barcode);
    if (!p) {
      const created: NewProduct = {
        normalizedBarcode: r.barcode, sku: r.sku ?? null, nameEn: r.nameEn, nameAr: r.nameAr ?? null, brand: r.brand ?? null,
        erpCategory: r.category ?? null, erpPrice: money3(r.price)!, costPrice: money3(r.cost ?? null), erpStock: r.stock, erpActive: r.active,
        status: newStatus,
      };
      const problem = productProblem(created);
      if (problem) plan.skipped.push({ rowNumber: r.rowNumber, reason: problem });
      else plan.create.push(created);
      continue;
    }
    const { normalizedBarcode: _, ...next } = p;
    const changes: FieldChange[] = [];
    const change = (field: keyof ProductWrite, value: FieldValue) => {
      const old = MONEY.has(field) ? money3(p[field] as number | null) : (p[field] as FieldValue);
      if (old === value) return;
      changes.push({ productId: p.id, field, old, new: value });
      (next as Record<string, FieldValue>)[field] = value;
    };
    for (const [key, field] of fields) if (!(key === 'cost' && costIgnored)) change(field, fileValue(r, key));
    if (!p.nameAr && r.nameAr) change('nameAr', r.nameAr);
    change('inLatestErpFile', true);
    if (!changes.length) continue;
    const problem = productProblem({ ...next, normalizedBarcode: p.normalizedBarcode });
    if (problem) { plan.skipped.push({ rowNumber: r.rowNumber, reason: problem }); continue; }
    plan.changes.push(...changes);
    plan.update.push(next);
  }
  return plan;
}

export interface ListingWrite {
  marketplaceProductId: string;
  productId: string | null;
  barcodes: string[];
  name: string | null;
  price: number;
  available: boolean;
}

export interface ListingApplyPlan {
  listings: ListingWrite[];
  skipped: SkippedRow[];
  /** written listings that point at a product / that do not (no match, or more than one) */
  matched: number;
  unmatched: number;
}

/**
 * Marketplace rows as listings, each matched again against the catalogue at apply time with the review's rules
 * (marketplaceMatcher), so a review built before the ERP was applied still links its rows. Pure.
 * - Exactly one product: the listing points at it. None, or more than one (never guessed): a null product.
 * - A row the database would refuse (listingProblem) is skipped and reported.
 */
export function planListingApply(rows: MarketplaceRow[], products: MatchProduct[]): ListingApplyPlan {
  const match = marketplaceMatcher(products);
  const plan: ListingApplyPlan = { listings: [], skipped: [], matched: 0, unmatched: 0 };
  for (const r of rows) {
    const ids = match(r);
    const l: ListingWrite = {
      marketplaceProductId: r.marketplaceProductId, productId: ids.length === 1 ? ids[0]! : null, barcodes: r.barcodes,
      name: r.name || null, price: money3(r.price)!, available: r.available,
    };
    const problem = listingProblem(l);
    if (problem) { plan.skipped.push({ rowNumber: r.rowNumber, reason: problem }); continue; }
    plan.listings.push(l);
    if (l.productId) plan.matched++;
    else plan.unmatched++;
  }
  return plan;
}
