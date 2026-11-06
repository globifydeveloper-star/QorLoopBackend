import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import { ERP_CHANGE_KINDS } from '../../../../packages/core/src/upload/apply.js';
import { STOCK_IN_EFFECT_DURING_CONFLICT, catalogueStock, type StockEditState } from '../../../../packages/core/src/catalogue-stock.js';
import type { StoredReviewSummary } from '../../../../packages/core/src/upload/review.js';
import { canSeeCost } from '../products/products.service.js';
import { view as uploadView } from '../uploads/uploads.service.js';

const edit = (stock: number | null, base: number | null, state: string | null) =>
  stock === null || base === null || state === null ? null : { stock, erpStockAtEdit: base, state: state as StockEditState };

@Injectable()
export class CatalogueStockService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /**
   * What an applied ERP upload changed, row by row (erp_upload_changes), file order, paginated. Cost rows are left out
   * for roles that may not see costs. Price rows say whether a fixed product price still applies (D6); stock rows show
   * the catalogue stock now and whether the change raised a conflict.
   */
  changes(ctx: RequestContext, id: string, query: z.infer<typeof contracts.uploadChangesQuery>) {
    return this.auth.authenticated(ctx, { permission: 'uploads.view' }, async (data, p) => {
      const u = await data.uploads.get(id);
      if (!u) throw new NotFoundException('Upload not found');
      if (u.source !== 'erp') throw new BadRequestException('Only an ERP upload changes the catalogue; marketplace uploads have a review only');
      if (u.status !== 'applied') throw new ConflictException('This upload has not been applied; its proposed changes are under /review');
      const hideCost = !canSeeCost(p.member.role);
      if (hideCost && query.kind === 'cost') throw new BadRequestException({ message: 'Validation failed', details: [{ path: 'kind', message: 'Cost changes are shown only to roles that may change prices' }] });
      const [{ rows, total }, grouped] = await Promise.all([
        data.stock.uploadChanges({
          uploadId: id, kinds: query.kind === 'all' ? null : [query.kind], conflictOnly: query.conflict === true, hideCost,
          skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        }),
        data.stock.uploadChangeCounts(id, hideCost),
      ]);
      const counts: Record<string, number> = { all: 0 };
      for (const k of ERP_CHANGE_KINDS) if (!(hideCost && k === 'cost')) counts[k] = 0;
      let stockConflicts = 0;
      for (const g of grouped) { counts[g.kind] = g.n; counts.all! += g.n; stockConflicts += g.conflicts; }
      const summary = u.summary as StoredReviewSummary | null;
      return {
        upload: uploadView(u),
        /** false: applied before ADR 017, so no change list was recorded (the summary counts still apply) */
        changesRecorded: summary?.applied?.changesRecorded === true,
        kind: query.kind, conflictOnly: query.conflict === true, page: query.page, pageSize: query.pageSize, total,
        counts: { ...counts, stockConflicts },
        rows: rows.map(r => ({
          productId: r.productId, barcode: r.barcode, rowNumber: r.rowNumber, kind: r.kind, field: r.field, old: r.old ?? null, new: r.new ?? null,
          stockConflict: r.stockConflict,
          product: { nameEn: r.nameEn, nameAr: r.nameAr, status: r.status },
          fixedPriceRule: r.kind === 'price' ? r.fixedPriceRule : null,
          catalogueStock: r.kind === 'stock' ? this.stockView(r.erpStock, edit(r.editStock, r.editBase, r.editState)) : null,
        })),
      };
    });
  }

  /** Open stock conflicts, newest first, with both values; the owner's value is the one in effect (D1). */
  conflicts(ctx: RequestContext, query: z.infer<typeof contracts.stockConflictsQuery>) {
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async data => {
      const { rows, total } = await data.stock.conflicts((query.page - 1) * query.pageSize, query.pageSize);
      return {
        inEffect: STOCK_IN_EFFECT_DURING_CONFLICT, page: query.page, pageSize: query.pageSize, total,
        rows: rows.map(e => ({
          productId: e.productId, barcode: e.product.barcode, nameEn: e.product.nameEn, nameAr: e.product.nameAr, status: e.product.status,
          erpStock: e.product.erpStock, ownerStock: e.stock, erpStockAtEdit: e.erpStockAtEdit,
          catalogueStock: catalogueStock(e.product.erpStock, { stock: e.stock, erpStockAtEdit: e.erpStockAtEdit, state: e.state as StockEditState }).stock,
          reason: e.reason, setBy: e.setBy, setAt: e.setAt, conflictUploadId: e.conflictUploadId, conflictAt: e.conflictAt, updatedAt: e.updatedAt,
        })),
      };
    });
  }

  /** The dashboard badge: "N stock conflicts". */
  conflictCount(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'products.view' }, async data => ({ count: await data.stock.conflictCount() }));
  }

  /** The catalogue stock of a product as every response shows it. */
  stockView(erpStock: number, e: { stock: number; erpStockAtEdit: number; state: StockEditState } | null) {
    const c = catalogueStock(erpStock, e);
    return {
      erpStock, catalogueStock: c.stock, source: c.source,
      conflict: e?.state === 'conflict' ? { ownerStock: e.stock, erpStock, erpStockAtEdit: e.erpStockAtEdit, inEffect: STOCK_IN_EFFECT_DURING_CONFLICT } : null,
    };
  }
}
