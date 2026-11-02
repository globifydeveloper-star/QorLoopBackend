import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue, ReconReason } from '../../../../packages/shared/src/recon.js';
import type { MarketplaceId } from '../../../../packages/core/src/constants.js';
import { toFils } from '../../../../packages/core/src/money.js';
import { PRICE_RULE_ORDER, resolveMarketplacePrice, type PriceRule } from '../../../../packages/core/src/pricing.js';
import { MARKETPLACE_LABELS, PRICE_BOUND_MESSAGES, priceBoundIssue } from '../../../../packages/core/src/price-change.js';
import { RECON_QUEUE } from '../tokens.js';
import {
  DEFAULT_PRICING, enabledMarketplaceIds, loadPricing, marketplacePricingView, productInputs, productPricingView, ruleView, type TenantPricing,
} from './pricing.data.js';
import { adoptionCounts, adoptionPreview, planAdoption, type AdoptInput } from './price-adoption.js';

type RuleInput = z.infer<typeof contracts.priceRule>;
type RuleView = ReturnType<typeof ruleView>;
/** 'same' is stored with value 0. */
const stored = (r: RuleInput) => ({ mode: r.mode, value: r.mode === 'same' ? 0 : r.value });
const sameRule = (a: RuleView | null, b: RuleView | null) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Adopting writes one rule per product: 23,000 rules took ~4 s on a laptop PostgreSQL 18 (index and foreign-key
 * maintenance), so a 50,000-product store needs more than a request's usual 20 s. The tenant row lock is held meanwhile.
 */
const ADOPT_TIMEOUT_MS = 60_000;

const invalid = (path: string, message: string) => new BadRequestException({ message: 'Validation failed', details: [{ path, message }] });

/**
 * Optimistic concurrency on the product rule: `expected` is the rule version the client saw (undefined = no check,
 * null = no rule). Writes run under the tenant row lock (Database.run), so check-then-write cannot interleave.
 */
export function checkRuleVersion(expected: string | null | undefined, current: { updatedAt: Date } | undefined) {
  if (expected === undefined) return;
  const stale = expected === null ? current !== undefined : !current || new Date(expected).getTime() !== current.updatedAt.getTime();
  if (stale) throw new ConflictException('This price was changed by someone else; reload it and try again');
}

function settingsView(p: TenantPricing) {
  const s = p.settings ?? { ...DEFAULT_PRICING, updatedAt: null };
  return {
    defaultRule: ruleView(s.defaultRuleMode, s.defaultRuleValue),
    rounding: s.rounding,
    perMarketplaceEnabled: s.perMarketplaceEnabled,
    compareReferenceDefault: s.compareReferenceDefault,
    marketplaceRules: p.marketplaceRules.map(r => ({ marketplaceId: r.marketplaceId, ...ruleView(r.mode, r.value), rounding: r.rounding })),
    order: PRICE_RULE_ORDER,
    updatedAt: s.updatedAt,
  };
}

@Injectable()
export class PricingService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RECON_QUEUE) private readonly recon: ReconQueue) {}

  /** Runs a pricing.edit change; after it commits, asks for a recon recompute if anything changed. */
  private async change<T>(ctx: RequestContext, reason: ReconReason, work: (data: TenantData, userId: string) => Promise<{ result: T; changed: boolean }>, timeout?: number) {
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'pricing.edit', mutation: true, timeout }, (data, p) => work(data, p.user.id));
    if (changed) await this.recon.enqueueRecon(ctx.tenantId, reason);
    return result;
  }

  settings(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'pricing.view' }, async data => settingsView(await loadPricing(data)));
  }

  /** One audit event per changed setting and per changed marketplace rule; an unchanged value writes nothing. */
  updateSettings(ctx: RequestContext, input: z.infer<typeof contracts.updatePricingSettings>) {
    return this.change(ctx, 'pricing.settings', async (data, actor) => {
      const before = settingsView(await loadPricing(data));
      const next = {
        defaultRule: input.defaultRule ? ruleView(input.defaultRule.mode, stored(input.defaultRule).value) : before.defaultRule,
        rounding: input.rounding ?? before.rounding,
        perMarketplaceEnabled: input.perMarketplaceEnabled ?? before.perMarketplaceEnabled,
        compareReferenceDefault: input.compareReferenceDefault ?? before.compareReferenceDefault,
      };
      const fields = (['defaultRule', 'rounding', 'perMarketplaceEnabled', 'compareReferenceDefault'] as const)
        .filter(f => JSON.stringify(next[f]) !== JSON.stringify(before[f]));
      if (fields.length) {
        await data.pricing.saveSettings({
          defaultRuleMode: next.defaultRule.mode, defaultRuleValue: 'value' in next.defaultRule ? next.defaultRule.value : 0,
          rounding: next.rounding, perMarketplaceEnabled: next.perMarketplaceEnabled, compareReferenceDefault: next.compareReferenceDefault,
        });
        for (const field of fields) await data.event('pricing.settings_changed', actor, null, ctx.requestId, { field, old: before[field], new: next[field] });
      }

      let rulesChanged = 0;
      if (input.marketplaceRules) {
        const old = new Map(before.marketplaceRules.map(({ marketplaceId, ...r }) => [marketplaceId, r]));
        const wanted = new Map<string, RuleView & { rounding: string }>(input.marketplaceRules.map(r => [r.marketplaceId, { ...ruleView(r.mode, stored(r).value), rounding: r.rounding }]));
        for (const r of input.marketplaceRules) {
          const { marketplaceId } = r;
          const rule = wanted.get(marketplaceId)!;
          const prior = old.get(marketplaceId) ?? null;
          if (prior && JSON.stringify(prior) === JSON.stringify(rule)) continue;
          await data.pricing.setMarketplaceRule(marketplaceId, { ...stored(r), rounding: r.rounding });
          await data.event('pricing.marketplace_rule_set', actor, null, ctx.requestId, { marketplaceId, old: prior, new: rule });
          rulesChanged++;
        }
        for (const [marketplaceId, prior] of old) {
          if (wanted.has(marketplaceId)) continue;
          await data.pricing.deleteMarketplaceRule(marketplaceId);
          await data.event('pricing.marketplace_rule_deleted', actor, null, ctx.requestId, { marketplaceId, old: prior });
          rulesChanged++;
        }
      }
      return { result: settingsView(await loadPricing(data)), changed: fields.length + rulesChanged > 0 };
    });
  }

  categoryRules(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'pricing.view' }, async data => {
      const [rules, categories] = await Promise.all([data.pricing.categoryRules(), data.categories.all()]);
      const names = new Map(categories.map(c => [c.id, { id: c.id, nameEn: c.nameEn, nameAr: c.nameAr }]));
      return rules.map(r => ({
        categoryId: r.categoryId, subcategoryId: r.subcategoryId, ...ruleView(r.mode, r.value),
        category: names.get(r.categoryId) ?? null, subcategory: r.subcategoryId ? names.get(r.subcategoryId) ?? null : null, updatedAt: r.updatedAt,
      }));
    });
  }

  /** The category must be top level and the subcategory, when given, one of its own. */
  private async checkCategoryKey(data: TenantData, categoryId: string, subcategoryId: string | null) {
    const category = await data.categories.get(categoryId);
    if (!category) throw new BadRequestException('Category not found');
    if (category.parentId) throw new BadRequestException('Choose a top-level category; this one is a subcategory');
    if (subcategoryId) {
      const sub = await data.categories.get(subcategoryId);
      if (!sub || !sub.parentId) throw new BadRequestException('Subcategory not found');
      if (sub.parentId !== categoryId) throw new BadRequestException('The subcategory does not belong to the chosen category');
    }
  }

  setCategoryRule(ctx: RequestContext, input: z.infer<typeof contracts.categoryPriceRule>) {
    const { categoryId, subcategoryId: sub, ...rule } = input;
    const subcategoryId = sub ?? null;
    return this.change(ctx, 'pricing.category_rule', async (data, actor) => {
      await this.checkCategoryKey(data, categoryId, subcategoryId);
      const prior = await data.pricing.categoryRule(categoryId, subcategoryId);
      const old = prior ? ruleView(prior.mode, prior.value) : null;
      const next = ruleView(rule.mode, stored(rule).value);
      const changed = !sameRule(old, next);
      if (changed) {
        await data.pricing.setCategoryRule(categoryId, subcategoryId, stored(rule));
        await data.event('pricing.category_rule_set', actor, subcategoryId ?? categoryId, ctx.requestId, { categoryId, subcategoryId, old, new: next });
      }
      return { result: { categoryId, subcategoryId, ...next }, changed };
    });
  }

  deleteCategoryRule(ctx: RequestContext, key: z.infer<typeof contracts.categoryPriceRuleKey>) {
    const { categoryId } = key;
    const subcategoryId = key.subcategoryId ?? null;
    return this.change(ctx, 'pricing.category_rule', async (data, actor) => {
      const prior = await data.pricing.categoryRule(categoryId, subcategoryId);
      if (!prior) throw new NotFoundException('No price rule for this category');
      await data.pricing.deleteCategoryRule(categoryId, subcategoryId);
      await data.event('pricing.category_rule_deleted', actor, subcategoryId ?? categoryId, ctx.requestId, { categoryId, subcategoryId, old: ruleView(prior.mode, prior.value) });
      return { result: { categoryId, subcategoryId, deleted: true }, changed: true };
    });
  }

  private async product(data: TenantData, id: string) {
    const product = await data.products.get(id);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  setProductRule(ctx: RequestContext, id: string, rule: RuleInput) {
    return this.change(ctx, 'product.price_rule', async (data, actor) => {
      const product = await this.product(data, id);
      const prior = (await data.pricing.productRules([id]))[0];
      const old = prior ? ruleView(prior.mode, prior.value) : null;
      const next = ruleView(rule.mode, stored(rule).value);
      const changed = !sameRule(old, next);
      if (changed) {
        await data.pricing.setProductRule(id, stored(rule));
        await data.event('product.price_rule_set', actor, id, ctx.requestId, { old, new: next });
      }
      return { result: await productPricingView(data, product), changed };
    });
  }

  deleteProductRule(ctx: RequestContext, id: string) {
    return this.change(ctx, 'product.price_rule', async (data, actor) => {
      const product = await this.product(data, id);
      const prior = (await data.pricing.productRules([id]))[0];
      if (!prior) throw new NotFoundException('This product has no price rule');
      await data.pricing.deleteProductRule(id);
      await data.event('product.price_rule_deleted', actor, id, ctx.requestId, { old: ruleView(prior.mode, prior.value) });
      return { result: await productPricingView(data, product), changed: true };
    });
  }

  /**
   * What an inline edit needs: an active product of this store and a marketplace the store reconciles; then the pricing
   * snapshot, the product's pricing inputs and its current rule, read once inside the request's transaction.
   */
  private async inlineTarget(data: TenantData, id: string, marketplaceId: MarketplaceId) {
    const product = await this.product(data, id);
    if (product.status !== 'active') throw invalid('productId', 'Only an active product can be priced; activate it first');
    const enabled = await enabledMarketplaceIds(data);
    if (!enabled.includes(marketplaceId)) throw invalid('marketplaceId', `${MARKETPLACE_LABELS[marketplaceId]} is not enabled for this store`);
    const [pricing, inputs] = await Promise.all([loadPricing(data), productInputs(data, [product])]);
    const { input, rule } = inputs.get(id)!;
    const now = new Date();
    const resolve = (productRule: PriceRule | null) =>
      resolveMarketplacePrice({ ...input, productRule }, pricing.snapshot, pricing.categoryRules, { marketplace: marketplaceId, now });
    return { product, enabled, pricing, input, rule, resolve };
  }

  /**
   * Inline edit: sets the product's own rule (fixed price, or percent over the ERP price) so the product shows that
   * price on `marketplaceId` (and, being the product's rule, on every marketplace). Refused when an offer decides the
   * price now (the rule would not show) or the price falls outside 0 < price <= PRICE_CHANGE_MAX.
   */
  setInlinePrice(ctx: RequestContext, id: string, body: z.infer<typeof contracts.inlinePrice>) {
    const { marketplaceId, expectedRuleUpdatedAt, ...rule } = body;
    return this.change(ctx, 'product.price_rule', async (data, actor) => {
      const t = await this.inlineTarget(data, id, marketplaceId);
      checkRuleVersion(expectedRuleUpdatedAt, t.rule);
      const before = t.resolve(t.input.productRule ?? null);
      const after = t.resolve(rule);
      if (after.source === 'offer') throw invalid('offer', 'A current offer sets this price; change or remove the offer first');
      const issue = priceBoundIssue(toFils(after.price));
      if (issue) throw invalid('value', PRICE_BOUND_MESSAGES[issue]);
      const old = t.rule ? ruleView(t.rule.mode, t.rule.value) : null;
      const next = ruleView(rule.mode, rule.value);
      const changed = !sameRule(old, next);
      if (changed) {
        await data.pricing.setProductRule(id, rule);
        await data.event('product.price_rule_set', actor, id, ctx.requestId, { old, new: next, via: 'pricing.inline', marketplaceId, oldPrice: before.price, newPrice: after.price });
      }
      const view = await marketplacePricingView(data, t.product, marketplaceId, t.enabled, t.pricing);
      return { result: { ...view, previous: { price: before.price, source: before.source }, changed }, changed };
    });
  }

  /**
   * Inline "back to the ERP price": removes the product's own rule, so the price follows the category, per-marketplace
   * and default rules again. No rule is not an error (changed: false), so a repeated click answers the same.
   */
  removeInlinePrice(ctx: RequestContext, id: string, query: z.infer<typeof contracts.inlinePriceRemove>) {
    const { marketplaceId, expectedRuleUpdatedAt } = query;
    return this.change(ctx, 'product.price_rule', async (data, actor) => {
      const t = await this.inlineTarget(data, id, marketplaceId);
      checkRuleVersion(expectedRuleUpdatedAt, t.rule);
      const before = t.resolve(t.input.productRule ?? null);
      let changed = false;
      if (t.rule) {
        const after = t.resolve(null);
        if (after.source === 'offer') throw invalid('offer', 'A current offer sets this price; change or remove the offer first');
        const issue = priceBoundIssue(toFils(after.price), false);
        if (issue) throw invalid('marketplaceId', PRICE_BOUND_MESSAGES[issue]);
        await data.pricing.deleteProductRule(id);
        await data.event('product.price_rule_deleted', actor, id, ctx.requestId, {
          old: ruleView(t.rule.mode, t.rule.value), via: 'pricing.inline', marketplaceId, oldPrice: before.price, newPrice: after.price,
        });
        changed = true;
      }
      const view = await marketplacePricingView(data, t.product, marketplaceId, t.enabled, t.pricing);
      return { result: { ...view, previous: { price: before.price, source: before.source }, changed }, changed };
    });
  }

  /** Replaces the product's offer. An offer that has already ended is refused; one that starts later is kept and waits. */
  setOffer(ctx: RequestContext, id: string, input: z.infer<typeof contracts.productOffer>) {
    const validFrom = input.validFrom ? new Date(input.validFrom) : null;
    const validUntil = input.validUntil ? new Date(input.validUntil) : null;
    if (validUntil && validUntil.getTime() < Date.now()) {
      throw new BadRequestException({ message: 'Validation failed', details: [{ path: 'validUntil', message: 'This offer has already ended' }] });
    }
    return this.change(ctx, 'product.offer', async (data, actor) => {
      const product = await this.product(data, id);
      const offers = await data.pricing.offers([id]);
      const view = (o: { price: number; validFrom: Date | null; validUntil: Date | null }) =>
        ({ price: o.price, validFrom: o.validFrom?.toISOString() ?? null, validUntil: o.validUntil?.toISOString() ?? null });
      const next = view({ price: input.price, validFrom, validUntil });
      const prior = offers.at(-1);
      const old = prior ? view({ price: prior.price.toNumber(), validFrom: prior.validFrom, validUntil: prior.validUntil }) : null;
      const changed = offers.length !== 1 || JSON.stringify(old) !== JSON.stringify(next);
      if (changed) {
        await data.pricing.replaceOffer(id, { price: input.price, validFrom, validUntil });
        await data.event('product.offer_set', actor, id, ctx.requestId, { old, new: next });
      }
      return { result: await productPricingView(data, product), changed };
    });
  }

  private async checkAdoptScope(data: TenantData, input: AdoptInput) {
    if ('categoryId' in input.scope) await this.checkCategoryKey(data, input.scope.categoryId, input.scope.subcategoryId ?? null);
  }

  /** What adopting the source marketplace's prices would do; writes nothing. */
  adoptPreview(ctx: RequestContext, input: AdoptInput) {
    return this.auth.authenticated(ctx, { permission: 'pricing.edit', mutation: true }, async data => {
      await this.checkAdoptScope(data, input);
      const { products, plan } = await planAdoption(data, input);
      return adoptionPreview(data, input, products, plan);
    });
  }

  /**
   * Adopts in one transaction, planned under the tenant row lock: set-based rule writes, ONE 'pricing.prices_adopted'
   * summary event, and 'product.price_rule_set' only for products whose own different rule is replaced. A run that
   * adopts nothing (a repeat) writes nothing and queues no recompute.
   */
  adoptApply(ctx: RequestContext, input: AdoptInput) {
    return this.change(ctx, 'pricing.adopt', async (data, actor) => {
      await this.checkAdoptScope(data, input);
      const { products, plan } = await planAdoption(data, input);
      const counts = adoptionCounts(products, plan);
      if (plan.adopt.length) {
        await data.pricing.upsertProductRules(plan.adopt.map(r => ({ productId: r.productId, mode: r.rule.mode, value: r.rule.value })));
        await data.products.auditEvents(actor, ctx.requestId, plan.adopt.filter(r => r.previousRule).map(r => ({
          action: 'product.price_rule_set', entityId: r.productId,
          details: { old: ruleView(r.previousRule!.mode, r.previousRule!.value), new: ruleView(r.rule.mode, r.rule.value), via: 'pricing.adopt' },
        })));
        await data.event('pricing.prices_adopted', actor, null, ctx.requestId, {
          sourceMarketplaceId: input.sourceMarketplaceId, mode: input.mode, onlyWithoutRule: input.onlyWithoutRule, scope: input.scope, ...counts,
        });
      }
      return { result: counts, changed: plan.adopt.length > 0 };
    }, ADOPT_TIMEOUT_MS);
  }

  deleteOffer(ctx: RequestContext, id: string) {
    return this.change(ctx, 'product.offer', async (data, actor) => {
      const product = await this.product(data, id);
      const prior = (await data.pricing.offers([id])).at(-1);
      if (!prior) throw new NotFoundException('This product has no offer');
      await data.pricing.deleteOffers(id);
      await data.event('product.offer_deleted', actor, id, ctx.requestId, {
        old: { price: prior.price.toNumber(), validFrom: prior.validFrom?.toISOString() ?? null, validUntil: prior.validUntil?.toISOString() ?? null },
      });
      return { result: await productPricingView(data, product), changed: true };
    });
  }
}
