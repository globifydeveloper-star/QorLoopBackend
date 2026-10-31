import type { Prisma } from './generated/client.js';

type Tx = Prisma.TransactionClient;

/** A rule as stored: 'same' keeps value 0. */
export type StoredRule = { mode: string; value: number };
export type PricingSettingsWrite = Pick<Prisma.PricingSettingsUncheckedCreateInput,
  'defaultRuleMode' | 'defaultRuleValue' | 'rounding' | 'perMarketplaceEnabled' | 'compareReferenceDefault'>;

const ruleSelect = { id: true, mode: true, value: true, updatedAt: true } satisfies Prisma.CategoryPriceRuleSelect;

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
