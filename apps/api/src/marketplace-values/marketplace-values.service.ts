import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../../../../packages/db/src/generated/client.js';
import type { TenantData } from '../../../../packages/db/src/database.js';
import { storedOverride, type OverrideColumns, type ReviewDbRow, type ReviewFilter } from '../../../../packages/db/src/marketplace-values.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { MarketplaceId } from '../../../../packages/core/src/constants.js';
import { toFils } from '../../../../packages/core/src/money.js';
import { MARKETPLACE_LABELS } from '../../../../packages/core/src/price-change.js';
import { catalogueStock, type StockEditState } from '../../../../packages/core/src/catalogue-stock.js';
import {
  BLOCKED_REASON_LABELS, EXPORT_STATES, MARKETPLACE_VALUES_BULK_LIMIT, SET_BLOCK_REASONS,
  marketplaceValuesPlanSignature, planMarketplaceValues, reviewRow,
  type FieldChange, type MarketplaceValueAction, type MarketplaceValueField, type MarketplaceValuePlan, type PlannedChange, type StoredField,
} from '../../../../packages/core/src/marketplace-values.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { RECON_QUEUE } from '../tokens.js';
import { searchFilter } from '../products/products.service.js';
import { enabledMarketplaceIds } from '../pricing/pricing.data.js';
import { canonical } from '../pricing/bulk-pricing.js';
import { BULK_IDEMPOTENCY_WINDOW_MS, BULK_TIMEOUT_MS } from '../pricing/bulk-pricing.service.js';

type ReviewQuery = z.infer<typeof contracts.marketplaceReviewQuery>;
type BulkInput = z.infer<typeof contracts.marketplaceValuesBulkPreview>;
type SetInput = z.infer<typeof contracts.setMarketplaceValues>;
type ClearQuery = z.infer<typeof contracts.clearMarketplaceValuesQuery>;

const PREVIEW_ROWS = 10;
const STALE = 'The export value changed since you loaded it; reload and try again';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const invalid = (path: string, message: string) => new BadRequestException({ message: 'Validation failed', details: [{ path, message }] });
const SET_BLOCK_LABELS: Record<(typeof SET_BLOCK_REASONS)[number] | 'not_found', string> = {
  not_listed: BLOCKED_REASON_LABELS.not_listed, inactive: BLOCKED_REASON_LABELS.inactive, erp_inactive: BLOCKED_REASON_LABELS.erp_inactive,
  missing_from_erp: BLOCKED_REASON_LABELS.missing_from_erp, not_found: 'Not a product of this store',
};

/** Opaque keyset cursor of the Review list: base64url JSON of [row rank, product id]. */
export const encodeReviewCursor = (r: { rank: number; productId: string }) => Buffer.from(JSON.stringify([r.rank, r.productId])).toString('base64url');
export function decodeReviewCursor(cursor: string) {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && v[0] >= 0 && v[0] < EXPORT_STATES.length && typeof v[1] === 'string' && z.uuid().safeParse(v[1]).success) {
      return { rank: v[0] as number, productId: v[1] };
    }
  } catch { /* falls through to the 400 */ }
  throw new BadRequestException('Invalid cursor');
}

/** The store's switches and tolerance, read once per request. */
async function reviewContext(data: TenantData, marketplaceId: MarketplaceId) {
  const [enabled, settings, latest] = await Promise.all([enabledMarketplaceIds(data), data.recon.settings(), data.generatedFiles.latestApplied(marketplaceId)]);
  return {
    enabled: enabled as string[], marketplaceEnabled: enabled.includes(marketplaceId),
    tolerance: settings.priceTolerance, toleranceFils: toFils(settings.priceTolerance),
    latestFile: latest ? { uploadId: latest.id, fileName: latest.fileName, uploadedAt: latest.createdAt, appliedAt: latest.appliedAt } : null,
  };
}
type Context = Awaited<ReturnType<typeof reviewContext>>;

function filterFor(ctx: Context, marketplaceId: MarketplaceId, f: Pick<ReviewQuery, 'show' | 'exportState' | 'field' | 'categoryId' | 'subcategoryId'> & Partial<Pick<ReviewQuery, 'q'>>, productIds?: string[]): ReviewFilter {
  return {
    marketplaceId, enabledMarketplaces: ctx.enabled, toleranceFils: ctx.toleranceFils, show: f.show, exportState: f.exportState, field: f.field,
    search: searchFilter({ q: f.q, categoryId: f.categoryId, subcategoryId: f.subcategoryId }), productIds,
  };
}

/** One Review row as the API returns it (also the `item` of every single change). */
export function reviewItem(r: ReviewDbRow & OverrideColumns, ctx: Context) {
  const override = storedOverride(r);
  const listed = r.actual_price !== null;
  const result = reviewRow({
    product: { status: r.product_status, erpActive: r.erp_active, inLatestErpFile: r.in_latest_erp_file },
    marketplaceEnabled: ctx.marketplaceEnabled, reconStatus: r.recon_status,
    catalogue: { available: r.catalogue_available, price: r.marketplace_price },
    catalogueDiffers: { availability: r.stock_issue !== null, price: r.price_mismatch_vs_marketplace },
    current: listed ? { available: r.actual_available ?? false, price: r.actual_price! } : null,
    priceTolerance: ctx.tolerance, override,
  });
  const edit = r.edit_stock === null || r.edit_base === null || r.edit_state === null ? null
    : { stock: r.edit_stock, erpStockAtEdit: r.edit_base, state: r.edit_state as StockEditState };
  const stock = catalogueStock(r.erp_stock, edit);
  const value = <V>(field: MarketplaceValueField, f: StoredField<V> | null, setByName: string | null) => (f ? {
    value: f.value, persistent: f.persistent, state: f.state, fieldState: result.fields[field].state,
    setBy: { id: f.setById, name: setByName }, setAt: f.setAt, reason: f.reason, clearedAt: f.clearedAt,
  } : null);
  return {
    productId: r.product_id, barcode: r.barcode, sku: r.sku, nameEn: r.name_en, nameAr: r.name_ar, productStatus: r.product_status,
    /** recon status against the catalogue */
    reconStatus: r.recon_status,
    marketplaceCurrent: { available: r.actual_available, price: r.actual_price },
    catalogue: {
      available: r.catalogue_available, price: r.marketplace_price, priceSource: r.marketplace_price_source,
      stock: stock.stock, stockSource: stock.source, stockConflict: edit?.state === 'conflict',
    },
    export: result.export,
    values: { availability: value('availability', override?.availability ?? null, r.availability_set_by_name), price: value('price', override?.price ?? null, r.price_set_by_name) },
    fields: result.fields,
    exportState: result.exportState, exportStateLabel: result.exportStateLabel,
    blockedReason: result.blockedReason, blockedReasonLabel: result.blockedReasonLabel, notExportableReason: result.notExportableReason,
    rulePrice: result.rulePrice, differsFromRulePrice: result.differsFromRulePrice, needsChange: result.needsChange,
    version: override ? { id: override.id, version: override.version } : null,
    marketplaceSource: r.source_upload_id ? {
      uploadId: r.source_upload_id, fileName: r.source_file_name, uploadedAt: r.source_uploaded_at, appliedAt: r.source_applied_at,
      isLatestFile: r.source_upload_id === ctx.latestFile?.uploadId,
    } : null,
    lastUpdated: r.last_updated,
  };
}

/** What an idempotency key is bound to: the request without the key and token, ids deduplicated and sorted. */
function requestHash(input: BulkInput) {
  const selection = 'productIds' in input.selection ? { productIds: [...new Set(input.selection.productIds)].sort() } : input.selection;
  return sha(canonical({ ...input, selection }));
}
/** The audit columns of one changed field (compact arrays, product id first, GIN-indexed for product history). */
export const VALUE_CHANGE_COLUMNS = ['productId', 'field', 'op', 'oldValue', 'oldState', 'oldPersistent', 'newValue', 'newState', 'newPersistent'] as const;
const changeEntries = (c: PlannedChange) => c.fields.map(f => [c.productId, f.field, f.op, f.before?.value ?? null, f.before?.state ?? null, f.before?.persistent ?? null, f.after.value, f.after.state, f.after.persistent]);
const fieldDetails = (f: FieldChange) => ({ field: f.field, op: f.op, before: f.before, after: f.after });

function counts(plan: MarketplaceValuePlan, selected: number) {
  const blockedByReason = (Object.keys(plan.blocked) as (keyof MarketplaceValuePlan['blocked'])[])
    .filter(k => plan.blocked[k] > 0).map(reason => ({ reason, label: SET_BLOCK_LABELS[reason], count: plan.blocked[reason] }));
  return {
    selected, willChange: plan.changes.length, unchanged: plan.unchanged, blocked: blockedByReason.reduce((n, b) => n + b.count, 0), blockedByReason,
  };
}

@Injectable()
export class MarketplaceValuesService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /** A pin is the comparison target of its field (recon): a change that sets, changes or removes one queues a recompute. */
  private async afterCommit(tenantId: string, changes: PlannedChange[]) {
    if (changes.some(c => c.fields.some(f => f.before?.persistent || f.after.persistent))) await this.recon.enqueueRecon(tenantId, 'marketplace.values');
  }

  /**
   * The Review screen of one marketplace: rows that differ from the catalogue or carry an export value, most urgent
   * first (blocked, waiting for export, to fix, pinned, in sync, not exportable), paginated by cursor, with the counts.
   * Catalogue and comparison values are the stored recon (lastUpdated); export values and states are live.
   */
  review(ctx: RequestContext, query: ReviewQuery) {
    const after = query.cursor ? decodeReviewCursor(query.cursor) : null;
    return this.auth.authenticated(ctx, { permission: 'recon.view' }, async data => {
      const c = await reviewContext(data, query.marketplaceId);
      const [rows, all] = await Promise.all([
        data.marketplaceValues.reviewPage(filterFor(c, query.marketplaceId, query), after, query.limit + 1),
        data.marketplaceValues.counts(c.enabled, c.toleranceFils, query.marketplaceId),
      ]);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        marketplaceId: query.marketplaceId, marketplaceEnabled: c.marketplaceEnabled,
        counts: all.get(query.marketplaceId) ?? { toFix: 0, waitingForExport: 0, pinned: 0, blocked: 0 },
        latestFile: c.latestFile,
        items: page.map(r => reviewItem(r, c)),
        nextCursor: rows.length > query.limit && last ? encodeReviewCursor({ rank: Number(last.rank), productId: last.product_id }) : null,
      };
    });
  }

  /** One product's Review row (null when the marketplace has no recon row for it yet, e.g. just switched on). */
  item(ctx: RequestContext, marketplaceId: MarketplaceId, productId: string) {
    return this.auth.authenticated(ctx, { permission: 'recon.view' }, async data => {
      const row = await this.row(data, await reviewContext(data, marketplaceId), marketplaceId, productId);
      if (!row && !(await data.marketplaceValues.targets([productId], marketplaceId)).length) throw new NotFoundException('Product not found');
      return row;
    });
  }

  private async row(data: TenantData, c: Context, marketplaceId: MarketplaceId, productId: string) {
    const [r] = await data.marketplaceValues.reviewPage(filterFor(c, marketplaceId, { show: 'all' }, [productId]), null, 1);
    return r ? reviewItem(r, c) : null;
  }

  /**
   * Set availability and/or price for one product on one marketplace. `expected` is the row as last read ({id,
   * version} or null); 409 when it moved. Same value, pin and reason = no change. One audit event.
   */
  set(ctx: RequestContext, marketplaceId: MarketplaceId, productId: string, input: SetInput) {
    return this.single(ctx, marketplaceId, productId, { type: 'set', values: input.values }, input.reason, input.expected);
  }

  /** "Use catalogue value" for one product: its pending export value(s) are removed (never the product or the row). */
  clear(ctx: RequestContext, marketplaceId: MarketplaceId, productId: string, query: ClearQuery) {
    const fields: MarketplaceValueField[] = query.fields === 'all' ? ['availability', 'price'] : [query.fields];
    const expected = query.expectedId && query.expectedVersion ? { id: query.expectedId, version: query.expectedVersion } : undefined;
    return this.single(ctx, marketplaceId, productId, { type: 'use_catalogue', fields }, null, expected);
  }

  private async single(ctx: RequestContext, marketplaceId: MarketplaceId, productId: string, action: MarketplaceValueAction, reason: string | null,
    expected: { id: string; version: number } | null | undefined) {
    const { result, changes } = await this.auth.authenticated(ctx, { permission: 'marketplace.values_edit', mutation: true }, async (data, p) => {
      const c = await reviewContext(data, marketplaceId);
      if (action.type === 'set' && !c.marketplaceEnabled) throw invalid('marketplaceId', `${MARKETPLACE_LABELS[marketplaceId]} is not enabled for this store`);
      const [t] = await data.marketplaceValues.targets([productId], marketplaceId);
      if (!t) throw new NotFoundException('Product not found');
      const current = t.override ? { id: t.override.id, version: t.override.version } : null;
      // set: expected is required (null = "had none"); clear: required only when there is something to clear
      if (action.type === 'set' || current) {
        if (expected === undefined) throw invalid('expectedVersion', 'Give the export value as last read (expectedId and expectedVersion)');
        if (JSON.stringify(expected) !== JSON.stringify(current)) throw new ConflictException(STALE);
      }
      const plan = planMarketplaceValues([t], 0, action, reason);
      const blocked = SET_BLOCK_REASONS.find(r => plan.blocked[r] > 0);
      if (blocked) throw invalid('productId', `${SET_BLOCK_LABELS[blocked]}: an export value can be set only for a listed, active product in the latest ERP file`);
      const change = plan.changes[0];
      let operationId: string | null = null;
      if (change) {
        await data.marketplaceValues.write(marketplaceId, p.user.id, [change]);
        const event = await data.event(action.type === 'set' ? 'product.marketplace_values_set' : 'product.marketplace_values_cleared', p.user.id, productId, ctx.requestId, {
          marketplaceId, version: change.version, changes: change.fields.map(fieldDetails) as unknown as Prisma.InputJsonArray,
        });
        operationId = event.id;
      }
      return { result: { changed: !!change, operationId, item: await this.row(data, c, marketplaceId, productId) }, changes: change ? [change] : [] };
    });
    await this.afterCommit(ctx.tenantId, changes);
    return result;
  }

  // ── Bulk ──

  /** The selected products (explicit ids, or the Review list with a filter, in list order) and the plan; reads only. */
  private async planBulk(data: TenantData, input: BulkInput) {
    const c = await reviewContext(data, input.marketplaceId);
    if (input.action.type === 'set' && !c.marketplaceEnabled) throw invalid('marketplaceId', `${MARKETPLACE_LABELS[input.marketplaceId]} is not enabled for this store`);
    let ids: string[];
    let selected: number;
    if ('productIds' in input.selection) {
      ids = [...new Set(input.selection.productIds)];
      selected = ids.length;
    } else {
      const f = filterFor(c, input.marketplaceId, input.selection.filter);
      ids = await data.marketplaceValues.selectionIds(f, MARKETPLACE_VALUES_BULK_LIMIT + 1);
      selected = ids.length > MARKETPLACE_VALUES_BULK_LIMIT ? await data.marketplaceValues.selectionCount(f) : ids.length;
    }
    if (selected > MARKETPLACE_VALUES_BULK_LIMIT) {
      throw invalid('selection', `This selection has ${selected.toLocaleString('en-US')} products; one change can cover at most ${MARKETPLACE_VALUES_BULK_LIMIT.toLocaleString('en-US')}. Narrow the filter.`);
    }
    const targets = await data.marketplaceValues.targets(ids, input.marketplaceId);
    const plan = planMarketplaceValues(targets, ids.length - targets.length, input.action as MarketplaceValueAction, input.reason);
    const labels = new Map(targets.map(t => [t.productId, t]));
    const rows = plan.changes.slice(0, PREVIEW_ROWS).map(ch => ({
      productId: ch.productId, nameEn: labels.get(ch.productId)!.nameEn, barcode: labels.get(ch.productId)!.barcode, changes: ch.fields.map(fieldDetails),
    }));
    return { plan, selected, rows, previewToken: sha(marketplaceValuesPlanSignature(plan)) };
  }

  /** What a bulk change would do now: counts, blocked reasons, the first rows and the token apply requires. */
  bulkPreview(ctx: RequestContext, input: BulkInput) {
    return this.auth.authenticated(ctx, { permission: 'marketplace.values_edit', mutation: true }, async data => {
      const { plan, selected, rows, previewToken } = await this.planBulk(data, input);
      return {
        marketplaceId: input.marketplaceId, selection: input.selection, action: input.action, reason: input.reason, limit: MARKETPLACE_VALUES_BULK_LIMIT,
        ...counts(plan, selected), rows, previewToken,
      };
    });
  }

  /**
   * One transaction under the tenant row lock (as bulk price and stock changes): the idempotency key first (a replay
   * returns the first result), then the change re-planned from current data and checked against the REQUIRED preview
   * token, written set-based and recorded in ONE 'marketplace.values_bulk_applied' event with every changed field.
   */
  async bulkApply(ctx: RequestContext, body: z.infer<typeof contracts.marketplaceValuesBulkApply>) {
    const { idempotencyKey, previewToken: expectedToken, ...input } = body;
    const hash = requestHash(input);
    const { result: applied, changes } = await this.auth.authenticated(ctx, { permission: 'marketplace.values_edit', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const prior = await data.marketplaceValues.operation(idempotencyKey, new Date(Date.now() - BULK_IDEMPOTENCY_WINDOW_MS));
      if (prior) {
        const d = prior.details as { requestHash?: string; result?: Record<string, unknown> } | null;
        if (d?.requestHash !== hash) throw new ConflictException('This idempotency key was already used for a different change');
        return { result: { operationId: prior.id, replayed: true, appliedAt: prior.createdAt, ...d.result }, changes: [] as PlannedChange[] };
      }
      const { plan, selected, previewToken } = await this.planBulk(data, input);
      if (expectedToken !== previewToken) throw new ConflictException('The selected products or their export values changed since the preview; preview again before applying');
      await data.marketplaceValues.write(input.marketplaceId, p.user.id, plan.changes);
      const result = {
        marketplaceId: input.marketplaceId, ...counts(plan, selected),
        created: plan.changes.filter(c => c.overrideId === null).length,
        updated: plan.changes.filter(c => c.overrideId !== null && c.fields.some(f => f.op === 'set')).length,
        clearedFields: plan.changes.reduce((n, c) => n + c.fields.filter(f => f.op === 'clear').length, 0),
      };
      const event = await data.event('marketplace.values_bulk_applied', p.user.id, null, ctx.requestId, {
        idempotencyKey, requestHash: hash, previewToken, marketplaceId: input.marketplaceId,
        selection: input.selection as Prisma.InputJsonObject, action: input.action as Prisma.InputJsonObject, reason: input.reason,
        result: result as unknown as Prisma.InputJsonObject, changeColumns: [...VALUE_CHANGE_COLUMNS], changes: plan.changes.flatMap(changeEntries),
      });
      return { result: { operationId: event.id, replayed: false, appliedAt: event.createdAt, ...result }, changes: plan.changes };
    });
    // one coalesced recompute when a pin was set, changed or removed; none for a replay
    await this.afterCommit(ctx.tenantId, changes);
    return applied;
  }
}
