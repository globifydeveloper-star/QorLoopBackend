import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../../../../packages/db/src/generated/client.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import { RECON_QUEUE } from '../tokens.js';
import { BULK_CHANGE_COLUMNS, bulkCounts, bulkPreview, changeEntry, planBulk, previewToken, requestHash } from './bulk-pricing.js';

type ApplyInput = z.infer<typeof contracts.bulkPriceApply>;

/** An apply plans and writes up to BULK_PRICE_LIMIT rules under the tenant row lock; requests keep 20 s. */
export const BULK_TIMEOUT_MS = 60_000;
/** How long an idempotency key is remembered (a double click, a retried request), searched on the created_at index. */
export const BULK_IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;

/** The result an apply returns, and stores in its audit event so a replay returns it again. */
type ApplyResult = ReturnType<typeof bulkCounts> & { created: number; replaced: number; removed: number };

@Injectable()
export class BulkPricingService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /** What the change would do now; writes nothing. */
  preview(ctx: RequestContext, input: z.infer<typeof contracts.bulkPricePreview>) {
    return this.auth.authenticated(ctx, { permission: 'pricing.bulk', mutation: true }, async data => bulkPreview(input, await planBulk(data, input)));
  }

  /**
   * One transaction under the tenant row lock: the idempotency key is looked up first (the lock serialises a double
   * click, so the second request sees the first one's event); then the change is planned again from current data
   * (never from the preview), checked against the preview token, written set-based (INSERT ... FROM unnest, one
   * DELETE ... ANY) and recorded in ONE 'pricing.bulk_applied' event holding the key, the request hash, the result and
   * every change (old and new rule and price). After commit, one coalesced recon recompute when anything changed.
   */
  async apply(ctx: RequestContext, body: ApplyInput) {
    const { idempotencyKey, previewToken: expectedToken, ...input } = body;
    const hash = requestHash(input);
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'pricing.bulk', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const prior = await data.pricing.bulkOperation(idempotencyKey, new Date(Date.now() - BULK_IDEMPOTENCY_WINDOW_MS));
      if (prior) {
        const details = prior.details as { requestHash?: string; result?: ApplyResult } | null;
        if (details?.requestHash !== hash) throw new ConflictException('This idempotency key was already used for a different price change');
        return { result: { operationId: prior.id, replayed: true, appliedAt: prior.createdAt, ...details.result! }, changed: false };
      }
      const planned = await planBulk(data, input);
      const token = previewToken(planned.plan);
      if (expectedToken && expectedToken !== token) {
        throw new ConflictException('Prices or rules changed since the preview; preview again before applying');
      }
      const { changes } = planned.plan;
      const sets = changes.filter(c => c.rule);
      const removes = changes.filter(c => !c.rule).map(c => c.productId);
      await data.pricing.upsertProductRules(sets.map(c => ({ productId: c.productId, mode: c.rule!.mode, value: c.rule!.value })));
      await data.pricing.deleteProductRules(removes);
      const created = sets.filter(c => !c.previousRule).length;
      const applied: ApplyResult = { ...bulkCounts(planned, input.marketplaceId), created, replaced: sets.length - created, removed: removes.length };
      const event = await data.event('pricing.bulk_applied', p.user.id, null, ctx.requestId, {
        idempotencyKey, requestHash: hash, previewToken: token,
        marketplaceId: input.marketplaceId, action: input.action, selection: input.selection,
        result: applied as unknown as Prisma.InputJsonObject,
        changeColumns: [...BULK_CHANGE_COLUMNS], changes: changes.map(changeEntry),
      });
      return { result: { operationId: event.id, replayed: false, appliedAt: event.createdAt, ...applied }, changed: changes.length > 0 };
    });
    if (changed) await this.recon.enqueueRecon(ctx.tenantId, 'pricing.bulk');
    return result;
  }
}
