import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { ProductFilter, Role, TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import { normalizeBarcode } from '../../../../packages/core/src/barcode.js';
import { hasPermission } from '../../../../packages/core/src/roles.js';
import { DEFAULT_READINESS_RULES, isReady, READINESS_REASONS } from '../../../../packages/core/src/products/readiness.js';

const MAX_SKIPPED_LISTED = 200;

type ProductRow = NonNullable<Awaited<ReturnType<TenantData['products']['get']>>>;
type Change = { field: 'nameAr' | 'categoryId' | 'subcategoryId' | 'status'; old: string | null; new: string | null };

/** roles.ts has no cost permission of its own: cost is shown to the roles that may change prices. */
export const canSeeCost = (role: Role) => hasPermission(role, 'pricing.edit');

/** Never exposes the image storage key; cost only for roles that may see it. */
function item(p: ProductRow, showCost: boolean) {
  return {
    id: p.id, barcode: p.barcode, sku: p.sku, nameEn: p.nameEn, nameAr: p.nameAr, brand: p.brand, erpCategory: p.erpCategory,
    categoryId: p.categoryId, subcategoryId: p.subcategoryId, erpPrice: p.erpPrice.toNumber(),
    ...(showCost ? { costPrice: p.costPrice?.toNumber() ?? null } : {}),
    erpStock: p.erpStock, status: p.status, inLatestErpFile: p.inLatestErpFile, updatedAt: p.updatedAt,
  };
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
function searchFilter(query: z.infer<typeof contracts.productListQuery>): ProductFilter {
  const q = query.q || undefined;
  const barcode = q && /^[\d\s.-]+$/.test(q) ? normalizeBarcode(q) : '';
  return { q, barcodePrefix: barcode || undefined, categoryId: query.categoryId, subcategoryId: query.subcategoryId };
}

@Injectable()
export class ProductsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  list(ctx: RequestContext, query: z.infer<typeof contracts.productListQuery>) {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const filter = searchFilter(query);
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async (data, p) => {
      const rows = await data.products.list(filter, query.tab, after, query.limit + 1);
      const counts = await data.products.counts(filter);
      const page = rows.slice(0, query.limit);
      const showCost = canSeeCost(p.member.role);
      return {
        items: page.map(r => item(r, showCost)),
        nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null,
        counts,
      };
    });
  }

  get(ctx: RequestContext, id: string) {
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async (data, p) => this.detail(data, id, canSeeCost(p.member.role)));
  }

  private async detail(data: TenantData, id: string, showCost: boolean) {
    const product = await data.products.get(id);
    if (!product) throw new NotFoundException('Product not found');
    const [listings, category, subcategory] = await Promise.all([
      data.products.listings(id),
      product.categoryId ? data.categories.get(product.categoryId) : null,
      product.subcategoryId ? data.categories.get(product.subcategoryId) : null,
    ]);
    const name = (c: { id: string; nameEn: string; nameAr: string | null } | null) => (c ? { id: c.id, nameEn: c.nameEn, nameAr: c.nameAr } : null);
    return {
      ...item(product, showCost), size: product.size, erpActive: product.erpActive, createdAt: product.createdAt,
      category: name(category), subcategory: name(subcategory),
      listings: listings.map(l => ({ marketplaceId: l.marketplaceId, marketplaceProductId: l.marketplaceProductId, price: l.price.toNumber(), available: l.available, updatedAt: l.updatedAt })),
    };
  }

  update(ctx: RequestContext, id: string, input: z.infer<typeof contracts.updateProduct>) {
    return this.auth.authenticated(ctx, { permission: 'products.edit', mutation: true }, async (data, p) => {
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
      return this.detail(data, id, canSeeCost(p.member.role));
    });
  }

  activate(ctx: RequestContext, input: z.infer<typeof contracts.activateProducts>) {
    return this.auth.authenticated(ctx, { permission: 'products.activate', mutation: true }, async (data, p) => {
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
      return { activated: activated.length, skipped: skipped.slice(0, MAX_SKIPPED_LISTED), skippedCount: skipped.length };
    });
  }
}
