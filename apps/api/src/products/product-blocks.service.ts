import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { ProductFilter, TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue } from '../../../../packages/shared/src/recon.js';
import {
  ENDED_OFFERS_NOT_RESTORED, OFFERS_END_ON_BLOCK, PRODUCT_BLOCK_FILTER_MAX, PRODUCT_BLOCK_REASON_LABELS,
  blockSignature, planBlock, planUnblock, type BlockedFilter, type ProductBlockReason,
} from '../../../../packages/core/src/products/blocking.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { RECON_QUEUE } from '../tokens.js';
import { BULK_TIMEOUT_MS } from '../pricing/bulk-pricing.service.js';
import { marketplaceContext, searchFilter } from './products.service.js';

export const PRODUCTS_BLOCKED = 'products.blocked';
export const PRODUCTS_UNBLOCKED = 'products.unblocked';

type Selection = { productIds?: string[]; filter?: z.infer<typeof contracts.productSelectionFilter> };
const count = (n: number) => n.toLocaleString('en-US');

/**
 * The selected products with their blocked state: explicit ids (deduplicated; ids not in this store count as
 * notFound), or every product the catalogue filters match (blocked ones included for a block, only the blocked ones
 * for an unblock). A filter matching more than PRODUCT_BLOCK_FILTER_MAX products is refused.
 */
async function select(data: TenantData, s: Selection, blocked: BlockedFilter) {
  if (s.productIds) {
    const ids = [...new Set(s.productIds)];
    return { products: await data.products.blockProducts(ids), requested: ids.length };
  }
  const f = s.filter!;
  let filter: ProductFilter = { ...searchFilter(f), blocked };
  if (f.marketplaceId) {
    const market = await marketplaceContext(data, f.marketplaceId);
    if (f.marketplaceStatus) filter = { ...filter, marketplace: { marketplaceId: market.marketplaceId, status: f.marketplaceStatus, reference: market.reference, hasData: market.hasData } };
  }
  const products = await data.products.blockSelection(filter, f.tab, PRODUCT_BLOCK_FILTER_MAX + 1);
  if (products.length > PRODUCT_BLOCK_FILTER_MAX) {
    const n = await data.products.blockSelectionCount(filter, f.tab);
    throw new BadRequestException({
      message: 'Validation failed',
      details: [{ path: 'filter', message: `This filter matches ${count(n)} products; at most ${count(PRODUCT_BLOCK_FILTER_MAX)} can be changed at once. Narrow the filter.` }],
    });
  }
  return { products, requested: products.length };
}

async function planBlocking(data: TenantData, input: Selection & { reason: ProductBlockReason }, at: Date) {
  const { products, requested } = await select(data, input, 'include');
  const plan = planBlock(products.map(p => ({ id: p.id, isBlocked: p.blockedAt !== null })), requested);
  const offers = await data.products.activeOffersOf(plan.toBlock, at);
  const token = createHash('sha256').update(blockSignature(plan.toBlock, offers.map(o => o.id), input.reason)).digest('hex');
  return { plan, offers, token };
}

@Injectable()
export class ProductBlocksService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /** What a block would do now; writes nothing. */
  preview(ctx: RequestContext, input: z.infer<typeof contracts.blockProductsPreview>) {
    return this.auth.authenticated(ctx, { permission: 'products.block', mutation: true, timeout: BULK_TIMEOUT_MS }, async data => {
      const { plan, offers, token } = await planBlocking(data, input, new Date());
      return {
        reason: input.reason, reasonLabel: PRODUCT_BLOCK_REASON_LABELS[input.reason],
        selected: plan.toBlock.length + plan.alreadyBlocked, toBlock: plan.toBlock.length, alreadyBlocked: plan.alreadyBlocked, notFound: plan.notFound,
        activeOffersToEnd: offers.length, offersNote: offers.length ? OFFERS_END_ON_BLOCK : null,
        previewToken: token,
      };
    });
  }

  /**
   * One transaction under the tenant row lock: a fresh plan checked against the preview token (409 when the selection,
   * its blocked state or its active offers changed), then ONE update of the products, ONE update ending their active
   * offers (valid_until = now), ONE delete of their recon rows, one 'product.blocked' event per product and one
   * 'products.blocked' summary. After commit, one coalesced recompute (reason product.blocked).
   */
  async block(ctx: RequestContext, body: z.infer<typeof contracts.blockProducts>) {
    const { previewToken, ...input } = body;
    const result = await this.auth.authenticated(ctx, { permission: 'products.block', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const at = new Date();
      const { plan, offers, token } = await planBlocking(data, input, at);
      if (token !== previewToken) throw new ConflictException('The products or their offers changed since the preview; preview again before blocking');
      const blocked = await data.products.block(plan.toBlock, input.reason, p.user.id, at);
      const offersEnded = await data.products.endOffers(offers.map(o => o.id), at);
      await data.products.deleteReconRows(blocked);
      const endedBy = new Map<string, typeof offers>();
      for (const o of offers) endedBy.set(o.productId, [...(endedBy.get(o.productId) ?? []), o]);
      await data.products.auditEvents(p.user.id, ctx.requestId, blocked.map(entityId => ({
        action: 'product.blocked', entityId,
        details: {
          reason: input.reason,
          offersEnded: (endedBy.get(entityId) ?? []).map(o => ({
            price: o.price.toNumber(), validFrom: o.validFrom?.toISOString() ?? null, validUntil: o.validUntil?.toISOString() ?? null, endedAt: at.toISOString(),
          })),
        },
      })));
      const summary = { mode: input.productIds ? 'ids' : 'filter', reason: input.reason, blocked: blocked.length, alreadyBlocked: plan.alreadyBlocked, notFound: plan.notFound, offersEnded };
      await data.event(PRODUCTS_BLOCKED, p.user.id, null, ctx.requestId, summary);
      return {
        reason: input.reason, reasonLabel: PRODUCT_BLOCK_REASON_LABELS[input.reason],
        blocked: blocked.length, alreadyBlocked: plan.alreadyBlocked, notFound: plan.notFound,
        offersEnded, offersNote: offersEnded ? ENDED_OFFERS_NOT_RESTORED : null, blockedAt: at,
      };
    });
    if (result.blocked) await this.recon.enqueueRecon(ctx.tenantId, 'product.blocked');
    return result;
  }

  /**
   * Clears the three blocked columns of the selected blocked products; status and every other field are as they were
   * before the block. Offers the block ended stay ended (the response says so). One coalesced recompute after commit.
   */
  async unblock(ctx: RequestContext, input: z.infer<typeof contracts.unblockProducts>) {
    const result = await this.auth.authenticated(ctx, { permission: 'products.block', mutation: true, timeout: BULK_TIMEOUT_MS }, async (data, p) => {
      const { products, requested } = await select(data, input, 'only');
      const plan = planUnblock(products.map(r => ({ id: r.id, isBlocked: r.blockedAt !== null })), requested);
      const unblocked = await data.products.unblock(plan.toUnblock);
      await data.products.auditEvents(p.user.id, ctx.requestId, unblocked.map(u => ({ action: 'product.unblocked', entityId: u.id, details: { reason: u.reason } })));
      await data.event(PRODUCTS_UNBLOCKED, p.user.id, null, ctx.requestId, {
        mode: input.productIds ? 'ids' : 'filter', unblocked: unblocked.length, notBlocked: plan.notBlocked, notFound: plan.notFound,
      });
      return { unblocked: unblocked.length, notBlocked: plan.notBlocked, notFound: plan.notFound, offersRestored: 0, offersNote: ENDED_OFFERS_NOT_RESTORED };
    });
    if (result.unblocked) await this.recon.enqueueRecon(ctx.tenantId, 'product.unblocked');
    return result;
  }
}
