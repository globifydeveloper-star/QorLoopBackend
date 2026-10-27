import { pgTable, uuid, text, numeric, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';
import { products } from './catalogue.js';
import { marketplaces } from './marketplaces.js';

export const reconRows = pgTable(
  'recon_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    marketplaceId: text('marketplace_id').notNull().references(() => marketplaces.id),
    marketplacePrice: numeric('marketplace_price', { precision: 12, scale: 3 }),
    marketplacePriceSource: text('marketplace_price_source'),
    erpPrice: numeric('erp_price', { precision: 12, scale: 3 }).notNull(),
    actualPrice: numeric('actual_price', { precision: 12, scale: 3 }),
    erpAvailable: boolean('erp_available').notNull().default(true),
    actualAvailable: boolean('actual_available'),
    priceMismatchVsErp: boolean('price_mismatch_vs_erp').notNull().default(false),
    priceMismatchVsMarketplace: boolean('price_mismatch_vs_marketplace').notNull().default(false),
    stockIssue: text('stock_issue', { enum: ['unavailable_but_in_stock', 'available_but_out_of_stock'] }),
    status: text('status', { enum: ['in_sync', 'mismatch', 'not_listed', 'missing_from_erp', 'new', 'no_data'] }).notNull(),
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex('recon_rows_tenant_prod_mp_idx').on(t.tenantId, t.productId, t.marketplaceId)]
);

export const reconSummary = pgTable(
  'recon_summary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    marketplaceId: text('marketplace_id').notNull().references(() => marketplaces.id),
    totalProducts: numeric('total_products').notNull().default('0'),
    inSync: numeric('in_sync').notNull().default('0'),
    mismatches: numeric('mismatches').notNull().default('0'),
    notListed: numeric('not_listed').notNull().default('0'),
    missingFromErp: numeric('missing_from_erp').notNull().default('0'),
    newProducts: numeric('new_products').notNull().default('0'),
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex('recon_summary_tenant_mp_idx').on(t.tenantId, t.marketplaceId)]
);
