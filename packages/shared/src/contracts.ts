import { z } from 'zod';
import { MARKETPLACES, ROUNDING_OPTIONS } from '../../core/src/constants.js';
import { RECON_REFERENCES, RECON_STATUSES } from '../../core/src/recon/status.js';
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
}).strict();
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
const categoryKey = { categoryId: z.uuid(), subcategoryId: z.uuid().nullable().optional() };
export const categoryPriceRule = ruleWith(categoryKey);
export const categoryPriceRuleKey = z.object(categoryKey).strict();
export const productOffer = z.object({
  price: threeDecimals(z.number().gt(0).lt(MAX_MONEY)),
  validFrom: z.iso.datetime({ offset: true }).nullable().optional(),
  validUntil: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict().refine(v => !v.validFrom || !v.validUntil || new Date(v.validUntil) > new Date(v.validFrom), { message: 'validUntil must be after validFrom', path: ['validUntil'] });

// ───────── Reconciliation ─────────
export const reconReference = z.enum(RECON_REFERENCES);
/** Without a reference, the tenant's compareReferenceDefault (pricing settings) applies. */
export const reconSummaryQuery = z.object({ reference: reconReference.optional() }).strict();
export const reconRowsQuery = z.object({
  marketplaceId: z.enum(MARKETPLACES),
  /** stock = a stock issue; price = a price mismatch for the reference; all = every row (urgent first). */
  type: z.enum(['stock', 'price', 'all']).default('all'),
  status: z.enum(RECON_STATUSES).optional(),
  reference: reconReference.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
}).strict();
