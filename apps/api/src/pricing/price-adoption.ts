import { z } from 'zod';
import type { TenantData } from '../../../../packages/db/src/database.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';
import { toFils, toQar } from '../../../../packages/core/src/money.js';
import { largestAdoptionChanges, planPriceAdoption, type AdoptionPlan, type AdoptionRow } from '../../../../packages/core/src/price-adoption.js';
import { ruleView } from './pricing.data.js';

export type AdoptInput = z.infer<typeof contracts.adoptPrices>;
export const ADOPT_PREVIEW_ROWS = 10;

/**
 * The adoption plan from the recon's own inputs (every product with its rules and offers, one latest listing per
 * product and marketplace, the pricing snapshot and the recon tolerance), so the adopted price is the one the recon
 * compares against. Products are taken in the product list's order (name, id).
 */
export async function planAdoption(data: TenantData, input: AdoptInput, now = new Date()) {
  const [all, listings, pricing, settings, order] = await Promise.all([
    data.recon.products(), data.recon.listings([...MARKETPLACES]), data.pricing.snapshot(), data.recon.settings(), data.products.nameOrder(),
  ]);
  const { scope } = input;
  const products = ('all' in scope ? all : all.filter(p => p.pricing.categoryId === scope.categoryId && (!scope.subcategoryId || p.pricing.subcategoryId === scope.subcategoryId)))
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const plan = planPriceAdoption(products, listings, pricing, {
    source: input.sourceMarketplaceId, mode: input.mode, onlyWithoutRule: input.onlyWithoutRule, priceTolerance: settings.priceTolerance, now,
  });
  return { products: products.length, plan };
}

/** The counts both preview and apply report. */
export function adoptionCounts(products: number, plan: AdoptionPlan) {
  const replaced = plan.adopt.filter(r => r.previousRule).length;
  return {
    products, adopted: plan.adopt.length, created: plan.adopt.length - replaced, replaced,
    fixedFallback: plan.fallbacks.rounding + plan.fallbacks.range, fallbacks: plan.fallbacks, skipped: plan.skipped,
    conflicts: { products: plan.conflicts.products, byMarketplace: plan.conflicts.byMarketplace },
  };
}

/** Counts, conflict examples, the largest changes and the first rows, with names and barcodes; reads only. */
export async function adoptionPreview(data: TenantData, input: AdoptInput, products: number, plan: AdoptionPlan) {
  const largest = largestAdoptionChanges(plan.adopt, ADOPT_PREVIEW_ROWS);
  const first = plan.adopt.slice(0, ADOPT_PREVIEW_ROWS);
  const ids = [...new Set([...plan.conflicts.examples.map(c => c.productId), ...largest.map(r => r.productId), ...first.map(r => r.productId)])];
  const labels = new Map((ids.length ? await data.products.labels(ids) : []).map(l => [l.id, { nameEn: l.nameEn, barcode: l.barcode }]));
  const label = (id: string) => labels.get(id) ?? { nameEn: '', barcode: '' };
  const row = (r: AdoptionRow) => ({
    productId: r.productId, ...label(r.productId), erpPrice: r.erpPrice, currentPrice: r.currentPrice, currentSource: r.currentSource,
    newPrice: r.listingPrice, difference: toQar(toFils(r.listingPrice) - toFils(r.currentPrice)),
    rule: ruleView(r.rule.mode, r.rule.value), fallback: r.fallback, previousRule: r.previousRule ? ruleView(r.previousRule.mode, r.previousRule.value) : null,
  });
  const { adopted, ...counts } = adoptionCounts(products, plan);
  return {
    sourceMarketplaceId: input.sourceMarketplaceId, mode: input.mode, onlyWithoutRule: input.onlyWithoutRule, scope: input.scope,
    ...counts, willAdopt: adopted,
    conflicts: { ...counts.conflicts, examples: plan.conflicts.examples.map(c => ({ ...c, ...label(c.productId) })) },
    largestDifferences: largest.map(row),
    rows: first.map(row),
  };
}
