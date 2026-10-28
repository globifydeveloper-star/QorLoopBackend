export const MARKETPLACES = ['talabat', 'snoonu', 'rafeeq', 'keeta'] as const;
export type MarketplaceId = (typeof MARKETPLACES)[number];

export const ERP_OWNED_FIELDS = [
  'barcode', 'sku', 'name_en', 'brand', 'size', 'erp_category',
  'erp_price', 'cost_price', 'erp_stock', 'erp_active', 'in_latest_erp_file'
] as const;

export const QORLOOP_MANAGED_FIELDS = [
  'name_ar', 'category_id', 'subcategory_id', 'image', 'status', 'price_rule', 'offers'
] as const;

export const DEFAULT_TENANT_SETTINGS = {
  priceTolerance: 0.0,
  stockThreshold: 0,
  staleHours: 12,
  mfaRequiredForAll: false,
  analystCanExport: true
} as const;

export const ROUNDING_OPTIONS = ['exact', '0.05', '0.25', '0.50'] as const;
export type RoundingOption = (typeof ROUNDING_OPTIONS)[number];

export const RULE_MODES = ['percent', 'amount', 'fixed', 'same'] as const;
export type RuleMode = (typeof RULE_MODES)[number];
