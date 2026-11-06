import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../../../../packages/db/src/generated/client.js';
import type { TenantData } from '../../../../packages/db/src/database.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import { ERP_CHANGE_KINDS } from '../../../../packages/core/src/upload/apply.js';
import {
  STOCK_BULK_LIMIT, STOCK_IN_EFFECT_DURING_CONFLICT, catalogueStock, planBulkStockEdit, planConflictResolution, planStockEdit, stockPlanSignature,
  type ConflictPlan, type ConflictResolution, type StockAction, type StockChange, type StockEditState, type StockTarget,
} from '../../../../packages/core/src/catalogue-stock.js';
import type { StoredReviewSummary } from '../../../../packages/core/src/upload/review.js';
import { RECON_QUEUE } from '../tokens.js';
import { canSeeCost, searchFilter } from '../products/products.service.js';
import { view as uploadView } from '../uploads/uploads.service.js';
import { canonical } from '../pricing/bulk-pricing.js';
import { BULK_IDEMPOTENCY_WINDOW_MS, BULK_TIMEOUT_MS } from '../pricing/bulk-pricing.service.js';

const edit = (stock: number | null, base: number | null, state: string | null) =>
  stock === null || base === null || state === null ? null : { stock, erpStockAtEdit: base, state: state as StockEditState };

const STALE = 'The stock changed since you loaded it; reload the product and try again';
const PREVIEW_ROWS = 10;
const invalid = (path: string, message: string) => new BadRequestException({ message: 'Validation failed', details: [{ path, message }] });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** What an idempotency key is bound to: the request without the key and token, ids deduplicated and sorted. */
function requestHash(input: { selection: object } & Record<string, unknown>) {
  const s = input.selection as { productIds?: string[] };
  const selection = s.productIds ? { productIds: [...new Set(s.productIds)].sort() } : input.selection;
  return sha(canonical({ ...input, selection }));
}
type Product = Awaited<ReturnType<TenantData['products']['stockProducts']>>[number];
const target = (p: Product): StockTarget => ({
  id: p.id, erpStock: p.erpStock, edit: p.stockEdit ? { stock: p.stockEdit.stock, erpStockAtEdit: p.stockEdit.erpStockAtEdit, state: p.stockEdit.state as StockEditState } : null,
});
type BulkStockInput = z.infer<typeof contracts.stockBulkPreview>;
type ConflictInput = z.infer<typeof contracts.conflictsResolvePreview>;

/** The audit columns of a bulk stock change and of a bulk conflict resolution (compact arrays, product id first, GIN-indexed). */
export const STOCK_CHANGE_COLUMNS = ['productId', 'op', 'erpStock', 'oldStock', 'oldSource', 'newStock'] as const;
export const CONFLICT_CHANGE_COLUMNS = ['productId', 'choice', 'ownerStock', 'erpStock', 'erpStockAtEdit'] as const;

@Injectable()
export class CatalogueStockService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /**
   * What an applied ERP upload changed, row by row (erp_upload_changes), file order, paginated. Cost rows are left out
   * for roles that may not see costs. Price rows say whether a fixed product price still applies (D6); stock rows show
   * the catalogue stock now and whether the change raised a conflict.
   */
  changes(ctx: RequestContext, id: string, query: z.infer<typeof contracts.uploadChangesQuery>) {
    return this.auth.authenticated(ctx, { permission: 'uploads.view' }, async (data, p) => {
      const u = await data.uploads.get(id);
      if (!u) throw new NotFoundException('Upload not found');
      if (u.source !== 'erp') throw new BadRequestException('Only an ERP upload changes the catalogue; marketplace uploads have a review only');
      if (u.status !== 'applied') throw new ConflictException('This upload has not been applied; its proposed changes are under /review');
      const hideCost = !canSeeCost(p.member.role);
      if (hideCost && query.kind === 'cost') throw new BadRequestException({ message: 'Validation failed', details: [{ path: 'kind', message: 'Cost changes are shown only to roles that may change prices' }] });
      const [{ rows, total }, grouped] = await Promise.all([
        data.stock.uploadChanges({
          uploadId: id, kinds: query.kind === 'all' ? null : [query.kind], conflictOnly: query.conflict === true, hideCost,
          skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        }),
        data.stock.uploadChangeCounts(id, hideCost),
      ]);
      const counts: Record<string, number> = { all: 0 };
      for (const k of ERP_CHANGE_KINDS) if (!(hideCost && k === 'cost')) counts[k] = 0;
      let stockConflicts = 0;
      for (const g of grouped) { counts[g.kind] = g.n; counts.all! += g.n; stockConflicts += g.conflicts; }
      const summary = u.summary as StoredReviewSummary | null;
      return {
        upload: uploadView(u),
        /** false: applied before ADR 017, so no change list was recorded (the summary counts still apply) */
        changesRecorded: summary?.applied?.changesRecorded === true,
        kind: query.kind, conflictOnly: query.conflict === true, page: query.page, pageSize: query.pageSize, total,
        counts: { ...counts, stockConflicts },
        rows: rows.map(r => ({
          productId: r.productId, barcode: r.barcode, rowNumber: r.rowNumber, kind: r.kind, field: r.field, old: r.old ?? null, new: r.new ?? null,
          stockConflict: r.stockConflict,
          product: { nameEn: r.nameEn, nameAr: r.nameAr, status: r.status },
          fixedPriceRule: r.kind === 'price' ? r.fixedPriceRule : null,
          catalogueStock: r.kind === 'stock' ? this.stockView(r.erpStock, edit(r.editStock, r.editBase, r.editState)) : null,
        })),
      };
    });
  }

  /** Open stock conflicts, newest first, with both values; the owner's value is the one in effect (D1). */
  conflicts(ctx: RequestContext, query: z.infer<typeof contracts.stockConflictsQuery>) {
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async data => {
      const { rows, total } = await data.stock.conflicts((query.page - 1) * query.pageSize, query.pageSize);
      return {
        inEffect: STOCK_IN_EFFECT_DURING_CONFLICT, page: query.page, pageSize: query.pageSize, total,
        rows: rows.map(e => ({
          productId: e.productId, barcode: e.product.barcode, nameEn: e.product.nameEn, nameAr: e.product.nameAr, status: e.product.status,
          erpStock: e.product.erpStock, ownerStock: e.stock, erpStockAtEdit: e.erpStockAtEdit,
          catalogueStock: catalogueStock(e.product.erpStock, { stock: e.stock, erpStockAtEdit: e.erpStockAtEdit, state: e.state as StockEditState }).stock,
          reason: e.reason, setBy: e.setBy, setAt: e.setAt, conflictUploadId: e.conflictUploadId, conflictAt: e.conflictAt, updatedAt: e.updatedAt,
        })),
      };
    });
  }

  /** The dashboard badge: "N stock conflicts". */
  conflictCount(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async data => ({ count: await data.stock.conflictCount() }));
  }

  // ── One product ──

  /** The product's catalogue stock, the ERP stock, the owner edit (who, when, why) and any open conflict. */
  get(ctx: RequestContext, id: string) {
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async data => this.productStock(data, id));
  }

  private async productStock(data: TenantData, id: string) {
    const [p] = await data.products.stockProducts([id]);
    if (!p) throw new NotFoundException('Product not found');
    const e = await data.stock.edit(id);
    return {
      productId: id, ...this.stockView(p.erpStock, e),
      edit: e ? { stock: e.stock, erpStockAtEdit: e.erpStockAtEdit, state: e.state, reason: e.reason, setBy: e.setBy, setAt: e.setAt, updatedAt: e.updatedAt } : null,
    };
  }

  /**
   * Set (stock) or clear (mode erp) one product's catalogue stock. Compare-and-set by value under the tenant row lock:
   * `expected` is the ERP and catalogue stock as last shown, so a concurrent edit or an ERP apply in between is a 409.
   * Setting the ERP's own value clears the edit. One audit event; one coalesced recon recompute after commit.
   */
  async set(ctx: RequestContext, id: string, action: StockAction, expected: { erpStock: number; catalogueStock: number }, reason: string | null) {
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'catalogue.stock_edit', mutation: true }, async (data, p) => {
      const [product] = await data.products.stockProducts([id]);
      if (!product) throw new NotFoundException('Product not found');
      const t = target(product);
      if (expected.erpStock !== t.erpStock || expected.catalogueStock !== catalogueStock(t.erpStock, t.edit).stock) throw new ConflictException(STALE);
      const change = planStockEdit(t, action);
      if (change) {
        await this.write(data, p.user.id, reason, [change]);
        await data.event(change.op === 'set' ? 'product.stock_set' : 'product.stock_reset', p.user.id, id, ctx.requestId, {
          old: change.old, new: change.new, erpStock: change.erpStock, reason: change.op === 'set' ? reason : 'owner', ...(change.op === 'set' ? {} : { note: reason }),
        });
      }
      return { result: { ...(await this.productStock(data, id)), changed: !!change }, changed: !!change };
    });
    if (changed) await this.recon.enqueueRecon(ctx.tenantId, 'catalogue.stock');
    return result;
  }

  /** "use ERP" or "keep mine" for one product's open conflict; `expected` is the conflict as shown (409 when it moved). */
  async resolve(ctx: RequestContext, id: string, input: z.infer<typeof contracts.resolveProductStock>) {
    const result = await this.auth.authenticated(ctx, { permission: 'catalogue.stock_edit', mutation: true }, async (data, p) => {
      const [product] = await data.products.stockProducts([id]);
      if (!product) throw new NotFoundException('Product not found');
      const t = target(product);
      if (!t.edit || t.edit.state !== 'conflict') throw new ConflictException('This product has no open stock conflict');
      if (input.expected.erpStock !== t.erpStock || input.expected.ownerStock !== t.edit.stock) throw new ConflictException(STALE);
      const [r] = planConflictResolution([t], 0, input.choice).changes;
      await this.resolveWrite(data, [r!]);
      await data.event('product.stock_conflict_resolved', p.user.id, id, ctx.requestId, { choice: r!.choice, ownerStock: r!.ownerStock, erpStock: r!.erpStock, erpStockAtEdit: r!.erpStockAtEdit });
      return this.productStock(data, id);
    });
    await this.recon.enqueueRecon(ctx.tenantId, 'catalogue.stock');
    return result;
  }

  private async write(data: TenantData, userId: string, reason: string | null, changes: StockChange[]) {
    await data.stock.setEdits(userId, reason, changes.filter(c => c.op === 'set').map(c => ({ productId: c.productId, stock: c.new.stock, erpStock: c.erpStock })));
    await data.stock.deleteEdits(changes.filter(c => c.op === 'clear').map(c => c.productId));
  }
  private async resolveWrite(data: TenantData, changes: ConflictResolution[]) {
    await data.stock.deleteEdits(changes.filter(c => c.choice === 'erp').map(c => c.productId));
    await data.stock.keepEdits(changes.filter(c => c.choice === 'keep').map(c => ({ productId: c.productId, erpStock: c.erpStock })));
  }

  // ── Bulk catalogue stock ──

  /** Explicit ids (unknown or other-store ids count as notFound) or every product matching the filter; at most STOCK_BULK_LIMIT. */
  private async stockTargets(data: TenantData, selection: BulkStockInput['selection']) {
    if ('productIds' in selection) {
      const ids = [...new Set(selection.productIds)];
      const products = await data.products.stockProducts(ids);
      return { products, selected: ids.length, notFound: ids.length - products.length };
    }
    const where = searchFilter(selection.filter);
    const products = await data.products.stockSelection(where, STOCK_BULK_LIMIT + 1);
    const selected = products.length > STOCK_BULK_LIMIT ? await data.products.stockSelectionCount(where) : products.length;
    if (selected > STOCK_BULK_LIMIT) throw invalid('selection', `This selection has ${selected.toLocaleString('en-US')} products; one change can set at most ${STOCK_BULK_LIMIT.toLocaleString('en-US')}. Narrow the filter.`);
    return { products, selected, notFound: 0 };
  }

  private async planBulk(data: TenantData, input: BulkStockInput) {
    const { products, selected, notFound } = await this.stockTargets(data, input.selection);
    const plan = planBulkStockEdit(products.map(target), notFound, input.action);
    const labels = new Map(products.map(p => [p.id, p]));
    const counts = {
      selected, willChange: plan.changes.length, unchanged: plan.unchanged, notFound: plan.notFound,
      sets: plan.changes.filter(c => c.op === 'set').length, clears: plan.changes.filter(c => c.op === 'clear').length,
    };
    const rows = plan.changes.slice(0, PREVIEW_ROWS).map(c => {
      const l = labels.get(c.productId)!;
      return { productId: c.productId, nameEn: l.nameEn, barcode: l.barcode, status: l.status, erpStock: c.erpStock, op: c.op, old: c.old, new: c.new };
    });
    return { plan, counts, rows, previewToken: sha(stockPlanSignature(plan.changes)) };
  }

  /** What a bulk catalogue stock change would do now; writes nothing. */
  bulkPreview(ctx: RequestContext, input: BulkStockInput) {
    return this.auth.authenticated(ctx, { permission: 'catalogue.stock_edit', mutation: true }, async data => {
      const { counts, rows, previewToken } = await this.planBulk(data, input);
      return { selection: input.selection, action: input.action, reason: input.reason, limit: STOCK_BULK_LIMIT, ...counts, rows, previewToken };
    });
  }

  /**
   * One transaction under the tenant row lock, as a bulk price change (ADR 013): the idempotency key first, then the
   * change re-planned from current data and checked against the preview token, written set-based and recorded in ONE
   * 'catalogue.stock_bulk_set' event (key, request hash, result, every change). One coalesced recompute after commit.
   */
  async bulkApply(ctx: RequestContext, body: z.infer<typeof contracts.stockBulkApply>) {
    const { idempotencyKey, previewToken: expectedToken, ...input } = body;
    const hash = requestHash(input);
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'catalogue.stock_edit', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const prior = await this.replay(data, 'catalogue.stock_bulk_set', idempotencyKey, hash, 'stock change');
      if (prior) return { result: prior, changed: false };
      const { plan, counts, previewToken } = await this.planBulk(data, input);
      if (expectedToken && expectedToken !== previewToken) throw new ConflictException('The stock of the selected products changed since the preview; preview again before applying');
      await this.write(data, p.user.id, input.reason, plan.changes);
      const event = await data.event('catalogue.stock_bulk_set', p.user.id, null, ctx.requestId, {
        idempotencyKey, requestHash: hash, previewToken, selection: input.selection as Prisma.InputJsonObject, action: input.action, reason: input.reason,
        result: counts, changeColumns: [...STOCK_CHANGE_COLUMNS],
        changes: plan.changes.map(c => [c.productId, c.op, c.erpStock, c.old.stock, c.old.source, c.new.stock]),
      });
      return { result: { operationId: event.id, replayed: false, appliedAt: event.createdAt, ...counts }, changed: plan.changes.length > 0 };
    });
    if (changed) await this.recon.enqueueRecon(ctx.tenantId, 'catalogue.stock');
    return result;
  }

  // ── Bulk conflict resolution ──

  private async planConflicts(data: TenantData, input: ConflictInput) {
    let ids: string[];
    if ('productIds' in input.selection) ids = [...new Set(input.selection.productIds)];
    else {
      ids = await data.stock.conflictProductIds(STOCK_BULK_LIMIT + 1);
      if (ids.length > STOCK_BULK_LIMIT) throw invalid('selection', `There are more than ${STOCK_BULK_LIMIT.toLocaleString('en-US')} open conflicts; resolve them by product ids in parts.`);
    }
    const products = await data.products.stockProducts(ids);
    const plan: ConflictPlan = planConflictResolution(products.map(target), ids.length - products.length, input.choice);
    const labels = new Map(products.map(p => [p.id, p]));
    const counts = { selected: ids.length, willResolve: plan.changes.length, notInConflict: plan.notInConflict, notFound: plan.notFound };
    const rows = plan.changes.slice(0, PREVIEW_ROWS).map(c => {
      const l = labels.get(c.productId)!;
      return { ...c, nameEn: l.nameEn, barcode: l.barcode, catalogueStockAfter: c.choice === 'erp' ? c.erpStock : c.ownerStock };
    });
    return { plan, counts, rows, previewToken: sha(stockPlanSignature(plan.changes)) };
  }

  conflictsPreview(ctx: RequestContext, input: ConflictInput) {
    return this.auth.authenticated(ctx, { permission: 'catalogue.stock_edit', mutation: true }, async data => {
      const { counts, rows, previewToken } = await this.planConflicts(data, input);
      return { selection: input.selection, choice: input.choice, limit: STOCK_BULK_LIMIT, ...counts, rows, previewToken };
    });
  }

  async conflictsApply(ctx: RequestContext, body: z.infer<typeof contracts.conflictsResolveApply>) {
    const { idempotencyKey, previewToken: expectedToken, ...input } = body;
    const hash = requestHash(input);
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'catalogue.stock_edit', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const prior = await this.replay(data, 'catalogue.stock_conflicts_resolved', idempotencyKey, hash, 'conflict resolution');
      if (prior) return { result: prior, changed: false };
      const { plan, counts, previewToken } = await this.planConflicts(data, input);
      if (expectedToken && expectedToken !== previewToken) throw new ConflictException('The conflicts changed since the preview; preview again before applying');
      await this.resolveWrite(data, plan.changes);
      const event = await data.event('catalogue.stock_conflicts_resolved', p.user.id, null, ctx.requestId, {
        idempotencyKey, requestHash: hash, previewToken, selection: input.selection as Prisma.InputJsonObject, choice: input.choice,
        result: counts, changeColumns: [...CONFLICT_CHANGE_COLUMNS],
        changes: plan.changes.map(c => [c.productId, c.choice, c.ownerStock, c.erpStock, c.erpStockAtEdit]),
      });
      return { result: { operationId: event.id, replayed: false, appliedAt: event.createdAt, ...counts }, changed: plan.changes.length > 0 };
    });
    if (changed) await this.recon.enqueueRecon(ctx.tenantId, 'catalogue.stock');
    return result;
  }

  /** The first result again for a repeated idempotency key with the same body; another body is a 409. */
  private async replay(data: TenantData, action: string, key: string, hash: string, what: string) {
    const prior = await data.stock.operation(action, key, new Date(Date.now() - BULK_IDEMPOTENCY_WINDOW_MS));
    if (!prior) return null;
    const d = prior.details as { requestHash?: string; result?: Record<string, number> } | null;
    if (d?.requestHash !== hash) throw new ConflictException(`This idempotency key was already used for a different ${what}`);
    return { operationId: prior.id, replayed: true, appliedAt: prior.createdAt, ...d.result };
  }

  /** The catalogue stock of a product as every response shows it. */
  stockView(erpStock: number, e: { stock: number; erpStockAtEdit: number; state: StockEditState } | null) {
    const c = catalogueStock(erpStock, e);
    return {
      erpStock, catalogueStock: c.stock, source: c.source,
      conflict: e?.state === 'conflict' ? { ownerStock: e.stock, erpStock, erpStockAtEdit: e.erpStockAtEdit, inEffect: STOCK_IN_EFFECT_DURING_CONFLICT } : null,
    };
  }
}
