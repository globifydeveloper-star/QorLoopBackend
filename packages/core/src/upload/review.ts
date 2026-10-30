import { round2 } from '../money.js';
import type { ErpRow, MarketplaceRow, RowError } from './validate.js';

export interface CatalogProduct {
  id: string;
  normalizedBarcode: string;
  sku?: string | null;
  nameEn: string;
  erpPrice: number;
  erpStock: number;
  inLatestErpFile: boolean;
}

export interface CatalogListing {
  productId: string | null;
  marketplaceProductId: string;
  price: number;
  available: boolean;
}

export type ChangeType = 'new' | 'price' | 'stock' | 'price_stock' | 'availability' | 'price_availability' | 'none' | 'unmatched';

export interface ReviewRow {
  rowNumber: number;
  changeType: ChangeType;
  productId: string | null;
  parsed: ErpRow | MarketplaceRow;
  /** old/new values for the review tabs */
  price?: { old: number | null; new: number };
  stock?: { old: number | null; new: number };
  availability?: { old: boolean | null; new: boolean };
}

export interface ReviewSummary {
  rowsRead: number;
  matched: number;
  newProducts: number;
  rowsWithErrors: number;
  priceChanges: number;
  stockChanges: number;
  missingFromFile: number;
  unmatched: number;
  /** ERP rows kept without their cost because it was negative or not a number */
  costIgnored: number;
}

/** The summary stored on an upload at review time and returned by the API (older uploads may lack costIgnored). */
export type StoredReviewSummary = Omit<ReviewSummary, 'costIgnored'> & {
  costIgnored?: number;
  contains: 'full' | 'partial';
  firstImport: boolean;
  missingSample: { productId: string; barcode: string }[];
};

export interface Review {
  rows: ReviewRow[];
  missing: { productId: string; barcode: string }[];
  errors: RowError[];
  summary: ReviewSummary;
}

const sameMoney = (a: number | null, b: number) => a !== null && round2(a) === round2(b);

/**
 * The file's own header for a review error, like row-validation errors report it: the header of the
 * first mapped field in `keys`, else `fallback` (the field key the error was reported under before).
 */
const columnOf = (fields: Record<string, string>, keys: string[], fallback = keys[0]) => keys.map((k) => fields[k]).find(Boolean) ?? fallback;

/**
 * Compare a validated ERP file with the current catalogue (docs 5.6). Pure: the worker persists the result.
 * `fields` is the confirmed mapping (field key -> file header), used to name the column in errors.
 */
export function buildErpReview(
  rows: ErpRow[],
  rowsRead: number,
  inputErrors: RowError[],
  products: CatalogProduct[],
  contains: 'full' | 'partial',
  fields: Record<string, string> = {},
): Review {
  const byBarcode = new Map(products.map((p) => [p.normalizedBarcode, p] as const));
  const errors = [...inputErrors];
  const out: ReviewRow[] = [];
  const seenBarcodes = new Set<string>();
  const seenProducts = new Set<string>();
  let matched = 0, priceChanges = 0, stockChanges = 0, newProducts = 0, costIgnored = 0;

  for (const r of rows) {
    if (seenBarcodes.has(r.barcode)) {
      errors.push({ row: r.rowNumber, column: columnOf(fields, ['barcode']), value: r.barcode, reason: 'Duplicate barcode in this file' });
      continue;
    }
    seenBarcodes.add(r.barcode);
    if (r.costIgnored) costIgnored++;
    const p = byBarcode.get(r.barcode);
    if (!p) {
      newProducts++;
      out.push({ rowNumber: r.rowNumber, changeType: 'new', productId: null, parsed: r });
      continue;
    }
    matched++;
    seenProducts.add(p.id);
    const priceChanged = !sameMoney(p.erpPrice, r.price);
    const stockChanged = p.erpStock !== r.stock;
    if (priceChanged) priceChanges++;
    if (stockChanged) stockChanges++;
    out.push({
      rowNumber: r.rowNumber,
      changeType: priceChanged && stockChanged ? 'price_stock' : priceChanged ? 'price' : stockChanged ? 'stock' : 'none',
      productId: p.id,
      parsed: r,
      price: priceChanged ? { old: p.erpPrice, new: r.price } : undefined,
      stock: stockChanged ? { old: p.erpStock, new: r.stock } : undefined,
    });
  }

  const missing =
    contains === 'full'
      ? products.filter((p) => p.inLatestErpFile && !seenProducts.has(p.id)).map((p) => ({ productId: p.id, barcode: p.normalizedBarcode }))
      : [];

  return {
    rows: out,
    missing,
    errors,
    summary: {
      rowsRead, matched, newProducts, rowsWithErrors: errors.length,
      priceChanges, stockChanges, missingFromFile: missing.length, unmatched: 0, costIgnored,
    },
  };
}

/**
 * Compare a validated marketplace file with the current listings (docs 5.5/5.6).
 * Match on any of the row's barcodes; fall back to SKU. Two products matching one row is an error.
 * `fields` is the confirmed mapping (field key -> file header), used to name the column in errors.
 */
export function buildMarketplaceReview(
  rows: MarketplaceRow[],
  rowsRead: number,
  inputErrors: RowError[],
  products: CatalogProduct[],
  listings: CatalogListing[],
  contains: 'full' | 'partial',
  fields: Record<string, string> = {},
): Review {
  const byBarcode = new Map(products.map((p) => [p.normalizedBarcode, p] as const));
  const bySku = new Map<string, CatalogProduct[]>();
  for (const p of products) if (p.sku) bySku.set(p.sku, [...(bySku.get(p.sku) ?? []), p]);
  const current = new Map(listings.filter((l) => l.productId).map((l) => [l.productId as string, l] as const));
  const errors = [...inputErrors];
  const out: ReviewRow[] = [];
  const seenProducts = new Set<string>();
  const seenIds = new Set<string>();
  let matched = 0, priceChanges = 0, availChanges = 0, unmatched = 0;

  for (const r of rows) {
    if (seenIds.has(r.marketplaceProductId)) {
      // without a mapped ID column (Snoonu) the ID is the row's first barcode
      errors.push({ row: r.rowNumber, column: columnOf(fields, ['marketplaceProductId', 'barcode1']), value: r.marketplaceProductId, reason: 'Duplicate marketplace product ID in this file' });
      continue;
    }
    seenIds.add(r.marketplaceProductId);

    let candidates = [...new Set(r.barcodes.map((b) => byBarcode.get(b)).filter(Boolean))] as CatalogProduct[];
    if (candidates.length === 0) candidates = bySku.get(r.marketplaceProductId) ?? [];
    if (candidates.length > 1) {
      errors.push({ row: r.rowNumber, column: columnOf(fields, ['barcode1'], 'barcode'), value: r.barcodes.join(', '), reason: 'Matches more than one product; not guessed' });
      continue;
    }
    const p = candidates[0];
    if (!p) {
      unmatched++;
      out.push({ rowNumber: r.rowNumber, changeType: 'unmatched', productId: null, parsed: r });
      continue;
    }
    matched++;
    seenProducts.add(p.id);
    const old = current.get(p.id);
    const priceChanged = !old || !sameMoney(old.price, r.price);
    const availChanged = !old || old.available !== r.available;
    if (priceChanged) priceChanges++;
    if (availChanged) availChanges++;
    out.push({
      rowNumber: r.rowNumber,
      changeType: priceChanged && availChanged ? 'price_availability' : priceChanged ? 'price' : availChanged ? 'availability' : 'none',
      productId: p.id,
      parsed: r,
      price: priceChanged ? { old: old?.price ?? null, new: r.price } : undefined,
      availability: availChanged ? { old: old?.available ?? null, new: r.available } : undefined,
    });
  }

  const missing =
    contains === 'full'
      ? [...current.keys()].filter((id) => !seenProducts.has(id)).map((id) => ({ productId: id, barcode: products.find((p) => p.id === id)?.normalizedBarcode ?? '' }))
      : [];

  return {
    rows: out,
    missing,
    errors,
    summary: {
      rowsRead, matched, newProducts: 0, rowsWithErrors: errors.length,
      priceChanges, stockChanges: availChanges, missingFromFile: missing.length, unmatched, costIgnored: 0,
    },
  };
}
