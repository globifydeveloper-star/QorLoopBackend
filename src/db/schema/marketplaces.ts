import { pgTable, text, uuid, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

export const marketplaces = pgTable('marketplaces', {
  id: text('id').primaryKey(), // 'talabat', 'snoonu', 'rafeeq', 'keeta'
  name: text('name').notNull()
});

export const tenantMarketplaces = pgTable(
  'tenant_marketplaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    marketplaceId: text('marketplace_id').notNull().references(() => marketplaces.id),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex('tenant_marketplaces_tenant_mp_idx').on(t.tenantId, t.marketplaceId)]
);
