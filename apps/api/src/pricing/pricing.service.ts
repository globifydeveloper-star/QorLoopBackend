import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ReconQueue, ReconReason } from '../../../../packages/shared/src/recon.js';
import { PRICE_RULE_ORDER } from '../../../../packages/core/src/pricing.js';
import { RECON_QUEUE } from '../tokens.js';
import { DEFAULT_PRICING, loadPricing, productPricingView, ruleView, type TenantPricing } from './pricing.data.js';

type RuleInput = z.infer<typeof contracts.priceRule>;
type RuleView = ReturnType<typeof ruleView>;
/** 'same' is stored with value 0. */
const stored = (r: RuleInput) => ({ mode: r.mode, value: r.mode === 'same' ? 0 : r.value });
const sameRule = (a: RuleView | null, b: RuleView | null) => JSON.stringify(a) === JSON.stringify(b);

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
  private async change<T>(ctx: RequestContext, reason: ReconReason, work: (data: TenantData, userId: string) => Promise<{ result: T; changed: boolean }>) {
    const { result, changed } = await this.auth.authenticated(ctx, { permission: 'pricing.edit', mutation: true }, (data, p) => work(data, p.user.id));
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
