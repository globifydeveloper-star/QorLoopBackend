import type { Prisma } from './generated/client.js';
import type { ListingWrite, NewProduct, ProductWrite } from '../../core/src/upload/apply.js';

type Tx = Prisma.TransactionClient;

export type UploadStatusName =
  | 'uploading' | 'uploaded' | 'processing' | 'needs_mapping' | 'needs_review'
  | 'applying' | 'applied' | 'rejected' | 'failed' | 'discarded';

const listSelect = {
  id: true, source: true, fileName: true, size: true, contains: true, status: true, step: true, progress: true,
  summary: true, errorMessage: true, uploadedById: true, createdAt: true, updatedAt: true, appliedAt: true,
} satisfies Prisma.UploadSelect;

/** Every method adds tenant_id; callers never pass a tenant. Built on the same transaction as the request. */
export class UploadRepository {
  constructor(private readonly tenantId: string, private readonly tx: Tx) {}

  create(data: Omit<Prisma.UploadUncheckedCreateInput, 'tenantId'>) {
    return this.tx.upload.create({ data: { ...data, tenantId: this.tenantId } });
  }
  get(id: string) { return this.tx.upload.findFirst({ where: { tenantId: this.tenantId, id } }); }
  list(take = 50) {
    return this.tx.upload.findMany({ where: { tenantId: this.tenantId }, orderBy: { createdAt: 'desc' }, take, select: listSelect });
  }
  /** Compare-and-set a status transition; returns false when someone else moved it first. */
  async transition(id: string, from: UploadStatusName[], data: Prisma.UploadUpdateManyMutationInput & { revision?: { increment: number } }) {
    const r = await this.tx.upload.updateMany({ where: { tenantId: this.tenantId, id, status: { in: from } }, data });
    return r.count === 1;
  }
  update(id: string, data: Prisma.UploadUpdateManyMutationInput) {
    return this.tx.upload.updateMany({ where: { tenantId: this.tenantId, id }, data });
  }
  progress(id: string, step: string, progress: number) {
    return this.tx.upload.updateMany({ where: { tenantId: this.tenantId, id, status: 'processing' }, data: { step, progress } });
  }

  /** Mappings the tenant saved plus the built-in ones (tenant_id IS NULL), which are shared reference data. */
  mappingsFor(source: string) {
    return this.tx.inputTemplate.findMany({
      where: { source, OR: [{ tenantId: this.tenantId }, { tenantId: null }] },
      orderBy: [{ version: 'desc' }],
    });
  }
  allMappings() {
    return this.tx.inputTemplate.findMany({ where: { OR: [{ tenantId: this.tenantId }, { tenantId: null }] } });
  }
  async saveMapping(source: string, name: string, fields: Record<string, string>, signature: string[]) {
    const prior = await this.tx.inputTemplate.findFirst({ where: { tenantId: this.tenantId, source, name }, orderBy: { version: 'desc' } });
    return this.tx.inputTemplate.create({ data: { tenantId: this.tenantId, source, name, version: (prior?.version ?? 0) + 1, fields, signature } });
  }

  /** Replaces the staging rows and errors of one upload in bulk (50k rows). */
  async replaceReview(
    uploadId: string,
    rows: { rowNumber: number; parsed: Prisma.InputJsonValue; matchProductId: string | null; changeType: string }[],
    errors: { row: number; column: string | null; value: string | null; reason: string }[],
  ) {
    await this.tx.uploadRow.deleteMany({ where: { tenantId: this.tenantId, uploadId } });
    await this.tx.uploadError.deleteMany({ where: { tenantId: this.tenantId, uploadId } });
    for (let i = 0; i < rows.length; i += 2000) {
      await this.tx.uploadRow.createMany({ data: rows.slice(i, i + 2000).map(r => ({ ...r, tenantId: this.tenantId, uploadId })) });
    }
    for (let i = 0; i < errors.length; i += 2000) {
      await this.tx.uploadError.createMany({ data: errors.slice(i, i + 2000).map(e => ({ ...e, tenantId: this.tenantId, uploadId })) });
    }
  }
  clearStaging(uploadId: string) {
    return Promise.all([
      this.tx.uploadRow.deleteMany({ where: { tenantId: this.tenantId, uploadId } }),
      this.tx.uploadError.deleteMany({ where: { tenantId: this.tenantId, uploadId } }),
    ]);
  }

  rows(uploadId: string, changeTypes: string[] | undefined, skip: number, take: number) {
    const where: Prisma.UploadRowWhereInput = { tenantId: this.tenantId, uploadId, ...(changeTypes ? { changeType: { in: changeTypes } } : {}) };
    return Promise.all([
      this.tx.uploadRow.findMany({ where, orderBy: { rowNumber: 'asc' }, skip, take, select: { rowNumber: true, changeType: true, matchProductId: true, parsed: true } }),
      this.tx.uploadRow.count({ where }),
    ]);
  }
  errors(uploadId: string, skip = 0, take = 200) {
    const where = { tenantId: this.tenantId, uploadId };
    return Promise.all([
      this.tx.uploadError.findMany({ where, orderBy: { row: 'asc' }, skip, take, select: { row: true, column: true, value: true, reason: true } }),
      this.tx.uploadError.count({ where }),
    ]);
  }

  /** Catalogue snapshots for matching a file against the tenant's data. */
  productSnapshot() {
    return this.tx.product.findMany({
      where: { tenantId: this.tenantId },
      select: { id: true, normalizedBarcode: true, sku: true, nameEn: true, erpPrice: true, erpStock: true, inLatestErpFile: true },
    });
  }
  listingSnapshot(marketplaceId: string) {
    return this.tx.listing.findMany({
      where: { tenantId: this.tenantId, marketplaceId },
      select: { productId: true, marketplaceProductId: true, price: true, available: true },
    });
  }
  /** Uploads that were queued but never finished, for the worker's recovery sweep. */
  stuck(olderThan: Date) {
    return this.tx.upload.findMany({
      where: { tenantId: this.tenantId, status: { in: ['processing', 'applying'] }, updatedAt: { lt: olderThan } },
      select: { id: true, revision: true, status: true },
    });
  }

  // ── Apply (docs 5.6). Bulk statements only: the whole apply runs in one transaction under the tenant lock. ──

  stagedRows(uploadId: string) {
    return this.tx.uploadRow.findMany({
      where: { tenantId: this.tenantId, uploadId }, orderBy: { rowNumber: 'asc' },
      select: { parsed: true, matchProductId: true, changeType: true },
    });
  }
  /** Who confirmed the apply; the job payload carries no user. */
  async applyRequestedBy(uploadId: string) {
    const e = await this.tx.auditEvent.findFirst({
      where: { tenantId: this.tenantId, action: 'upload.apply_requested', entityId: uploadId },
      orderBy: { createdAt: 'desc' }, select: { actorId: true },
    });
    return e?.actorId ?? null;
  }
  applySnapshot() {
    return this.tx.product.findMany({
      where: { tenantId: this.tenantId },
      select: {
        id: true, normalizedBarcode: true, sku: true, nameEn: true, nameAr: true, brand: true, erpCategory: true,
        erpPrice: true, costPrice: true, erpStock: true, erpActive: true, inLatestErpFile: true,
      },
    });
  }
  /**
   * One INSERT ... SELECT FROM unnest(...) per 5,000 products: one bind parameter per column, not per value.
   * Timestamps are cut to milliseconds (here and below) so the updatedAt a client reads back as a JS Date matches the row.
   */
  async createProducts(rows: NewProduct[]) {
    for (let i = 0; i < rows.length; i += 5000) {
      const c = rows.slice(i, i + 5000);
      const text = (n: number | null) => (n === null ? null : String(n));
      await this.tx.$executeRaw`
        INSERT INTO products (id, tenant_id, barcode, normalized_barcode, sku, name_en, name_ar, brand, erp_category,
                              erp_price, cost_price, erp_stock, erp_active, in_latest_erp_file, status, created_at, updated_at)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, v.barcode, v.barcode, v.sku, v.name_en, v.name_ar, v.brand, v.erp_category,
               v.erp_price::numeric, v.cost_price::numeric, v.erp_stock::int, v.erp_active::boolean, true, v.status, date_trunc('milliseconds', now()), date_trunc('milliseconds', now())
        FROM unnest(
          ${c.map(r => r.normalizedBarcode)}::text[], ${c.map(r => r.sku)}::text[], ${c.map(r => r.nameEn)}::text[], ${c.map(r => r.nameAr)}::text[],
          ${c.map(r => r.brand)}::text[], ${c.map(r => r.erpCategory)}::text[], ${c.map(r => text(r.erpPrice))}::text[],
          ${c.map(r => text(r.costPrice))}::text[], ${c.map(r => String(r.erpStock))}::text[], ${c.map(r => String(r.erpActive))}::text[],
          ${c.map(r => r.status)}::text[]
        ) AS v(barcode, sku, name_en, name_ar, brand, erp_category, erp_price, cost_price, erp_stock, erp_active, status)`;
    }
  }
  /** One UPDATE ... FROM unnest(...) per 5,000 products; sets every ERP-owned field to an absolute value. */
  async updateProducts(rows: ProductWrite[]) {
    for (let i = 0; i < rows.length; i += 5000) {
      const c = rows.slice(i, i + 5000);
      const text = (n: number | null) => (n === null ? null : String(n));
      await this.tx.$executeRaw`
        UPDATE products AS p SET
          sku = v.sku, name_en = v.name_en, name_ar = v.name_ar, brand = v.brand, erp_category = v.erp_category,
          erp_price = v.erp_price::numeric, cost_price = v.cost_price::numeric, erp_stock = v.erp_stock::int,
          erp_active = v.erp_active::boolean, in_latest_erp_file = v.in_latest::boolean, updated_at = date_trunc('milliseconds', now())
        FROM unnest(
          ${c.map(r => r.id)}::uuid[], ${c.map(r => r.sku)}::text[], ${c.map(r => r.nameEn)}::text[], ${c.map(r => r.nameAr)}::text[],
          ${c.map(r => r.brand)}::text[], ${c.map(r => r.erpCategory)}::text[], ${c.map(r => text(r.erpPrice))}::text[],
          ${c.map(r => text(r.costPrice))}::text[], ${c.map(r => String(r.erpStock))}::text[], ${c.map(r => String(r.erpActive))}::text[],
          ${c.map(r => String(r.inLatestErpFile))}::text[]
        ) AS v(id, sku, name_en, name_ar, brand, erp_category, erp_price, cost_price, erp_stock, erp_active, in_latest)
        WHERE p.tenant_id = ${this.tenantId}::uuid AND p.id = v.id`;
    }
  }
  /** Full ERP list: products not in the file are flagged (never deactivated). Returns the flagged ids. */
  async flagMissingProducts(barcodes: string[]) {
    const rows = await this.tx.$queryRaw<{ id: string }[]>`
      UPDATE products SET in_latest_erp_file = false, updated_at = date_trunc('milliseconds', now())
      WHERE tenant_id = ${this.tenantId}::uuid AND in_latest_erp_file AND NOT (normalized_barcode = ANY(${barcodes}::text[]))
      RETURNING id`;
    return rows.map(r => r.id);
  }
  /** Insert-or-update by (tenant, marketplace, marketplace product ID), 5,000 rows per statement. */
  async upsertListings(marketplaceId: string, uploadId: string, rows: ListingWrite[]) {
    for (let i = 0; i < rows.length; i += 5000) {
      const c = rows.slice(i, i + 5000);
      await this.tx.$executeRaw`
        INSERT INTO listings (id, tenant_id, marketplace_id, marketplace_product_id, product_id, barcodes, name, price, available, upload_id, created_at, updated_at)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, ${marketplaceId}, v.mpid, v.product_id,
               ARRAY(SELECT jsonb_array_elements_text(v.barcodes::jsonb)), v.name, v.price::numeric, v.available::boolean, ${uploadId}::uuid, date_trunc('milliseconds', now()), date_trunc('milliseconds', now())
        FROM unnest(
          ${c.map(r => r.marketplaceProductId)}::text[], ${c.map(r => r.productId)}::uuid[], ${c.map(r => JSON.stringify(r.barcodes))}::text[],
          ${c.map(r => r.name)}::text[], ${c.map(r => String(r.price))}::text[], ${c.map(r => String(r.available))}::text[]
        ) AS v(mpid, product_id, barcodes, name, price, available)
        ON CONFLICT (tenant_id, marketplace_id, marketplace_product_id) DO UPDATE SET
          product_id = EXCLUDED.product_id, barcodes = EXCLUDED.barcodes, name = EXCLUDED.name, price = EXCLUDED.price,
          available = EXCLUDED.available, upload_id = EXCLUDED.upload_id, updated_at = date_trunc('milliseconds', now())`;
    }
  }
  /** Full marketplace list: this marketplace's listings that are not in the file are removed. */
  removeListingsNotIn(marketplaceId: string, marketplaceProductIds: string[]) {
    return this.tx.$executeRaw`
      DELETE FROM listings
      WHERE tenant_id = ${this.tenantId}::uuid AND marketplace_id = ${marketplaceId}
        AND NOT (marketplace_product_id = ANY(${marketplaceProductIds}::text[]))`;
  }
  /** One INSERT ... SELECT FROM unnest(...) per 5,000 events (an apply can write one per changed field). */
  async auditEvents(actorId: string | null, events: { action: string; entityId: string; details: Prisma.InputJsonObject }[]) {
    for (let i = 0; i < events.length; i += 5000) {
      const c = events.slice(i, i + 5000);
      await this.tx.$executeRaw`
        INSERT INTO audit_events (id, tenant_id, actor_id, action, entity_id, details, created_at)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, ${actorId}::uuid, v.action, v.entity_id, v.details::jsonb, now()
        FROM unnest(${c.map(e => e.action)}::text[], ${c.map(e => e.entityId)}::uuid[], ${c.map(e => JSON.stringify(e.details))}::text[])
          AS v(action, entity_id, details)`;
    }
  }
}
