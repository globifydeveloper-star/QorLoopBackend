import { Prisma } from './generated/client.js';
import type { FileReconRow } from '../../core/src/generated-files.js';
import type { ReconReference } from '../../core/src/recon/status.js';

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
  async reconRows(marketplaceId: string, reference: ReconReference): Promise<FileReconRow[]> {
    const erp = reference === 'erp';
    const available = erp ? Prisma.sql`r.erp_available` : Prisma.sql`r.catalogue_available`;
    const stockIssue = erp ? Prisma.sql`r.stock_issue_vs_erp` : Prisma.sql`r.stock_issue`;
    const rows = await this.tx.$queryRaw<Omit<FileReconRow, 'marketplaceProductId'>[]>`
      SELECT r.product_id AS "productId", p.name_en AS name,
             r.erp_price::float8 AS "erpPrice", r.marketplace_price::float8 AS "marketplacePrice", ${available} AS "available",
             r.actual_price::float8 AS "actualPrice", ${stockIssue} AS "stockIssue", r.status,
             r.price_mismatch_vs_erp AS "priceMismatchVsErp", r.price_mismatch_vs_marketplace AS "priceMismatchVsMarketplace"
      FROM recon_rows r
      JOIN products p ON p.tenant_id = r.tenant_id AND p.id = r.product_id
      WHERE r.tenant_id = ${this.tenantId}::uuid AND r.marketplace_id = ${marketplaceId}`;
    // The same listing winner as ReconRepository.listings: one recon row per product, never multiply by listings.
    const winners = await this.tx.$queryRaw<{ productId: string; marketplaceProductId: string | null }[]>`
      SELECT DISTINCT ON (product_id) product_id AS "productId", marketplace_product_id AS "marketplaceProductId"
      FROM listings
      WHERE tenant_id = ${this.tenantId}::uuid AND marketplace_id = ${marketplaceId} AND product_id IS NOT NULL
      ORDER BY product_id, updated_at DESC, marketplace_product_id`;
    const byProduct = new Map(winners.map(w => [w.productId, w.marketplaceProductId]));
    return rows.map(r => ({ ...r, marketplaceProductId: byProduct.get(r.productId) ?? null }));
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
