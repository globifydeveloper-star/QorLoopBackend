import { Prisma } from './generated/client.js';
import type { FileReconRow } from '../../core/src/generated-files.js';
import type { ReconReference } from '../../core/src/recon/status.js';
import { reviewRow } from '../../core/src/marketplace-values.js';
import { OVERRIDE_COLUMNS, storedOverride, type OverrideColumns } from './marketplace-values.js';

/**
 * The export fields of a file row (migration 202611100001, owner decision C): a pending export value in effect (waiting
 * for export, or pinned and shown) is written in every file whatever the reference; otherwise the reference's own value
 * (catalogue for marketplace, ERP for erp), exactly as before. Blocked values fall back the same way. Field states come
 * from core reviewRow, as on the Review screen.
 */
function exportFields(r: ExportInputs, reference: ReconReference, priceTolerance: number): Partial<FileReconRow> {
  const override = storedOverride(r);
  if (!override) return { listingUploadId: r.listing_upload_id };
  const review = reviewRow({
    product: { status: r.product_status, erpActive: r.erp_active, inLatestErpFile: r.in_latest_erp_file },
    marketplaceEnabled: true, // recon rows exist only for enabled marketplaces
    reconStatus: r.status, catalogue: { available: r.catalogue_available, price: r.marketplacePrice },
    catalogueDiffers: { availability: r.stock_issue_catalogue !== null, price: r.priceMismatchVsMarketplace },
    current: r.actualPrice !== null ? { available: r.actual_available ?? false, price: r.actualPrice } : null,
    priceTolerance, override,
  });
  const a = review.fields.availability.state, p = review.fields.price.state;
  const overridesAvailability = a === 'waiting_for_export' || a === 'pinned';
  const overridesPrice = p === 'waiting_for_export' || p === 'pinned';
  return {
    exportAvailable: overridesAvailability ? override.availability!.value : r.available,
    exportPrice: overridesPrice ? override.price!.value : reference === 'erp' ? r.erpPrice : r.marketplacePrice,
    overridesAvailability, overridesPrice,
    pendingAvailability: a === 'waiting_for_export', pendingPrice: p === 'waiting_for_export',
    blockedExport: a === 'blocked' || p === 'blocked', listingUploadId: r.listing_upload_id,
  };
}
type ExportInputs = Omit<FileReconRow, 'marketplaceProductId'> & OverrideColumns & {
  product_status: string; erp_active: boolean; in_latest_erp_file: boolean; catalogue_available: boolean | null;
  stock_issue_catalogue: string | null; actual_available: boolean | null; listing_upload_id: string | null;
};

/** Every read and write is scoped here, including listing joins and downloads. */
export class GeneratedFilesRepository {
  constructor(private readonly tenantId: string, private readonly tx: Prisma.TransactionClient) {}

  latestApplied(marketplaceId: string) {
    return this.tx.upload.findFirst({
      where: { tenantId: this.tenantId, source: marketplaceId, status: 'applied' },
      orderBy: [{ appliedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, storageKey: true, fileName: true, mapping: true, headers: true, sheetName: true, source: true, createdAt: true, appliedAt: true, templateId: true },
    });
  }
  /**
   * Two set-based reads joined here, like ReconRepository.listings. A per-row LATERAL listing lookup is planned as a
   * listings scan per recon row when statistics are missing (just after a bulk load): 230 s at 25,000 rows.
   */
  /**
   * Availability and stock issue are those of `reference` (ADR 017): the catalogue reference (marketplace) writes what
   * the catalogue stock says, the ERP reference what the ERP stock says.
   */
  async reconRows(marketplaceId: string, reference: ReconReference, priceTolerance = 0): Promise<FileReconRow[]> {
    const erp = reference === 'erp';
    const available = erp ? Prisma.sql`r.erp_available` : Prisma.sql`r.catalogue_available`;
    const stockIssue = erp ? Prisma.sql`r.stock_issue_vs_erp` : Prisma.sql`r.stock_issue`;
    const rows = await this.tx.$queryRaw<ExportInputs[]>`
      SELECT r.product_id AS "productId", p.name_en AS name,
             r.erp_price::float8 AS "erpPrice", r.marketplace_price::float8 AS "marketplacePrice", ${available} AS "available",
             r.actual_price::float8 AS "actualPrice", ${stockIssue} AS "stockIssue", r.status,
             r.price_mismatch_vs_erp AS "priceMismatchVsErp", r.price_mismatch_vs_marketplace AS "priceMismatchVsMarketplace",
             p.status AS product_status, p.erp_active, p.in_latest_erp_file, r.catalogue_available, r.stock_issue AS stock_issue_catalogue,
             r.actual_available, ${OVERRIDE_COLUMNS}
      FROM recon_rows r
      JOIN products p ON p.tenant_id = r.tenant_id AND p.id = r.product_id
      LEFT JOIN marketplace_value_overrides o ON o.tenant_id = r.tenant_id AND o.product_id = r.product_id AND o.marketplace_id = r.marketplace_id
      WHERE r.tenant_id = ${this.tenantId}::uuid AND r.marketplace_id = ${marketplaceId}`;
    // The same listing winner as ReconRepository.listings: one recon row per product, never multiply by listings.
    const winners = await this.tx.$queryRaw<{ productId: string; marketplaceProductId: string | null; uploadId: string | null }[]>`
      SELECT DISTINCT ON (product_id) product_id AS "productId", marketplace_product_id AS "marketplaceProductId", upload_id AS "uploadId"
      FROM listings
      WHERE tenant_id = ${this.tenantId}::uuid AND marketplace_id = ${marketplaceId} AND product_id IS NOT NULL
      ORDER BY product_id, updated_at DESC, marketplace_product_id`;
    const byProduct = new Map(winners.map(w => [w.productId, w]));
    return rows.map(r => {
      const w = byProduct.get(r.productId);
      const base: FileReconRow = {
        productId: r.productId, name: r.name, marketplaceProductId: w?.marketplaceProductId ?? null, erpPrice: r.erpPrice, marketplacePrice: r.marketplacePrice,
        available: r.available, actualPrice: r.actualPrice, stockIssue: r.stockIssue, status: r.status,
        priceMismatchVsErp: r.priceMismatchVsErp, priceMismatchVsMarketplace: r.priceMismatchVsMarketplace,
      };
      return { ...base, ...exportFields({ ...r, listing_upload_id: w?.uploadId ?? null }, reference, priceTolerance) };
    });
  }
  get(id: string) { return this.tx.generatedFile.findFirst({ where: { tenantId: this.tenantId, id } }); }
  create(data: Omit<Prisma.GeneratedFileUncheckedCreateInput, 'tenantId'>) {
    return this.tx.generatedFile.create({ data: { ...data, tenantId: this.tenantId } });
  }
  history(now: Date) {
    return this.tx.generatedFile.findMany({
      where: { tenantId: this.tenantId, generatedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) }, expiresAt: { gt: now } },
      orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true, marketplaceId: true, kind: true, scope: true, reference: true, fileName: true, productCount: true,
        generatedAt: true, generatedBy: { select: { name: true } }, expiresAt: true,
      },
    });
  }
}
