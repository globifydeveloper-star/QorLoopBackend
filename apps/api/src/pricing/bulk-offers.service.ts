import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { Prisma } from '../../../../packages/db/src/generated/client.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import { bulkOfferRemoveTotals, bulkOfferTotals } from '../../../../packages/core/src/bulk-offers.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { RECON_QUEUE } from '../tokens.js';
import { BULK_IDEMPOTENCY_WINDOW_MS, BULK_TIMEOUT_MS } from './bulk-pricing.service.js';
import {
  OFFER_CHANGE_COLUMNS, REMOVE_CHANGE_COLUMNS, appliedRow, offerChangeEntry, offerPreviewToken, offerRequestHash, offersPreview, planOfferRemoval, planOffers,
  removalPreview, removeChangeEntry, removePreviewToken, removeRequestHash,
} from './bulk-offers.js';

export const OFFERS_BULK_REMOVED = 'pricing.offers_bulk_removed';

type ApplyInput = z.infer<typeof contracts.bulkOfferApply>;
export const OFFERS_BULK_SET = 'pricing.offers_bulk_set';

/**
 * The result an apply returns, and stores in its audit event so a replay returns it again: the preview's counts and
 * every row (compact: the old and new offers are in the event's changes), the totals, the token and the split.
 */
type ApplyResult = {
  willChange: number;
  unchanged: number;
  rejected: number;
  rows: ReturnType<typeof appliedRow>[];
  totals: ReturnType<typeof bulkOfferTotals>;
  previewToken: string;
  created: number;
  replaced: number;
};

@Injectable()
export class BulkOffersService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /** What the bulk offer would do now, row by row; writes nothing. */
  preview(ctx: RequestContext, input: z.infer<typeof contracts.bulkOfferPreview>) {
    return this.auth.authenticated(ctx, { permission: 'pricing.edit', mutation: true }, async data => offersPreview(await planOffers(data, input)));
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
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'pricing.edit', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const prior = await data.pricing.bulkOperation(OFFERS_BULK_SET, idempotencyKey, new Date(Date.now() - BULK_IDEMPOTENCY_WINDOW_MS));
      if (prior) {
        const details = prior.details as { requestHash?: string; result?: ApplyResult } | null;
        if (details?.requestHash !== hash) throw new ConflictException('This idempotency key was already used for a different bulk offer');
        return { result: { operationId: prior.id, replayed: true, appliedAt: prior.createdAt, ...details.result! }, changed: false };
      }
      const { plan, labels } = await planOffers(data, input);
      const token = offerPreviewToken(plan);
      if (expectedToken && expectedToken !== token) {
        throw new ConflictException('Prices or offers changed since the preview; preview again before applying');
      }
      await data.pricing.replaceOffers(plan.sets.map(r => ({ productId: r.productId, ...r.offer! })));
      const created = plan.sets.filter(r => !r.previous).length;
      const totals = bulkOfferTotals(plan);
      const applied: ApplyResult = {
        willChange: totals.set, unchanged: totals.unchanged, rejected: totals.rejected,
        rows: plan.rows.map(r => appliedRow(r, labels)), totals, previewToken: token,
        created, replaced: plan.sets.length - created,
      };
      const event = await data.event(OFFERS_BULK_SET, p.user.id, null, ctx.requestId, {
        idempotencyKey, requestHash: hash, previewToken: token,
        result: applied as unknown as Prisma.InputJsonObject,
        changeColumns: [...OFFER_CHANGE_COLUMNS], changes: plan.sets.map(offerChangeEntry),
      });
      return { result: { operationId: event.id, replayed: false, appliedAt: event.createdAt, ...applied }, changed: plan.sets.length > 0 };
    });
    if (changed) await this.recon.enqueueRecon(ctx.tenantId, 'product.offer');
    return result;
  }

  /** What a bulk remove would do now, product by product; writes nothing. */
  removePreview(ctx: RequestContext, input: z.infer<typeof contracts.bulkOfferRemovePreview>) {
    return this.auth.authenticated(ctx, { permission: 'pricing.edit', mutation: true }, async data => removalPreview(await planOfferRemoval(data, input)));
  }

  /**
   * Same pattern as apply: idempotency key, a fresh plan checked against the preview token (an offer changed or
   * removed since the preview is a 409), ONE DELETE for every product with an offer, ONE 'pricing.offers_bulk_removed'
   * event with every removed offer, and one coalesced recompute after commit when anything was removed.
   */
  async removeApply(ctx: RequestContext, body: z.infer<typeof contracts.bulkOfferRemoveApply>) {
    const { idempotencyKey, previewToken: expectedToken, ...input } = body;
    const hash = removeRequestHash(input);
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'pricing.edit', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const prior = await data.pricing.bulkOperation(OFFERS_BULK_REMOVED, idempotencyKey, new Date(Date.now() - BULK_IDEMPOTENCY_WINDOW_MS));
      if (prior) {
        const details = prior.details as { requestHash?: string; result?: RemoveResult } | null;
        if (details?.requestHash !== hash) throw new ConflictException('This idempotency key was already used for a different bulk offer removal');
        return { result: { operationId: prior.id, replayed: true, appliedAt: prior.createdAt, ...details.result! }, changed: false };
      }
      const { plan } = await planOfferRemoval(data, input);
      const token = removePreviewToken(plan);
      if (expectedToken && expectedToken !== token) {
        throw new ConflictException('Offers changed since the preview; preview again before applying');
      }
      await data.pricing.deleteOffersOf(plan.removes.map(r => r.productId));
      const removed: RemoveResult = {
        totals: bulkOfferRemoveTotals(plan),
        skipped: plan.rows.filter(r => r.outcome === 'skipped').map(r => ({ productId: r.productId, reason: r.reason!, message: r.message! })),
      };
      const event = await data.event(OFFERS_BULK_REMOVED, p.user.id, null, ctx.requestId, {
        idempotencyKey, requestHash: hash, previewToken: token,
        result: removed as unknown as Prisma.InputJsonObject,
        changeColumns: [...REMOVE_CHANGE_COLUMNS], changes: plan.removes.map(removeChangeEntry),
      });
      return { result: { operationId: event.id, replayed: false, appliedAt: event.createdAt, ...removed }, changed: plan.removes.length > 0 };
    });
    if (changed) await this.recon.enqueueRecon(ctx.tenantId, 'product.offer');
    return result;
  }
}

type RemoveResult = {
  totals: ReturnType<typeof bulkOfferRemoveTotals>;
  skipped: { productId: string; reason: string; message: string }[];
};
