import { normalizeBarcode } from '../barcode.js';
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
  /** ERP rows whose negative stock was stored as 0 */
  negativeStockClamped: number;
}

/** The summary stored on an upload at review time and returned by the API (older uploads may lack the optional counts). */
export type StoredReviewSummary = Omit<ReviewSummary, 'costIgnored' | 'negativeStockClamped'> & {
  costIgnored?: number;
  negativeStockClamped?: number;
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
  let matched = 0, priceChanges = 0, stockChanges = 0, newProducts = 0, costIgnored = 0, negativeStockClamped = 0;

  for (const r of rows) {
    if (seenBarcodes.has(r.barcode)) {
      errors.push({ row: r.rowNumber, column: columnOf(fields, ['barcode']), value: r.barcode, reason: 'Duplicate barcode in this file' });
      continue;
    }
    seenBarcodes.add(r.barcode);
    if (r.costIgnored) costIgnored++;
    if (r.negativeStockClamped) negativeStockClamped++;
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
      priceChanges, stockChanges, missingFromFile: missing.length, unmatched: 0, costIgnored, negativeStockClamped,
    },
  };
}

/** What marketplace matching needs from a product. */
export type MatchProduct = Pick<CatalogProduct, 'id' | 'normalizedBarcode' | 'sku'>;

/** A marketplace product ID that is a barcode as written (Excel may add ".0"). */
const DIGITS = /^[0-9]+(\.0+)?$/;

/**
 * Marketplace matching (docs 5.5), shared by the review and the apply so the two cannot drift.
 * Returns the ids of every product the row matches under the first rule that matches any:
 * 1. any of the row's barcodes;
 * 2. the row's marketplace product ID (Talabat's sku) read as a barcode, when it is all digits;
 * 3. the marketplace product ID equal to a product's own SKU.
 * Rules 2 and 3 apply only to a row that has barcodes, none of which matched; a row without barcodes
 * (validation reports it, but one may be staged from before) matches nothing.
 * More than one id is ambiguous and never guessed.
 */
export function marketplaceMatcher(products: MatchProduct[]): (r: MarketplaceRow) => string[] {
  const byBarcode = new Map<string, string[]>();
  const bySku = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, key: string, id: string) => m.set(key, [...(m.get(key) ?? []), id]);
  for (const p of products) {
    add(byBarcode, p.normalizedBarcode, p.id);
    if (p.sku) add(bySku, p.sku, p.id);
  }
  return (r) => {
    const byRowBarcodes = [...new Set(r.barcodes.flatMap((b) => byBarcode.get(b) ?? []))];
    if (byRowBarcodes.length || !r.barcodes.length) return byRowBarcodes;
    // digits only: normalising strips letters, so a code like "LBN-500" would otherwise match barcode 500
    const idAsBarcode = DIGITS.test(r.marketplaceProductId.trim()) ? normalizeBarcode(r.marketplaceProductId) : '';
    const byId = idAsBarcode ? byBarcode.get(idAsBarcode) ?? [] : [];
    if (byId.length) return byId;
    return bySku.get(r.marketplaceProductId) ?? [];
  };
}

/**
 * Compare a validated marketplace file with the current listings (docs 5.5/5.6).
 * Matching is marketplaceMatcher's; a row matching two products is an error.
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
  const match = marketplaceMatcher(products);
  const byId = new Map(products.map((p) => [p.id, p] as const));
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

    const candidates = match(r);
    if (candidates.length > 1) {
      errors.push({ row: r.rowNumber, column: columnOf(fields, ['barcode1'], 'barcode'), value: r.barcodes.join(', '), reason: 'Matches more than one product; not guessed' });
      continue;
    }
    const p = candidates[0] === undefined ? undefined : byId.get(candidates[0]);
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
      priceChanges, stockChanges: availChanges, missingFromFile: missing.length, unmatched, costIgnored: 0, negativeStockClamped: 0,
    },
  };
}
