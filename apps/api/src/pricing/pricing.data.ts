import type { TenantData } from '../../../../packages/db/src/database.js';
import { MARKETPLACES, type MarketplaceId, type RoundingOption, type RuleMode } from '../../../../packages/core/src/constants.js';
import {
  offerState, priceRuleChain, resolveMarketplacePrice, PRICE_RULE_ORDER,
  type OfferInput, type PriceChainStep, type PriceRule, type ProductPricingInput,
} from '../../../../packages/core/src/pricing.js';
import { enabledMarketplaces } from '../../../../packages/core/src/recon/compute.js';

type Decimalish = { toNumber(): number };
/** 'same' has no value on the wire, in either direction. */
export function ruleView(mode: string, value: Decimalish | number) {
  const v = typeof value === 'number' ? value : value.toNumber();
  return mode === 'same' ? { mode: 'same' as const } : { mode: mode as Exclude<RuleMode, 'same'>, value: v };
}
const asRule = (mode: string, value: Decimalish): PriceRule => ({ mode: mode as RuleMode, value: value.toNumber() });

export const DEFAULT_PRICING = {
  defaultRuleMode: 'same', defaultRuleValue: 0, rounding: 'exact' as RoundingOption, perMarketplaceEnabled: false, compareReferenceDefault: 'marketplace',
};

/** Settings and every tenant-level rule, read once per request (the recon worker reads the same snapshot). */
export function loadPricing(data: TenantData) {
  return data.pricing.snapshot();
}
export type TenantPricing = Awaited<ReturnType<typeof loadPricing>>;

type PricedProduct = { id: string; erpPrice: Decimalish; categoryId: string | null; subcategoryId: string | null };

/** Product rules and offers for a page of products: two queries whatever the page size. */
export async function productInputs(data: TenantData, products: PricedProduct[]) {
  const ids = products.map(p => p.id);
  const [rules, offers] = ids.length ? await Promise.all([data.pricing.productRules(ids), data.pricing.offers(ids)]) : [[], []];
  const ruleBy = new Map(rules.map(r => [r.productId, r]));
  const offersBy = new Map<string, typeof offers>();
  for (const o of offers) offersBy.set(o.productId, [...(offersBy.get(o.productId) ?? []), o]);
  return new Map(products.map(p => {
    const rule = ruleBy.get(p.id);
    const productOffers = offersBy.get(p.id) ?? [];
    const input: ProductPricingInput = {
      erpPrice: p.erpPrice.toNumber(), categoryId: p.categoryId, subcategoryId: p.subcategoryId,
      productRule: rule ? asRule(rule.mode, rule.value) : null,
      offers: productOffers.map((o): OfferInput => ({ price: o.price.toNumber(), validFrom: o.validFrom, validUntil: o.validUntil })),
    };
    return [p.id, { input, rule, offers: productOffers }];
  }));
}

/** {price, source} for the list; the marketplace-agnostic price (no per-marketplace step). */
export function marketplacePrice(pricing: TenantPricing, input: ProductPricingInput, now = new Date()) {
  const r = resolveMarketplacePrice(input, pricing.snapshot, pricing.categoryRules, { now });
  return { price: r.price, source: r.source };
}

/** The rule chain as the API shows it: rounding only where it applied (percent, amount). */
export function chainView(steps: PriceChainStep[]) {
  return steps.map(s => ({
    source: s.source, status: s.status,
    ...(s.price !== undefined ? { price: s.price } : {}),
    ...(s.rule ? { rule: ruleView(s.rule.mode, s.rule.value) } : {}),
    ...(s.rule && (s.rule.mode === 'percent' || s.rule.mode === 'amount') ? { rounding: s.rounding } : {}),
    ...(s.offer ? { offer: { price: s.offer.price, validFrom: s.offer.validFrom ?? null, validUntil: s.offer.validUntil ?? null } } : {}),
  }));
}

/** The marketplaces the recon reconciles for this tenant (core enabledMarketplaces), in MARKETPLACES order. */
export async function enabledMarketplaceIds(data: TenantData): Promise<MarketplaceId[]> {
  const [switches, applied] = await Promise.all([data.recon.marketplaceSwitches(), data.recon.lastApplied()]);
  return enabledMarketplaces(MARKETPLACES, switches, new Set(applied.keys())).map(m => m.marketplaceId);
}

/**
 * One product's price as seen from one marketplace (the per-marketplace step included), with its rule chain, the
 * product's own rule and its version, and the price on every enabled marketplace (a product rule applies to all).
 */
export async function marketplacePricingView(
  data: TenantData, product: PricedProduct, marketplaceId: MarketplaceId, enabled: readonly MarketplaceId[], pricing?: TenantPricing,
) {
  pricing ??= await loadPricing(data);
  const { input, rule } = (await productInputs(data, [product])).get(product.id)!;
  const now = new Date();
  const { resolved, steps } = priceRuleChain(input, pricing.snapshot, pricing.categoryRules, { marketplace: marketplaceId, now });
  return {
    productId: product.id, marketplaceId, erpPrice: product.erpPrice.toNumber(),
    resolved: { price: resolved.price, source: resolved.source },
    rule: rule ? { ...ruleView(rule.mode, rule.value), updatedAt: rule.updatedAt } : null,
    chain: chainView(steps),
    marketplaces: enabled.map(m => {
      const r = resolveMarketplacePrice(input, pricing.snapshot, pricing.categoryRules, { marketplace: m, now });
      return { marketplaceId: m, price: r.price, source: r.source };
    }),
  };
}

/** Everything a screen needs to explain one product's price. */
export async function productPricingView(data: TenantData, product: PricedProduct, pricing?: TenantPricing) {
  pricing ??= await loadPricing(data);
  const { input, rule, offers } = (await productInputs(data, [product])).get(product.id)!;
  const now = new Date();
  const { resolved, steps } = priceRuleChain(input, pricing.snapshot, pricing.categoryRules, { now });
  const offer = offers[offers.length - 1];
  return {
    marketplacePrice: { price: resolved.price, source: resolved.source },
    pricing: {
      order: PRICE_RULE_ORDER,
      productRule: rule ? { ...ruleView(rule.mode, rule.value), updatedAt: rule.updatedAt } : null,
      offer: offer ? {
        price: offer.price.toNumber(), validFrom: offer.validFrom, validUntil: offer.validUntil, updatedAt: offer.updatedAt,
        state: offerState({ price: 0, validFrom: offer.validFrom, validUntil: offer.validUntil }, now),
      } : null,
      chain: chainView(steps),
      // With per-marketplace pricing on, the price each marketplace that has its own rule would get.
      marketplaces: pricing.snapshot.perMarketplaceEnabled
        ? Object.keys(pricing.snapshot.marketplaceRules ?? {}).map(id => {
          const r = resolveMarketplacePrice(input, pricing.snapshot, pricing.categoryRules, { marketplace: id as MarketplaceId, now });
          return { marketplaceId: id, price: r.price, source: r.source };
        })
        : [],
    },
  };
}
