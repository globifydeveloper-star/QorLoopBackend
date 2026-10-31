import type { MarketplaceId, RoundingOption, RuleMode } from './constants.js';
import { roundFils, toFils, toQar } from './money.js';

export interface PriceRule {
  mode: RuleMode;
  value: number;
}

export type PriceSource = 'offer' | 'product' | 'subcategory' | 'category' | 'marketplace' | 'default';

/**
 * The order in which a marketplace price is chosen; the first step that has something to say wins:
 *   1. offer        - a product offer valid now (validFrom <= now <= validUntil, either end optional)
 *   2. product      - the product's own price rule
 *   3. subcategory  - the rule of the product's subcategory
 *   4. category     - the rule of the product's category (a category-level rule, not a subcategory one)
 *   5. marketplace  - the per-marketplace rule, only when perMarketplaceEnabled and a marketplace is asked for
 *   6. default      - the tenant default rule (always applies)
 * Open question Q9: the client may change this order. Reorder this list only; every caller walks it.
 */
export const PRICE_RULE_ORDER: readonly PriceSource[] = ['offer', 'product', 'subcategory', 'category', 'marketplace', 'default'];

export interface ResolvedPrice {
  price: number;
  source: PriceSource;
  rule?: PriceRule;
}

export interface MarketplaceRuleSetting extends PriceRule {
  rounding: RoundingOption;
}

export interface PricingSettingsSnapshot {
  defaultRule: PriceRule;
  rounding: RoundingOption;
  perMarketplaceEnabled?: boolean;
  marketplaceRules?: Partial<Record<MarketplaceId, MarketplaceRuleSetting>>;
}

export interface OfferInput {
  price: number;
  validFrom?: Date | null;
  validUntil?: Date | null;
}

export interface ProductPricingInput {
  erpPrice: number;
  offers?: OfferInput[] | null;
  productRule?: PriceRule | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
}

export interface CategoryRuleItem {
  categoryId: string;
  subcategoryId?: string | null;
  rule: PriceRule;
}

export interface ResolveOptions {
  /** The per-marketplace step only runs for a named marketplace. */
  marketplace?: MarketplaceId;
  /** When offers are judged; defaults to the current time. */
  now?: Date;
}

/** Unrounded result of a rule, in QAR. Prefer priceFromRule, which also rounds. */
export function applyRule(erpPrice: number, rule: PriceRule): number {
  switch (rule.mode) {
    case 'percent': return toQar(toFils(erpPrice) * (100 + rule.value) / 100);
    case 'amount': return toQar(toFils(erpPrice) + toFils(rule.value));
    case 'fixed': return rule.value;
    case 'same':
    default: return erpPrice;
  }
}

/**
 * Calculated prices (percent, amount) are rounded to the tenant step; fixed, same and offers are used
 * exactly as entered. Maths is done in integer fils to avoid float noise. A calculated price never goes
 * below 0 (a large negative amount on a cheap product).
 */
export function priceFromRule(erpPrice: number, rule: PriceRule, rounding: RoundingOption): number {
  const erp = toFils(erpPrice);
  switch (rule.mode) {
    case 'percent':
      // (100 + v) / 100 rather than 1 + v / 100: 5.5 x 1.15 stays 6325 fils for whole percentages
      return toQar(Math.max(0, roundFils(erp * (100 + rule.value) / 100, rounding)));
    case 'amount':
      return toQar(Math.max(0, roundFils(erp + toFils(rule.value), rounding)));
    case 'fixed':
      return toQar(toFils(rule.value));
    case 'same':
    default:
      return toQar(erp);
  }
}

/** validFrom <= now <= validUntil; a missing end is open. */
export function offerState(offer: OfferInput, now: Date): 'valid' | 'scheduled' | 'expired' {
  if (offer.validFrom && offer.validFrom.getTime() > now.getTime()) return 'scheduled';
  if (offer.validUntil && offer.validUntil.getTime() < now.getTime()) return 'expired';
  return 'valid';
}

/** What one step of the order says about a product, before the steps are compared. */
export type StepStatus = 'available' | 'not_set' | 'expired' | 'scheduled' | 'disabled';
export interface PriceStep {
  source: PriceSource;
  status: StepStatus;
  price?: number;
  rule?: PriceRule;
  rounding?: RoundingOption;
  offer?: OfferInput;
}

function evaluateStep(
  source: PriceSource,
  product: ProductPricingInput,
  settings: PricingSettingsSnapshot,
  categoryRules: CategoryRuleItem[],
  { marketplace, now = new Date() }: ResolveOptions,
): PriceStep {
  const fromRule = (rule: PriceRule, rounding = settings.rounding): PriceStep =>
    ({ source, status: 'available', price: priceFromRule(product.erpPrice, rule, rounding), rule, rounding });
  switch (source) {
    case 'offer': {
      const offers = product.offers ?? [];
      const states = offers.map(o => offerState(o, now));
      // Several valid offers should not happen (the API keeps one); the one that started last wins.
      const valid = offers.filter((_, i) => states[i] === 'valid')
        .sort((x, y) => (y.validFrom?.getTime() ?? -Infinity) - (x.validFrom?.getTime() ?? -Infinity))[0];
      if (valid) return { source, status: 'available', price: toQar(toFils(valid.price)), offer: valid };
      const scheduled = offers.find((_, i) => states[i] === 'scheduled');
      if (scheduled) return { source, status: 'scheduled', offer: scheduled };
      const expired = offers.find((_, i) => states[i] === 'expired');
      return expired ? { source, status: 'expired', offer: expired } : { source, status: 'not_set' };
    }
    case 'product':
      return product.productRule ? fromRule(product.productRule) : { source, status: 'not_set' };
    case 'subcategory': {
      const r = product.subcategoryId ? categoryRules.find(c => c.subcategoryId === product.subcategoryId) : undefined;
      return r ? fromRule(r.rule) : { source, status: 'not_set' };
    }
    case 'category': {
      const r = product.categoryId ? categoryRules.find(c => c.categoryId === product.categoryId && !c.subcategoryId) : undefined;
      return r ? fromRule(r.rule) : { source, status: 'not_set' };
    }
    case 'marketplace': {
      if (!settings.perMarketplaceEnabled) return { source, status: 'disabled' };
      const r = marketplace ? settings.marketplaceRules?.[marketplace] : undefined;
      return r ? fromRule({ mode: r.mode, value: r.value }, r.rounding) : { source, status: 'not_set' };
    }
    case 'default':
      return fromRule(settings.defaultRule);
  }
}

const resolved = (step: PriceStep): ResolvedPrice =>
  ({ price: step.price!, source: step.source, ...(step.rule ? { rule: step.rule } : {}) });

/** The price a marketplace should show: the first available step of PRICE_RULE_ORDER. */
export function resolveMarketplacePrice(
  product: ProductPricingInput,
  settings: PricingSettingsSnapshot,
  categoryRules: CategoryRuleItem[] = [],
  options: ResolveOptions = {},
): ResolvedPrice {
  for (const source of PRICE_RULE_ORDER) {
    const step = evaluateStep(source, product, settings, categoryRules, options);
    if (step.status === 'available') return resolved(step);
  }
  // PRICE_RULE_ORDER always holds 'default', which always applies; this keeps an edited list safe.
  return resolved(evaluateStep('default', product, settings, categoryRules, options));
}

export type ChainStatus = 'applied' | 'overridden' | Exclude<StepStatus, 'available'>;
export interface PriceChainStep extends Omit<PriceStep, 'status'> { status: ChainStatus }

/**
 * Every step of PRICE_RULE_ORDER for one product, so a screen can explain the price: the step that won is
 * 'applied', later ones that exist are 'overridden'. resolved is always resolveMarketplacePrice's answer.
 */
export function priceRuleChain(
  product: ProductPricingInput,
  settings: PricingSettingsSnapshot,
  categoryRules: CategoryRuleItem[] = [],
  options: ResolveOptions = {},
): { resolved: ResolvedPrice; steps: PriceChainStep[] } {
  const winner = resolveMarketplacePrice(product, settings, categoryRules, options);
  const steps = PRICE_RULE_ORDER.map((source): PriceChainStep => {
    const { status, ...step } = evaluateStep(source, product, settings, categoryRules, options);
    if (status !== 'available') return { ...step, status };
    return { ...step, status: source === winner.source ? 'applied' : 'overridden' };
  });
  return { resolved: winner, steps };
}
