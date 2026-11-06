/**
 * Catalogue stock (ADR 017). The catalogue stock is the ERP stock unless the owner edited it (a catalogue_stock_edits
 * row). A later ERP upload that changes the product's ERP stock away from the value the edit was made against raises
 * a conflict, which the owner resolves with "use ERP" (the edit is removed) or "keep mine" (the edit is re-based on
 * the current ERP stock). Pure: nothing here reads the database or the clock.
 */

export const STOCK_EDIT_STATES = ['active', 'conflict'] as const;
export type StockEditState = (typeof STOCK_EDIT_STATES)[number];

/**
 * D1, owner decision 6 November 2026: while a stock conflict is open, the OWNER's catalogue value stays in effect
 * until the conflict is resolved. 'erp' would make the new ERP value apply at once instead. The one switch: recon,
 * generated files and every API read go through catalogueStock() below.
 */
export const STOCK_IN_EFFECT_DURING_CONFLICT: 'owner' | 'erp' = 'owner';

/** products.erp_stock and catalogue_stock_edits.stock are int; both are 0 or more. */
export const STOCK_MAX = 2_147_483_647;
/** catalogue_stock_edit_valid: reason length. */
export const STOCK_REASON_MAX = 500;
/** At most this many products per bulk stock edit or bulk conflict resolution (as BULK_PRICE_LIMIT, G15). */
export const STOCK_BULK_LIMIT = 5_000;

export interface StockEdit { stock: number; erpStockAtEdit: number; state: StockEditState }
export type StockSource = 'erp' | 'owner';

/** The stock the catalogue uses for a product: its edit, else the ERP stock. */
export function catalogueStock(erpStock: number, edit: StockEdit | null | undefined, during: 'owner' | 'erp' = STOCK_IN_EFFECT_DURING_CONFLICT): { stock: number; source: StockSource } {
  if (!edit) return { stock: erpStock, source: 'erp' };
  if (edit.state === 'conflict' && during === 'erp') return { stock: erpStock, source: 'erp' };
  return { stock: edit.stock, source: 'owner' };
}

// ── ERP apply ──

/**
 * What a new ERP stock does to an edit. Only called for a product whose ERP stock this upload changes (D2: no other
 * field raises a conflict).
 * - erp_matches: the ERP now says what the owner said; the edit is removed (nothing left to keep).
 * - erp_reverted: an open conflict whose ERP stock went back to the value the edit was made against; it is active again.
 * - unchanged: an active edit and the ERP stock equals its base (cannot happen when the stock changed; kept total).
 * - conflict: the ERP stock now differs from the edit's base; flagged (a conflict already open is refreshed).
 */
export type ErpStockOutcome = 'erp_matches' | 'erp_reverted' | 'unchanged' | 'conflict';
export function stockAfterErpChange(edit: StockEdit, newErpStock: number): ErpStockOutcome {
  if (newErpStock === edit.stock) return 'erp_matches';
  if (newErpStock === edit.erpStockAtEdit) return edit.state === 'conflict' ? 'erp_reverted' : 'unchanged';
  return 'conflict';
}

export interface ErpStockEffect { productId: string; ownerStock: number; erpStockAtEdit: number; oldErpStock: number; erpStock: number; wasConflict: boolean }
export interface ErpStockConflictPlan {
  /** state = conflict (new or refreshed) for this upload */
  conflicts: ErpStockEffect[];
  /** edits removed because the ERP caught up with the owner's value */
  cleared: ErpStockEffect[];
  /** open conflicts that went back to active */
  reverted: ErpStockEffect[];
}

/** The edits an ERP apply touches, from its ERP stock changes (old -> new) and the current edits. Pure. */
export function planErpStockConflicts(changes: { productId: string; old: number; new: number }[], edits: ReadonlyMap<string, StockEdit>): ErpStockConflictPlan {
  const plan: ErpStockConflictPlan = { conflicts: [], cleared: [], reverted: [] };
  for (const c of changes) {
    const edit = edits.get(c.productId);
    if (!edit || c.old === c.new) continue;
    const effect: ErpStockEffect = { productId: c.productId, ownerStock: edit.stock, erpStockAtEdit: edit.erpStockAtEdit, oldErpStock: c.old, erpStock: c.new, wasConflict: edit.state === 'conflict' };
    const outcome = stockAfterErpChange(edit, c.new);
    if (outcome === 'conflict') plan.conflicts.push(effect);
    else if (outcome === 'erp_matches') plan.cleared.push(effect);
    else if (outcome === 'erp_reverted') plan.reverted.push(effect);
  }
  return plan;
}

// ── Owner edits ──

export type StockAction = { mode: 'set'; stock: number } | { mode: 'erp' };
export interface StockTarget { id: string; erpStock: number; edit: StockEdit | null }
export interface StockChange {
  productId: string;
  /** set: write an edit (active, based on the current ERP stock); clear: remove the edit (follow the ERP) */
  op: 'set' | 'clear';
  erpStock: number;
  old: { stock: number; source: StockSource; state: StockEditState | null };
  new: { stock: number; source: StockSource };
}

/**
 * One product's edit, or null when nothing would change. Setting the ERP's own value clears the edit: the catalogue
 * then follows the ERP and no later conflict can arise from a value the owner did not change. Setting an open
 * conflict's own value is "keep mine" (the edit is re-based, the conflict closes).
 */
export function planStockEdit(t: StockTarget, action: StockAction): StockChange | null {
  const current = catalogueStock(t.erpStock, t.edit);
  const old = { ...current, state: t.edit?.state ?? null };
  if (action.mode === 'erp' || action.stock === t.erpStock) {
    return t.edit ? { productId: t.id, op: 'clear', erpStock: t.erpStock, old, new: { stock: t.erpStock, source: 'erp' } } : null;
  }
  const e = t.edit;
  if (e && e.stock === action.stock && e.state === 'active' && e.erpStockAtEdit === t.erpStock) return null;
  return { productId: t.id, op: 'set', erpStock: t.erpStock, old, new: { stock: action.stock, source: 'owner' } };
}

export interface BulkStockPlan { changes: StockChange[]; unchanged: number; notFound: number }
export function planBulkStockEdit(targets: StockTarget[], notFound: number, action: StockAction): BulkStockPlan {
  const plan: BulkStockPlan = { changes: [], unchanged: 0, notFound };
  for (const t of targets) {
    const c = planStockEdit(t, action);
    if (c) plan.changes.push(c);
    else plan.unchanged++;
  }
  return plan;
}

// ── Conflict resolution ──

export const CONFLICT_CHOICES = ['erp', 'keep'] as const;
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];
export interface ConflictResolution { productId: string; choice: ConflictChoice; ownerStock: number; erpStock: number; erpStockAtEdit: number }
export interface ConflictPlan { changes: ConflictResolution[]; notInConflict: number; notFound: number }

/** "use ERP" removes each edit, "keep mine" re-bases it on the current ERP stock. Targets without an open conflict are counted, not changed. */
export function planConflictResolution(targets: StockTarget[], notFound: number, choice: ConflictChoice): ConflictPlan {
  const plan: ConflictPlan = { changes: [], notInConflict: 0, notFound };
  for (const t of targets) {
    if (!t.edit || t.edit.state !== 'conflict') { plan.notInConflict++; continue; }
    plan.changes.push({ productId: t.id, choice, ownerStock: t.edit.stock, erpStock: t.erpStock, erpStockAtEdit: t.edit.erpStockAtEdit });
  }
  return plan;
}

/**
 * Every planned write in one string, ordered by product: preview and apply compare its hash (the preview token), so an
 * apply that would now write something else is refused instead of applied.
 */
export function stockPlanSignature(changes: (StockChange | ConflictResolution)[]): string {
  return changes
    .map(c => ('op' in c
      ? `${c.productId}|${c.op}|${c.erpStock}|${c.old.stock}|${c.old.state ?? ''}|${c.new.stock}`
      : `${c.productId}|${c.choice}|${c.erpStock}|${c.ownerStock}|${c.erpStockAtEdit}`))
    .sort()
    .join('\n');
}
