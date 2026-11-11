import { Prisma } from './generated/client.js';
import {
  EXPORT_STATES, NEEDS_CHANGE_STATES, exportStateRank,
  type ExportState, type MarketplaceValueField, type PlanTarget, type PlannedChange, type StoredField, type StoredOverride,
} from '../../core/src/marketplace-values.js';
import type { ProductFilter } from './products.js';

type Tx = Prisma.TransactionClient;

/** Every write cuts timestamps to milliseconds (the columns are TIMESTAMPTZ(3)): a value read back compares equal. */
const MS_NOW = Prisma.sql`date_trunc('milliseconds', now())`;
const likeText = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m);

/**
 * What the Review list, its counts and a bulk selection by filter read. The state of each field is computed here in SQL
 * from the stored recon row (catalogue reference), the product, the live export value and the live marketplace switch,
 * with the same rules and the same rank order as core reviewRow (marketplace-values.ts): change both together.
 */
export interface ReviewFilter {
  marketplaceId: string;
  /** The store's enabled marketplaces now (a pending value on a switched-off marketplace is blocked). */
  enabledMarketplaces: string[];
  /** The store's price tolerance in fils: a pinned price within it counts as shown. */
  toleranceFils: number;
  /** needs_change: blocked, waiting for export or to fix (the default Review list); all: every row. */
  show: 'needs_change' | 'all';
  /** Exactly this state (of the row, or of `field`); overrides `show`. */
  exportState?: ExportState;
  /** Judge `show` / `exportState` on one field only. */
  field?: MarketplaceValueField;
  search?: ProductFilter;
  productIds?: string[];
}

export interface ReviewDbRow {
  rank: number; a_rank: number; p_rank: number;
  product_id: string; barcode: string; sku: string | null; name_en: string; name_ar: string | null;
  product_status: string; erp_active: boolean; in_latest_erp_file: boolean; erp_stock: number;
  recon_status: string; catalogue_available: boolean | null; marketplace_price: number | null; marketplace_price_source: string | null;
  actual_price: number | null; actual_available: boolean | null; stock_issue: string | null; price_mismatch_vs_marketplace: boolean; last_updated: Date;
  edit_stock: number | null; edit_base: number | null; edit_state: string | null;
  source_upload_id: string | null; source_file_name: string | null; source_uploaded_at: Date | null; source_applied_at: Date | null;
  availability_set_by_name: string | null; price_set_by_name: string | null;
}
export type OverrideColumns = {
  o_id: string | null; o_version: number | null;
  availability_value: boolean | null; availability_state: string | null; availability_set_by_id: string | null; availability_set_at: Date | null;
  availability_reason: string | null; availability_cleared_at: Date | null; availability_persistent: boolean | null;
  price_value: number | null; price_state: string | null; price_set_by_id: string | null; price_set_at: Date | null;
  price_reason: string | null; price_cleared_at: Date | null; price_persistent: boolean | null;
};

const OVERRIDE_COLUMNS = Prisma.sql`o.id AS o_id, o.version AS o_version,
  o.availability_value, o.availability_state, o.availability_set_by_id, o.availability_set_at, o.availability_reason, o.availability_cleared_at, o.availability_persistent,
  o.price_value::float8 AS price_value, o.price_state, o.price_set_by_id, o.price_set_at, o.price_reason, o.price_cleared_at, o.price_persistent`;

function storedField<V>(state: string | null, value: V | null, setById: string | null, setAt: Date | null, reason: string | null, clearedAt: Date | null, persistent: boolean | null): StoredField<V> | null {
  if (state === null || value === null || setById === null || setAt === null) return null;
  return { value, state: state as 'pending' | 'cleared', persistent: persistent ?? false, setById, setAt, reason, clearedAt };
}
/** The stored export value of a joined row (null = no row: the file writes the catalogue value). */
export function storedOverride(r: OverrideColumns): StoredOverride | null {
  if (r.o_id === null || r.o_version === null) return null;
  return {
    id: r.o_id, version: r.o_version,
    availability: storedField(r.availability_state, r.availability_value, r.availability_set_by_id, r.availability_set_at, r.availability_reason, r.availability_cleared_at, r.availability_persistent),
    price: storedField(r.price_state, r.price_value, r.price_set_by_id, r.price_set_at, r.price_reason, r.price_cleared_at, r.price_persistent),
  };
}

const ELIGIBLE = Prisma.sql`(p.status = 'active' AND p.erp_active AND p.in_latest_erp_file)`;
const NOT_EXPORTABLE = Prisma.sql`(r.status = 'no_data' OR r.actual_price IS NULL OR p.status = 'new')`;

/** The two field ranks (EXPORT_STATES order: 0 blocked, 1 waiting_for_export, 2 to_fix, 3 pinned, 4 in_sync, 5 not_exportable). */
function fieldRanks(enabledMarketplaces: string[], toleranceFils: number) {
  const enabled = Prisma.sql`(r.marketplace_id = ANY(${enabledMarketplaces}::text[]))`;
  const availability = Prisma.sql`CASE
      WHEN o.availability_state = 'pending' THEN CASE
        WHEN r.actual_price IS NULL OR NOT ${enabled} OR (o.availability_value AND NOT ${ELIGIBLE}) THEN 0
        WHEN o.availability_persistent AND r.actual_available = o.availability_value THEN 3 ELSE 1 END
      WHEN ${NOT_EXPORTABLE} THEN 5 WHEN r.stock_issue IS NOT NULL THEN 2 ELSE 4 END`;
  const price = Prisma.sql`CASE
      WHEN o.price_state = 'pending' THEN CASE
        WHEN r.actual_price IS NULL OR NOT ${enabled} OR NOT ${ELIGIBLE} THEN 0
        WHEN o.price_persistent AND abs(round(r.actual_price * 1000) - round(o.price_value * 1000)) <= ${toleranceFils}::numeric THEN 3 ELSE 1 END
      WHEN ${NOT_EXPORTABLE} THEN 5 WHEN r.price_mismatch_vs_marketplace THEN 2 ELSE 4 END`;
  return { availability, price };
}
for (const [i, s] of ['blocked', 'waiting_for_export', 'to_fix', 'pinned', 'in_sync', 'not_exportable'].entries()) {
  if (EXPORT_STATES[i] !== s) throw new Error('EXPORT_STATES order changed: update the SQL ranks in marketplace-values.ts');
}

function searchSql(f?: ProductFilter): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  if (f?.categoryId) out.push(Prisma.sql`p.category_id = ${f.categoryId}::uuid`);
  if (f?.subcategoryId) out.push(Prisma.sql`p.subcategory_id = ${f.subcategoryId}::uuid`);
  // the product list's search (ProductRepository.where): name contains, SKU equals, barcode starts with
  if (f?.q) {
    const barcode = f.barcodePrefix ? Prisma.sql` OR p.normalized_barcode LIKE ${likeText(f.barcodePrefix) + '%'}` : Prisma.empty;
    out.push(Prisma.sql`(p.name_en ILIKE ${'%' + likeText(f.q) + '%'} OR p.sku = ${f.q}${barcode})`);
  }
  return out;
}

/** Export values, the Review list and its counts (tenant-scoped on every read and write). */
export class MarketplaceValuesRepository {
  constructor(private readonly tenantId: string, private readonly tx: Tx) {}

  /** product_id, a_rank, p_rank of every recon row of the marketplace (or of every marketplace) matching the search. */
  private ranked(f: Pick<ReviewFilter, 'enabledMarketplaces' | 'toleranceFils' | 'search' | 'productIds'> & { marketplaceId?: string }) {
    const { availability, price } = fieldRanks(f.enabledMarketplaces, f.toleranceFils);
    const where = [
      Prisma.sql`r.tenant_id = ${this.tenantId}::uuid`,
      ...(f.marketplaceId ? [Prisma.sql`r.marketplace_id = ${f.marketplaceId}`] : []),
      ...(f.productIds ? [Prisma.sql`r.product_id = ANY(${f.productIds}::uuid[])`] : []),
      ...searchSql(f.search),
    ];
    return Prisma.sql`
      SELECT r.marketplace_id, r.product_id, ${availability} AS a_rank, ${price} AS p_rank
      FROM recon_rows r JOIN products p ON p.tenant_id = r.tenant_id AND p.id = r.product_id
      LEFT JOIN marketplace_value_overrides o ON o.tenant_id = r.tenant_id AND o.product_id = r.product_id AND o.marketplace_id = r.marketplace_id
      WHERE ${Prisma.join(where, ' AND ')}`;
  }
  private stateWhere(f: ReviewFilter) {
    const target = f.field === 'availability' ? Prisma.sql`s.a_rank` : f.field === 'price' ? Prisma.sql`s.p_rank` : Prisma.sql`LEAST(s.a_rank, s.p_rank)`;
    if (f.exportState) return Prisma.sql`${target} = ${exportStateRank(f.exportState)}::int`;
    if (f.show === 'needs_change') return Prisma.sql`${target} = ANY(${NEEDS_CHANGE_STATES.map(exportStateRank)}::int[])`;
    return Prisma.sql`true`;
  }

  /** One page of the Review list, most urgent first (row rank, then product id); keyset on (rank, product id). */
  reviewPage(f: ReviewFilter, after: { rank: number; productId: string } | null, limit: number) {
    const cursor = after ? Prisma.sql` AND (LEAST(s.a_rank, s.p_rank), s.product_id) > (${after.rank}::int, ${after.productId}::uuid)` : Prisma.empty;
    return this.tx.$queryRaw<(ReviewDbRow & OverrideColumns)[]>`
      WITH s AS (${this.ranked(f)}), page AS (
        SELECT s.product_id, s.a_rank, s.p_rank, LEAST(s.a_rank, s.p_rank) AS rank FROM s
        WHERE ${this.stateWhere(f)}${cursor}
        ORDER BY LEAST(s.a_rank, s.p_rank), s.product_id LIMIT ${limit}
      )
      SELECT page.rank, page.a_rank, page.p_rank, r.product_id, p.barcode, p.sku, p.name_en, p.name_ar, p.status AS product_status,
             p.erp_active, p.in_latest_erp_file, p.erp_stock,
             r.status AS recon_status, r.catalogue_available, r.marketplace_price::float8 AS marketplace_price, r.marketplace_price_source,
             r.actual_price::float8 AS actual_price, r.actual_available, r.stock_issue, r.price_mismatch_vs_marketplace, r.last_updated,
             e.stock AS edit_stock, e.erp_stock_at_edit AS edit_base, e.state AS edit_state,
             ${OVERRIDE_COLUMNS}, au.name AS availability_set_by_name, pu.name AS price_set_by_name,
             u.id AS source_upload_id, u.file_name AS source_file_name, u.created_at AS source_uploaded_at, u.applied_at AS source_applied_at
      FROM page
      JOIN recon_rows r ON r.tenant_id = ${this.tenantId}::uuid AND r.marketplace_id = ${f.marketplaceId} AND r.product_id = page.product_id
      JOIN products p ON p.tenant_id = r.tenant_id AND p.id = r.product_id
      LEFT JOIN marketplace_value_overrides o ON o.tenant_id = r.tenant_id AND o.product_id = r.product_id AND o.marketplace_id = r.marketplace_id
      LEFT JOIN users au ON au.tenant_id = o.tenant_id AND au.id = o.availability_set_by_id
      LEFT JOIN users pu ON pu.tenant_id = o.tenant_id AND pu.id = o.price_set_by_id
      LEFT JOIN catalogue_stock_edits e ON e.tenant_id = r.tenant_id AND e.product_id = r.product_id
      -- the listing the comparison uses (ReconRepository.listings: newest, then marketplace product id) and its file; page rows only
      LEFT JOIN LATERAL (
        SELECT l.upload_id FROM listings l
        WHERE l.tenant_id = r.tenant_id AND l.marketplace_id = r.marketplace_id AND l.product_id = r.product_id
        ORDER BY l.updated_at DESC, l.marketplace_product_id LIMIT 1
      ) w ON true
      LEFT JOIN uploads u ON u.tenant_id = r.tenant_id AND u.id = w.upload_id
      ORDER BY page.rank, page.product_id`;
  }

  /** Product ids of a bulk selection by filter, in Review order; `limit` + 1 tells "more than the limit". */
  async selectionIds(f: ReviewFilter, limit: number): Promise<string[]> {
    const rows = await this.tx.$queryRaw<{ product_id: string }[]>`
      WITH s AS (${this.ranked(f)})
      SELECT s.product_id FROM s WHERE ${this.stateWhere(f)} ORDER BY LEAST(s.a_rank, s.p_rank), s.product_id LIMIT ${limit}`;
    return rows.map(r => r.product_id);
  }
  async selectionCount(f: ReviewFilter): Promise<number> {
    const [r] = await this.tx.$queryRaw<{ n: number }[]>`WITH s AS (${this.ranked(f)}) SELECT count(*)::int AS n FROM s WHERE ${this.stateWhere(f)}`;
    return r?.n ?? 0;
  }

  /** Per marketplace: to fix, waiting for export, pinned, blocked (row states, as the Review list counts them). */
  async counts(enabledMarketplaces: string[], toleranceFils: number, marketplaceId?: string) {
    const rows = await this.tx.$queryRaw<{ marketplace_id: string; to_fix: number; waiting: number; pinned: number; blocked: number }[]>`
      WITH s AS (${this.ranked({ enabledMarketplaces, toleranceFils, marketplaceId })})
      SELECT s.marketplace_id,
             count(*) FILTER (WHERE LEAST(s.a_rank, s.p_rank) = 2)::int AS to_fix, count(*) FILTER (WHERE LEAST(s.a_rank, s.p_rank) = 1)::int AS waiting,
             count(*) FILTER (WHERE LEAST(s.a_rank, s.p_rank) = 3)::int AS pinned, count(*) FILTER (WHERE LEAST(s.a_rank, s.p_rank) = 0)::int AS blocked
      FROM s GROUP BY s.marketplace_id`;
    return new Map(rows.map(r => [r.marketplace_id, { toFix: r.to_fix, waitingForExport: r.waiting, pinned: r.pinned, blocked: r.blocked }]));
  }

  /**
   * What the planner needs of each product, from live data (not the stored recon): listed = a listing of this
   * marketplace matched to the product now; the eligibility gates; the stored export value. Absent ids are not returned.
   */
  async targets(productIds: string[], marketplaceId: string): Promise<(PlanTarget & { nameEn: string; barcode: string })[]> {
    if (!productIds.length) return [];
    const rows = await this.tx.$queryRaw<({ id: string; name_en: string; barcode: string; status: string; erp_active: boolean; in_latest_erp_file: boolean; listed: boolean } & OverrideColumns)[]>`
      SELECT p.id, p.name_en, p.barcode, p.status, p.erp_active, p.in_latest_erp_file,
             EXISTS (SELECT 1 FROM listings l WHERE l.tenant_id = p.tenant_id AND l.marketplace_id = ${marketplaceId} AND l.product_id = p.id) AS listed,
             ${OVERRIDE_COLUMNS}
      FROM products p
      LEFT JOIN marketplace_value_overrides o ON o.tenant_id = p.tenant_id AND o.product_id = p.id AND o.marketplace_id = ${marketplaceId}
      WHERE p.tenant_id = ${this.tenantId}::uuid AND p.id = ANY(${productIds}::uuid[])`;
    const by = new Map(rows.map(r => [r.id, r]));
    // in the order given: the plan (and so the preview token) is the same for the same request
    return productIds.flatMap(id => {
      const r = by.get(id);
      return r ? [{
        productId: r.id, nameEn: r.name_en, barcode: r.barcode, listed: r.listed,
        product: { status: r.status, erpActive: r.erp_active, inLatestErpFile: r.in_latest_erp_file }, override: storedOverride(r),
      }] : [];
    });
  }

  /**
   * Writes planned changes, set-based: sets become pending values (who = actorId, when = now, ms precision) and clears
   * mark pending fields cleared; the other field of a row is left exactly as it was. Every changed row: version + 1.
   */
  async write(marketplaceId: string, actorId: string, changes: PlannedChange[]) {
    const sets = changes.filter(c => c.fields.some(f => f.op === 'set'));
    const clears = changes.filter(c => c.fields.some(f => f.op === 'clear'));
    if (sets.length) {
      const col = (field: MarketplaceValueField, pick: (f: PlannedChange['fields'][number]) => string | null) =>
        sets.map(c => { const f = c.fields.find(x => x.field === field && x.op === 'set'); return f ? pick(f) : null; });
      const isSet = (field: MarketplaceValueField) => sets.map(c => String(c.fields.some(x => x.field === field && x.op === 'set')));
      await this.tx.$executeRaw`
        INSERT INTO marketplace_value_overrides AS o (id, tenant_id, product_id, marketplace_id,
          availability_value, availability_state, availability_set_by_id, availability_set_at, availability_reason, availability_cleared_at, availability_persistent,
          price_value, price_state, price_set_by_id, price_set_at, price_reason, price_cleared_at, price_persistent, version, created_at, updated_at)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, v.product_id, ${marketplaceId},
          CASE WHEN v.a_set::boolean THEN v.a_value::boolean END, CASE WHEN v.a_set::boolean THEN 'pending' END,
          CASE WHEN v.a_set::boolean THEN ${actorId}::uuid END, CASE WHEN v.a_set::boolean THEN ${MS_NOW} END, v.a_reason, NULL, coalesce(v.a_persistent::boolean, false),
          CASE WHEN v.p_set::boolean THEN v.p_value::numeric END, CASE WHEN v.p_set::boolean THEN 'pending' END,
          CASE WHEN v.p_set::boolean THEN ${actorId}::uuid END, CASE WHEN v.p_set::boolean THEN ${MS_NOW} END, v.p_reason, NULL, coalesce(v.p_persistent::boolean, false),
          1, ${MS_NOW}, ${MS_NOW}
        FROM unnest(${sets.map(c => c.productId)}::uuid[],
                    ${isSet('availability')}::text[], ${col('availability', f => String(f.after.value))}::text[], ${col('availability', f => String(f.after.persistent))}::text[], ${col('availability', f => f.after.reason)}::text[],
                    ${isSet('price')}::text[], ${col('price', f => String(f.after.value))}::text[], ${col('price', f => String(f.after.persistent))}::text[], ${col('price', f => f.after.reason)}::text[])
             AS v(product_id, a_set, a_value, a_persistent, a_reason, p_set, p_value, p_persistent, p_reason)
        ON CONFLICT (tenant_id, product_id, marketplace_id) DO UPDATE SET
          availability_value = CASE WHEN EXCLUDED.availability_state IS NULL THEN o.availability_value ELSE EXCLUDED.availability_value END,
          availability_state = coalesce(EXCLUDED.availability_state, o.availability_state),
          availability_set_by_id = CASE WHEN EXCLUDED.availability_state IS NULL THEN o.availability_set_by_id ELSE EXCLUDED.availability_set_by_id END,
          availability_set_at = CASE WHEN EXCLUDED.availability_state IS NULL THEN o.availability_set_at ELSE EXCLUDED.availability_set_at END,
          availability_reason = CASE WHEN EXCLUDED.availability_state IS NULL THEN o.availability_reason ELSE EXCLUDED.availability_reason END,
          availability_cleared_at = CASE WHEN EXCLUDED.availability_state IS NULL THEN o.availability_cleared_at ELSE NULL END,
          availability_persistent = CASE WHEN EXCLUDED.availability_state IS NULL THEN o.availability_persistent ELSE EXCLUDED.availability_persistent END,
          price_value = CASE WHEN EXCLUDED.price_state IS NULL THEN o.price_value ELSE EXCLUDED.price_value END,
          price_state = coalesce(EXCLUDED.price_state, o.price_state),
          price_set_by_id = CASE WHEN EXCLUDED.price_state IS NULL THEN o.price_set_by_id ELSE EXCLUDED.price_set_by_id END,
          price_set_at = CASE WHEN EXCLUDED.price_state IS NULL THEN o.price_set_at ELSE EXCLUDED.price_set_at END,
          price_reason = CASE WHEN EXCLUDED.price_state IS NULL THEN o.price_reason ELSE EXCLUDED.price_reason END,
          price_cleared_at = CASE WHEN EXCLUDED.price_state IS NULL THEN o.price_cleared_at ELSE NULL END,
          price_persistent = CASE WHEN EXCLUDED.price_state IS NULL THEN o.price_persistent ELSE EXCLUDED.price_persistent END,
          version = o.version + 1, updated_at = EXCLUDED.updated_at`;
    }
    if (clears.length) {
      const clearing = (field: MarketplaceValueField) => clears.map(c => String(c.fields.some(x => x.field === field && x.op === 'clear')));
      await this.tx.$executeRaw`
        UPDATE marketplace_value_overrides AS o SET
          availability_state = CASE WHEN v.a_clear::boolean THEN 'cleared' ELSE o.availability_state END,
          availability_cleared_at = CASE WHEN v.a_clear::boolean THEN ${MS_NOW} ELSE o.availability_cleared_at END,
          price_state = CASE WHEN v.p_clear::boolean THEN 'cleared' ELSE o.price_state END,
          price_cleared_at = CASE WHEN v.p_clear::boolean THEN ${MS_NOW} ELSE o.price_cleared_at END,
          version = o.version + 1, updated_at = ${MS_NOW}
        FROM unnest(${clears.map(c => c.productId)}::uuid[], ${clearing('availability')}::text[], ${clearing('price')}::text[]) AS v(product_id, a_clear, p_clear)
        WHERE o.tenant_id = ${this.tenantId}::uuid AND o.marketplace_id = ${marketplaceId} AND o.product_id = v.product_id`;
    }
  }

  /** A bulk apply recorded under this idempotency key within the window (the event holds the request hash and result). */
  operation(idempotencyKey: string, since: Date) {
    return this.tx.auditEvent.findFirst({
      where: { tenantId: this.tenantId, action: 'marketplace.values_bulk_applied', createdAt: { gte: since }, details: { path: ['idempotencyKey'], equals: idempotencyKey } },
      orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, details: true },
    });
  }
}
