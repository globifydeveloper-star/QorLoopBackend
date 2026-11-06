import { Prisma } from './generated/client.js';
import type { StockEdit, StockEditState } from '../../core/src/catalogue-stock.js';
import type { ErpChangeKind, FieldValue } from '../../core/src/upload/apply.js';

type Tx = Prisma.TransactionClient;

/** Rows per INSERT ... SELECT FROM unnest(...) of change rows: one bind parameter per column, not per value. */
export const ERP_CHANGE_WRITE_BATCH = 5_000;
/** Bind parameters of one change-row write: tenant + upload + one array per column (see writeErpChanges). */
export const ERP_CHANGE_COLUMNS = 10;

export interface ErpChangeWrite {
  productId: string; rowNumber: number | null; barcode: string; kind: ErpChangeKind; field: string | null;
  old: FieldValue | undefined; new: FieldValue | undefined; stockConflict: boolean;
}

export interface StockEditRow extends StockEdit {
  productId: string; reason: string | null; setAt: Date; updatedAt: Date; conflictUploadId: string | null; conflictAt: Date | null;
  setBy: { id: string; name: string };
}

/** Every write cuts timestamps to milliseconds: a client reading one back as a JS Date must compare equal. */
const MS_NOW = Prisma.sql`date_trunc('milliseconds', now())`;
const json = (v: FieldValue | undefined) => (v === undefined ? null : JSON.stringify(v));

/** Catalogue stock edits, their conflicts, and the per-upload ERP change list (ADR 017). Every method adds tenant_id. */
export class CatalogueStockRepository {
  constructor(private readonly tenantId: string, private readonly tx: Tx) {}

  // ── Edits ──

  private readonly editSelect = {
    productId: true, stock: true, erpStockAtEdit: true, state: true, reason: true, setAt: true, updatedAt: true,
    conflictUploadId: true, conflictAt: true, setBy: { select: { id: true, name: true } },
  } satisfies Prisma.CatalogueStockEditSelect;

  private asRow(e: Prisma.CatalogueStockEditGetPayload<{ select: CatalogueStockRepository['editSelect'] }>): StockEditRow {
    return { ...e, state: e.state as StockEditState };
  }
  async edit(productId: string): Promise<StockEditRow | null> {
    const e = await this.tx.catalogueStockEdit.findFirst({ where: { tenantId: this.tenantId, productId }, select: this.editSelect });
    return e ? this.asRow(e) : null;
  }
  /** The edits of the given products (absent = no edit), one statement. */
  async edits(productIds: string[]): Promise<Map<string, StockEditRow>> {
    if (!productIds.length) return new Map();
    const rows = await this.tx.catalogueStockEdit.findMany({ where: { tenantId: this.tenantId, productId: { in: productIds } }, select: this.editSelect });
    return new Map(rows.map(e => [e.productId, this.asRow(e)]));
  }
  /** Every edit as the planners need it; the review and the recon read all of them (few rows). */
  async allEdits(): Promise<Map<string, StockEdit>> {
    const rows = await this.tx.catalogueStockEdit.findMany({ where: { tenantId: this.tenantId }, select: { productId: true, stock: true, erpStockAtEdit: true, state: true } });
    return new Map(rows.map(e => [e.productId, { stock: e.stock, erpStockAtEdit: e.erpStockAtEdit, state: e.state as StockEditState }]));
  }

  /** Writes owner values: an active edit based on the given ERP stock, replacing any edit (and closing its conflict). */
  async setEdits(setById: string, reason: string | null, rows: { productId: string; stock: number; erpStock: number }[]) {
    for (let i = 0; i < rows.length; i += ERP_CHANGE_WRITE_BATCH) {
      const c = rows.slice(i, i + ERP_CHANGE_WRITE_BATCH);
      await this.tx.$executeRaw`
        INSERT INTO catalogue_stock_edits (id, tenant_id, product_id, stock, erp_stock_at_edit, state, conflict_upload_id, conflict_at, reason, set_by_id, set_at, created_at, updated_at)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, v.product_id, v.stock::int, v.erp::int, 'active', NULL, NULL, ${reason}, ${setById}::uuid, ${MS_NOW}, now(), ${MS_NOW}
        FROM unnest(${c.map(r => r.productId)}::uuid[], ${c.map(r => String(r.stock))}::text[], ${c.map(r => String(r.erpStock))}::text[]) AS v(product_id, stock, erp)
        ON CONFLICT (tenant_id, product_id) DO UPDATE SET
          stock = EXCLUDED.stock, erp_stock_at_edit = EXCLUDED.erp_stock_at_edit, state = 'active', conflict_upload_id = NULL, conflict_at = NULL,
          reason = EXCLUDED.reason, set_by_id = EXCLUDED.set_by_id, set_at = EXCLUDED.set_at, updated_at = EXCLUDED.updated_at`;
    }
  }
  /** Removes edits: the catalogue follows the ERP stock again. */
  async deleteEdits(productIds: string[]) {
    if (!productIds.length) return 0;
    return this.tx.catalogueStockEdit.deleteMany({ where: { tenantId: this.tenantId, productId: { in: productIds } } }).then(r => r.count);
  }
  /** "Keep mine": the owner's value stays and is re-based on the current ERP stock; the conflict closes. */
  async keepEdits(rows: { productId: string; erpStock: number }[]) {
    for (let i = 0; i < rows.length; i += ERP_CHANGE_WRITE_BATCH) {
      const c = rows.slice(i, i + ERP_CHANGE_WRITE_BATCH);
      await this.tx.$executeRaw`
        UPDATE catalogue_stock_edits AS e SET erp_stock_at_edit = v.erp::int, state = 'active', conflict_upload_id = NULL, conflict_at = NULL, updated_at = ${MS_NOW}
        FROM unnest(${c.map(r => r.productId)}::uuid[], ${c.map(r => String(r.erpStock))}::text[]) AS v(product_id, erp)
        WHERE e.tenant_id = ${this.tenantId}::uuid AND e.product_id = v.product_id`;
    }
  }

  // ── ERP apply ──

  /** Opens (or refreshes) conflicts raised by this upload, and closes those whose ERP stock went back to the edit base. */
  async markErpConflicts(uploadId: string, conflicts: string[], reverted: string[]) {
    if (conflicts.length) {
      await this.tx.$executeRaw`
        UPDATE catalogue_stock_edits SET state = 'conflict', conflict_upload_id = ${uploadId}::uuid, conflict_at = ${MS_NOW}, updated_at = ${MS_NOW}
        WHERE tenant_id = ${this.tenantId}::uuid AND product_id = ANY(${conflicts}::uuid[])`;
    }
    if (reverted.length) {
      await this.tx.$executeRaw`
        UPDATE catalogue_stock_edits SET state = 'active', conflict_upload_id = NULL, conflict_at = NULL, updated_at = ${MS_NOW}
        WHERE tenant_id = ${this.tenantId}::uuid AND product_id = ANY(${reverted}::uuid[])`;
    }
  }
  /** One INSERT ... SELECT FROM unnest(...) per 5,000 change rows. */
  async writeErpChanges(uploadId: string, rows: ErpChangeWrite[]) {
    for (let i = 0; i < rows.length; i += ERP_CHANGE_WRITE_BATCH) {
      const c = rows.slice(i, i + ERP_CHANGE_WRITE_BATCH);
      await this.tx.$executeRaw`
        INSERT INTO erp_upload_changes (id, tenant_id, upload_id, product_id, row_number, barcode, kind, field, old_value, new_value, stock_conflict, created_at)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, ${uploadId}::uuid, v.product_id, v.row_number::int, v.barcode, v.kind, v.field,
               v.old_value::jsonb, v.new_value::jsonb, v.stock_conflict::boolean, now()
        FROM unnest(
          ${c.map(r => r.productId)}::uuid[], ${c.map(r => (r.rowNumber === null ? null : String(r.rowNumber)))}::text[], ${c.map(r => r.barcode)}::text[],
          ${c.map(r => r.kind)}::text[], ${c.map(r => r.field)}::text[], ${c.map(r => json(r.old))}::text[], ${c.map(r => json(r.new))}::text[],
          ${c.map(r => String(r.stockConflict))}::text[]
        ) AS v(product_id, row_number, barcode, kind, field, old_value, new_value, stock_conflict)`;
    }
  }

  // ── Reads ──

  /** One applied upload's change rows, file order (missing products last), optionally of some kinds / conflicts only. */
  async uploadChanges(q: { uploadId: string; kinds: readonly string[] | null; conflictOnly: boolean; hideCost: boolean; skip: number; take: number }) {
    const filters = [
      Prisma.sql`c.tenant_id = ${this.tenantId}::uuid`, Prisma.sql`c.upload_id = ${q.uploadId}::uuid`,
      ...(q.kinds ? [Prisma.sql`c.kind = ANY(${[...q.kinds]}::text[])`] : []),
      ...(q.conflictOnly ? [Prisma.sql`c.stock_conflict`] : []),
      ...(q.hideCost ? [Prisma.sql`c.kind <> 'cost'`] : []),
    ];
    const where = Prisma.join(filters, ' AND ');
    const [rows, [total]] = await Promise.all([
      this.tx.$queryRaw<{
        productId: string; rowNumber: number | null; barcode: string; kind: string; field: string | null; old: unknown; new: unknown; stockConflict: boolean;
        nameEn: string; nameAr: string | null; status: string; erpStock: number; fixedPriceRule: boolean;
        editStock: number | null; editBase: number | null; editState: string | null;
      }[]>`
        SELECT c.product_id AS "productId", c.row_number AS "rowNumber", c.barcode, c.kind, c.field, c.old_value AS old, c.new_value AS new,
               c.stock_conflict AS "stockConflict", p.name_en AS "nameEn", p.name_ar AS "nameAr", p.status, p.erp_stock AS "erpStock",
               (r.mode = 'fixed') IS TRUE AS "fixedPriceRule",
               e.stock AS "editStock", e.erp_stock_at_edit AS "editBase", e.state AS "editState"
        FROM erp_upload_changes c
        JOIN products p ON p.tenant_id = c.tenant_id AND p.id = c.product_id
        LEFT JOIN product_price_rules r ON r.tenant_id = c.tenant_id AND r.product_id = c.product_id
        LEFT JOIN catalogue_stock_edits e ON e.tenant_id = c.tenant_id AND e.product_id = c.product_id
        WHERE ${where}
        ORDER BY c.row_number ASC NULLS LAST, c.kind, c.id
        OFFSET ${q.skip} LIMIT ${q.take}`,
      this.tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM erp_upload_changes c WHERE ${where}`,
    ]);
    return { rows, total: total?.n ?? 0 };
  }
  /** Change rows per kind, and the stock conflicts, of one upload. */
  async uploadChangeCounts(uploadId: string, hideCost: boolean) {
    const rows = await this.tx.$queryRaw<{ kind: string; n: number; conflicts: number }[]>`
      SELECT kind, count(*)::int AS n, (count(*) FILTER (WHERE stock_conflict))::int AS conflicts
      FROM erp_upload_changes WHERE tenant_id = ${this.tenantId}::uuid AND upload_id = ${uploadId}::uuid
      ${hideCost ? Prisma.sql`AND kind <> 'cost'` : Prisma.empty}
      GROUP BY kind`;
    return rows;
  }

  /** Open conflicts, newest first (partial index catalogue_stock_edits_conflicts_idx). */
  async conflicts(skip: number, take: number) {
    const where = { tenantId: this.tenantId, state: 'conflict' };
    const [rows, total] = await Promise.all([
      this.tx.catalogueStockEdit.findMany({
        where, orderBy: [{ conflictAt: 'desc' }, { productId: 'asc' }], skip, take,
        select: { ...this.editSelect, product: { select: { barcode: true, nameEn: true, nameAr: true, status: true, erpStock: true } } },
      }),
      this.tx.catalogueStockEdit.count({ where }),
    ]);
    return { rows, total };
  }
  conflictCount() { return this.tx.catalogueStockEdit.count({ where: { tenantId: this.tenantId, state: 'conflict' } }); }
  /** Every open conflict's product, oldest-first by product id, at most `take` (bulk "all conflicts"). */
  async conflictProductIds(take: number) {
    const rows = await this.tx.catalogueStockEdit.findMany({ where: { tenantId: this.tenantId, state: 'conflict' }, orderBy: { productId: 'asc' }, take, select: { productId: true } });
    return rows.map(r => r.productId);
  }

  /** An idempotent operation recorded with this key since `since` (its single audit event). */
  operation(action: string, idempotencyKey: string, since: Date) {
    return this.tx.auditEvent.findFirst({
      where: { tenantId: this.tenantId, action, createdAt: { gte: since }, details: { path: ['idempotencyKey'], equals: idempotencyKey } },
      orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, details: true },
    });
  }
}
