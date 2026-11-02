import type { Prisma } from './generated/client.js';
import type { RoundingOption, RuleMode } from '../../core/src/constants.js';
import type { CategoryRuleItem, PriceRule, PricingSettingsSnapshot } from '../../core/src/pricing.js';

type Tx = Prisma.TransactionClient;
type Decimalish = { toNumber(): number };
const asRule = (mode: string, value: Decimalish): PriceRule => ({ mode: mode as RuleMode, value: value.toNumber() });

/** A rule as stored: 'same' keeps value 0. */
export type StoredRule = { mode: string; value: number };
export type PricingSettingsWrite = Pick<Prisma.PricingSettingsUncheckedCreateInput,
  'defaultRuleMode' | 'defaultRuleValue' | 'rounding' | 'perMarketplaceEnabled' | 'compareReferenceDefault'>;

/** Product rules per statement of upsertProductRules. */
export const PRODUCT_RULE_WRITE_BATCH = 5_000;

const ruleSelect ={ id: true, mode: true, value: true, updatedAt: true } satisfies Prisma.CategoryPriceRuleSelect;

/**
 * Every method adds tenant_id. Rows with a nullable column in their unique key (category rules without a
 * subcategory, tenant-wide marketplace rules) are not deduplicated by PostgreSQL, so they are found and then
 * updated or created; the request's tenant row lock (Database.run) makes that safe.
 */
export class PricingRepository {
  constructor(private readonly tenantId: string, private readonly tx: Tx) {}

  settings() {
    return this.tx.pricingSettings.findUnique({
      where: { tenantId: this.tenantId },
      select: { defaultRuleMode: true, defaultRuleValue: true, rounding: true, perMarketplaceEnabled: true, compareReferenceDefault: true, updatedAt: true },
    });
  }
  /** Settings and every tenant-level rule in the pricing engine's shape, read once; products are then priced without further queries. */
  async snapshot() {
    const [settings, marketplaceRules, categoryRules] = await Promise.all([this.settings(), this.marketplaceRules(), this.categoryRules()]);
    const snapshot: PricingSettingsSnapshot = {
      defaultRule: settings ? asRule(settings.defaultRuleMode, settings.defaultRuleValue) : { mode: 'same', value: 0 },
      rounding: (settings?.rounding ?? 'exact') as RoundingOption,
      perMarketplaceEnabled: settings?.perMarketplaceEnabled ?? false,
      marketplaceRules: Object.fromEntries(marketplaceRules.map(r => [r.marketplaceId, { ...asRule(r.mode, r.value), rounding: r.rounding as RoundingOption }])),
    };
    const rules: CategoryRuleItem[] = categoryRules.map(r => ({ categoryId: r.categoryId, subcategoryId: r.subcategoryId, rule: asRule(r.mode, r.value) }));
    return { settings, snapshot, marketplaceRules, categoryRules: rules, categoryRuleRows: categoryRules };
  }
  saveSettings(data: PricingSettingsWrite) {
    return this.tx.pricingSettings.upsert({ where: { tenantId: this.tenantId }, create: { ...data, tenantId: this.tenantId }, update: data });
  }

  /** Tenant-wide per-marketplace rules (product_id null); per-product marketplace rules are not used yet. */
  marketplaceRules() {
    return this.tx.marketplacePriceRule.findMany({
      where: { tenantId: this.tenantId, productId: null }, orderBy: { marketplaceId: 'asc' },
      select: { marketplaceId: true, mode: true, value: true, rounding: true },
    });
  }
  async setMarketplaceRule(marketplaceId: string, rule: StoredRule & { rounding: string }) {
    const r = await this.tx.marketplacePriceRule.updateMany({ where: { tenantId: this.tenantId, marketplaceId, productId: null }, data: rule });
    if (!r.count) await this.tx.marketplacePriceRule.create({ data: { ...rule, tenantId: this.tenantId, marketplaceId } });
  }
  deleteMarketplaceRule(marketplaceId: string) {
    return this.tx.marketplacePriceRule.deleteMany({ where: { tenantId: this.tenantId, marketplaceId, productId: null } });
  }

  categoryRules() {
    return this.tx.categoryPriceRule.findMany({
      where: { tenantId: this.tenantId }, orderBy: [{ categoryId: 'asc' }, { subcategoryId: 'asc' }],
      select: { ...ruleSelect, categoryId: true, subcategoryId: true },
    });
  }
  categoryRule(categoryId: string, subcategoryId: string | null) {
    return this.tx.categoryPriceRule.findFirst({ where: { tenantId: this.tenantId, categoryId, subcategoryId }, select: ruleSelect });
  }
  async setCategoryRule(categoryId: string, subcategoryId: string | null, rule: StoredRule) {
    const r = await this.tx.categoryPriceRule.updateMany({ where: { tenantId: this.tenantId, categoryId, subcategoryId }, data: rule });
    if (!r.count) await this.tx.categoryPriceRule.create({ data: { ...rule, tenantId: this.tenantId, categoryId, subcategoryId } });
  }
  async deleteCategoryRule(categoryId: string, subcategoryId: string | null) {
    return (await this.tx.categoryPriceRule.deleteMany({ where: { tenantId: this.tenantId, categoryId, subcategoryId } })).count;
  }

  /** One query for any number of products (a page of the list). */
  productRules(productIds: string[]) {
    return this.tx.productPriceRule.findMany({ where: { tenantId: this.tenantId, productId: { in: productIds } }, select: { ...ruleSelect, productId: true } });
  }
  setProductRule(productId: string, rule: StoredRule) {
    return this.tx.productPriceRule.upsert({
      where: { tenantId_productId: { tenantId: this.tenantId, productId } },
      create: { ...rule, tenantId: this.tenantId, productId }, update: rule,
    });
  }
  async deleteProductRule(productId: string) {
    return (await this.tx.productPriceRule.deleteMany({ where: { tenantId: this.tenantId, productId } })).count;
  }
  /**
   * Creates or replaces many product rules: one INSERT ... SELECT FROM unnest(...) per PRODUCT_RULE_WRITE_BATCH rules,
   * three array bind parameters whatever the batch size. Values are sent as 3-decimal text (DECIMAL(12,3) exactly);
   * timestamps are cut to milliseconds like the upload apply, so updatedAt read back as a JS Date matches the row.
   */
  async upsertProductRules(rules: { productId: string; mode: string; value: number }[]) {
    let written = 0;
    for (let i = 0; i < rules.length; i += PRODUCT_RULE_WRITE_BATCH) {
      const c = rules.slice(i, i + PRODUCT_RULE_WRITE_BATCH);
      written += await this.tx.$executeRaw`
        INSERT INTO product_price_rules (id, tenant_id, product_id, mode, value, created_at, updated_at)
        SELECT gen_random_uuid(), ${this.tenantId}::uuid, v.product_id, v.mode, v.value::numeric, date_trunc('milliseconds', now()), date_trunc('milliseconds', now())
        FROM unnest(${c.map(r => r.productId)}::uuid[], ${c.map(r => r.mode)}::text[], ${c.map(r => r.value.toFixed(3))}::text[]) AS v(product_id, mode, value)
        ON CONFLICT (tenant_id, product_id) DO UPDATE SET mode = EXCLUDED.mode, value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
    }
    return written;
  }

  /** Removes the rules of many products in one statement (one uuid[] bind parameter whatever the count). */
  async deleteProductRules(productIds: string[]) {
    if (!productIds.length) return 0;
    return this.tx.$executeRaw`
      DELETE FROM product_price_rules WHERE tenant_id = ${this.tenantId}::uuid AND product_id = ANY(${productIds}::uuid[])`;
  }

  /**
   * The bulk price change applied with this idempotency key since `since` (its single 'pricing.bulk_applied' audit
   * event, which stores the key). The created_at bound keeps the lookup on the (tenant_id, created_at) index.
   */
  bulkOperation(idempotencyKey: string, since: Date) {
    return this.tx.auditEvent.findFirst({
      where: { tenantId: this.tenantId, action: 'pricing.bulk_applied', createdAt: { gte: since }, details: { path: ['idempotencyKey'], equals: idempotencyKey } },
      orderBy: { createdAt: 'desc' }, select: { id: true, details: true, createdAt: true },
    });
  }

  offers(productIds: string[]) {
    return this.tx.productOffer.findMany({
      where: { tenantId: this.tenantId, productId: { in: productIds } }, orderBy: { createdAt: 'asc' },
      select: { id: true, productId: true, price: true, validFrom: true, validUntil: true, updatedAt: true },
    });
  }
  /** A product has at most one offer through the API: setting one replaces any other. */
  async replaceOffer(productId: string, offer: { price: number; validFrom: Date | null; validUntil: Date | null }) {
    await this.tx.productOffer.deleteMany({ where: { tenantId: this.tenantId, productId } });
    await this.tx.productOffer.create({ data: { ...offer, tenantId: this.tenantId, productId } });
  }
  async deleteOffers(productId: string) {
    return (await this.tx.productOffer.deleteMany({ where: { tenantId: this.tenantId, productId } })).count;
  }
}
