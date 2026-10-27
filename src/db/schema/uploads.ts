import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';
import { products } from './catalogue.js';

export const inputTemplates = pgTable('input_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  fields: jsonb('fields').notNull(),
  signature: text('signature').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    fileName: text('file_name').notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull(),
    contains: text('contains', { enum: ['full', 'partial'] }).notNull().default('full'),
    templateId: uuid('template_id').references(() => inputTemplates.id),
    uploadedBy: text('uploaded_by').notNull(),
    status: text('status', {
      enum: ['uploading', 'processing', 'needs_mapping', 'needs_review', 'applying', 'applied', 'rejected', 'failed', 'discarded']
    }).notNull().default('uploading'),
    step: text('step'),
    progress: integer('progress').notNull().default(0),
    summary: jsonb('summary'),
    errorMessage: text('error_message'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index('uploads_tenant_source_idx').on(t.tenantId, t.source)]
);

export const uploadRows = pgTable('upload_rows', {
  id: uuid('id').primaryKey().defaultRandom(),
  uploadId: uuid('upload_id').notNull().references(() => uploads.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  rowNumber: integer('row_number').notNull(),
  parsed: jsonb('parsed').notNull(),
  matchProductId: uuid('match_product_id').references(() => products.id),
  changeType: text('change_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const uploadErrors = pgTable('upload_errors', {
  id: uuid('id').primaryKey().defaultRandom(),
  uploadId: uuid('upload_id').notNull().references(() => uploads.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  row: integer('row').notNull(),
  column: text('column'),
  value: text('value'),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
