import { pgTable, uuid, text, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';
import { marketplaces } from './marketplaces.js';
import { tenants } from './tenancy.js';

export const outputTemplates = pgTable('output_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  marketplaceId: text('marketplace_id').notNull().references(() => marketplaces.id),
  name: text('name').notNull(),
  format: text('format', { enum: ['xlsx', 'csv'] }).notNull().default('xlsx'),
  columns: jsonb('columns').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const generatedFiles = pgTable('generated_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  marketplaceId: text('marketplace_id').notNull().references(() => marketplaces.id),
  fileName: text('file_name').notNull(),
  storageKey: text('storage_key').notNull(),
  rowCount: integer('row_count').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
});
