/**
 * When a new product may go live (board C3). The default asks for an Arabic name and a category; a store can
 * change the rules later, so every caller passes them through this one function.
 */
export interface ReadinessRules {
  requireArabicName: boolean;
  requireCategory: boolean;
  requireSubcategory: boolean;
}

export const DEFAULT_READINESS_RULES: Readonly<ReadinessRules> = Object.freeze({
  requireArabicName: true,
  requireCategory: true,
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

export function isReady(product: ReadinessInput, rules: ReadinessRules = DEFAULT_READINESS_RULES): { ready: boolean; missing: ReadinessGap[] } {
  const missing: ReadinessGap[] = [];
  if (rules.requireArabicName && !product.nameAr?.trim()) missing.push('nameAr');
  if (rules.requireCategory && !product.categoryId) missing.push('category');
  if (rules.requireSubcategory && !product.subcategoryId) missing.push('subcategory');
  return { ready: missing.length === 0, missing };
}
