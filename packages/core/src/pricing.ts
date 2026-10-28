import type { MarketplaceId, RoundingOption, RuleMode } from '@qorloop/shared';
import { fromFils, roundFils, toFils } from './money';

export interface PriceRule {
  mode: RuleMode;
  value: number;
}

export type PriceSource = 'offer' | 'product' | 'subcategory' | 'category' | 'marketplace' | 'default';

export interface ResolvedPrice {
  price: number;
  source: PriceSource;
  rule?: PriceRule;
}

export interface PricingSettingsSnapshot {
  defaultRule: PriceRule;
  rounding: RoundingOption;
  perMarketplaceEnabled?: boolean;
  marketplaceRules?: Partial<Record<MarketplaceId, { active: boolean; rule: PriceRule; rounding: RoundingOption }>>;
}

export interface ProductPricingInput {
  erpPrice: number;
  offerPrice?: number | null;
  productRule?: PriceRule | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
}

export interface CategoryRuleItem {
  categoryId: string;
  subcategoryId?: string | null;
  rule: PriceRule;
}

/** Calculated prices (percent, amount) are rounded; fixed, same and offers are used exactly as entered. */
export function priceFromRule(erpPrice: number, rule: PriceRule, rounding: RoundingOption): number {
  const erp = toFils(erpPrice);
  switch (rule.mode) {
    case 'percent':
      return fromFils(roundFils(erp * (1 + rule.value / 100), rounding));
    case 'amount':
      return fromFils(roundFils(erp + toFils(rule.value), rounding));
    case 'fixed':
      return fromFils(toFils(rule.value));
    case 'same':
    default:
      return fromFils(erp);
  }
}

/**
 * Marketplace Price: the first rule that applies (docs 5.1).
 * Order lives in this ONE function so it can change if open question Q9 is answered differently:
 * offer -> product -> subcategory -> category -> per-marketplace (advanced, off by default) -> default.
 */
export function resolveMarketplacePrice(
  product: ProductPricingInput,
  settings: PricingSettingsSnapshot,
  categoryRules: CategoryRuleItem[] = [],
  marketplace?: MarketplaceId,
): ResolvedPrice {
  if (product.offerPrice !== undefined && product.offerPrice !== null) {
    return { price: fromFils(toFils(product.offerPrice)), source: 'offer' };
  }
  if (product.productRule) {
    return {
      price: priceFromRule(product.erpPrice, product.productRule, settings.rounding),
      source: 'product',
      rule: product.productRule,
    };
  }
  if (product.subcategoryId) {
    const r = categoryRules.find((x) => x.subcategoryId === product.subcategoryId);
    if (r) {
      return { price: priceFromRule(product.erpPrice, r.rule, settings.rounding), source: 'subcategory', rule: r.rule };
    }
  }
  if (product.categoryId) {
    const r = categoryRules.find((x) => x.categoryId === product.categoryId && !x.subcategoryId);
    if (r) {
      return { price: priceFromRule(product.erpPrice, r.rule, settings.rounding), source: 'category', rule: r.rule };
    }
  }
  if (marketplace && settings.perMarketplaceEnabled) {
    const mp = settings.marketplaceRules?.[marketplace];
    if (mp?.active) {
      return { price: priceFromRule(product.erpPrice, mp.rule, mp.rounding), source: 'marketplace', rule: mp.rule };
    }
  }
  return {
    price: priceFromRule(product.erpPrice, settings.defaultRule, settings.rounding),
    source: 'default',
    rule: settings.defaultRule,
  };
}
