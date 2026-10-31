import { toFils } from '../money.js';
import type { PriceSource } from '../pricing.js';

/**
 * Reconciliation of one product on one marketplace (business rules 5.3 and 5.4).
 * Pure: the worker loads the inputs in bulk and writes the results; nothing here reads the database or the clock.
 */

/** What a price is compared with: the resolved Marketplace price, or the ERP price. */
export const RECON_REFERENCES = ['marketplace', 'erp'] as const;
export type ReconReference = (typeof RECON_REFERENCES)[number];

export const RECON_STATUSES = ['in_sync', 'mismatch', 'not_listed', 'missing_from_erp', 'new', 'no_data'] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

export const STOCK_ISSUES = ['available_but_out_of_stock', 'unavailable_but_in_stock'] as const;
export type StockIssue = (typeof STOCK_ISSUES)[number];

export interface ReconSettings {
  /** QAR; a difference of exactly the tolerance is still in sync. */
  priceTolerance: number;
  /** ERP stock must be above this to count as available. */
  stockThreshold: number;
}

export interface ReconProduct {
  status: string; // active | inactive | new
  erpActive: boolean;
  inLatestErpFile: boolean;
  erpStock: number;
  erpPrice: number;
}

export interface ReconListing {
  price: number;
  available: boolean;
}

export interface ReconInput {
  product: ReconProduct;
  /** The product's listing on this marketplace, or null when it has none. */
  listing: ReconListing | null;
  /** The marketplace has at least one applied upload. */
  hasData: boolean;
  /** The resolved Marketplace price (pricing engine, with this marketplace's step) and the rule step that chose it. */
  marketplacePrice: { price: number; source: PriceSource };
}

export interface ReconResult {
  /** Status against the Marketplace reference. */
  status: ReconStatus;
  /** Status against the ERP reference. */
  statusVsErp: ReconStatus;
  erpAvailable: boolean;
  actualAvailable: boolean | null;
  actualPrice: number | null;
  erpPrice: number;
  marketplacePrice: number;
  marketplacePriceSource: PriceSource;
  stockIssue: StockIssue | null;
  priceMismatchVsErp: boolean;
  priceMismatchVsMarketplace: boolean;
}

/** Rule 5.3: the ERP says the product can be sold. */
export function erpAvailable(product: Pick<ReconProduct, 'status' | 'erpActive' | 'inLatestErpFile' | 'erpStock'>, stockThreshold: number): boolean {
  return product.status === 'active' && product.erpActive && product.inLatestErpFile && product.erpStock > stockThreshold;
}

/** |actual - expected| > tolerance, in integer fils so 0.1 + 0.2 never counts as a mismatch. */
export function priceMismatch(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(toFils(actual) - toFils(expected)) > toFils(tolerance);
}

/** Rule 5.4 in its fixed order; the first step that applies decides the status. One object per call (200,000 a run). */
export function reconcile(input: ReconInput, settings: ReconSettings): ReconResult {
  const { product, listing, hasData, marketplacePrice } = input;
  const available = erpAvailable(product, settings.stockThreshold);
  let status: ReconStatus;
  let statusVsErp: ReconStatus;
  let stockIssue: StockIssue | null = null;
  let priceMismatchVsErp = false;
  let priceMismatchVsMarketplace = false;

  if (!hasData) {
    // 1. an enabled marketplace with no applied upload yet: nothing to compare with
    status = statusVsErp = 'no_data';
  } else if (product.status === 'new') {
    // 2. a new product is not reconciled until it is activated
    status = statusVsErp = 'new';
  } else if (!listing) {
    // 3. not on the marketplace: only a sellable product should be
    status = statusVsErp = product.status === 'active' && product.inLatestErpFile && product.erpActive ? 'not_listed' : 'in_sync';
  } else if (!product.inLatestErpFile) {
    // 4. gone from the ERP file but still listed
    status = statusVsErp = 'missing_from_erp';
    if (listing.available) stockIssue = 'available_but_out_of_stock';
  } else {
    // 5. compare price (per reference) and availability
    stockIssue = available && !listing.available ? 'unavailable_but_in_stock'
      : !available && listing.available ? 'available_but_out_of_stock'
        : null;
    priceMismatchVsErp = priceMismatch(listing.price, product.erpPrice, settings.priceTolerance);
    priceMismatchVsMarketplace = priceMismatch(listing.price, marketplacePrice.price, settings.priceTolerance);
    status = stockIssue || priceMismatchVsMarketplace ? 'mismatch' : 'in_sync';
    statusVsErp = stockIssue || priceMismatchVsErp ? 'mismatch' : 'in_sync';
  }
  return {
    status, statusVsErp, erpAvailable: available,
    actualAvailable: listing ? listing.available : null, actualPrice: listing ? listing.price : null,
    erpPrice: product.erpPrice, marketplacePrice: marketplacePrice.price, marketplacePriceSource: marketplacePrice.source,
    stockIssue, priceMismatchVsErp, priceMismatchVsMarketplace,
  };
}

/** The status and price flag that belong to one reference. */
export function forReference(r: Pick<ReconResult, 'status' | 'statusVsErp' | 'priceMismatchVsErp' | 'priceMismatchVsMarketplace'>, reference: ReconReference) {
  return reference === 'erp'
    ? { status: r.statusVsErp, priceMismatch: r.priceMismatchVsErp }
    : { status: r.status, priceMismatch: r.priceMismatchVsMarketplace };
}

/** The latest applied upload is older than staleHours. No upload is "no data", not stale. */
export function isStale(lastUploadAt: Date | null, staleHours: number, now: Date): boolean {
  return lastUploadAt !== null && now.getTime() - lastUploadAt.getTime() > staleHours * 3_600_000;
}

/**
 * Urgent first: a product the marketplace sells but the store cannot supply, then one the store could sell but the
 * marketplace hides, then a wrong price, then everything else. The database sorts by the same ranks (ReconRepository).
 */
export function urgency(r: Pick<ReconResult, 'stockIssue'> & { priceMismatch: boolean }): number {
  if (r.stockIssue === 'available_but_out_of_stock') return 0;
  if (r.stockIssue === 'unavailable_but_in_stock') return 1;
  if (r.priceMismatch) return 2;
  return 3;
}

export interface ReconCounts {
  stock: number; price: number; total: number;
  listed: number; notListed: number; noData: number; missingFromErp: number; newCount: number;
}

/**
 * Counts of one marketplace for one reference. total = stock + price: a product with both issues counts once in each.
 * The worker computes the stored summary in SQL from the stored rows; this is the same definition, for tests.
 */
export function countRows(rows: ReconResult[], reference: ReconReference): ReconCounts {
  const c: ReconCounts = { stock: 0, price: 0, total: 0, listed: 0, notListed: 0, noData: 0, missingFromErp: 0, newCount: 0 };
  for (const r of rows) {
    const { status, priceMismatch: pm } = forReference(r, reference);
    if (r.stockIssue) c.stock++;
    if (pm) c.price++;
    if (r.actualPrice !== null) c.listed++;
    if (status === 'not_listed') c.notListed++;
    if (status === 'no_data') c.noData++;
    if (status === 'missing_from_erp') c.missingFromErp++;
    if (status === 'new') c.newCount++;
  }
  c.total = c.stock + c.price;
  return c;
}
