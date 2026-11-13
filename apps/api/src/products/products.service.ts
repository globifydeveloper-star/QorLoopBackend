import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { ProductFilter, ProductMarketplaceRow, Role, TenantData } from '../../../../packages/db/src/database.js';
import { MARKETPLACES, type MarketplaceId } from '../../../../packages/core/src/constants.js';
import { MARKETPLACE_LABELS } from '../../../../packages/core/src/price-change.js';
import { enabledMarketplaces } from '../../../../packages/core/src/recon/compute.js';
import type { ReconReference, ReconStatus, StockIssue } from '../../../../packages/core/src/recon/status.js';
import { marketplaceView } from '../../../../packages/core/src/products/marketplace-view.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import { normalizeBarcode } from '../../../../packages/core/src/barcode.js';
import { hasPermission } from '../../../../packages/core/src/roles.js';
import { DEFAULT_READINESS_RULES, isReady, missingDetails, READINESS_REASONS } from '../../../../packages/core/src/products/readiness.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import { RECON_QUEUE } from '../tokens.js';
import { catalogueStock, type StockEditState } from '../../../../packages/core/src/catalogue-stock.js';
import { enabledMarketplaceIds, loadPricing, marketplacePrice, productInputs, productPricingView } from '../pricing/pricing.data.js';

import { catalogueAvailable } from '../../../../packages/core/src/recon/status.js';
import { BLOCKED_REASON_LABELS, setBlockReason } from '../../../../packages/core/src/marketplace-values.js';

const MAX_SKIPPED_LISTED = 200;

type ProductRow = NonNullable<Awaited<ReturnType<TenantData['products']['get']>>>;
type Change = { field: 'nameAr' | 'categoryId' | 'subcategoryId' | 'status'; old: string | null; new: string | null };

/** roles.ts has no cost permission of its own: cost is shown to the roles that may change prices. */
export const canSeeCost = (role: Role) => hasPermission(role, 'pricing.edit');

/** Never exposes the image storage key; cost only for roles that may see it. */
function baseItem(p: ProductRow, showCost: boolean) {
  return {
    id: p.id, barcode: p.barcode, sku: p.sku, nameEn: p.nameEn, nameAr: p.nameAr, brand: p.brand, erpCategory: p.erpCategory,
    categoryId: p.categoryId, subcategoryId: p.subcategoryId, erpPrice: p.erpPrice.toNumber(),
    ...(showCost ? { costPrice: p.costPrice?.toNumber() ?? null } : {}),
    erpStock: p.erpStock, status: p.status, inLatestErpFile: p.inLatestErpFile, updatedAt: p.updatedAt,
  };
}

/** The catalogue stock beside the ERP stock (ADR 017): the owner value while an edit exists (also during a conflict, D1). */
function stockFields(erpStock: number, e: { stock: number; erpStockAtEdit: number; state: StockEditState } | null) {
  const c = catalogueStock(erpStock, e);
  return { catalogueStock: c.stock, catalogueStockSource: c.source, stockConflict: e?.state === 'conflict' };
}

/** Opaque keyset cursor: base64url JSON of the last row's [name_en, id]. */
export function encodeCursor(p: { nameEn: string; id: string }) {
  return Buffer.from(JSON.stringify([p.nameEn, p.id])).toString('base64url');
}
export function decodeCursor(cursor: string) {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && z.uuid().safeParse(v[1]).success) {
      return { nameEn: v[0], id: v[1] };
    }
  } catch { /* falls through to the 400 */ }
  throw new BadRequestException('Invalid cursor');
}

/** A search reads as a barcode when it holds only digits, spaces, dashes and dots (e.g. "06281 000.0"). */
export function searchFilter(query: Pick<z.infer<typeof contracts.productListQuery>, 'q' | 'categoryId' | 'subcategoryId'>): ProductFilter {
  const q = query.q || undefined;
  const barcode = q && /^[\d\s.-]+$/.test(q) ? normalizeBarcode(q) : '';
  return { q, barcodePrefix: barcode || undefined, categoryId: query.categoryId, subcategoryId: query.subcategoryId };
}

type MarketplaceContext = { marketplaceId: MarketplaceId; reference: ReconReference; hasData: boolean };

/**
 * The marketplace of a list request: it must be one the store reconciles (core enabledMarketplaces, as the recon and
 * bulk pricing use), else 400. The comparison uses the tenant's default reference, as the recon reports do.
 */
async function marketplaceContext(data: TenantData, marketplaceId: MarketplaceId): Promise<MarketplaceContext> {
  const [switches, applied, settings] = await Promise.all([data.recon.marketplaceSwitches(), data.recon.lastApplied(), data.pricing.settings()]);
  const enabled = enabledMarketplaces(MARKETPLACES, switches, new Set(applied.keys())).find(m => m.marketplaceId === marketplaceId);
  if (!enabled) {
    throw new BadRequestException({ message: 'Validation failed', details: [{ path: 'marketplaceId', message: `${MARKETPLACE_LABELS[marketplaceId]} is not enabled for this store` }] });
  }
  return { marketplaceId, reference: settings?.compareReferenceDefault === 'erp' ? 'erp' : 'marketplace', hasData: enabled.hasData };
}

/** The `marketplace` object of a list item (core marketplaceView), with the requested reference's recon columns. */
export function marketplaceItem(m: MarketplaceContext, row: ProductMarketplaceRow | null) {
  const r = row?.recon ?? null;
  const erp = m.reference === 'erp';
  const view = marketplaceView({
    marketplaceId: m.marketplaceId, reference: m.reference, hasData: m.hasData, listing: row?.listing ?? null,
    recon: r && {
      status: (erp ? r.statusVsErp : r.status) as ReconStatus,
      stockIssue: (erp ? r.stockIssueVsErp : r.stockIssue) as StockIssue | null,
      priceMismatch: erp ? r.priceMismatchVsErp : r.priceMismatchVsMarketplace,
      actualPrice: r.actualPrice, expectedPrice: erp ? r.erpPrice : r.marketplacePrice,
    },
  });
  return { ...view, sourceUploadedAt: view.sourceUploadedAt?.toISOString() ?? null };
}

@Injectable()
export class ProductsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  list(ctx: RequestContext, query: z.infer<typeof contracts.productListQuery>) {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const search = searchFilter(query);
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async (data, p) => {
      const market = query.marketplaceId ? await marketplaceContext(data, query.marketplaceId) : null;
      // A second marketplace next to the first ("Compare with Talabat and Snoonu"); enabled-checked the same way.
      const compare = market && query.compareMarketplaceId ? await marketplaceContext(data, query.compareMarketplaceId) : null;
      let filter: ProductFilter = market && query.marketplaceStatus
        ? { ...search, marketplace: { marketplaceId: market.marketplaceId, status: query.marketplaceStatus, reference: market.reference, hasData: market.hasData } }
        : search;
      if (market && compare && query.marketplacesDiffer) {
        // Without an applied file on both, nothing is compared, so nothing differs (as the marketplace filter's rule 1).
        const ids = market.hasData && compare.hasData ? await data.products.differingIds(market.marketplaceId, compare.marketplaceId, query.marketplacesDiffer) : [];
        filter = { ...filter, productIds: ids };
      }
      const rows = await data.products.list(filter, query.tab, after, query.limit + 1);
      const counts = await data.products.counts(filter);
      const page = rows.slice(0, query.limit);
      const showCost = canSeeCost(p.member.role);
      // catalogue stock next to the ERP stock (ADR 017): one read for the page's edits
      const [edits, values, compareValues] = await Promise.all([
        data.stock.edits(page.map(r => r.id)),
        // the page's listing, upload and recon row on the marketplace: one statement, never one per row
        market ? data.products.marketplaceValues(market.marketplaceId, page.map(r => r.id)) : Promise.resolve(null),
        compare ? data.products.marketplaceValues(compare.marketplaceId, page.map(r => r.id)) : Promise.resolve(null),
      ]);
      const item = (r: ProductRow) => ({
        ...baseItem(r, showCost), ...stockFields(r.erpStock, edits.get(r.id) ?? null),
        ...(market && values ? { marketplace: marketplaceItem(market, values.get(r.id) ?? null) } : {}),
        ...(compare && compareValues ? { compareMarketplace: marketplaceItem(compare, compareValues.get(r.id) ?? null) } : {}),
      });
      if (!hasPermission(p.member.role, 'pricing.view')) {
        return { items: page.map(item), nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null, counts };
      }
      // Settings and rules once, product rules and offers for the whole page: a fixed number of queries per request.
      const [pricing, inputs] = await Promise.all([loadPricing(data), productInputs(data, page)]);
      const now = new Date();
      return {
        items: page.map(r => ({ ...item(r), marketplacePrice: marketplacePrice(pricing, inputs.get(r.id)!.input, now) })),
        nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null,
        counts,
      };
    });
  }

  marketplaceListings(ctx: RequestContext, query: z.infer<typeof contracts.marketplaceListingsQuery>) {
    let after: { marketplaceProductId: string; id: string } | null = null;
    if (query.cursor) {
      try {
        const v: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(v) || v.length !== 3 || v[0] !== query.marketplaceId || typeof v[1] !== 'string' || !z.uuid().safeParse(v[2]).success) throw new Error('cursor');
        after = { marketplaceProductId: v[1], id: v[2] as string };
      } catch { throw new BadRequestException('Invalid cursor'); }
    }
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async data => {
      const { rows, total, latestUpload } = await data.products.marketplaceListings({ ...query, ...searchFilter(query) }, after, query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const ids = [...new Set(page.flatMap(r => r.product_id ? [r.product_id] : []))];
      const [targets, edits, settings, enabled] = await Promise.all([
        data.marketplaceValues.targets(ids, query.marketplaceId), data.stock.edits(ids), data.recon.settings(), enabledMarketplaceIds(data),
      ]);
      const byProduct = new Map(targets.map(t => [t.productId, t]));
      const adjustment = (id: string | null, erpStock: number | null) => {
        const target = id ? byProduct.get(id) : undefined;
        if (!target || erpStock === null) return null;
        const blocked = setBlockReason(target);
        const av = target.override?.availability;
        return {
          catalogueAvailable: catalogueAvailable({ ...target.product, erpStock, catalogueStock: catalogueStock(erpStock, edits.get(id!) ?? null).stock }, settings.stockThreshold),
          override: av?.state === 'pending' ? { value: av.value, persistent: av.persistent } : null,
          version: target.override ? { id: target.override.id, version: target.override.version } : null,
          blockedReason: !enabled.includes(query.marketplaceId) ? BLOCKED_REASON_LABELS.marketplace_disabled : blocked ? BLOCKED_REASON_LABELS[blocked] : null,
        };
      };
      return {
        total, latestUpload,
        items: page.map(r => ({
          id: r.id, marketplaceProductId: r.marketplace_product_id, name: r.name, barcodes: r.barcodes,
          price: r.price, available: r.available, updatedAt: r.updated_at,
          availabilityAdjustment: adjustment(r.product_id, r.product_erp_stock),
          product: r.product_id ? { id: r.product_id, nameEn: r.product_name, barcode: r.product_barcode } : null,
          sourceFile: r.upload_id ? { id: r.upload_id, fileName: r.file_name } : null,
        })),
        nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify([query.marketplaceId, last.marketplace_product_id, last.id])).toString('base64url') : null,
      };
    });
  }

  get(ctx: RequestContext, id: string) {
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async (data, p) => this.detail(data, id, p.member.role));
  }

  private async detail(data: TenantData, id: string, role: Role) {
    const showCost = canSeeCost(role);
    const product = await data.products.get(id);
    if (!product) throw new NotFoundException('Product not found');
    const [listings, category, subcategory] = await Promise.all([
      data.products.listings(id),
      product.categoryId ? data.categories.get(product.categoryId) : null,
      product.subcategoryId ? data.categories.get(product.subcategoryId) : null,
    ]);
    const name = (c: { id: string; nameEn: string; nameAr: string | null } | null) => (c ? { id: c.id, nameEn: c.nameEn, nameAr: c.nameAr } : null);
    return {
      ...baseItem(product, showCost), ...stockFields(product.erpStock, await data.stock.edit(id)), size: product.size, erpActive: product.erpActive, createdAt: product.createdAt,
      category: name(category), subcategory: name(subcategory),
      // informational only: activation does not require them (DEFAULT_READINESS_RULES)
      ...missingDetails(product),
      listings: listings.map(l => ({ marketplaceId: l.marketplaceId, marketplaceProductId: l.marketplaceProductId, price: l.price.toNumber(), available: l.available, updatedAt: l.updatedAt })),
      // marketplacePrice and the rule chain that explains it
      ...(hasPermission(role, 'pricing.view') ? await productPricingView(data, product) : {}),
    };
  }

  /**
   * A new category or subcategory can move the marketplace price, and a new status changes availability, so either
   * asks for a recon recompute after commit.
   */
  async update(ctx: RequestContext, id: string, input: z.infer<typeof contracts.updateProduct>) {
    const { detail, recategorised, restatused } = await this.auth.authenticated(ctx, { permission: 'products.edit', mutation: true }, async (data, p) => {
      const current = await data.products.get(id);
      if (!current) throw new NotFoundException('Product not found');
      if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== current.updatedAt.getTime()) {
        throw new ConflictException('This product was changed by someone else; reload it and try again');
      }
      const next = { nameAr: current.nameAr, categoryId: current.categoryId, subcategoryId: current.subcategoryId, status: current.status };
      if (input.nameAr !== undefined) next.nameAr = input.nameAr;
      if (input.categoryId !== undefined) {
        if (input.categoryId !== null) {
          const category = await data.categories.get(input.categoryId);
          if (!category) throw new BadRequestException('Category not found');
          if (category.parentId) throw new BadRequestException('Choose a top-level category; this one is a subcategory');
        }
        // a new category drops the old subcategory unless the request names one
        if (input.categoryId !== current.categoryId && input.subcategoryId === undefined) next.subcategoryId = null;
        next.categoryId = input.categoryId;
      }
      if (input.subcategoryId !== undefined) {
        if (input.subcategoryId !== null) {
          const sub = await data.categories.get(input.subcategoryId);
          if (!sub || !sub.parentId) throw new BadRequestException('Subcategory not found');
          if (sub.parentId !== next.categoryId) throw new BadRequestException('The subcategory does not belong to the chosen category');
        }
        next.subcategoryId = input.subcategoryId;
      }
      if (input.status !== undefined) {
        if (input.status === 'active' && current.status !== 'active') {
          if (!hasPermission(p.member.role, 'products.activate')) throw new ForbiddenException('Permission denied');
          const readiness = isReady(next, DEFAULT_READINESS_RULES);
          if (!readiness.ready) {
            throw new BadRequestException({ message: 'The product is not ready to activate', details: readiness.missing.map(m => ({ path: m, message: READINESS_REASONS[m] })) });
          }
        }
        next.status = input.status;
      }

      const changes: Change[] = (['nameAr', 'categoryId', 'subcategoryId', 'status'] as const)
        .filter(field => next[field] !== current[field])
        .map(field => ({ field, old: current[field], new: next[field] }));
      if (changes.length) {
        const written = await data.products.update(id, current.updatedAt, { ...Object.fromEntries(changes.map(c => [c.field, c.new])), updatedBy: p.user.id });
        if (!written) throw new ConflictException('This product was changed by someone else; reload it and try again');
        for (const c of changes) await data.event('product.field_changed', p.user.id, id, ctx.requestId, c);
      }
      const recategorised = changes.some(c => c.field === 'categoryId' || c.field === 'subcategoryId');
      const restatused = changes.some(c => c.field === 'status');
      return { detail: await this.detail(data, id, p.member.role), recategorised, restatused };
    });
    if (recategorised) await this.recon.enqueueRecon(ctx.tenantId, 'product.category');
    if (restatused) await this.recon.enqueueRecon(ctx.tenantId, 'product.status');
    return detail;
  }

  /**
   * Activated products become reconcilable (no longer 'new'): a recon recompute is asked for after commit.
   * arabicNameMissing / categoryMissing count the activated products still lacking them; they never block.
   */
  async activate(ctx: RequestContext, input: z.infer<typeof contracts.activateProducts>) {
    const result = await this.auth.authenticated(ctx, { permission: 'products.activate', mutation: true }, async (data, p) => {
      const ids = 'ids' in input ? [...new Set(input.ids)] : null;
      const candidates = await data.products.activationCandidates(ids);
      const skipped: { id: string; reason: string }[] = [];
      const ready: string[] = [];
      const byId = new Map(candidates.map(c => [c.id, c]));
      for (const id of ids ?? candidates.map(c => c.id)) {
        const c = byId.get(id);
        if (!c) { skipped.push({ id, reason: 'Not found' }); continue; }
        if (c.status !== 'new') { skipped.push({ id, reason: 'Not a new product' }); continue; }
        const readiness = isReady(c, DEFAULT_READINESS_RULES);
        if (!readiness.ready) skipped.push({ id, reason: READINESS_REASONS[readiness.missing[0]!] });
        else ready.push(id);
      }
      const activated = await data.products.activate(ready, p.user.id);
      await data.products.auditEvents(p.user.id, ctx.requestId, activated.map(entityId => ({
        action: 'product.field_changed', entityId, details: { field: 'status', old: 'new', new: 'active' },
      })));
      await data.event('products.activated', p.user.id, null, ctx.requestId, { mode: ids ? 'ids' : 'all', activated: activated.length, skipped: skipped.length });
      const missing = activated.map(id => missingDetails(byId.get(id)!));
      return {
        activated: activated.length,
        arabicNameMissing: missing.filter(m => m.arabicNameMissing).length,
        categoryMissing: missing.filter(m => m.categoryMissing).length,
        skipped: skipped.slice(0, MAX_SKIPPED_LISTED), skippedCount: skipped.length,
      };
    });
    if (result.activated) await this.recon.enqueueRecon(ctx.tenantId, 'product.activated');
    return result;
  }
}
