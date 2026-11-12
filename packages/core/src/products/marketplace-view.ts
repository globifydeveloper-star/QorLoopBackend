import { toFils } from '../money.js';
import type { ReconReference, ReconStatus, StockIssue } from '../recon/status.js';

/**
 * One product as seen on one marketplace, for the catalogue product list (GET /api/products?marketplaceId=...).
 * Pure: the repository reads the winning listing, its upload and the stored recon row for a page in one statement.
 * The database filter (ProductRepository marketplace filter) selects exactly the products this classifies as
 * `in_sync`, `mismatch` or `not_in_file`: change both together.
 */

export const MARKETPLACE_COMPARISONS = ['in_sync', 'mismatch', 'not_in_file', 'not_applicable'] as const;
export type MarketplaceComparison = (typeof MARKETPLACE_COMPARISONS)[number];

/** The list filter: every comparison except not_applicable. */
export const MARKETPLACE_STATUS_FILTERS = ['mismatch', 'in_sync', 'not_in_file'] as const;
export type MarketplaceStatusFilter = (typeof MARKETPLACE_STATUS_FILTERS)[number];

export const PRICE_ISSUES = ['marketplace_price_higher', 'marketplace_price_lower'] as const;
export type PriceIssue = (typeof PRICE_ISSUES)[number];

/** The stored recon row's values for the requested reference (status/stock issue/price flag of that reference). */
export interface MarketplaceReconInput {
  status: ReconStatus;
  stockIssue: StockIssue | null;
  priceMismatch: boolean;
  /** recon_rows.actual_price: the listing price at the last recompute. */
  actualPrice: number | null;
  /** The reference's expected price: marketplace_price (marketplace) or erp_price (erp). */
  expectedPrice: number | null;
}

export interface MarketplaceViewInput {
  marketplaceId: string;
  reference: ReconReference;
  /** The marketplace has an applied upload; without one nothing is compared. */
  hasData: boolean;
  /** The winning listing (same choice as recon), or null when the product is not in the marketplace file. */
  listing: { price: string; available: boolean; uploadedAt: Date | null } | null;
  recon: MarketplaceReconInput | null;
}

export interface MarketplaceView {
  marketplaceId: string;
  reference: ReconReference;
  available: boolean | null;
  price: string | null;
  inFile: boolean;
  comparison: MarketplaceComparison;
  stockIssue: StockIssue | null;
  priceIssue: PriceIssue | null;
  sourceUploadedAt: Date | null;
}

/**
 * 1. no applied upload: not_applicable; 2. no listing: not_in_file; 3. no recon row yet: not_applicable;
 * 4. recon in_sync / mismatch as stored; 5. missing_from_erp but still listed available (a stock issue): mismatch;
 * 6. new, not_listed (a listing newer than the recompute) or missing_from_erp without an issue: not_applicable.
 */
export function marketplaceComparison(hasData: boolean, inFile: boolean, recon: Pick<MarketplaceReconInput, 'status' | 'stockIssue'> | null): MarketplaceComparison {
  if (!hasData) return 'not_applicable';
  if (!inFile) return 'not_in_file';
  if (!recon) return 'not_applicable';
  if (recon.status === 'in_sync') return 'in_sync';
  if (recon.status === 'mismatch') return 'mismatch';
  if (recon.status === 'missing_from_erp' && recon.stockIssue) return 'mismatch';
  return 'not_applicable';
}

/** The price flag of the reference, with its direction compared in integer fils. */
export function priceIssueOf(recon: Pick<MarketplaceReconInput, 'priceMismatch' | 'actualPrice' | 'expectedPrice'>): PriceIssue | null {
  if (!recon.priceMismatch || recon.actualPrice === null || recon.expectedPrice === null) return null;
  const actual = toFils(recon.actualPrice);
  const expected = toFils(recon.expectedPrice);
  if (actual === expected) return null;
  return actual > expected ? 'marketplace_price_higher' : 'marketplace_price_lower';
}

export function marketplaceView(i: MarketplaceViewInput): MarketplaceView {
  const inFile = i.hasData && i.listing !== null;
  const comparison = marketplaceComparison(i.hasData, inFile, i.recon);
  // issues only where something was compared: in the file and with a recon row
  const compared = inFile && i.recon !== null && comparison !== 'not_applicable';
  return {
    marketplaceId: i.marketplaceId,
    reference: i.reference,
    available: inFile ? i.listing!.available : null,
    price: inFile ? i.listing!.price : null,
    inFile,
    comparison,
    stockIssue: compared ? i.recon!.stockIssue : null,
    priceIssue: compared ? priceIssueOf(i.recon!) : null,
    sourceUploadedAt: inFile ? i.listing!.uploadedAt : null,
  };
}
