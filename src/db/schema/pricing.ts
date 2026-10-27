import { pgTable, uuid, text, numeric, timestamp, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';
import { categories, products } from './catalogue.js';
import { marketplaces } from './marketplaces.js';

export const pricingSettings = pgTable('pricing_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }).unique(),
  defaultRuleMode: text('default_rule_mode', { enum: ['percent', 'amount', 'fixed', 'same'] }).notNull().default('percent'),
  defaultRuleValue: numeric('default_rule_value', { precision: 12, scale: 3 }).notNull().default('10.000'),
  rounding: text('rounding', { enum: ['exact', '0.05', '0.25', '0.50'] }).notNull().default('0.25'),
  perMarketplaceEnabled: boolean('per_marketplace_enabled').notNull().default(false),
  compareReferenceDefault: text('compare_reference_default', { enum: ['erp', 'marketplace'] }).notNull().default('marketplace'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const categoryPriceRules = pgTable(
  'category_price_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
    subcategoryId: uuid('subcategory_id').references(() => categories.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['percent', 'amount', 'fixed', 'same'] }).notNull(),
    value: numeric('value', { precision: 12, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index('category_price_rules_tenant_cat_idx').on(t.tenantId, t.categoryId)]
);

export const productPriceRules = pgTable(
  'product_price_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }).unique(),
    mode: text('mode', { enum: ['percent', 'amount', 'fixed', 'same'] }).notNull(),
    value: numeric('value', { precision: 12, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  }
);

export const productOffers = pgTable('product_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }).unique(),
  price: numeric('price', { precision: 12, scale: 3 }).notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const marketplacePriceRules = pgTable(
  'marketplace_price_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    marketplaceId: text('marketplace_id').notNull().references(() => marketplaces.id),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['percent', 'amount', 'fixed', 'same'] }).notNull().default('percent'),
    value: numeric('value', { precision: 12, scale: 3 }).notNull(),
    rounding: text('rounding', { enum: ['exact', '0.05', '0.25', '0.50'] }).notNull().default('0.25'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  }
);
