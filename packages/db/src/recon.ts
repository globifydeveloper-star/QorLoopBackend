import { Prisma } from './generated/client.js';
import { MARKETPLACES, type MarketplaceId } from '../../core/src/constants.js';
import type { OfferInput, PriceRule } from '../../core/src/pricing.js';
import {
  isStale, type ReconCatalogueProduct, type ReconListing, type ReconMarketplace, type ReconReference, type ReconRowResult, type ReconStatus,
} from '../../core/src/recon/index.js';

type Tx = Prisma.TransactionClient;

/** Rows per INSERT ... SELECT FROM unnest(...): one bind parameter per column (RECON_ROW_COLUMNS), not per value. */
export const RECON_WRITE_BATCH = 10_000;
/** Bind parameters of one recon row write: the tenant plus one array per column (see upsertRows). */
export const RECON_ROW_COLUMNS = 14;

export interface ReconMarketplaceState extends ReconMarketplace { lastUploadAt: Date | null; stale: boolean }
export type ReconRowType = 'stock' | 'price' | 'all';
export interface ReconRowsQuery {
  marketplaceId: MarketplaceId;
  reference: ReconReference;
  type: ReconRowType;
  status?: ReconStatus;
  after: { rank: number; productId: string } | null;
  limit: number;
}

const text = (v: number | boolean | null) => (v === null ? null : String(v));

/**
 * Recon rows and summaries. Every method adds tenant_id. Money is read as float8 (exact for DECIMAL(12,3) below 1e9
 * once rounded to fils) so 50,000 products do not each allocate Decimal objects.
 */
export class ReconRepository {
  constructor(private readonly tenantId: string, private readonly tx: Tx) {}

  // ── Inputs ──

  async settings() {
    const s = await this.tx.tenantSettings.findUnique({ where: { tenantId: this.tenantId }, select: { priceTolerance: true, stockThreshold: true, staleHours: true } });
    return { priceTolerance: s?.priceTolerance.toNumber() ?? 0, stockThreshold: s?.stockThreshold ?? 0, staleHours: s?.staleHours ?? 12 };
  }
  marketplaceSwitches() {
    return this.tx.tenantMarketplace.findMany({ where: { tenantId: this.tenantId }, select: { marketplaceId: true, enabled: true } });
  }
  /** The latest applied upload per marketplace (ERP excluded). */
  async lastApplied() {
    const rows = await this.tx.$queryRaw<{ source: string; at: Date }[]>`
      SELECT source, max(applied_at) AS at FROM uploads
      WHERE tenant_id = ${this.tenantId}::uuid AND status = 'applied' AND source = ANY(${[...MARKETPLACES]}::text[])
      GROUP BY source`;
    return new Map(rows.map(r => [r.source, r.at]));
  }

  /** Every product with its pricing inputs: three statements whatever the catalogue size. */
  async products(): Promise<ReconCatalogueProduct[]> {
    const [products, rules, offers] = await Promise.all([
      this.tx.$queryRaw<{ id: string; status: string; erp_active: boolean; in_latest_erp_file: boolean; erp_stock: number; erp_price: number; category_id: string | null; subcategory_id: string | null }[]>`
        SELECT id, status, erp_active, in_latest_erp_file, erp_stock, erp_price::float8 AS erp_price, category_id, subcategory_id
        FROM products WHERE tenant_id = ${this.tenantId}::uuid`,
      this.tx.$queryRaw<{ product_id: string; mode: string; value: number }[]>`
        SELECT product_id, mode, value::float8 AS value FROM product_price_rules WHERE tenant_id = ${this.tenantId}::uuid`,
      this.tx.$queryRaw<{ product_id: string; price: number; valid_from: Date | null; valid_until: Date | null }[]>`
        SELECT product_id, price::float8 AS price, valid_from, valid_until FROM product_offers
        WHERE tenant_id = ${this.tenantId}::uuid ORDER BY created_at`,
    ]);
    const ruleBy = new Map(rules.map(r => [r.product_id, { mode: r.mode, value: r.value } as PriceRule]));
    const offersBy = new Map<string, OfferInput[]>();
    for (const o of offers) {
      const list = offersBy.get(o.product_id) ?? [];
      list.push({ price: o.price, validFrom: o.valid_from, validUntil: o.valid_until });
      offersBy.set(o.product_id, list);
    }
    return products.map(p => ({
      id: p.id, status: p.status, erpActive: p.erp_active, inLatestErpFile: p.in_latest_erp_file, erpStock: p.erp_stock, erpPrice: p.erp_price,
      pricing: { erpPrice: p.erp_price, categoryId: p.category_id, subcategoryId: p.subcategory_id, productRule: ruleBy.get(p.id) ?? null, offers: offersBy.get(p.id) ?? [] },
    }));
  }

  /**
   * Matched listings keyed `${marketplaceId}:${productId}`. Two listings matched to one product (two marketplace IDs
   * with the same barcode) are reconciled by the one written last. Sent as one packed text value: 200,000 rows as
   * Prisma objects cost seconds, one string costs milliseconds.
   */
  async listings(marketplaceIds: string[]): Promise<Map<string, ReconListing>> {
    const [row] = await this.tx.$queryRaw<{ packed: string | null }[]>`
      SELECT string_agg(l.marketplace_id || ':' || l.product_id || E'\t' || l.price::text || E'\t' || l.available::int::text, E'\n') AS packed
      FROM (
        SELECT DISTINCT ON (marketplace_id, product_id) marketplace_id, product_id, price, available
        FROM listings
        WHERE tenant_id = ${this.tenantId}::uuid AND product_id IS NOT NULL AND marketplace_id = ANY(${marketplaceIds}::text[])
        ORDER BY marketplace_id, product_id, updated_at DESC, marketplace_product_id
      ) AS l`;
    const map = new Map<string, ReconListing>();
    for (const line of row?.packed ? row.packed.split('\n') : []) {
      const [key, price, available] = line.split('\t');
      map.set(key!, { price: Number(price), available: available === '1' });
    }
    return map;
  }

  // ── Writes (one transaction, set-based; only what changed) ──

  /**
   * reconKey -> reconSignature of every stored row, built by the database (core reconSignature builds the same string:
   * change both together), so the worker writes only the difference without loading the rows as objects.
   */
  async storedSignatures(): Promise<Map<string, string>> {
    const [row] = await this.tx.$queryRaw<{ packed: string | null }[]>`
      SELECT string_agg(marketplace_id || ':' || product_id || E'\t' || concat_ws('|',
               status, status_vs_erp, coalesce(stock_issue, ''), price_mismatch_vs_erp::int::text, price_mismatch_vs_marketplace::int::text,
               coalesce(erp_available::int::text, ''), coalesce(actual_available::int::text, ''), coalesce(marketplace_price_source, ''),
               coalesce(round(marketplace_price * 1000)::bigint::text, ''), coalesce(round(erp_price * 1000)::bigint::text, ''),
               coalesce(round(actual_price * 1000)::bigint::text, '')), E'\n') AS packed
      FROM recon_rows WHERE tenant_id = ${this.tenantId}::uuid`;
    const map = new Map<string, string>();
    for (const line of row?.packed ? row.packed.split('\n') : []) {
      const tab = line.indexOf('\t');
      map.set(line.slice(0, tab), line.slice(tab + 1));
    }
    return map;
  }

  /** The 13 columns of a row write, one text[] each (one bind parameter per column whatever the batch size). */
  private columns(c: ReconRowResult[]) {
    return Prisma.sql`unnest(
      ${c.map(r => r.productId)}::uuid[], ${c.map(r => r.marketplaceId)}::text[], ${c.map(r => String(r.marketplacePrice))}::text[],
      ${c.map(r => r.marketplacePriceSource)}::text[], ${c.map(r => String(r.erpPrice))}::text[], ${c.map(r => text(r.actualPrice))}::text[],
      ${c.map(r => String(r.erpAvailable))}::text[], ${c.map(r => text(r.actualAvailable))}::text[], ${c.map(r => String(r.priceMismatchVsErp))}::text[],
      ${c.map(r => String(r.priceMismatchVsMarketplace))}::text[], ${c.map(r => r.stockIssue)}::text[], ${c.map(r => r.status)}::text[],
      ${c.map(r => r.statusVsErp)}::text[]
    ) AS v(product_id, marketplace_id, mp, mp_source, erp, actual, erp_av, actual_av, pm_erp, pm_mp, stock_issue, status, status_erp)`;
  }

  /** New rows. ON CONFLICT keeps a retried or overlapping write correct (the advisory lock already serializes runs). */
  async insertRows(rows: ReconRowResult[]) {
    let written = 0;
    for (let i = 0; i < rows.length; i += RECON_WRITE_BATCH) {
      written += await this.tx.$executeRaw`
        INSERT INTO recon_rows (id, tenant_id, product_id, marketplace_id, marketplace_price, marketplace_price_source, erp_price, actual_price,
                                erp_available, actual_available, price_mismatch_vs_erp, price_mismatch_vs_marketplace, stock_issue, status, status_vs_erp, last_updated)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, v.product_id, v.marketplace_id, v.mp::numeric, v.mp_source, v.erp::numeric, v.actual::numeric,
               v.erp_av::boolean, v.actual_av::boolean, v.pm_erp::boolean, v.pm_mp::boolean, v.stock_issue, v.status, v.status_erp, now()
        FROM ${this.columns(rows.slice(i, i + RECON_WRITE_BATCH))}
        ON CONFLICT (tenant_id, product_id, marketplace_id) DO UPDATE SET
          marketplace_price = EXCLUDED.marketplace_price, marketplace_price_source = EXCLUDED.marketplace_price_source,
          erp_price = EXCLUDED.erp_price, actual_price = EXCLUDED.actual_price, erp_available = EXCLUDED.erp_available,
          actual_available = EXCLUDED.actual_available, price_mismatch_vs_erp = EXCLUDED.price_mismatch_vs_erp,
          price_mismatch_vs_marketplace = EXCLUDED.price_mismatch_vs_marketplace, stock_issue = EXCLUDED.stock_issue,
          status = EXCLUDED.status, status_vs_erp = EXCLUDED.status_vs_erp, last_updated = now()`;
    }
    return written;
  }

  /** Changed rows, by key; last_updated says when a row's result last changed. */
  async updateRows(rows: ReconRowResult[]) {
    let written = 0;
    for (let i = 0; i < rows.length; i += RECON_WRITE_BATCH) {
      written += await this.tx.$executeRaw`
        UPDATE recon_rows AS r SET
          marketplace_price = v.mp::numeric, marketplace_price_source = v.mp_source, erp_price = v.erp::numeric, actual_price = v.actual::numeric,
          erp_available = v.erp_av::boolean, actual_available = v.actual_av::boolean, price_mismatch_vs_erp = v.pm_erp::boolean,
          price_mismatch_vs_marketplace = v.pm_mp::boolean, stock_issue = v.stock_issue, status = v.status, status_vs_erp = v.status_erp, last_updated = now()
        FROM ${this.columns(rows.slice(i, i + RECON_WRITE_BATCH))}
        WHERE r.tenant_id = ${this.tenantId}::uuid AND r.product_id = v.product_id AND r.marketplace_id = v.marketplace_id`;
    }
    return written;
  }

  /** Rows that no longer qualify (a marketplace switched off). */
  async deleteRows(keys: { productId: string; marketplaceId: string }[]) {
    let removed = 0;
    for (let i = 0; i < keys.length; i += RECON_WRITE_BATCH) {
      const c = keys.slice(i, i + RECON_WRITE_BATCH);
      removed += await this.tx.$executeRaw`
        DELETE FROM recon_rows AS r USING unnest(${c.map(k => k.productId)}::uuid[], ${c.map(k => k.marketplaceId)}::text[]) AS v(product_id, marketplace_id)
        WHERE r.tenant_id = ${this.tenantId}::uuid AND r.product_id = v.product_id AND r.marketplace_id = v.marketplace_id`;
    }
    return removed;
  }

  /**
   * Summaries counted by the database from the stored rows, in the same transaction: they cannot disagree with the rows.
   * One pass over the rows (both references side by side), then one row per marketplace x reference, including a
   * marketplace with no rows (zeros, has_data false). Summaries of marketplaces no longer reconciled are removed.
   */
  async writeSummaries(marketplaces: ReconMarketplaceState[]) {
    await this.tx.$executeRaw`
      DELETE FROM recon_summaries WHERE tenant_id = ${this.tenantId}::uuid AND NOT (marketplace_id = ANY(${marketplaces.map(m => m.marketplaceId)}::text[]))`;
    if (!marketplaces.length) return 0;
    return this.tx.$executeRaw`
      WITH c AS (
        SELECT marketplace_id,
               count(*) FILTER (WHERE actual_price IS NOT NULL)::int AS listed,
               count(*) FILTER (WHERE stock_issue IS NOT NULL)::int AS stock,
               count(*) FILTER (WHERE price_mismatch_vs_marketplace)::int AS price_mp,
               count(*) FILTER (WHERE price_mismatch_vs_erp)::int AS price_erp,
               count(*) FILTER (WHERE status = 'not_listed')::int AS not_listed_mp, count(*) FILTER (WHERE status_vs_erp = 'not_listed')::int AS not_listed_erp,
               count(*) FILTER (WHERE status = 'no_data')::int AS no_data_mp, count(*) FILTER (WHERE status_vs_erp = 'no_data')::int AS no_data_erp,
               count(*) FILTER (WHERE status = 'missing_from_erp')::int AS missing_mp, count(*) FILTER (WHERE status_vs_erp = 'missing_from_erp')::int AS missing_erp,
               count(*) FILTER (WHERE status = 'new')::int AS new_mp, count(*) FILTER (WHERE status_vs_erp = 'new')::int AS new_erp
        FROM recon_rows WHERE tenant_id = ${this.tenantId}::uuid GROUP BY marketplace_id
      ), m AS (
        SELECT v.marketplace_id, v.has_data::boolean AS has_data, v.last_upload_at::timestamptz AS last_upload_at, v.stale::boolean AS stale
        FROM unnest(${marketplaces.map(m => m.marketplaceId)}::text[], ${marketplaces.map(m => String(m.hasData))}::text[],
                    ${marketplaces.map(m => m.lastUploadAt?.toISOString() ?? null)}::text[], ${marketplaces.map(m => String(m.stale))}::text[])
               AS v(marketplace_id, has_data, last_upload_at, stale)
      ), s AS (
        SELECT m.marketplace_id, ref.reference, m.has_data, m.last_upload_at, m.stale,
               coalesce(c.listed, 0) AS listed, coalesce(c.stock, 0) AS stock,
               coalesce(CASE WHEN ref.reference = 'erp' THEN c.price_erp ELSE c.price_mp END, 0) AS price,
               coalesce(CASE WHEN ref.reference = 'erp' THEN c.not_listed_erp ELSE c.not_listed_mp END, 0) AS not_listed,
               coalesce(CASE WHEN ref.reference = 'erp' THEN c.no_data_erp ELSE c.no_data_mp END, 0) AS no_data,
               coalesce(CASE WHEN ref.reference = 'erp' THEN c.missing_erp ELSE c.missing_mp END, 0) AS missing_from_erp,
               coalesce(CASE WHEN ref.reference = 'erp' THEN c.new_erp ELSE c.new_mp END, 0) AS new_count
        FROM m CROSS JOIN (VALUES ('marketplace'), ('erp')) AS ref(reference) LEFT JOIN c ON c.marketplace_id = m.marketplace_id
      )
      INSERT INTO recon_summaries (id, tenant_id, marketplace_id, reference, listed, stock, price, total, not_listed, no_data, missing_from_erp, new_count,
                                   has_data, last_upload_at, stale, computed_at)
      SELECT gen_random_uuid(), ${this.tenantId}::uuid, s.marketplace_id, s.reference, s.listed, s.stock, s.price, s.stock + s.price,
             s.not_listed, s.no_data, s.missing_from_erp, s.new_count, s.has_data, s.last_upload_at, s.stale, now()
      FROM s
      ON CONFLICT (tenant_id, marketplace_id, reference) DO UPDATE SET
        listed = EXCLUDED.listed, stock = EXCLUDED.stock, price = EXCLUDED.price, total = EXCLUDED.total, not_listed = EXCLUDED.not_listed,
        no_data = EXCLUDED.no_data, missing_from_erp = EXCLUDED.missing_from_erp, new_count = EXCLUDED.new_count, has_data = EXCLUDED.has_data,
        last_upload_at = EXCLUDED.last_upload_at, stale = EXCLUDED.stale, computed_at = EXCLUDED.computed_at`;
  }

  // ── Reads (the dashboard, the reports and the files all read these) ──

  /**
   * The stored summary of every reconciled marketplace for one reference. `stale` is re-judged against the clock on
   * read (the stored flag is as of the last run), from the same stored last_upload_at, so every reader agrees.
   */
  async summaries(reference: ReconReference, now = new Date()) {
    const [rows, settings] = await Promise.all([
      this.tx.reconSummary.findMany({
        where: { tenantId: this.tenantId, reference }, orderBy: { marketplaceId: 'asc' },
        select: {
          marketplaceId: true, hasData: true, stock: true, price: true, total: true, listed: true, notListed: true, noData: true,
          missingFromErp: true, newCount: true, lastUploadAt: true, computedAt: true,
        },
      }),
      this.settings(),
    ]);
    const order = new Map(MARKETPLACES.map((m, i) => [m as string, i]));
    return rows
      .sort((a, b) => (order.get(a.marketplaceId) ?? 99) - (order.get(b.marketplaceId) ?? 99))
      .map(r => ({ ...r, stale: isStale(r.lastUploadAt, settings.staleHours, now) }));
  }

  /**
   * One marketplace's rows, urgent first (core urgency(): available_but_out_of_stock, unavailable_but_in_stock, price,
   * rest), then by product id; keyset pagination on (rank, product id).
   */
  rows(q: ReconRowsQuery) {
    const erp = q.reference === 'erp';
    const priceFlag = erp ? Prisma.sql`r.price_mismatch_vs_erp` : Prisma.sql`r.price_mismatch_vs_marketplace`;
    const status = erp ? Prisma.sql`r.status_vs_erp` : Prisma.sql`r.status`;
    const rank = Prisma.sql`(CASE WHEN r.stock_issue = 'available_but_out_of_stock' THEN 0 WHEN r.stock_issue = 'unavailable_but_in_stock' THEN 1 WHEN ${priceFlag} THEN 2 ELSE 3 END)`;
    const filters = [
      Prisma.sql`r.tenant_id = ${this.tenantId}::uuid`, Prisma.sql`r.marketplace_id = ${q.marketplaceId}`,
      ...(q.type === 'stock' ? [Prisma.sql`r.stock_issue IS NOT NULL`] : q.type === 'price' ? [priceFlag] : []),
      ...(q.status ? [Prisma.sql`${status} = ${q.status}`] : []),
      ...(q.after ? [Prisma.sql`(${rank}, r.product_id) > (${q.after.rank}::int, ${q.after.productId}::uuid)`] : []),
    ];
    return this.tx.$queryRaw<{
      rank: number; product_id: string; barcode: string; sku: string | null; name_en: string; name_ar: string | null; product_status: string; erp_stock: number;
      status: string; stock_issue: string | null; price_mismatch: boolean; price_mismatch_vs_erp: boolean; price_mismatch_vs_marketplace: boolean;
      erp_price: number | null; marketplace_price: number | null; marketplace_price_source: string | null; actual_price: number | null;
      erp_available: boolean | null; actual_available: boolean | null; last_updated: Date;
    }[]>`
      SELECT ${rank} AS rank, r.product_id, p.barcode, p.sku, p.name_en, p.name_ar, p.status AS product_status, p.erp_stock,
             ${status} AS status, r.stock_issue, ${priceFlag} AS price_mismatch, r.price_mismatch_vs_erp, r.price_mismatch_vs_marketplace,
             r.erp_price::float8 AS erp_price, r.marketplace_price::float8 AS marketplace_price, r.marketplace_price_source,
             r.actual_price::float8 AS actual_price, r.erp_available, r.actual_available, r.last_updated
      FROM recon_rows r JOIN products p ON p.tenant_id = r.tenant_id AND p.id = r.product_id
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY ${rank}, r.product_id
      LIMIT ${q.limit}`;
  }
}
