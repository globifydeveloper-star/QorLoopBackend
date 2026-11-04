/**
 * When a product may go live (board C3). Single activation (PATCH status, including re-activating an inactive
 * product) and bulk activation (POST /api/products/activate) both pass DEFAULT_READINESS_RULES through this one
 * function, so the rules below are the only switch.
 */
export interface ReadinessRules {
  requireArabicName: boolean;
  requireCategory: boolean;
  requireSubcategory: boolean;
}

/**
 * Owner decision 2026-11-04: neither an Arabic name nor a category is required to activate, for now.
 * Set requireArabicName / requireCategory back to true here to block activation on them again.
 */
export const DEFAULT_READINESS_RULES: Readonly<ReadinessRules> = Object.freeze({
  requireArabicName: false,
  requireCategory: false,
  requireSubcategory: false,
});

export type ReadinessGap = 'nameAr' | 'category' | 'subcategory';

export const READINESS_REASONS: Record<ReadinessGap, string> = {
  nameAr: 'Arabic name missing',
  category: 'Category missing',
  subcategory: 'Subcategory missing',
};

export interface ReadinessInput {
  nameAr: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
}

/** A blank Arabic name counts as missing. */
const lacksArabicName = (p: Pick<ReadinessInput, 'nameAr'>) => !p.nameAr?.trim();
const lacksCategory = (p: Pick<ReadinessInput, 'categoryId'>) => !p.categoryId;

export function isReady(product: ReadinessInput, rules: ReadinessRules = DEFAULT_READINESS_RULES): { ready: boolean; missing: ReadinessGap[] } {
  const missing: ReadinessGap[] = [];
  if (rules.requireArabicName && lacksArabicName(product)) missing.push('nameAr');
  if (rules.requireCategory && lacksCategory(product)) missing.push('category');
  if (rules.requireSubcategory && !product.subcategoryId) missing.push('subcategory');
  return { ready: missing.length === 0, missing };
}

/** Non-blocking: which optional details a product still lacks, whatever the rules require. Derived, never stored. */
export function missingDetails(product: Pick<ReadinessInput, 'nameAr' | 'categoryId'>): { arabicNameMissing: boolean; categoryMissing: boolean } {
  return { arabicNameMissing: lacksArabicName(product), categoryMissing: lacksCategory(product) };
}
