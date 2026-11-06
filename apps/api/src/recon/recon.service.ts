import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import type { ReconReference } from '../../../../packages/core/src/recon/status.js';
import { RECON_QUEUE } from '../tokens.js';
import { catalogueStock, type StockEditState } from '../../../../packages/core/src/catalogue-stock.js';

/** Opaque keyset cursor: base64url JSON of the last row's [urgency rank, product id]. */
export function encodeReconCursor(r: { rank: number; productId: string }) {
  return Buffer.from(JSON.stringify([r.rank, r.productId])).toString('base64url');
}
export function decodeReconCursor(cursor: string) {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && v[0] >= 0 && v[0] <= 3 && typeof v[1] === 'string' && z.uuid().safeParse(v[1]).success) {
      return { rank: v[0] as number, productId: v[1] };
    }
  } catch { /* falls through to the 400 */ }
  throw new BadRequestException('Invalid cursor');
}

/** The catalogue stock next to the ERP stock, each with its availability and stock issue. */
function stockColumns(r: {
  erp_stock: number; catalogue_available: boolean | null; stock_issue_vs_marketplace: string | null; stock_issue_vs_erp: string | null;
  edit_stock: number | null; edit_base: number | null; edit_state: string | null;
}) {
  const e = r.edit_stock === null || r.edit_base === null || r.edit_state === null ? null
    : { stock: r.edit_stock, erpStockAtEdit: r.edit_base, state: r.edit_state as StockEditState };
  const c = catalogueStock(r.erp_stock, e);
  return {
    catalogueStock: c.stock, catalogueStockSource: c.source, stockConflict: e?.state === 'conflict',
    catalogueAvailable: r.catalogue_available, stockIssueVsCatalogue: r.stock_issue_vs_marketplace, stockIssueVsErp: r.stock_issue_vs_erp,
  };
}

/** The request's reference, else the tenant's comparison default from the pricing settings. */
async function referenceFor(data: TenantData, requested?: ReconReference): Promise<ReconReference> {
  if (requested) return requested;
  const settings = await data.pricing.settings();
  return settings?.compareReferenceDefault === 'erp' ? 'erp' : 'marketplace';
}

@Injectable()
export class ReconService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /** What the dashboard reads; the reports read the same stored summary rows. */
  summary(ctx: RequestContext, query: z.infer<typeof contracts.reconSummaryQuery>) {
    return this.auth.authenticated(ctx, { permission: 'recon.view' }, async data => {
      const reference = await referenceFor(data, query.reference);
      const [rows, stockConflicts] = await Promise.all([data.recon.summaries(reference), data.stock.conflictCount()]);
      const computedAt = rows.reduce<Date | null>((at, r) => (r.computedAt && (!at || r.computedAt > at) ? r.computedAt : at), null);
      // stockConflicts: the dashboard badge "N stock conflicts" (ADR 017)
      return { reference, computedAt, stockConflicts, marketplaces: rows.map(({ computedAt: _c, ...r }) => r) };
    });
  }

  rows(ctx: RequestContext, query: z.infer<typeof contracts.reconRowsQuery>) {
    const after = query.cursor ? decodeReconCursor(query.cursor) : null;
    return this.auth.authenticated(ctx, { permission: 'recon.view' }, async data => {
      const reference = await referenceFor(data, query.reference);
      const rows = await data.recon.rows({ marketplaceId: query.marketplaceId, reference, type: query.type, status: query.status, after, limit: query.limit + 1 });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        reference,
        items: page.map(r => ({
          productId: r.product_id, barcode: r.barcode, sku: r.sku, nameEn: r.name_en, nameAr: r.name_ar, productStatus: r.product_status, erpStock: r.erp_stock,
          status: r.status, stockIssue: r.stock_issue, priceMismatch: r.price_mismatch,
          priceMismatchVsErp: r.price_mismatch_vs_erp, priceMismatchVsMarketplace: r.price_mismatch_vs_marketplace,
          expectedPrice: reference === 'erp' ? r.erp_price : r.marketplace_price,
          erpPrice: r.erp_price, marketplacePrice: r.marketplace_price, marketplacePriceSource: r.marketplace_price_source, actualPrice: r.actual_price,
          erpAvailable: r.erp_available, actualAvailable: r.actual_available, lastUpdated: r.last_updated,
          // ADR 017: both references side by side; stockIssue above is the requested reference's
          ...stockColumns(r),
        })),
        nextCursor: rows.length > query.limit && last ? encodeReconCursor({ rank: last.rank, productId: last.product_id }) : null,
      };
    });
  }

  /** A manual run, for when the data changed outside the usual triggers; coalesced with any run already waiting. */
  async recompute(ctx: RequestContext) {
    await this.auth.authenticated(ctx, { permission: 'pricing.edit', mutation: true }, async (data, p) => {
      await data.event('recon.recompute_requested', p.user.id, null, ctx.requestId);
    });
    await this.recon.enqueueRecon(ctx.tenantId, 'manual');
    return { queued: true };
  }
}
