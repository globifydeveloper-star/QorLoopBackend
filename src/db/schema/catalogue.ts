import { pgTable, uuid, text, timestamp, boolean, integer, numeric, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';
import { marketplaces } from './marketplaces.js';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    sort: integer('sort').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index('categories_tenant_idx').on(t.tenantId)]
);

export const categoryMappings = pgTable(
  'category_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
    marketplaceId: text('marketplace_id').notNull().references(() => marketplaces.id),
    marketplaceCategory: text('marketplace_category').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex('category_mappings_tenant_cat_mp_idx').on(t.tenantId, t.categoryId, t.marketplaceId)]
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    barcode: text('barcode').notNull(),
    normalizedBarcode: text('normalized_barcode').notNull(),
    sku: text('sku').notNull(),
    // ERP-owned fields:
    nameEn: text('name_en').notNull(),
    brand: text('brand'),
    size: text('size'),
    erpCategory: text('erp_category'),
    erpPrice: numeric('erp_price', { precision: 12, scale: 3 }).notNull(),
    costPrice: numeric('cost_price', { precision: 12, scale: 3 }),
    erpStock: integer('erp_stock').notNull().default(0),
    erpActive: boolean('erp_active').notNull().default(true),
    inLatestErpFile: boolean('in_latest_erp_file').notNull().default(true),
    // Qorloop-managed fields:
    nameAr: text('name_ar'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    subcategoryId: uuid('subcategory_id').references(() => categories.id, { onDelete: 'set null' }),
    image: text('image'),
    status: text('status', { enum: ['active', 'inactive', 'new'] }).notNull().default('active'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('products_tenant_normalized_barcode_idx').on(t.tenantId, t.normalizedBarcode),
    index('products_tenant_sku_idx').on(t.tenantId, t.sku),
    index('products_tenant_category_idx').on(t.tenantId, t.categoryId)
  ]
);

export const listings = pgTable(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    marketplaceId: text('marketplace_id').notNull().references(() => marketplaces.id),
    marketplaceProductId: text('marketplace_product_id').notNull(),
    barcodes: text('barcodes').array(),
    name: text('name').notNull(),
    price: numeric('price', { precision: 12, scale: 3 }).notNull(),
    available: boolean('available').notNull().default(true),
    uploadId: uuid('upload_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex('listings_tenant_mp_product_idx').on(t.tenantId, t.marketplaceId, t.marketplaceProductId)]
);
