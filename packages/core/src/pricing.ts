import type { MarketplaceId, RoundingOption, RuleMode } from './constants.js';
import { roundFils, toFils, toQar } from './money.js';

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
  marketplaceRules?: Partial<Record<MarketplaceId, { active: boolean; markup: number; rounding: RoundingOption }>>;
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

/** Unrounded result of a rule, in QAR. Prefer priceFromRule, which also rounds. */
export function applyRule(erpPrice: number, rule: PriceRule): number {
  switch (rule.mode) {
    case 'percent': return toQar(toFils(erpPrice) * (1 + rule.value / 100));
    case 'amount': return toQar(toFils(erpPrice) + toFils(rule.value));
    case 'fixed': return rule.value;
    case 'same':
    default: return erpPrice;
  }
}

/**
 * Calculated prices (percent, amount) are rounded to the tenant step; fixed, same and offers are used
 * exactly as entered. Maths is done in integer fils to avoid float noise.
 */
export function priceFromRule(erpPrice: number, rule: PriceRule, rounding: RoundingOption): number {
  const erp = toFils(erpPrice);
  switch (rule.mode) {
    case 'percent':
      return toQar(roundFils(erp * (1 + rule.value / 100), rounding));
    case 'amount':
      return toQar(roundFils(erp + toFils(rule.value), rounding));
    case 'fixed':
      return toQar(toFils(rule.value));
    case 'same':
    default:
      return toQar(erp);
  }
}

export function resolveMarketplacePrice(
  product: ProductPricingInput,
  settings: PricingSettingsSnapshot,
  categoryRules: CategoryRuleItem[] = [],
  marketplace?: MarketplaceId
): ResolvedPrice {
  // 1. Offer
  if (product.offerPrice !== undefined && product.offerPrice !== null) {
    return { price: toQar(toFils(product.offerPrice)), source: 'offer' };
  }

  // 2. Product Rule
  if (product.productRule) {
    return {
      price: priceFromRule(product.erpPrice, product.productRule, settings.rounding),
      source: 'product',
      rule: product.productRule
    };
  }

  // 3. Subcategory Rule
  if (product.subcategoryId) {
    const subcatRule = categoryRules.find((r) => r.subcategoryId === product.subcategoryId);
    if (subcatRule) {
      return {
        price: priceFromRule(product.erpPrice, subcatRule.rule, settings.rounding),
        source: 'subcategory',
        rule: subcatRule.rule
      };
    }
  }

  // 4. Category Rule
  if (product.categoryId) {
    const catRule = categoryRules.find((r) => r.categoryId === product.categoryId && !r.subcategoryId);
    if (catRule) {
      return {
        price: priceFromRule(product.erpPrice, catRule.rule, settings.rounding),
        source: 'category',
        rule: catRule.rule
      };
    }
  }

  // 5. Per-Marketplace Rule
  if (marketplace && settings.perMarketplaceEnabled && settings.marketplaceRules) {
    const mpRule = settings.marketplaceRules[marketplace];
    if (mpRule && mpRule.active) {
      const rule: PriceRule = { mode: 'percent', value: mpRule.markup };
      return {
        price: priceFromRule(product.erpPrice, rule, mpRule.rounding),
        source: 'marketplace',
        rule
      };
    }
  }

  // 6. Default Rule
  return {
    price: priceFromRule(product.erpPrice, settings.defaultRule, settings.rounding),
    source: 'default',
    rule: settings.defaultRule
  };
}
