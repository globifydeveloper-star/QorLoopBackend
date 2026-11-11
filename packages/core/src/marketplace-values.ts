import { toFils } from './money.js';

/**
 * Per-marketplace export values (migration 202611100001, owner decisions A-F of 10 November 2026, Review workflow of
 * 11 November 2026). The catalogue is the source of truth; a manager may set, for ONE product on ONE marketplace, the
 * availability (yes/no) and/or the price the generated file writes instead of the catalogue value. Pure: nothing here
 * reads the database or the clock. packages/db/src/marketplace-values.ts computes the same states in SQL for paging,
 * filters and counts: change both together (the integration test compares them).
 */

export const MARKETPLACE_VALUE_FIELDS = ['availability', 'price'] as const;
export type MarketplaceValueField = (typeof MARKETPLACE_VALUE_FIELDS)[number];
/** Same bounds as a hand-set price (G15): above zero, at most 100,000 QAR, three decimals. */
export const MARKETPLACE_PRICE_MAX = 100_000;
export const MARKETPLACE_REASON_MAX = 500;
/** Selected products per bulk change (not merely changed ones); more is refused, never truncated. */
export const MARKETPLACE_VALUES_BULK_LIMIT = 5_000;

export type StoredFieldState = 'pending' | 'cleared';
export interface StoredField<T> {
  value: T; state: StoredFieldState; persistent: boolean;
  setById: string; setAt: Date; reason: string | null; clearedAt: Date | null;
}
export interface StoredOverride {
  id: string; version: number;
  availability: StoredField<boolean> | null;
  price: StoredField<number> | null;
}

/**
 * A field's and a row's state on the Review screen, most urgent first (the row takes its most urgent field; this order
 * is also the list order and the cursor rank):
 * - blocked: a pending export value that cannot be written (plain reason in blockedReason)
 * - waiting_for_export: a pending export value the marketplace does not show yet ("Adjusted, waiting for export")
 * - to_fix: no export value, and the marketplace differs from the catalogue; the next file writes the catalogue value
 * - pinned: a pinned export value the marketplace shows
 * - in_sync: listed, nothing to change
 * - not_exportable: nothing pending, and the file cannot write this product (not listed, a new product, no file yet)
 */
export const EXPORT_STATES = ['blocked', 'waiting_for_export', 'to_fix', 'pinned', 'in_sync', 'not_exportable'] as const;
export type ExportState = (typeof EXPORT_STATES)[number];
/** The default Review list: rows the next file changes, or that need the manager's attention. */
export const NEEDS_CHANGE_STATES: readonly ExportState[] = ['blocked', 'waiting_for_export', 'to_fix'];
export const exportStateRank = (s: ExportState) => EXPORT_STATES.indexOf(s);

export const BLOCKED_REASONS = ['not_listed', 'marketplace_disabled', 'inactive', 'erp_inactive', 'missing_from_erp'] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];
export const BLOCKED_REASON_LABELS: Record<BlockedReason, string> = {
  not_listed: 'Not listed on this marketplace', marketplace_disabled: 'Marketplace is switched off', inactive: 'Product is not active',
  erp_inactive: 'Inactive in the ERP', missing_from_erp: 'Not in the latest ERP file',
};
export const NOT_EXPORTABLE_REASONS = ['no_data', 'not_listed', 'new_product'] as const;
export type NotExportableReason = (typeof NOT_EXPORTABLE_REASONS)[number];
export const NOT_EXPORTABLE_LABELS: Record<NotExportableReason, string> = {
  no_data: 'No file from this marketplace yet', not_listed: 'Not listed on this marketplace', new_product: 'New product, not compared yet',
};

/** One stored recon row of the catalogue (marketplace) reference, with its product and the marketplace switch. */
export interface ReviewInput {
  product: { status: string; erpActive: boolean; inLatestErpFile: boolean };
  marketplaceEnabled: boolean;
  /** recon status against the catalogue; 'no_data' = no applied file of this marketplace yet */
  reconStatus: string;
  /** What the catalogue says: catalogue availability and the rule (marketplace) price. */
  catalogue: { available: boolean | null; price: number | null };
  /** Stored recon flags against the catalogue: a stock issue, a price difference above the tolerance. */
  catalogueDiffers: { availability: boolean; price: boolean };
  /** The marketplace's listing (null = not listed). */
  current: { available: boolean; price: number } | null;
  /** QAR; a pinned price within it counts as shown. */
  priceTolerance: number;
  override: StoredOverride | null;
}

export interface FieldView { state: ExportState; blockedReason: BlockedReason | null }
export interface ReviewResult {
  fields: Record<MarketplaceValueField, FieldView>;
  /** What the next generated file writes (null: the file cannot write this product). */
  export: { available: boolean | null; price: number | null; availabilitySource: 'catalogue' | 'override'; priceSource: 'catalogue' | 'override' };
  exportState: ExportState;
  exportStateLabel: string | null;
  blockedReason: BlockedReason | null;
  blockedReasonLabel: string | null;
  notExportableReason: NotExportableReason | null;
  /** The catalogue rule price, and whether a pending typed price differs from it (exact, in fils). */
  rulePrice: number | null;
  differsFromRulePrice: boolean;
  needsChange: boolean;
}

/** Why a pending field cannot be written; availability "no" only needs a listing (disabling is always allowed, D). */
function blockedReason(i: ReviewInput, field: MarketplaceValueField, value: boolean | number): BlockedReason | null {
  if (!i.current) return 'not_listed';
  if (!i.marketplaceEnabled) return 'marketplace_disabled';
  if (field === 'availability' && value === false) return null;
  if (i.product.status !== 'active') return 'inactive';
  if (!i.product.erpActive) return 'erp_inactive';
  if (!i.product.inLatestErpFile) return 'missing_from_erp';
  return null;
}

function notExportable(i: ReviewInput): NotExportableReason | null {
  if (i.reconStatus === 'no_data') return 'no_data';
  if (!i.current) return 'not_listed';
  if (i.product.status === 'new') return 'new_product';
  return null;
}

/** The marketplace shows a pinned value: availability exactly; price within the price tolerance (as the comparison). */
function shows(i: ReviewInput, field: MarketplaceValueField, value: boolean | number) {
  if (!i.current) return false;
  return field === 'availability'
    ? i.current.available === value
    : Math.abs(toFils(i.current.price) - toFils(value as number)) <= toFils(i.priceTolerance);
}

function fieldView(i: ReviewInput, field: MarketplaceValueField): FieldView {
  const o = i.override?.[field];
  if (o?.state === 'pending') {
    const reason = blockedReason(i, field, o.value);
    if (reason) return { state: 'blocked', blockedReason: reason };
    return { state: o.persistent && shows(i, field, o.value) ? 'pinned' : 'waiting_for_export', blockedReason: null };
  }
  if (notExportable(i)) return { state: 'not_exportable', blockedReason: null };
  return { state: i.catalogueDiffers[field] ? 'to_fix' : 'in_sync', blockedReason: null };
}

const mostUrgent = (a: ExportState, b: ExportState) => (exportStateRank(a) <= exportStateRank(b) ? a : b);

/** One Review row: per-field and row state, what the next file writes, labels, and the rule-price note. */
export function reviewRow(i: ReviewInput): ReviewResult {
  const fields = { availability: fieldView(i, 'availability'), price: fieldView(i, 'price') };
  const exportState = mostUrgent(fields.availability.state, fields.price.state);
  const a = i.override?.availability;
  const p = i.override?.price;
  const useA = a?.state === 'pending' && fields.availability.state !== 'blocked';
  const useP = p?.state === 'pending' && fields.price.state !== 'blocked';
  const blocked = fields.availability.blockedReason ?? fields.price.blockedReason;
  const waiting = MARKETPLACE_VALUE_FIELDS.filter(f => fields[f].state === 'waiting_for_export');
  const nx = exportState === 'not_exportable' ? notExportable(i) : null;
  const label = exportState === 'blocked' ? `Adjusted, cannot be exported: ${BLOCKED_REASON_LABELS[blocked!]}`
    : exportState === 'waiting_for_export' ? (waiting.every(f => i.override?.[f]?.persistent) ? 'Pinned, waiting for export' : 'Adjusted, waiting for export')
      : exportState === 'to_fix' ? 'Differs from the catalogue; the next file writes the catalogue value'
        : exportState === 'pinned' ? 'Pinned'
          : nx ? NOT_EXPORTABLE_LABELS[nx] : null;
  return {
    fields,
    export: {
      available: i.current ? (useA ? a!.value : i.catalogue.available) : null,
      price: i.current ? (useP ? p!.value : i.catalogue.price) : null,
      availabilitySource: useA ? 'override' : 'catalogue', priceSource: useP ? 'override' : 'catalogue',
    },
    exportState, exportStateLabel: label,
    blockedReason: exportState === 'blocked' ? blocked : null, blockedReasonLabel: exportState === 'blocked' ? BLOCKED_REASON_LABELS[blocked!] : null,
    notExportableReason: nx,
    rulePrice: i.catalogue.price,
    differsFromRulePrice: p?.state === 'pending' && i.catalogue.price !== null && toFils(p.value) !== toFils(i.catalogue.price),
    needsChange: NEEDS_CHANGE_STATES.includes(exportState),
  };
}

export interface ExportCounts { toFix: number; waitingForExport: number; pinned: number; blocked: number }
/** The Dashboard card and Review counts, from row states (the SQL counts the same way). */
export function countExportStates(states: Iterable<ExportState>): ExportCounts {
  const c: ExportCounts = { toFix: 0, waitingForExport: 0, pinned: 0, blocked: 0 };
  for (const s of states) {
    if (s === 'to_fix') c.toFix++;
    else if (s === 'waiting_for_export') c.waitingForExport++;
    else if (s === 'pinned') c.pinned++;
    else if (s === 'blocked') c.blocked++;
  }
  return c;
}

// ───────── Planning a change (single and bulk share it) ─────────

export interface SetValues {
  availability?: { value: boolean; persistent?: boolean };
  price?: { value: number; persistent?: boolean };
}
export type MarketplaceValueAction = { type: 'set'; values: SetValues } | { type: 'use_catalogue'; fields: MarketplaceValueField[] };

/** A product as the planner needs it: may it receive a set, and its stored override. */
export interface PlanTarget {
  productId: string;
  listed: boolean;
  product: { status: string; erpActive: boolean; inLatestErpFile: boolean };
  override: StoredOverride | null;
}

export const SET_BLOCK_REASONS = ['not_listed', 'inactive', 'erp_inactive', 'missing_from_erp'] as const;
export type SetBlockReason = (typeof SET_BLOCK_REASONS)[number];

/** Per field: what is written. set = a new pending value; clear = pending -> cleared ("use catalogue value"). */
export interface FieldChange {
  field: MarketplaceValueField; op: 'set' | 'clear';
  before: { value: boolean | number; state: StoredFieldState; persistent: boolean; reason: string | null } | null;
  after: { value: boolean | number; state: StoredFieldState; persistent: boolean; reason: string | null };
}
export interface PlannedChange { productId: string; overrideId: string | null; version: number | null; fields: FieldChange[] }
export interface MarketplaceValuePlan {
  changes: PlannedChange[];
  unchanged: number;
  blocked: Record<SetBlockReason | 'not_found', number>;
}

/** Only listed, active, ERP-active products in the latest ERP file may receive a value (decision D). */
export function setBlockReason(t: Pick<PlanTarget, 'listed' | 'product'>): SetBlockReason | null {
  if (!t.listed) return 'not_listed';
  if (t.product.status !== 'active') return 'inactive';
  if (!t.product.erpActive) return 'erp_inactive';
  if (!t.product.inLatestErpFile) return 'missing_from_erp';
  return null;
}

function planOne(t: PlanTarget, action: MarketplaceValueAction, reason: string | null): FieldChange[] | SetBlockReason {
  const out: FieldChange[] = [];
  if (action.type === 'use_catalogue') {
    for (const field of [...new Set(action.fields)]) {
      const o = t.override?.[field];
      if (o?.state !== 'pending') continue; // never set, or already following the catalogue
      out.push({ field, op: 'clear', before: { value: o.value, state: 'pending', persistent: o.persistent, reason: o.reason }, after: { value: o.value, state: 'cleared', persistent: o.persistent, reason: o.reason } });
    }
    return out;
  }
  const block = setBlockReason(t);
  if (block) return block;
  for (const field of MARKETPLACE_VALUE_FIELDS) {
    const v = action.values[field];
    if (!v) continue;
    const persistent = v.persistent ?? false;
    const o = t.override?.[field];
    const same = o?.state === 'pending' && o.persistent === persistent && o.reason === reason
      && (field === 'price' ? toFils(o.value as number) === toFils(v.value as number) : o.value === v.value);
    if (same) continue;
    out.push({
      field, op: 'set',
      before: o ? { value: o.value, state: o.state, persistent: o.persistent, reason: o.reason } : null,
      after: { value: v.value, state: 'pending', persistent, reason },
    });
  }
  return out;
}

/**
 * Plans a set or a "use catalogue value" for the given products. notFound = selected ids that are not this store's
 * products. use_catalogue is allowed for any owned product (an existing value can always be removed); set blocks
 * ineligible ones. Same value, pin and reason = unchanged (a pin change alone is a change, and counts as a new set).
 */
export function planMarketplaceValues(targets: PlanTarget[], notFound: number, action: MarketplaceValueAction, reason: string | null): MarketplaceValuePlan {
  const plan: MarketplaceValuePlan = { changes: [], unchanged: 0, blocked: { not_listed: 0, inactive: 0, erp_inactive: 0, missing_from_erp: 0, not_found: notFound } };
  for (const t of targets) {
    const r = planOne(t, action, reason);
    if (typeof r === 'string') plan.blocked[r]++;
    else if (!r.length) plan.unchanged++;
    else plan.changes.push({ productId: t.productId, overrideId: t.override?.id ?? null, version: t.override?.version ?? null, fields: r });
  }
  return plan;
}

const v = (x: boolean | number) => (typeof x === 'number' ? String(toFils(x)) : x ? 'y' : 'n');
/** Everything a bulk apply would write, in order, with the versions it read: the preview token hashes this. */
export function marketplaceValuesPlanSignature(plan: MarketplaceValuePlan): string {
  const changes = plan.changes.map(c => `${c.productId}@${c.overrideId ?? '-'}:${c.version ?? 0}=`
    + c.fields.map(f => `${f.field}.${f.op}.${v(f.after.value)}.${f.after.persistent ? 'p' : 'o'}.${f.after.reason ?? ''}`).join(','));
  return [changes.join(';'), `u${plan.unchanged}`, ...Object.entries(plan.blocked).map(([k, n]) => `${k}${n}`)].join('|');
}

// ───────── Acknowledgement by a later marketplace upload (fix-once fields only) ─────────

export interface AcknowledgeInput {
  override: StoredOverride;
  /** The upload's created_at, truncated to milliseconds. */
  uploadCreatedAt: Date;
  /** This upload's accepted, uniquely matched rows of the product (none = no evidence). */
  incoming: { available: boolean; price: number }[];
  /** Every listing of the product on this marketplace after the apply (several marketplace ids can share a product). */
  retained: { available: boolean; price: number }[];
}

/**
 * Which fix-once fields a marketplace upload clears: the upload was created strictly after the value was set, at
 * least one accepted incoming row is evidence, and every retained listing of the product shows exactly the value
 * (availability exactly; price exactly in fils, not within the tolerance). Pinned fields never clear here.
 */
export function acknowledgedFields(i: AcknowledgeInput): MarketplaceValueField[] {
  if (!i.incoming.length) return [];
  const out: MarketplaceValueField[] = [];
  for (const field of MARKETPLACE_VALUE_FIELDS) {
    const o = i.override[field];
    if (!o || o.state !== 'pending' || o.persistent || !(i.uploadCreatedAt.getTime() > o.setAt.getTime())) continue;
    const matches = (l: { available: boolean; price: number }) => (field === 'availability' ? l.available === o.value : toFils(l.price) === toFils(o.value as number));
    if (i.retained.length && i.retained.every(matches) && i.incoming.some(matches)) out.push(field);
  }
  return out;
}
