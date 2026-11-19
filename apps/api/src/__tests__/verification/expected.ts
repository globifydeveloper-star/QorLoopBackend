/**
 * Expected outputs for the golden datasets, computed ONLY with the reference calculator (reference.ts) from the dataset rows.
 * It simulates the documented pipeline: ERP import(s) -> Qorloop edits (block, inactive, categories, rules, offers) ->
 * marketplace uploads -> reconciliation -> generated files.
 */
import * as ref from './reference.js';
import {
  type Cell, type Dataset, type ErpRow, type RuleSpec, ERP_HEADERS, ERP_MAPPING, TALABAT_HEADERS, SNOONU_HEADERS,
  talabatCells, snoonuCells,
} from './datasets.js';

export type MarketplaceId = 'talabat' | 'snoonu';
export const MARKETPLACES: MarketplaceId[] = ['talabat', 'snoonu'];

/** The value a cell carries (a date-formatted number is still that number). */
export const cellValue = (c: Cell): unknown => (c !== null && typeof c === 'object' ? c.date : c);

/** Attribution variant only (REF_CONFIG.dateCellsAsDates): the digits of the ISO date an Excel serial shows, or '' when too large. */
function dateDigits(serial: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() > 9999 ? '' : d.toISOString().replace(/\D/g, '');
}
export function erpInputs(rows: ErpRow[]): ref.ErpInput[] {
  const barcode = (c: Cell) => (c !== null && typeof c === 'object' && ref.REF_CONFIG.dateCellsAsDates ? dateDigits(c.date) : cellValue(c));
  return rows.map(r => ({ barcode: barcode(r[0]), nameEn: r[1], nameAr: r[2], price: r[3], stock: r[4], active: r[5], category: r[6], sku: r[7] }));
}
export const ERP_FIELD_HEADER: Record<string, string> = ERP_MAPPING;
export const MARKET_FIELD_HEADER: Record<MarketplaceId, Record<string, string>> = {
  talabat: { marketplaceProductId: 'sku', barcode1: 'barcode 1', price: 'price', available: 'active' },
  snoonu: { marketplaceProductId: SNOONU_HEADERS[0]!, barcode1: SNOONU_HEADERS[0]!, price: SNOONU_HEADERS[3]!, available: SNOONU_HEADERS[2]! },
};

export type ExpectedListing = ref.MarketListing & { match: string | 'unmatched' | 'ambiguous' };
export type ExpectedMarket = {
  validation: ref.MarketValidation;
  listings: ExpectedListing[];
  /** source rows as written (header excluded) and each row's identifier as the generator compares it */
  sourceRows: Cell[][];
  identifiers: string[];
  headers: string[];
};
export type ExpectedDataset = {
  name: string;
  erp1: ref.ErpValidation;
  erp2?: ref.ErpValidation;
  /** final catalogue keyed by normalised barcode */
  products: Map<string, ref.CatalogueProduct & { nameAr: string | null }>;
  market: Partial<Record<MarketplaceId, ExpectedMarket>>;
  recon: ref.ExpectedRecon[];
  pricing: ref.PricingInput;
  settings: ref.ReconSettings;
  stale: Partial<Record<MarketplaceId, boolean>>;
};

const rule = (r: RuleSpec): ref.Rule => r;

export function pricingFor(ds: Dataset, now: Date): ref.PricingInput {
  const p = ds.pricing ?? {};
  const categoryRules: Record<string, ref.Rule> = {};
  const subcategoryRules: Record<string, ref.Rule> = {};
  for (const [cat, def] of Object.entries(p.categories ?? {})) {
    if (def.rule) categoryRules[cat] = rule(def.rule);
    for (const [sub, r] of Object.entries(def.subcategories ?? {})) if (r) subcategoryRules[`${cat}/${sub}`] = rule(r);
  }
  const offers: Record<string, ref.Offer> = {};
  for (const [barcode, o] of Object.entries(p.offers ?? {})) {
    offers[barcode] = { priceFils: ref.refFils(o.price)!, validFrom: o.fromMs === null ? null : new Date(now.getTime() + o.fromMs),
      validUntil: o.untilMs === null ? null : new Date(now.getTime() + o.untilMs) };
  }
  return {
    defaultRule: rule(p.defaultRule ?? { mode: 'same' }), rounding: p.rounding ?? 'exact',
    perMarketplaceEnabled: Boolean(p.perMarketplace), marketplaceRules: Object.fromEntries(Object.entries(p.perMarketplace ?? {}).map(([k, v]) => [k, { ...rule(v), rounding: v.rounding }])),
    categoryRules, subcategoryRules, productRules: Object.fromEntries(Object.entries(p.productRules ?? {}).map(([k, v]) => [k, rule(v)])), offers,
  };
}

function marketInputs(ds: Dataset, mp: MarketplaceId): { inputs: ref.MarketInput[]; cells: Cell[][]; identifiers: string[]; headers: string[] } {
  if (mp === 'talabat') {
    const rows = ds.talabat ?? [];
    return { inputs: rows.map(r => ({ id: r.sku, barcode1: cellValue(r.barcode1), barcode2: r.barcode2, barcode3: r.barcode3, name: r.name, price: r.price, available: r.active })),
      cells: rows.map(talabatCells), identifiers: rows.map(r => r.sku.trim()), headers: TALABAT_HEADERS };
  }
  const rows = ds.snoonu ?? [];
  return { inputs: rows.map(r => ({ barcode1: cellValue(r.barcode), name: r.name, price: r.price, available: r.available })),
    cells: rows.map(snoonuCells), identifiers: rows.map(r => ref.refBarcode(cellValue(r.barcode))), headers: SNOONU_HEADERS };
}

export function computeExpected(ds: Dataset, now: Date, enabledWithoutFile: MarketplaceId[] = []): ExpectedDataset {
  const settings: ref.ReconSettings = { tolerance: ref.refFils(ds.settings.tolerance)!, threshold: ds.settings.threshold, staleHours: ds.settings.staleHours };
  const erp1 = ref.refValidateErp(erpInputs(ds.erp));
  const products = new Map<string, ref.CatalogueProduct & { nameAr: string | null }>();
  if (!erp1.rejected) {
    for (const p of erp1.products) { // R25: first import -> active
      const [cat, sub] = ds.pricing?.assign?.[p.barcode] ?? [null, null];
      products.set(p.barcode, { key: p.barcode, barcode: p.barcode, sku: p.sku, nameEn: p.nameEn, nameAr: p.nameAr, priceFils: p.priceFils, stock: p.stock,
        erpActive: p.erpActive, inLatestErpFile: true, status: 'active', blocked: false, categoryKey: cat ?? null, subcategoryKey: sub ?? null });
    }
  }
  for (const b of ds.block ?? []) { const p = products.get(b); if (p) p.blocked = true; }
  for (const b of ds.inactive ?? []) { const p = products.get(b); if (p) p.status = 'inactive'; }
  let erp2: ref.ErpValidation | undefined;
  if (ds.erp2) {
    erp2 = ref.refValidateErp(erpInputs(ds.erp2));
    if (!erp2.rejected) {
      const inFile = new Set(erp2.products.map(p => p.barcode));
      for (const p of products.values()) if (!inFile.has(p.barcode)) p.inLatestErpFile = false; // full file (BR 5.6)
      for (const row of erp2.products) {
        const existing = products.get(row.barcode);
        if (existing) {
          Object.assign(existing, { nameEn: row.nameEn, priceFils: row.priceFils, stock: row.stock, erpActive: row.erpActive, sku: row.sku, inLatestErpFile: true });
          if (!existing.nameAr && row.nameAr) existing.nameAr = row.nameAr; // R26
        } else {
          products.set(row.barcode, { key: row.barcode, barcode: row.barcode, sku: row.sku, nameEn: row.nameEn, nameAr: row.nameAr, priceFils: row.priceFils,
            stock: row.stock, erpActive: row.erpActive, inLatestErpFile: true, status: 'new', blocked: false, categoryKey: null, subcategoryKey: null });
        }
      }
    }
  }
  const pricing = pricingFor(ds, now);
  const catalogue = [...products.values()];
  const market: ExpectedDataset['market'] = {};
  const recon: ref.ExpectedRecon[] = [];
  const stale: ExpectedDataset['stale'] = {};
  for (const mp of MARKETPLACES) {
    const rows = mp === 'talabat' ? ds.talabat : ds.snoonu;
    const hasFile = Boolean(rows) || enabledWithoutFile.includes(mp);
    if (!rows && !enabledWithoutFile.includes(mp)) continue;
    let listingFor = new Map<string, ExpectedListing>();
    if (rows) {
      const m = marketInputs(ds, mp);
      const validation = ref.refValidateMarket(m.inputs, mp === 'talabat');
      const listings = validation.rejected ? [] : validation.listings.map(l => ({ ...l, match: ref.refMatch(l, catalogue) }));
      market[mp] = { validation, listings, sourceRows: m.cells, identifiers: m.identifiers, headers: m.headers };
      listingFor = new Map(listings.filter(l => l.match !== 'unmatched' && l.match !== 'ambiguous').map(l => [l.match, l]));
      stale[mp] = ref.refStale(new Date(now.getTime() - (ds.uploadAgeHours?.[mp] ?? 0) * 3_600_000), now, settings.staleHours);
    }
    for (const p of catalogue) {
      const l = listingFor.get(p.key);
      const r = ref.refReconcile(p, mp, l ? { priceFils: l.priceFils, available: l.available } : null, rows ? hasFile : false, pricing, settings, now);
      if (r) recon.push(r);
    }
  }
  return { name: ds.name, erp1, erp2, products, market, recon, pricing, settings, stale };
}

// ───────────────── generated files ─────────────────
/** empty: nothing selected. ASSUMPTION (the documents are silent): no file is written for an empty selection. */
export type ExpectedFile = { blocked: boolean; empty: boolean; header: unknown[]; rows: unknown[][]; selectedKeys: string[] };

const isNumberCell = (c: Cell) => typeof c === 'number' || (c !== null && typeof c === 'object');

/** R21-R24 for one marketplace, kind and scope, reference = marketplace. */
export function expectedFile(e: ExpectedDataset, mp: MarketplaceId, kind: ref.FileKind, scope: 'mismatches' | 'all'): ExpectedFile {
  const m = e.market[mp]!;
  const headerCells = m.headers.map(h => ref.refSafeCell(h));
  const priceCol = mp === 'talabat' ? 2 : 3;
  const availCol = mp === 'talabat' ? 3 : 2;
  // A011: quantity-like availability blocks every kind. ASSUMPTION: any numeric availability cell is quantity-like.
  const blocked = m.sourceRows.some(r => typeof r[availCol] === 'number');
  const rows = e.recon.filter(r => r.marketplaceId === mp && ref.refSelected(r, kind, scope));
  const byId = new Map<string, ref.ExpectedRecon>();
  for (const r of rows) {
    const l = m.listings.find(x => x.match === r.productKey)!;
    byId.set(mp === 'talabat' ? l.id : ref.refBarcode(l.id), r);
  }
  const out: unknown[][] = [];
  m.sourceRows.forEach((src, i) => {
    const r = byId.get(m.identifiers[i]!);
    if (!r) return;
    out.push(src.map((c, col) => {
      if (col === priceCol && kind !== 'stock') return isNumberCell(c) ? r.expectedFils / 1000 : ref.refPriceText(r.expectedFils, String(c ?? ''));
      if (col === availCol && kind !== 'price') return typeof c === 'boolean' ? r.shouldBeAvailable : ref.refBoolText(r.shouldBeAvailable, String(c ?? 'True'));
      const v = cellValue(c);
      return typeof v === 'string' ? ref.refSafeCell(v) : v;
    }));
  });
  return { blocked, empty: out.length === 0, header: headerCells, rows: out, selectedKeys: [...new Set(rows.map(r => r.productKey))] };
}

export { ERP_HEADERS };
