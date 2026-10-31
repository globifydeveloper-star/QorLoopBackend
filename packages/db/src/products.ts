import type { Prisma } from './generated/client.js';

type Tx = Prisma.TransactionClient;

export type ProductTab = 'all' | 'active' | 'inactive' | 'new' | 'missing';

/** Search and category filters shared by the list and its tab counts (the tab itself is not part of it). */
export interface ProductFilter {
  q?: string;
  /** A normalised barcode to match by prefix; only set when the search text reads as a barcode. */
  barcodePrefix?: string;
  categoryId?: string;
  subcategoryId?: string;
}

const TAB_WHERE: Record<ProductTab, Prisma.ProductWhereInput> = {
  all: {}, active: { status: 'active' }, inactive: { status: 'inactive' }, new: { status: 'new' }, missing: { inLatestErpFile: false },
};

/** Never the image storage key. */
export const productSelect = {
  id: true, barcode: true, sku: true, nameEn: true, nameAr: true, brand: true, size: true, erpCategory: true,
  categoryId: true, subcategoryId: true, erpPrice: true, costPrice: true, erpStock: true, erpActive: true,
  status: true, inLatestErpFile: true, createdAt: true, updatedAt: true,
} satisfies Prisma.ProductSelect;

/** `ILIKE` reads % _ and \ as wildcards and escape; a search for "50%" means the text. */
const likeText = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m);

/** Every method adds tenant_id; callers never pass a tenant. Built on the same transaction as the request. */
export class ProductRepository {
  constructor(private readonly tenantId: string, private readonly tx: Tx) {}

  private where(f: ProductFilter): Prisma.ProductWhereInput {
    return {
      tenantId: this.tenantId,
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
      ...(f.subcategoryId ? { subcategoryId: f.subcategoryId } : {}),
      // name via the pg_trgm index, barcode via (tenant, normalized_barcode), SKU via (tenant, sku)
      ...(f.q ? {
        OR: [
          { nameEn: { contains: likeText(f.q), mode: 'insensitive' as const } },
          { sku: f.q },
          ...(f.barcodePrefix ? [{ normalizedBarcode: { startsWith: f.barcodePrefix } }] : []),
        ],
      } : {}),
    };
  }
  /** Keyset page ordered by (name_en, id): rows after `after`, never an OFFSET. */
  list(f: ProductFilter, tab: ProductTab, after: { nameEn: string; id: string } | null, take: number) {
    const keyset: Prisma.ProductWhereInput = after ? { OR: [{ nameEn: { gt: after.nameEn } }, { nameEn: after.nameEn, id: { gt: after.id } }] } : {};
    return this.tx.product.findMany({
      where: { AND: [this.where(f), TAB_WHERE[tab], keyset] },
      orderBy: [{ nameEn: 'asc' }, { id: 'asc' }], take, select: productSelect,
    });
  }
  /** Every tab count from one grouped query. */
  async counts(f: ProductFilter): Promise<Record<ProductTab, number>> {
    const groups = await this.tx.product.groupBy({ by: ['status', 'inLatestErpFile'], where: this.where(f), _count: { _all: true } });
    const counts = { all: 0, active: 0, inactive: 0, new: 0, missing: 0 };
    for (const g of groups) {
      const n = g._count._all;
      counts.all += n;
      if (g.status === 'active' || g.status === 'inactive' || g.status === 'new') counts[g.status] += n;
      if (!g.inLatestErpFile) counts.missing += n;
    }
    return counts;
  }
  get(id: string) {
    return this.tx.product.findFirst({ where: { tenantId: this.tenantId, id }, select: productSelect });
  }
  listings(productId: string) {
    return this.tx.listing.findMany({
      where: { tenantId: this.tenantId, productId }, orderBy: [{ marketplaceId: 'asc' }, { marketplaceProductId: 'asc' }],
      select: { marketplaceId: true, marketplaceProductId: true, price: true, available: true, updatedAt: true },
    });
  }
  /**
   * Compare-and-set on updated_at; returns false when the product changed since it was read.
   * `seen` is a JS Date (milliseconds) while rows written by SQL now() before date_trunc may hold microseconds,
   * so the match is "within the millisecond either side", not equality.
   */
  async update(id: string, seen: Date, data: Pick<Prisma.ProductUncheckedUpdateManyInput, 'nameAr' | 'categoryId' | 'subcategoryId' | 'status' | 'updatedBy'>) {
    const updatedAt = { gt: new Date(seen.getTime() - 1), lt: new Date(seen.getTime() + 1) };
    const r = await this.tx.product.updateMany({ where: { tenantId: this.tenantId, id, updatedAt }, data });
    return r.count === 1;
  }

  /** What the readiness rule needs, for the given ids or (no ids) for every new product. */
  activationCandidates(ids: string[] | null) {
    return this.tx.product.findMany({
      where: { tenantId: this.tenantId, ...(ids ? { id: { in: ids } } : { status: 'new' }) },
      orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true, nameAr: true, categoryId: true, subcategoryId: true },
    });
  }
  /** One statement for any number of ids (a single uuid[] bind parameter). Only moves new products. */
  async activate(ids: string[], actorId: string) {
    if (!ids.length) return [];
    const rows = await this.tx.$queryRaw<{ id: string }[]>`
      UPDATE products SET status = 'active', updated_by = ${actorId}, updated_at = date_trunc('milliseconds', now())
      WHERE tenant_id = ${this.tenantId}::uuid AND status = 'new' AND id = ANY(${ids}::uuid[])
      RETURNING id`;
    return rows.map(r => r.id);
  }

  /** Products that point at a category, as their category or subcategory. */
  async usingCategory(categoryId: string) {
    const [asCategory, asSubcategory] = await Promise.all([
      this.tx.product.count({ where: { tenantId: this.tenantId, categoryId } }),
      this.tx.product.count({ where: { tenantId: this.tenantId, subcategoryId: categoryId } }),
    ]);
    return asCategory + asSubcategory;
  }
  /** Product counts per category id and per subcategory id. */
  async countsByCategory() {
    const [byCategory, bySubcategory] = await Promise.all([
      this.tx.product.groupBy({ by: ['categoryId'], where: { tenantId: this.tenantId, categoryId: { not: null } }, _count: { _all: true } }),
      this.tx.product.groupBy({ by: ['subcategoryId'], where: { tenantId: this.tenantId, subcategoryId: { not: null } }, _count: { _all: true } }),
    ]);
    const counts = new Map<string, number>();
    for (const g of byCategory) counts.set(g.categoryId!, g._count._all);
    for (const g of bySubcategory) counts.set(g.subcategoryId!, g._count._all);
    return counts;
  }
  /** Distinct trimmed ERP category texts, most used first; `unassigned` counts products with no category yet. */
  erpCategories(take = 1000) {
    return this.tx.$queryRaw<{ erpCategory: string; products: number; unassigned: number }[]>`
      SELECT btrim(erp_category) AS "erpCategory", count(*)::int AS products,
             count(*) FILTER (WHERE category_id IS NULL)::int AS unassigned
      FROM products
      WHERE tenant_id = ${this.tenantId}::uuid AND erp_category IS NOT NULL AND btrim(erp_category) <> ''
      GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${take}`;
  }
  /** Sets the category of uncategorised products whose trimmed ERP category is one of `erpCategories`. */
  assignCategoryFromErp(categoryId: string, erpCategories: string[], actorId: string) {
    return this.tx.$executeRaw`
      UPDATE products SET category_id = ${categoryId}::uuid, updated_by = ${actorId}, updated_at = date_trunc('milliseconds', now())
      WHERE tenant_id = ${this.tenantId}::uuid AND category_id IS NULL AND btrim(erp_category) = ANY(${erpCategories}::text[])`;
  }

  /** One INSERT ... SELECT FROM unnest(...) per 5,000 events (activating every new product writes one each). */
  async auditEvents(actorId: string, requestId: string, events: { action: string; entityId: string; details: Prisma.InputJsonObject }[]) {
    for (let i = 0; i < events.length; i += 5000) {
      const c = events.slice(i, i + 5000);
      await this.tx.$executeRaw`
        INSERT INTO audit_events (id, tenant_id, actor_id, action, entity_id, request_id, details, created_at)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, ${actorId}::uuid, v.action, v.entity_id, ${requestId}, v.details::jsonb, now()
        FROM unnest(${c.map(e => e.action)}::text[], ${c.map(e => e.entityId)}::uuid[], ${c.map(e => JSON.stringify(e.details))}::text[])
          AS v(action, entity_id, details)`;
    }
  }
}

/** Every method adds tenant_id. Two levels at most: a category (parent_id null) and its subcategories. */
export class CategoryRepository {
  constructor(private readonly tenantId: string, private readonly tx: Tx) {}

  all() {
    return this.tx.category.findMany({
      where: { tenantId: this.tenantId }, orderBy: [{ sort: 'asc' }, { nameEn: 'asc' }, { id: 'asc' }],
      select: { id: true, parentId: true, nameEn: true, nameAr: true, sort: true, createdAt: true, updatedAt: true },
    });
  }
  get(id: string) {
    return this.tx.category.findFirst({ where: { tenantId: this.tenantId, id } });
  }
  /** A sibling with the same English name, ignoring case (compared exactly, not as an ILIKE pattern). */
  async siblingNamed(parentId: string | null, nameEn: string, exceptId?: string) {
    const rows = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM categories
      WHERE tenant_id = ${this.tenantId}::uuid AND parent_id IS NOT DISTINCT FROM ${parentId}::uuid
        AND lower(name_en) = lower(${nameEn}) AND id IS DISTINCT FROM ${exceptId ?? null}::uuid
      LIMIT 1`;
    return rows[0]?.id ?? null;
  }
  create(data: { nameEn: string; nameAr: string | null; parentId: string | null; sort: number }) {
    return this.tx.category.create({ data: { ...data, tenantId: this.tenantId } });
  }
  update(id: string, data: Pick<Prisma.CategoryUncheckedUpdateManyInput, 'nameEn' | 'nameAr' | 'parentId' | 'sort'>) {
    return this.tx.category.updateMany({ where: { tenantId: this.tenantId, id }, data });
  }
  delete(id: string) {
    return this.tx.category.deleteMany({ where: { tenantId: this.tenantId, id } });
  }
  /** What still refers to a category besides products: subcategories, marketplace mappings and price rules. */
  async references(id: string) {
    const [children, mappings, priceRules] = await Promise.all([
      this.tx.category.count({ where: { tenantId: this.tenantId, parentId: id } }),
      this.tx.categoryMapping.count({ where: { tenantId: this.tenantId, categoryId: id } }),
      this.tx.categoryPriceRule.count({ where: { tenantId: this.tenantId, OR: [{ categoryId: id }, { subcategoryId: id }] } }),
    ]);
    return { children, mappings, priceRules };
  }
}
