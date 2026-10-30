import type { ErpRow, MarketplaceRow } from './validate.js';

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
 */
export function planErpApply(rows: ErpRow[], products: ApplyProduct[], mappedKeys: Iterable<string>, newStatus: 'active' | 'new'): ErpApplyPlan {
  const mapped = new Set(mappedKeys);
  const fields = ERP_FIELDS.filter(([key]) => mapped.has(key));
  const byBarcode = new Map(products.map(p => [p.normalizedBarcode, p] as const));
  const plan: ErpApplyPlan = { create: [], update: [], changes: [], barcodes: [] };
  const seen = new Set<string>();

  for (const r of rows) {
    // the review already rejects duplicate barcodes; first row wins if one slips through
    if (seen.has(r.barcode)) continue;
    seen.add(r.barcode);
    plan.barcodes.push(r.barcode);
    const p = byBarcode.get(r.barcode);
    if (!p) {
      plan.create.push({
        normalizedBarcode: r.barcode, sku: r.sku ?? null, nameEn: r.nameEn, nameAr: r.nameAr ?? null, brand: r.brand ?? null,
        erpCategory: r.category ?? null, erpPrice: money3(r.price)!, costPrice: money3(r.cost ?? null), erpStock: r.stock, erpActive: r.active,
        status: newStatus,
      });
      continue;
    }
    const { normalizedBarcode: _, ...next } = p;
    const before = plan.changes.length;
    const change = (field: keyof ProductWrite, value: FieldValue) => {
      const old = MONEY.has(field) ? money3(p[field] as number | null) : (p[field] as FieldValue);
      if (old === value) return;
      plan.changes.push({ productId: p.id, field, old, new: value });
      (next as Record<string, FieldValue>)[field] = value;
    };
    for (const [key, field] of fields) change(field, fileValue(r, key));
    if (!p.nameAr && r.nameAr) change('nameAr', r.nameAr);
    change('inLatestErpFile', true);
    if (plan.changes.length > before) plan.update.push(next);
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

/** Marketplace rows as listings: matched rows point at their product, unmatched rows keep a null product. */
export function planListingApply(rows: { parsed: MarketplaceRow; productId: string | null }[]): ListingWrite[] {
  return rows.map(({ parsed: r, productId }) => ({
    marketplaceProductId: r.marketplaceProductId, productId, barcodes: r.barcodes,
    name: r.name || null, price: money3(r.price)!, available: r.available,
  }));
}
