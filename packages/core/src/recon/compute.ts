import type { MarketplaceId } from '../constants.js';
import { toFils } from '../money.js';
import { PRICE_RULE_ORDER, resolveMarketplacePrice, type CategoryRuleItem, type PricingSettingsSnapshot, type ProductPricingInput } from '../pricing.js';
import { reconcile, type ReconListing, type ReconProduct, type ReconResult, type ReconSettings } from './status.js';

export interface ReconMarketplace {
  marketplaceId: MarketplaceId;
  /** At least one applied upload. */
  hasData: boolean;
}

export interface ReconCatalogueProduct extends ReconProduct {
  id: string;
  pricing: ProductPricingInput;
}

export interface ReconRowResult extends ReconResult {
  productId: string;
  marketplaceId: MarketplaceId;
}

/**
 * Which marketplaces get reconciled: an explicit tenant_marketplaces row decides (enabled or not); a marketplace without
 * a row counts as enabled once it has an applied upload (tenants provisioned before the switch existed have no rows).
 */
export function enabledMarketplaces(
  all: readonly MarketplaceId[],
  switches: { marketplaceId: string; enabled: boolean }[],
  applied: ReadonlySet<string>,
): ReconMarketplace[] {
  const explicit = new Map(switches.map(s => [s.marketplaceId, s.enabled]));
  return all
    .filter(id => explicit.get(id) ?? applied.has(id))
    .map(marketplaceId => ({ marketplaceId, hasData: applied.has(marketplaceId) }));
}

/**
 * One row per product x enabled marketplace. `listings` is keyed `${marketplaceId}:${productId}`.
 * The Marketplace price is resolved per marketplace, so a per-marketplace rule is honoured when it is switched on.
 */
export function computeReconRows(
  products: ReconCatalogueProduct[],
  marketplaces: ReconMarketplace[],
  listings: ReadonlyMap<string, ReconListing>,
  pricing: { snapshot: PricingSettingsSnapshot; categoryRules: CategoryRuleItem[] },
  settings: ReconSettings,
  now: Date,
): ReconRowResult[] {
  const rows: ReconRowResult[] = [];
  const marketplaceStep = PRICE_RULE_ORDER.indexOf('marketplace');
  // The per-marketplace step can only decide for a marketplace that has its own rule while the switch is on.
  const ownRule = new Set(pricing.snapshot.perMarketplaceEnabled ? Object.keys(pricing.snapshot.marketplaceRules ?? {}) : []);
  for (const p of products) {
    // Resolved once per product; again per marketplace only where that marketplace's rule could win.
    const agnostic = resolveMarketplacePrice(p.pricing, pricing.snapshot, pricing.categoryRules, { now });
    const decided = PRICE_RULE_ORDER.indexOf(agnostic.source) < marketplaceStep;
    for (const m of marketplaces) {
      const price = decided || !ownRule.has(m.marketplaceId)
        ? agnostic
        : resolveMarketplacePrice(p.pricing, pricing.snapshot, pricing.categoryRules, { marketplace: m.marketplaceId, now });
      const r = reconcile({ product: p, listing: listings.get(`${m.marketplaceId}:${p.id}`) ?? null, hasData: m.hasData, marketplacePrice: price }, settings);
      rows.push(Object.assign(r, { productId: p.id, marketplaceId: m.marketplaceId }));
    }
  }
  return rows;
}

/** `${marketplaceId}:${productId}`: the key of a row in diffs and listing maps. */
export const reconKey = (r: { productId: string; marketplaceId: string }) => `${r.marketplaceId}:${r.productId}`;
const fils = (v: number | null) => (v === null ? '' : String(toFils(v)));
const bit = (v: boolean | null) => (v === null ? '' : v ? '1' : '0');

/**
 * Every stored value of a row in one string (money in fils), so a computed row is compared with the stored one without
 * loading it as an object. ReconRepository.storedSignatures builds the same string in SQL: change both together.
 */
export function reconSignature(r: ReconRowResult): string {
  return `${r.status}|${r.statusVsErp}|${r.stockIssue ?? ''}|${bit(r.priceMismatchVsErp)}|${bit(r.priceMismatchVsMarketplace)}|${bit(r.erpAvailable)}`
    + `|${bit(r.actualAvailable)}|${r.marketplacePriceSource}|${fils(r.marketplacePrice)}|${fils(r.erpPrice)}|${fils(r.actualPrice)}`;
}

/**
 * What to write so the stored rows become exactly `computed`: new rows, changed rows, and stored rows that no longer
 * qualify (a marketplace switched off). Unchanged rows are left alone. `stored` maps reconKey to reconSignature.
 */
export function diffReconRows(stored: ReadonlyMap<string, string>, computed: ReconRowResult[]) {
  const insert: ReconRowResult[] = [];
  const update: ReconRowResult[] = [];
  let matched = 0;
  for (const r of computed) {
    const old = stored.get(`${r.marketplaceId}:${r.productId}`);
    if (old === undefined) insert.push(r);
    else {
      matched++;
      if (old !== reconSignature(r)) update.push(r);
    }
  }
  // every stored row was matched (the usual case): nothing to remove, and no key set to build
  const remove: { productId: string; marketplaceId: string }[] = [];
  if (matched < stored.size) {
    const keep = new Set(computed.map(reconKey));
    for (const key of stored.keys()) {
      if (keep.has(key)) continue;
      const at = key.indexOf(':');
      remove.push({ marketplaceId: key.slice(0, at), productId: key.slice(at + 1) });
    }
  }
  return { insert, update, remove };
}
