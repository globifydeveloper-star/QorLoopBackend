import { z } from 'zod';
import { MARKETPLACES, ROUNDING_OPTIONS } from '../../core/src/constants.js';
import { RECON_REFERENCES, RECON_STATUSES } from '../../core/src/recon/status.js';
import { ADOPT_MODES } from '../../core/src/price-adoption.js';
import { ACTIVITY_GROUPS } from '../../core/src/activity.js';
import { ERP_CHANGE_KINDS } from '../../core/src/upload/apply.js';
import { CONFLICT_CHOICES, STOCK_MAX, STOCK_REASON_MAX } from '../../core/src/catalogue-stock.js';
import { MARKETPLACE_STATUS_FILTERS } from '../../core/src/products/marketplace-view.js';
import {
  BULK_PERCENT_DECREASE_MAX, BULK_PERCENT_INCREASE_MAX, BULK_PRODUCT_IDS_MAX, BULK_ROUNDINGS, PRICE_CHANGE_MAX,
} from '../../core/src/price-change.js';
export const email = z.string().trim().email().max(254).transform(v => v.toLowerCase());
export const password = z.string().min(12).max(128);
export const role = z.enum(['owner', 'admin', 'catalogue_manager', 'analyst']);
export const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const acceptInvitation = z.object({ token, name: z.string().trim().min(1).max(100), password }).strict();
export const login = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const forgotPassword = z.object({ email }).strict();
export const resetPassword = z.object({ token, password }).strict();
export const mfaSetup = z.object({ password: z.string().min(1).max(128) }).strict();
export const mfaVerify = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const mfaRecovery = z.object({ code: token }).strict();
export const inviteMember = z.object({ email, role }).strict();
export const changeRole = z.object({ role }).strict();


// ───────── Uploads ─────────
export const uploadSource = z.enum(['erp', 'talabat', 'snoonu', 'rafeeq', 'keeta']);
export const createUpload = z.object({
  source: uploadSource,
  fileName: z.string().trim().min(1).max(200).refine(v => !/[\\/\u0000-\u001f]/.test(v), 'Invalid file name'),
  size: z.number().int().min(1).max(25 * 1024 * 1024),
  contains: z.enum(['full', 'partial']).default('full'),
}).strict();
export const confirmMapping = z.object({
  fields: z.record(z.string().max(60), z.string().max(300)),
  saveAs: z.string().trim().min(1).max(100).optional(),
}).strict();
/** PUT /api/templates/:source. fields lists only the fields to change (null unmaps an optional one); expectedVersion is the version read. */
export const updateTemplate = z.object({
  name: z.string().trim().min(1).max(100),
  expectedVersion: z.number().int().min(1),
  fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,59}$/, 'Unknown field'), z.string().max(300).nullable())
    .refine(f => Object.keys(f).length > 0, 'Change at least one field'),
}).strict();
export const reviewQuery = z.object({
  tab: z.enum(['price', 'stock', 'availability', 'new', 'unmatched', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

// ───────── Products & categories ─────────
export const productTab = z.enum(['all', 'active', 'inactive', 'new', 'missing']);
export const productListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  tab: productTab.default('all'),
  categoryId: z.uuid().optional(),
  subcategoryId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(1000).optional(),
  /** Adds each product's values on this marketplace (must be enabled for the store). */
  marketplaceId: z.enum(MARKETPLACES).optional(),
  /** Only with marketplaceId. */
  marketplaceStatus: z.enum(MARKETPLACE_STATUS_FILTERS).optional(),
}).strict().refine(q => !q.marketplaceStatus || q.marketplaceId, { path: ['marketplaceStatus'], message: 'marketplaceStatus needs marketplaceId' });
export const updateProduct = z.object({
  nameAr: z.string().trim().max(200).transform(v => v || null).optional(),
  categoryId: z.uuid().nullable().optional(),
  subcategoryId: z.uuid().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export const activateProducts = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
const categoryName = z.string().trim().min(1).max(100);
export const createCategory = z.object({
  nameEn: categoryName,
  nameAr: z.string().trim().max(100).transform(v => v || null).optional(),
  parentId: z.uuid().nullable().optional(),
  sort: z.number().int().min(-100000).max(100000).optional(),
}).strict();
export const updateCategory = z.object({
  nameEn: categoryName.optional(),
  nameAr: z.string().trim().max(100).transform(v => v || null).nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  sort: z.number().int().min(-100000).max(100000).optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
export const assignFromErp = z.object({
  erpCategories: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
}).strict();

// ───────── Pricing ─────────
/** Money and rule values are stored as DECIMAL(12,3): more decimals would be cut silently, so they are refused. */
const threeDecimals = (n: z.ZodNumber) => n.refine(v => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'At most 3 decimal places');
/** DECIMAL(12,3) holds less than 1,000,000,000. */
const MAX_MONEY = 1_000_000_000;
export const roundingOption = z.enum(ROUNDING_OPTIONS);
/** Flat {mode, value}; 'same' takes no value. Extra fields (a category, a marketplace) go alongside. */
const ruleWith = <S extends z.ZodRawShape>(extra: S) => z.discriminatedUnion('mode', [
  z.object({ ...extra, mode: z.literal('percent'), value: threeDecimals(z.number().min(-90).max(1000)) }).strict(),
  z.object({ ...extra, mode: z.literal('amount'), value: threeDecimals(z.number().min(-100000).max(100000)) }).strict(),
  z.object({ ...extra, mode: z.literal('fixed'), value: threeDecimals(z.number().gt(0).lt(MAX_MONEY)) }).strict(),
  z.object({ ...extra, mode: z.literal('same') }).strict(),
]);
export const priceRule = ruleWith({});
export const marketplacePriceRule = ruleWith({ marketplaceId: z.enum(MARKETPLACES), rounding: roundingOption });
export const updatePricingSettings = z.object({
  defaultRule: priceRule.optional(),
  rounding: roundingOption.optional(),
  perMarketplaceEnabled: z.boolean().optional(),
  compareReferenceDefault: z.enum(['marketplace', 'erp']).optional(),
  /** The full set of per-marketplace rules: a marketplace left out loses its rule. */
  marketplaceRules: z.array(marketplacePriceRule).max(MARKETPLACES.length)
    .refine(rules => new Set(rules.map(r => r.marketplaceId)).size === rules.length, 'One rule per marketplace').optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');

const settingsThresholds = z.object({
  priceTolerance: threeDecimals(z.number().min(0).max(100000)).optional(),
  stockThreshold: z.number().int().min(0).max(2147483647).optional(),
  staleHours: z.number().int().min(1).max(8760).optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
export const updateTenantSettings = z.object({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  profile: z.object({ name: z.string().trim().min(1).max(100) }).strict().optional(),
  thresholds: settingsThresholds.optional(),
  pricing: updatePricingSettings.optional(),
  security: z.object({ mfaRequiredForAll: z.boolean().optional(), analystCanExport: z.boolean().optional() })
    .strict().refine(v => Object.keys(v).length > 0, 'Nothing to change').optional(),
}).strict().refine(v => Object.keys(v).some(k => k !== 'expectedRevision'), 'Nothing to change');
const categoryKey = { categoryId: z.uuid(), subcategoryId: z.uuid().nullable().optional() };
export const categoryPriceRule = ruleWith(categoryKey);
export const categoryPriceRuleKey = z.object(categoryKey).strict();
export const productOffer = z.object({
  price: threeDecimals(z.number().gt(0).lt(MAX_MONEY)),
  validFrom: z.iso.datetime({ offset: true }).nullable().optional(),
  validUntil: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict().refine(v => !v.validFrom || !v.validUntil || new Date(v.validUntil) > new Date(v.validFrom), { message: 'validUntil must be after validFrom', path: ['validUntil'] });
/** Adopt the source marketplace's listing prices as product rules (preview and apply take the same body). */
export const adoptPrices = z.object({
  sourceMarketplaceId: z.enum(MARKETPLACES),
  mode: z.enum(ADOPT_MODES).default('fixed'),
  /** Never overwrite a product's own rule or offer. */
  onlyWithoutRule: z.boolean().default(true),
  scope: z.union([
    z.object({ all: z.literal(true) }).strict(),
    z.object({ categoryId: z.uuid(), subcategoryId: z.uuid().optional() }).strict(),
  ]),
}).strict();

/**
 * The version of the product rule the client last saw (pricing.productRule.updatedAt, or rule.updatedAt of an inline
 * answer): a different current rule gives 409. null = "I saw no rule"; omitted = no check.
 */
const expectedRuleUpdatedAt = z.iso.datetime({ offset: true }).nullable().optional();
const inlineKey = { marketplaceId: z.enum(MARKETPLACES), expectedRuleUpdatedAt };
/**
 * Inline price edit of one product, seen from one marketplace: a fixed price, or a percent over the ERP price. Stored as
 * the product's own rule, so it applies on every marketplace.
 */
export const inlinePrice = z.discriminatedUnion('mode', [
  z.object({ ...inlineKey, mode: z.literal('fixed'), value: threeDecimals(z.number().gt(0).max(PRICE_CHANGE_MAX)) }).strict(),
  z.object({ ...inlineKey, mode: z.literal('percent'), value: threeDecimals(z.number().min(-90).max(1000)) }).strict(),
]);
/** Query of DELETE /api/pricing/products/:id: the marketplace the answer is priced for, and the rule version seen. */
export const inlinePriceRemove = z.object({
  marketplaceId: z.enum(MARKETPLACES),
  expectedRuleUpdatedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

// ───────── Reconciliation ─────────
export const reconReference = z.enum(RECON_REFERENCES);

// ───────── Bulk price changes (preview and apply take the same body; apply adds the idempotency key) ─────────
/** A recon status of the stored row on the operation's marketplace, or price_mismatch (the price flag) for the reference. */
export const BULK_RECON_FILTERS = ['price_mismatch', ...RECON_STATUSES] as const;
export const bulkSelection = z.union([
  /** Explicit products (the list's checkboxes); unknown or other-store ids are counted as blocked, not_found. */
  z.object({ productIds: z.array(z.uuid()).min(1).max(BULK_PRODUCT_IDS_MAX) }).strict(),
  /** Every ACTIVE product matching all given conditions ({} = every active product); at most BULK_PRICE_LIMIT. */
  z.object({
    filter: z.object({
      /** The product list's search: English name (contains), SKU (exact), barcode (normalised, prefix). */
      q: z.string().trim().min(1).max(200).optional(),
      categoryId: z.uuid().optional(),
      subcategoryId: z.uuid().optional(),
      /** true: only products listed on the operation's marketplace; false: only products not listed there. */
      listed: z.boolean().optional(),
      reconStatus: z.enum(BULK_RECON_FILTERS).optional(),
      /** Which recon status reconStatus reads; default: the tenant's compareReferenceDefault. */
      reference: reconReference.optional(),
    }).strict(),
  }).strict(),
]);
const bulkRounding = { rounding: z.enum(BULK_ROUNDINGS).default('none') };
const bulkAmount = threeDecimals(z.number().gt(0).max(PRICE_CHANGE_MAX));
export const bulkAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_fixed'), price: threeDecimals(z.number().gt(0).max(PRICE_CHANGE_MAX)) }).strict(),
  z.object({ type: z.literal('increase_percent'), percent: threeDecimals(z.number().gt(0).max(BULK_PERCENT_INCREASE_MAX)), ...bulkRounding }).strict(),
  z.object({ type: z.literal('decrease_percent'), percent: threeDecimals(z.number().gt(0).max(BULK_PERCENT_DECREASE_MAX)), ...bulkRounding }).strict(),
  z.object({ type: z.literal('increase_amount'), amount: bulkAmount, ...bulkRounding }).strict(),
  z.object({ type: z.literal('decrease_amount'), amount: bulkAmount, ...bulkRounding }).strict(),
  z.object({ type: z.literal('match_marketplace') }).strict(),
  z.object({ type: z.literal('match_erp') }).strict(),
]);
const bulkShape = {
  /** Must be enabled for the store: prices are computed, compared and (match_marketplace) matched on it. */
  marketplaceId: z.enum(MARKETPLACES),
  selection: bulkSelection,
  action: bulkAction,
};
export const bulkPricePreview = z.object(bulkShape).strict();
export const bulkPriceApply = z.object({
  ...bulkShape,
  /** Chosen by the client once per intended change (a UUID): a repeat with the same key and body applies nothing again. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'Use 8-100 letters, digits, - or _ (a UUID works)'),
  /** previewToken from the preview: when the re-planned writes differ, 409 instead of applying something else. */
  previewToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
/** Without a reference, the tenant's compareReferenceDefault (pricing settings) applies. */
export const reconSummaryQuery = z.object({ reference: reconReference.optional() }).strict();
export const activityQuery = z.object({
  productId: z.uuid().optional(),
  eventType: z.enum(ACTIVITY_GROUPS).optional(),
  actorId: z.union([z.uuid(), z.literal('system')]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict().refine(v => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), { message: 'to must be on or after from', path: ['to'] });
export const reconRowsQuery = z.object({
  marketplaceId: z.enum(MARKETPLACES),
  /** stock = a stock issue; price = a price mismatch for the reference; all = every row (urgent first). */
  type: z.enum(['stock', 'price', 'all']).default('all'),
  status: z.enum(RECON_STATUSES).optional(),
  reference: reconReference.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
}).strict();

// Preview and generation intentionally take the same strict input.
export const generateMarketplaceFile = z.object({
  marketplaceId: z.enum(MARKETPLACES),
  kind: z.enum(['stock', 'price', 'stock_price']),
  scope: z.enum(['mismatches', 'all']).default('mismatches'),
  reference: reconReference.optional(),
}).strict();

// ───────── ERP change review & catalogue stock (ADR 017) ─────────
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(50);
/** A query-string boolean: only the words true and false. */
const queryBoolean = z.enum(['true', 'false']).transform(v => v === 'true');
export const uploadChangesQuery = z.object({
  /** new, price, cost (roles that may change prices only), stock, name, active, missing, returned, other, or all */
  kind: z.enum([...ERP_CHANGE_KINDS, 'all']).default('all'),
  /** true: only stock changes that raised a conflict with an owner-edited catalogue stock */
  conflict: queryBoolean.optional(),
  page, pageSize,
}).strict();
export const stockConflictsQuery = z.object({ page, pageSize }).strict();
export const stockValue = z.number().int().min(0).max(STOCK_MAX);
const stockReason = z.string().trim().max(STOCK_REASON_MAX).optional().transform(v => v || null);
/** Optimistic concurrency by value: the ERP stock and the catalogue stock as last shown; 409 when either moved. */
const stockExpected = z.object({ erpStock: stockValue, catalogueStock: stockValue }).strict();
export const setProductStock = z.object({ stock: stockValue, reason: stockReason, expected: stockExpected }).strict();
export const resetProductStock = z.object({ expectedErpStock: z.coerce.number().int().min(0).max(STOCK_MAX), expectedCatalogueStock: z.coerce.number().int().min(0).max(STOCK_MAX) }).strict();
export const resolveProductStock = z.object({
  choice: z.enum(CONFLICT_CHOICES),
  /** The conflict as last shown: 409 when the ERP or the owner value moved since. */
  expected: z.object({ erpStock: stockValue, ownerStock: stockValue }).strict(),
}).strict();
const stockSelection = z.union([
  z.object({ productIds: z.array(z.uuid()).min(1).max(BULK_PRODUCT_IDS_MAX) }).strict(),
  /** Every product (any status) matching all given conditions ({} = every product); at most STOCK_BULK_LIMIT. */
  z.object({
    filter: z.object({
      q: z.string().trim().min(1).max(200).optional(),
      categoryId: z.uuid().optional(),
      subcategoryId: z.uuid().optional(),
    }).strict(),
  }).strict(),
]);
const stockBulkShape = {
  selection: stockSelection,
  /** set: the owner's catalogue stock (the ERP's own value clears an edit); erp: back to the ERP stock */
  action: z.discriminatedUnion('mode', [z.object({ mode: z.literal('set'), stock: stockValue }).strict(), z.object({ mode: z.literal('erp') }).strict()]),
  reason: stockReason,
};
const idempotency = {
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'Use 8-100 letters, digits, - or _ (a UUID works)'),
  previewToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
};
export const stockBulkPreview = z.object(stockBulkShape).strict();
export const stockBulkApply = z.object({ ...stockBulkShape, ...idempotency }).strict();
const conflictShape = {
  /** explicit products, or every open conflict (at most STOCK_BULK_LIMIT) */
  selection: z.union([z.object({ productIds: z.array(z.uuid()).min(1).max(BULK_PRODUCT_IDS_MAX) }).strict(), z.object({ all: z.literal(true) }).strict()]),
  choice: z.enum(CONFLICT_CHOICES),
};
export const conflictsResolvePreview = z.object(conflictShape).strict();
export const conflictsResolveApply = z.object({ ...conflictShape, ...idempotency }).strict();
