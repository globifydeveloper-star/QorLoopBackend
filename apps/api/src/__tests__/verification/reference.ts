/**
 * Independent reference calculator for the full-verification suite.
 *
 * Written ONLY from the written rules, never from the product implementation. It imports nothing from
 * packages/core, packages/db, packages/shared or apps/*: plain TypeScript, integer fils (1 QAR = 1000 fils) and BigInt
 * where a product could overflow. Every rule carries its source; "ASSUMPTION" marks a point the documents leave open, so
 * the report can say which mismatches are bugs and which are documentation gaps.
 *
 * Sources (paths from the repository root unless noted):
 *   BR   = QorloopFrontend/docs/05-business-rules.md (the business-rules document ADR 008 names as the source)
 *   DM   = QorloopFrontend/docs/04-data-model.md
 *   OQ   = QorloopFrontend/docs/08-open-questions.md
 *   A008 = docs/decisions/008-uploads-and-catalogue-schema.md, A009 = 009-reconciliation-worker.md,
 *   A011 = 011-generated-marketplace-files.md, A013 = 013-bulk-price-changes.md, A017 = 017-erp-changes-catalogue-stock.md,
 *   PAPI = docs/products-api.md ("Blocked products"), SAPI = docs/settings-activity-api.md, OG = docs/open-gaps.md
 */

// ───────────────────────────── rule register (listed in the report) ─────────────────────────────
export const RULES = {
  R01: 'Barcode: trim, strip a trailing ".0", strip non-digits, strip leading zeros; GTIN-14 with a leading 0 equals the EAN-13 (BR 5.5, A008)',
  R02: 'An empty normalised barcode is a row error (BR 5.6 required field; OG G11 "Barcode is empty")',
  R03: 'Marketplace row matches a product on any of barcode 1..3; with no barcode match, fall back to SKU (BR 5.5). ASSUMPTION: the marketplace product ID is compared with the ERP SKU, trimmed',
  R04: 'Two products matching one marketplace row is an error; never guess (BR 5.5)',
  R05: 'ERP required fields barcode, name (EN), selling price, stock; missing value or non-numeric price/stock is a row error and the row is skipped (BR 5.6)',
  R06: 'An upload with MORE than 20% invalid rows is rejected; exactly 20% is accepted (BR 5.6, A008, OG G6)',
  R07: 'ERP duplicate barcode (after normalisation): ASSUMPTION the first row wins and later rows are row errors, as A011 states for marketplace files',
  R08: 'Negative ERP stock: ASSUMPTION valid numeric stock (the documents only require numeric); it is <= threshold so never available',
  R09: 'Money is integer fils; a value with more than 3 decimals is rounded half-up to fils (DM numeric(12,3); A013 "halves up")',
  R10: 'Marketplace Price: the first rule that applies — offer > product > subcategory > category > per-marketplace (only when enabled) > default (BR 5.1)',
  R11: 'Offer applies when valid_from <= now (or null) and now <= valid_until (or null); expired or future offers do not apply (pricing-offers-bulk-api OfferState)',
  R12: 'Rule modes: percent ERP*(1+v/100), amount ERP+v, fixed v, same ERP; rounding only for percent/amount; fixed, same and offers exact (BR 5.1)',
  R13: 'Rounding step exact|0.05|0.25|0.50, halves up, once (BR 5.1, A013). ASSUMPTION: a percent result is first rounded half-up to whole fils',
  R14: 'Reference "marketplace": expected price = resolved Marketplace Price; "erp": expected = ERP price (BR 5.2)',
  R15: 'Should be available when status active AND erp_active AND in latest full ERP file AND stock > threshold (BR 5.3; A017 D3/D4)',
  R16: 'Marketplace availability: True/False, Yes/No, 1/0 or a quantity (> 0 = available) (BR 5.3)',
  R17: 'Stock issue: ERP available & marketplace unavailable = unavailable_but_in_stock; ERP unavailable & marketplace available = available_but_out_of_stock (BR 5.3)',
  R18: 'Status order: no file -> no_data; status new -> new; no listing -> not_listed (active, in ERP file, ERP-active) else in_sync; not in ERP file but listed -> missing_from_erp (+available_but_out_of_stock if available); else price mismatch |actual-expected| > tolerance (fils) or stock issue -> mismatch, otherwise in_sync (BR 5.4)',
  R19: 'Blocked products are ignored by every check: no recon row, never in a generated file, not counted (PAPI "What skips a blocked product")',
  R20: 'A source is stale when its latest upload is older than stale_hours (default 12) (BR 5.4, SAPI)',
  R21: 'Generated file rows: listed rows except missing_from_erp; scope mismatches filters by the kind (price: price mismatch; stock: stock issue; stock_price: either). missing_from_erp stock issues stay selectable (BR 5.8, A011)',
  R22: 'Generated file values: price = expected price of the reference; availability = should-be-available; every other cell and every unselected row unchanged; unselected rows are not written (A011)',
  R23: 'Text prices keep their decimal places, more only when needed; numbers stay numbers; boolean text keeps its spelling and case (A011)',
  R24: 'Formula-like cells (= + - @ first) are neutralised with a leading apostrophe in generated files (A011)',
  R25: 'First ERP import: every product active; later ERP files create products with status new (BR 5.6)',
  R26: 'The Arabic name is taken from the ERP only when Qorloop\'s is empty (BR 5.6, DM ownership)',
  R27: 'Marketplace duplicate identifier: the first row is kept, the others are row errors (A011)',
  R28: 'Each tenant sees only its own rows (A007 security invariants, A008)',
} as const;

// ───────────────────────────── primitives ─────────────────────────────
export type Fils = number;

/** R01. Returns '' when nothing is left (R02 decides that is an error). */
export function refBarcode(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? (Number.isInteger(value) ? BigInt(value).toString() : String(value)) : String(value);
  s = s.trim();
  if (s.endsWith('.0')) s = s.slice(0, -2);
  s = s.replace(/\D+/g, '');
  s = s.replace(/^0+/, '');
  return s;
}

/** R09: decimal text or number -> integer fils, half-up. null when not a finite number. */
export function refFils(value: unknown): Fils | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toString() : '') : String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    if (/^-?\d+(\.\d+)?e[+-]?\d+$/i.test(text)) return refFils(Number(text).toFixed(6));
    return null;
  }
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const padded = (frac + '0000').slice(0, 4);
  let fils = BigInt(whole!) * 1000n + BigInt(padded.slice(0, 3));
  if (Number(padded[3]) >= 5) fils += 1n;
  const n = Number(fils);
  return negative ? -n : n;
}

export function filsToText(fils: Fils, decimals = 3) {
  const negative = fils < 0;
  const abs = Math.abs(fils);
  const whole = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, '0');
  const body = decimals === 0 ? String(whole) : `${whole}.${(frac + '000').slice(0, decimals)}`;
  return (negative ? '-' : '') + body;
}

/** R16. undefined = unreadable (row error). */
export function refAvailability(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value > 0 : undefined;
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim().toLowerCase();
  if (['true', 'yes', '1', 'y'].includes(s)) return true;
  if (['false', 'no', '0', 'n'].includes(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s) > 0;
  return undefined;
}

// ───────────────────────────── ERP validation ─────────────────────────────
export type ErpInput = { barcode?: unknown; nameEn?: unknown; nameAr?: unknown; price?: unknown; stock?: unknown; active?: unknown; category?: unknown; sku?: unknown };
export type ErpProduct = { row: number; barcode: string; nameEn: string; nameAr: string | null; priceFils: Fils; stock: number; erpActive: boolean; category: string | null; sku: string | null };
export type RowError = { row: number; field: string; reason: 'missing' | 'not_numeric' | 'duplicate' | 'unreadable' };
export type ErpValidation = { products: ErpProduct[]; errors: RowError[]; rowsRead: number; rejected: boolean };

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
function refActive(v: unknown): boolean {
  if (blank(v)) return true;
  const a = refAvailability(v);
  return a ?? true;
}

/** Rows are numbered as the spreadsheet does: the header is row 1, the first data row is row 2. */
export function refValidateErp(rows: ErpInput[]): ErpValidation {
  const products: ErpProduct[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const row = i + 2;
    const rowErrors: RowError[] = [];
    const barcode = refBarcode(r.barcode);
    if (!barcode) rowErrors.push({ row, field: 'barcode', reason: 'missing' });
    if (blank(r.nameEn)) rowErrors.push({ row, field: 'nameEn', reason: 'missing' });
    const price = blank(r.price) ? undefined : refFils(r.price);
    if (price === undefined) rowErrors.push({ row, field: 'price', reason: 'missing' });
    else if (price === null) rowErrors.push({ row, field: 'price', reason: 'not_numeric' });
    const stockFils = blank(r.stock) ? undefined : refFils(r.stock);
    if (stockFils === undefined) rowErrors.push({ row, field: 'stock', reason: 'missing' });
    else if (stockFils === null) rowErrors.push({ row, field: 'stock', reason: 'not_numeric' });
    if (!rowErrors.length && seen.has(barcode)) rowErrors.push({ row, field: 'barcode', reason: 'duplicate' }); // R07
    if (rowErrors.length) { errors.push(...rowErrors); return; }
    seen.add(barcode);
    products.push({
      row, barcode, nameEn: String(r.nameEn).trim(), nameAr: blank(r.nameAr) ? null : String(r.nameAr).trim(),
      priceFils: price as Fils, stock: Math.trunc((stockFils as Fils) / 1000), erpActive: refActive(r.active),
      category: blank(r.category) ? null : String(r.category).trim(), sku: blank(r.sku) ? null : String(r.sku).trim(),
    });
  });
  const invalidRows = new Set(errors.map(e => e.row)).size;
  return { products, errors, rowsRead: rows.length, rejected: rows.length > 0 && invalidRows * 5 > rows.length }; // R06
}

// ───────────────────────────── marketplace rows ─────────────────────────────
export type MarketInput = { id?: unknown; barcode1?: unknown; barcode2?: unknown; barcode3?: unknown; name?: unknown; price?: unknown; available?: unknown };
export type MarketListing = { row: number; id: string; barcodes: string[]; priceFils: Fils; available: boolean };
export type MarketValidation = { listings: MarketListing[]; errors: RowError[]; rowsRead: number; rejected: boolean };

/** idRequired: Talabat carries its own product id (sku); others fall back to the first barcode (A011 "IDs"). */
export function refValidateMarket(rows: MarketInput[], idRequired: boolean): MarketValidation {
  const listings: MarketListing[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const row = i + 2;
    const rowErrors: RowError[] = [];
    const barcodes = [r.barcode1, r.barcode2, r.barcode3].map(refBarcode).filter(Boolean);
    if (!refBarcode(r.barcode1)) rowErrors.push({ row, field: 'barcode1', reason: 'missing' });
    const id = blank(r.id) ? (idRequired ? '' : String(r.barcode1 ?? '').trim()) : String(r.id).trim();
    if (idRequired && !id) rowErrors.push({ row, field: 'marketplaceProductId', reason: 'missing' });
    const price = blank(r.price) ? undefined : refFils(r.price);
    if (price === undefined) rowErrors.push({ row, field: 'price', reason: 'missing' });
    else if (price === null) rowErrors.push({ row, field: 'price', reason: 'not_numeric' });
    const available = refAvailability(r.available);
    if (available === undefined) rowErrors.push({ row, field: 'available', reason: blank(r.available) ? 'missing' : 'unreadable' });
    const key = idRequired ? id : refBarcode(id);
    if (!rowErrors.length && seen.has(key)) rowErrors.push({ row, field: 'marketplaceProductId', reason: 'duplicate' }); // R27
    if (rowErrors.length) { errors.push(...rowErrors); return; }
    seen.add(key);
    listings.push({ row, id, barcodes, priceFils: price as Fils, available: available as boolean });
  });
  const invalidRows = new Set(errors.map(e => e.row)).size;
  return { listings, errors, rowsRead: rows.length, rejected: rows.length > 0 && invalidRows * 5 > rows.length };
}

export type CatalogueProduct = {
  key: string; // stable fixture key
  barcode: string; sku: string | null; nameEn: string; priceFils: Fils; stock: number; erpActive: boolean; inLatestErpFile: boolean;
  status: 'active' | 'inactive' | 'new'; blocked: boolean; categoryKey: string | null; subcategoryKey: string | null;
};

/** R03/R04: product key or 'unmatched' or 'ambiguous'. */
export function refMatch(listing: { barcodes: string[]; id: string }, products: CatalogueProduct[]): string | 'unmatched' | 'ambiguous' {
  const byBarcode = new Set(products.filter(p => listing.barcodes.includes(p.barcode)).map(p => p.key));
  if (byBarcode.size > 1) return 'ambiguous';
  if (byBarcode.size === 1) return [...byBarcode][0]!;
  const bySku = products.filter(p => p.sku !== null && p.sku === listing.id.trim());
  if (bySku.length > 1) return 'ambiguous';
  return bySku[0]?.key ?? 'unmatched';
}

// ───────────────────────────── pricing ─────────────────────────────
export type Rule = { mode: 'same' } | { mode: 'percent' | 'amount' | 'fixed'; value: string };
export type Rounding = 'exact' | '0.05' | '0.25' | '0.50';
export type Offer = { priceFils: Fils; validFrom: Date | null; validUntil: Date | null };
export type PricingInput = {
  defaultRule: Rule; rounding: Rounding; perMarketplaceEnabled: boolean;
  marketplaceRules: Record<string, Rule & { rounding: Rounding }>;
  categoryRules: Record<string, Rule>; // key: categoryKey
  subcategoryRules: Record<string, Rule>; // key: `${categoryKey}/${subcategoryKey}`
  productRules: Record<string, Rule>; // key: product key
  offers: Record<string, Offer>; // key: product key
};
export type PriceSource = 'offer' | 'product' | 'category' | 'marketplace' | 'default';

/** R13: round fils to a step, halves up. */
function roundStep(fils: bigint, rounding: Rounding): bigint {
  if (rounding === 'exact') return fils;
  const step = BigInt(Math.round(Number(rounding) * 1000));
  return ((fils * 2n + step) / (2n * step)) * step; // half-up for non-negative prices
}

/** R12/R13. value is decimal text (<= 3 decimals). */
export function refApplyRule(erpFils: Fils, rule: Rule, rounding: Rounding): Fils {
  if (rule.mode === 'same') return erpFils;
  const v = refFils(rule.value)!;
  if (rule.mode === 'fixed') return v;
  const erp = BigInt(erpFils);
  let result: bigint;
  if (rule.mode === 'amount') result = erp + BigInt(v);
  else {
    // ERP * (1 + p/100) = ERP * (100000 + p*1000) / 100000; v already holds p*1000 (the percent read as fils).
    const num = erp * (100_000n + BigInt(v));
    result = (num * 2n + 100_000n) / 200_000n; // half-up to whole fils
  }
  return Number(roundStep(result, rounding));
}

export function refOfferActive(offer: Offer | undefined, now: Date): boolean {
  if (!offer) return false;
  if (offer.validFrom && offer.validFrom.getTime() > now.getTime()) return false;
  if (offer.validUntil && offer.validUntil.getTime() < now.getTime()) return false;
  return true;
}

/** R10/R11. */
export function refMarketplacePrice(p: CatalogueProduct, marketplaceId: string, pricing: PricingInput, now: Date): { fils: Fils; source: PriceSource } {
  const offer = pricing.offers[p.key];
  if (refOfferActive(offer, now)) return { fils: offer!.priceFils, source: 'offer' };
  const product = pricing.productRules[p.key];
  if (product) return { fils: refApplyRule(p.priceFils, product, pricing.rounding), source: 'product' };
  if (p.categoryKey && p.subcategoryKey) {
    const sub = pricing.subcategoryRules[`${p.categoryKey}/${p.subcategoryKey}`];
    if (sub) return { fils: refApplyRule(p.priceFils, sub, pricing.rounding), source: 'category' };
  }
  if (p.categoryKey) {
    const cat = pricing.categoryRules[p.categoryKey];
    if (cat) return { fils: refApplyRule(p.priceFils, cat, pricing.rounding), source: 'category' };
  }
  if (pricing.perMarketplaceEnabled) {
    const mp = pricing.marketplaceRules[marketplaceId];
    if (mp) return { fils: refApplyRule(p.priceFils, mp, mp.rounding), source: 'marketplace' };
  }
  return { fils: refApplyRule(p.priceFils, pricing.defaultRule, pricing.rounding), source: 'default' };
}

// ───────────────────────────── availability, recon ─────────────────────────────
/** R15. */
export function refShouldBeAvailable(p: CatalogueProduct, threshold: number): boolean {
  return p.status === 'active' && p.erpActive && p.inLatestErpFile && p.stock > threshold;
}

export type StockIssue = 'unavailable_but_in_stock' | 'available_but_out_of_stock' | null;
export type ReconStatus = 'no_data' | 'new' | 'not_listed' | 'in_sync' | 'missing_from_erp' | 'mismatch';
export type ExpectedRecon = {
  productKey: string; marketplaceId: string; status: ReconStatus; expectedFils: Fils; source: PriceSource; erpFils: Fils;
  actualFils: Fils | null; shouldBeAvailable: boolean; actualAvailable: boolean | null;
  priceMismatch: boolean; priceMismatchVsErp: boolean; stockIssue: StockIssue;
};
export type ReconSettings = { tolerance: Fils; threshold: number; staleHours: number };

/** R17/R18 for one product x marketplace, catalogue (marketplace) reference. hasFile = the marketplace has an applied upload. */
export function refReconcile(p: CatalogueProduct, marketplaceId: string, listing: { priceFils: Fils; available: boolean } | null, hasFile: boolean,
  pricing: PricingInput, settings: ReconSettings, now: Date): ExpectedRecon | null {
  if (p.blocked) return null; // R19
  const price = refMarketplacePrice(p, marketplaceId, pricing, now);
  const should = refShouldBeAvailable(p, settings.threshold);
  const base = { productKey: p.key, marketplaceId, expectedFils: price.fils, source: price.source, erpFils: p.priceFils,
    actualFils: listing?.priceFils ?? null, shouldBeAvailable: should, actualAvailable: listing?.available ?? null,
    priceMismatch: false, priceMismatchVsErp: false, stockIssue: null as StockIssue };
  if (!hasFile) return { ...base, status: 'no_data' };
  if (p.status === 'new') return { ...base, status: 'new' };
  if (!listing) return { ...base, status: p.status === 'active' && p.inLatestErpFile && p.erpActive ? 'not_listed' : 'in_sync' };
  if (!p.inLatestErpFile) return { ...base, status: 'missing_from_erp', stockIssue: listing.available ? 'available_but_out_of_stock' : null };
  const priceMismatch = Math.abs(listing.priceFils - price.fils) > settings.tolerance;
  const priceMismatchVsErp = Math.abs(listing.priceFils - p.priceFils) > settings.tolerance;
  const stockIssue: StockIssue = should && !listing.available ? 'unavailable_but_in_stock' : !should && listing.available ? 'available_but_out_of_stock' : null;
  return { ...base, priceMismatch, priceMismatchVsErp, stockIssue, status: priceMismatch || stockIssue ? 'mismatch' : 'in_sync' };
}

/** R20. */
export function refStale(lastUploadAt: Date | null, now: Date, staleHours: number): boolean {
  if (!lastUploadAt) return false;
  return now.getTime() - lastUploadAt.getTime() > staleHours * 3_600_000;
}

// ───────────────────────────── generated files ─────────────────────────────
export type FileKind = 'price' | 'stock' | 'stock_price';
/** R21. */
export function refSelected(r: ExpectedRecon, kind: FileKind, scope: 'mismatches' | 'all'): boolean {
  if (r.actualFils === null) return false; // not listed
  if (scope === 'all') return r.status !== 'missing_from_erp';
  const price = r.status !== 'missing_from_erp' && r.priceMismatch;
  const stock = r.stockIssue !== null;
  return kind === 'price' ? price : kind === 'stock' ? stock : price || stock;
}

/** R23: decimals a text price must keep: its own, more only when the fils need it. */
export function refPriceText(fils: Fils, sourceText: string): string {
  const own = (sourceText.split('.')[1] ?? '').length;
  const needed = fils % 10 !== 0 ? 3 : fils % 100 !== 0 ? 2 : fils % 1000 !== 0 ? 1 : 0;
  return filsToText(fils, Math.max(own, needed));
}
/** R23: boolean text keeps its spelling family and case. */
export function refBoolText(value: boolean, sourceText: string): string {
  const lower = sourceText.toLowerCase();
  const [t, f] = lower === 'yes' || lower === 'no' ? ['yes', 'no'] : lower === 'y' || lower === 'n' ? ['y', 'n'] : lower === '1' || lower === '0' ? ['1', '0'] : ['true', 'false'];
  const word = value ? t! : f!;
  if (sourceText === sourceText.toUpperCase() && sourceText !== sourceText.toLowerCase()) return word.toUpperCase();
  if (sourceText[0] === sourceText[0]?.toUpperCase() && sourceText !== sourceText.toLowerCase()) return word[0]!.toUpperCase() + word.slice(1);
  return word;
}
/** R24. */
export function refSafeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
