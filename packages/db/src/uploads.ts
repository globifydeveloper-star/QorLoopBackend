import type { Prisma } from './generated/client.js';

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
      where: { tenantId: this.tenantId, status: 'processing', updatedAt: { lt: olderThan } },
      select: { id: true, revision: true },
    });
  }
}
