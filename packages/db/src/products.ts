import { Prisma } from './generated/client.js';
import type { MarketplaceStatusFilter } from '../../core/src/products/marketplace-view.js';

type Tx = Prisma.TransactionClient;

export type ProductTab = 'all' | 'active' | 'inactive' | 'new' | 'missing';

/**
 * The catalogue list's marketplace filter. Selects exactly the products core marketplaceComparison classifies as
 * `status` (change both together): in_sync = listed + recon in_sync; mismatch = listed + (recon mismatch, or
 * missing_from_erp with a stock issue); not_in_file = not listed. Columns are those of `reference`.
 */
export interface ProductMarketplaceFilter {
  marketplaceId: string;
  status: MarketplaceStatusFilter;
  reference: 'marketplace' | 'erp';
  /** The marketplace has an applied upload; without one nothing is compared and nothing matches. */
  hasData: boolean;
}

/** Search and category filters shared by the list and its tab counts (the tab itself is not part of it). */
export interface ProductFilter {
  q?: string;
  /** A normalised barcode to match by prefix; only set when the search text reads as a barcode. */
  barcodePrefix?: string;
  categoryId?: string;
  subcategoryId?: string;
  /** Only the catalogue list sets it (GET /api/products?marketplaceId=...&marketplaceStatus=...). */
  marketplace?: ProductMarketplaceFilter;
}

/** One product's values on one marketplace, as read for a list page (ProductRepository.marketplaceValues). */
export interface ProductMarketplaceRow {
  productId: string;
  /** The winning listing (same choice as recon): newest updated_at, then marketplace_product_id. */
  listing: { price: string; available: boolean; uploadedAt: Date | null } | null;
  recon: {
    status: string; statusVsErp: string; stockIssue: string | null; stockIssueVsErp: string | null;
    priceMismatchVsMarketplace: boolean; priceMismatchVsErp: boolean;
    actualPrice: number | null; marketplacePrice: number | null; erpPrice: number | null;
  } | null;
}

/** The statement of ProductRepository.marketplaceValues; exported so a test can EXPLAIN exactly this SQL. */
export function marketplaceValuesSql(tenantId: string, marketplaceId: string, productIds: string[]) {
  return Prisma.sql`
    SELECT p.id AS product_id, l.price::text AS l_price, l.available AS l_available, u.created_at AS uploaded_at,
           r.id IS NOT NULL AS has_recon, r.status, r.status_vs_erp, r.stock_issue, r.stock_issue_vs_erp,
           r.price_mismatch_vs_marketplace, r.price_mismatch_vs_erp,
           r.actual_price::float8 AS actual_price, r.marketplace_price::float8 AS marketplace_price, r.erp_price::float8 AS erp_price
    FROM unnest(${productIds}::uuid[]) AS p(id)
    LEFT JOIN LATERAL (
      SELECT price, available, upload_id FROM listings
      WHERE tenant_id = ${tenantId}::uuid AND marketplace_id = ${marketplaceId} AND product_id = p.id
      ORDER BY updated_at DESC, marketplace_product_id
      LIMIT 1
    ) AS l ON true
    LEFT JOIN uploads u ON u.tenant_id = ${tenantId}::uuid AND u.id = l.upload_id
    LEFT JOIN recon_rows r ON r.tenant_id = ${tenantId}::uuid AND r.product_id = p.id AND r.marketplace_id = ${marketplaceId}`;
}

function marketplaceWhere(m: ProductMarketplaceFilter): Prisma.ProductWhereInput {
  // no applied upload: no product is in the file or compared (core rule 1)
  if (!m.hasData) return { id: { in: [] } };
  const listed: Prisma.ProductWhereInput = { listings: { some: { marketplaceId: m.marketplaceId } } };
  if (m.status === 'not_in_file') return { listings: { none: { marketplaceId: m.marketplaceId } } };
  const erp = m.reference === 'erp';
  const recon: Prisma.ReconRowWhereInput = m.status === 'in_sync'
    ? (erp ? { statusVsErp: 'in_sync' } : { status: 'in_sync' })
    : erp
      ? { OR: [{ statusVsErp: 'mismatch' }, { statusVsErp: 'missing_from_erp', stockIssueVsErp: { not: null } }] }
      : { OR: [{ status: 'mismatch' }, { status: 'missing_from_erp', stockIssue: { not: null } }] };
  return { AND: [listed, { reconRows: { some: { marketplaceId: m.marketplaceId, ...recon } } }] };
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

/** A bulk price change's filter: the product list's search and category, on one marketplace. */
export interface PricingSelection extends ProductFilter {
  marketplaceId: string;
  /** true: only products with a listing on marketplaceId; false: only products without one. */
  listed?: boolean;
  /** Only products whose stored recon row on marketplaceId has this status (or, price_mismatch, the price flag) for `reference`. */
  recon?: { status: string; reference: 'marketplace' | 'erp' };
}

/** What a bulk price change prices and shows of each product. */
const pricingSelect = {
  id: true, nameEn: true, barcode: true, status: true, erpPrice: true, categoryId: true, subcategoryId: true,
} satisfies Prisma.ProductSelect;

/** What a stock edit or conflict resolution needs of each product (ADR 017). */
const stockSelect = {
  id: true, nameEn: true, barcode: true, status: true, erpStock: true,
  stockEdit: { select: { stock: true, erpStockAtEdit: true, state: true } },
} satisfies Prisma.ProductSelect;

/** `ILIKE` reads % _ and \ as wildcards and escape; a search for "50%" means the text. */
const likeText = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m);

/** Every method adds tenant_id; callers never pass a tenant. Built on the same transaction as the request. */
export class ProductRepository {
  constructor(private readonly tenantId: string, private readonly tx: Tx) {}

  private where(f: ProductFilter): Prisma.ProductWhereInput {
    return {
      tenantId: this.tenantId,
      ...(f.marketplace ? marketplaceWhere(f.marketplace) : {}),
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
  /** Active products only: a new or inactive product is not priced by a bulk change. */
  private pricingWhere(s: PricingSelection): Prisma.ProductWhereInput {
    const erp = s.recon?.reference === 'erp';
    const recon: Prisma.ReconRowWhereInput | null = !s.recon ? null
      : s.recon.status === 'price_mismatch' ? (erp ? { priceMismatchVsErp: true } : { priceMismatchVsMarketplace: true })
        : erp ? { statusVsErp: s.recon.status } : { status: s.recon.status };
    return {
      AND: [
        this.where(s), { status: 'active' },
        ...(s.listed === undefined ? [] : [{ listings: s.listed ? { some: { marketplaceId: s.marketplaceId } } : { none: { marketplaceId: s.marketplaceId } } }]),
        ...(recon ? [{ reconRows: { some: { marketplaceId: s.marketplaceId, ...recon } } }] : []),
      ],
    };
  }
  /** A bulk price selection in list order (name, id), at most `take` rows (ask for one more than the limit). */
  pricingSelection(s: PricingSelection, take: number) {
    return this.tx.product.findMany({ where: this.pricingWhere(s), orderBy: [{ nameEn: 'asc' }, { id: 'asc' }], take, select: pricingSelect });
  }
  pricingSelectionCount(s: PricingSelection) {
    return this.tx.product.count({ where: this.pricingWhere(s) });
  }
  /** A bulk stock selection (any status) in list order, at most `take` rows (ask for one more than the limit). */
  stockSelection(f: ProductFilter, take: number) {
    return this.tx.product.findMany({ where: this.where(f), orderBy: [{ nameEn: 'asc' }, { id: 'asc' }], take, select: stockSelect });
  }
  stockSelectionCount(f: ProductFilter) { return this.tx.product.count({ where: this.where(f) }); }
  /** The given products of this store for a stock edit or conflict resolution (another store's ids are absent), in list order. */
  stockProducts(ids: string[]) {
    return this.tx.product.findMany({ where: { tenantId: this.tenantId, id: { in: ids } }, orderBy: [{ nameEn: 'asc' }, { id: 'asc' }], select: stockSelect });
  }
  /** The given products of this store (any status; another store's ids are simply absent), in list order. */
  pricingProducts(ids: string[]) {
    return this.tx.product.findMany({ where: { tenantId: this.tenantId, id: { in: ids } }, orderBy: [{ nameEn: 'asc' }, { id: 'asc' }], select: pricingSelect });
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
  /** Every product's position in the list order (name, id); one packed value, not one object per product. */
  async nameOrder(): Promise<Map<string, number>> {
    const [row] = await this.tx.$queryRaw<{ packed: string | null }[]>`
      SELECT string_agg(id::text, ',' ORDER BY name_en, id) AS packed FROM products WHERE tenant_id = ${this.tenantId}::uuid`;
    return new Map((row?.packed ? row.packed.split(',') : []).map((id, i) => [id, i]));
  }
  /** Name and barcode of a few products (examples on a screen). */
  labels(ids: string[]) {
    return this.tx.product.findMany({ where: { tenantId: this.tenantId, id: { in: ids } }, select: { id: true, nameEn: true, barcode: true } });
  }
  /**
   * A list page's values on one marketplace in one statement: per product id the winning listing (index
   * listings(tenant_id, marketplace_id, product_id); the same choice as recon), its upload (primary key) and the
   * stored recon row (unique (tenant_id, product_id, marketplace_id)). Every join is tenant-scoped; ids of another
   * store simply find nothing. Prices as text keep the 3 stored decimals.
   */
  async marketplaceValues(marketplaceId: string, productIds: string[]): Promise<Map<string, ProductMarketplaceRow>> {
    if (!productIds.length) return new Map();
    const rows = await this.tx.$queryRaw<{
      product_id: string; l_price: string | null; l_available: boolean | null; uploaded_at: Date | null; has_recon: boolean;
      status: string | null; status_vs_erp: string | null; stock_issue: string | null; stock_issue_vs_erp: string | null;
      price_mismatch_vs_marketplace: boolean | null; price_mismatch_vs_erp: boolean | null;
      actual_price: number | null; marketplace_price: number | null; erp_price: number | null;
    }[]>(marketplaceValuesSql(this.tenantId, marketplaceId, productIds));
    return new Map(rows.map(r => [r.product_id, {
      productId: r.product_id,
      listing: r.l_price === null ? null : { price: r.l_price, available: r.l_available!, uploadedAt: r.uploaded_at },
      recon: !r.has_recon ? null : {
        status: r.status!, statusVsErp: r.status_vs_erp!, stockIssue: r.stock_issue, stockIssueVsErp: r.stock_issue_vs_erp,
        priceMismatchVsMarketplace: r.price_mismatch_vs_marketplace!, priceMismatchVsErp: r.price_mismatch_vs_erp!,
        actualPrice: r.actual_price, marketplacePrice: r.marketplace_price, erpPrice: r.erp_price,
      },
    }]));
  }
  /** All actual listings of one marketplace, including unmatched and in-sync products. */
  async marketplaceListings(f: {
    marketplaceId: string; q?: string; barcodePrefix?: string;
    availability: 'all' | 'available' | 'unavailable'; match: 'all' | 'matched' | 'unmatched';
  }, after: { marketplaceProductId: string; id: string } | null, take: number) {
    const search = f.q ? Prisma.sql` AND (l.name ILIKE ${'%' + likeText(f.q) + '%'}
      OR l.marketplace_product_id ILIKE ${'%' + likeText(f.q) + '%'} OR p.name_en ILIKE ${'%' + likeText(f.q) + '%'}
      OR EXISTS (SELECT 1 FROM unnest(l.barcodes) AS b(barcode) WHERE b.barcode LIKE ${likeText(f.barcodePrefix ?? f.q) + '%'})
      ${f.barcodePrefix ? Prisma.sql` OR p.normalized_barcode LIKE ${likeText(f.barcodePrefix) + '%'}` : Prisma.empty})` : Prisma.empty;
    const where = Prisma.sql`l.tenant_id = ${this.tenantId}::uuid AND l.marketplace_id = ${f.marketplaceId}
      ${f.availability === 'all' ? Prisma.empty : Prisma.sql` AND l.available = ${f.availability === 'available'}`}
      ${f.match === 'all' ? Prisma.empty : f.match === 'matched' ? Prisma.sql` AND l.product_id IS NOT NULL` : Prisma.sql` AND l.product_id IS NULL`}${search}`;
    const cursor = after ? Prisma.sql` AND (l.marketplace_product_id, l.id) > (${after.marketplaceProductId}, ${after.id}::uuid)` : Prisma.empty;
    const rows = await this.tx.$queryRaw<{
      id: string; marketplace_product_id: string; name: string | null; barcodes: string[]; price: number; available: boolean; updated_at: Date;
      product_id: string | null; product_name: string | null; product_barcode: string | null; product_erp_stock: number | null; upload_id: string | null; file_name: string | null;
    }[]>`
      SELECT l.id, l.marketplace_product_id, l.name, l.barcodes, l.price::float8 AS price, l.available, l.updated_at,
             p.id AS product_id, p.name_en AS product_name, p.barcode AS product_barcode, p.erp_stock AS product_erp_stock, u.id AS upload_id, u.file_name
      FROM listings l LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
      LEFT JOIN uploads u ON u.tenant_id = l.tenant_id AND u.id = l.upload_id
      WHERE ${where}${cursor} ORDER BY l.marketplace_product_id, l.id LIMIT ${take}`;
    const [count] = await this.tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM listings l LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id WHERE ${where}`;
    const latestUpload = await this.tx.upload.findFirst({
      where: { tenantId: this.tenantId, source: f.marketplaceId, status: 'applied' },
      orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], select: { id: true, fileName: true, appliedAt: true },
    });
    return { rows, total: count?.n ?? 0, latestUpload };
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
