import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { Prisma } from '../../../../packages/db/src/generated/client.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import { bulkOfferTotals } from '../../../../packages/core/src/bulk-offers.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { RECON_QUEUE } from '../tokens.js';
import { BULK_IDEMPOTENCY_WINDOW_MS, BULK_TIMEOUT_MS } from './bulk-pricing.service.js';
import { OFFER_CHANGE_COLUMNS, offerChangeEntry, offerPreviewToken, offerRequestHash, offersPreview, planOffers } from './bulk-offers.js';

type ApplyInput = z.infer<typeof contracts.bulkOfferApply>;
export const OFFERS_BULK_SET = 'pricing.offers_bulk_set';

/** The result an apply returns, and stores in its audit event so a replay returns it again. */
type ApplyResult = {
  totals: ReturnType<typeof bulkOfferTotals>;
  created: number;
  replaced: number;
  rejected: { index: number; productId: string; reason: string; message: string }[];
};

@Injectable()
export class BulkOffersService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /** What the bulk offer would do now, row by row; writes nothing. */
  preview(ctx: RequestContext, input: z.infer<typeof contracts.bulkOfferPreview>) {
    return this.auth.authenticated(ctx, { permission: 'pricing.bulk', mutation: true }, async data => offersPreview(await planOffers(data, input)));
  }

  /**
   * One transaction under the tenant row lock: the idempotency key first (a double click waits on the lock and then
   * sees the first request's event), then a fresh plan checked against the preview token, then the valid rows only
   * (one DELETE and one INSERT for all of them) and ONE 'pricing.offers_bulk_set' event with every write (old and new
   * offer). Rejected rows are reported, never written. After commit, one coalesced recompute when anything was set.
   */
  async apply(ctx: RequestContext, body: ApplyInput) {
    const { idempotencyKey, previewToken: expectedToken, ...input } = body;
    const hash = offerRequestHash(input);
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'pricing.bulk', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const prior = await data.pricing.bulkOperation(OFFERS_BULK_SET, idempotencyKey, new Date(Date.now() - BULK_IDEMPOTENCY_WINDOW_MS));
      if (prior) {
        const details = prior.details as { requestHash?: string; result?: ApplyResult } | null;
        if (details?.requestHash !== hash) throw new ConflictException('This idempotency key was already used for a different bulk offer');
        return { result: { operationId: prior.id, replayed: true, appliedAt: prior.createdAt, ...details.result! }, changed: false };
      }
      const { plan } = await planOffers(data, input);
      const token = offerPreviewToken(plan);
      if (expectedToken && expectedToken !== token) {
        throw new ConflictException('Prices or offers changed since the preview; preview again before applying');
      }
      await data.pricing.replaceOffers(plan.sets.map(r => ({ productId: r.productId, ...r.offer! })));
      const created = plan.sets.filter(r => !r.previous).length;
      const applied: ApplyResult = {
        totals: bulkOfferTotals(plan), created, replaced: plan.sets.length - created,
        rejected: plan.rows.filter(r => r.outcome === 'rejected').map(r => ({ index: r.index, productId: r.productId, reason: r.reason!, message: r.message! })),
      };
      const event = await data.event(OFFERS_BULK_SET, p.user.id, null, ctx.requestId, {
        idempotencyKey, requestHash: hash, previewToken: token,
        result: applied as unknown as Prisma.InputJsonObject,
        changeColumns: [...OFFER_CHANGE_COLUMNS], changes: plan.sets.map(offerChangeEntry),
      });
      return { result: { operationId: event.id, replayed: false, appliedAt: event.createdAt, ...applied }, changed: plan.sets.length > 0 };
    });
    if (changed) await this.recon.enqueueRecon(ctx.tenantId, 'pricing.offers_bulk');
    return result;
  }
}
