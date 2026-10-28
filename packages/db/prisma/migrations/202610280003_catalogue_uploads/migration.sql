-- CreateTable
CREATE TABLE "marketplaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_marketplaces" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_marketplaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "marketplace_category" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "category_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "barcode" TEXT NOT NULL,
    "normalized_barcode" TEXT NOT NULL,
    "sku" TEXT,
    "name_en" TEXT NOT NULL,
    "brand" TEXT,
    "size" TEXT,
    "erp_category" TEXT,
    "erp_price" DECIMAL(12,3) NOT NULL,
    "cost_price" DECIMAL(12,3),
    "erp_stock" INTEGER NOT NULL DEFAULT 0,
    "erp_active" BOOLEAN NOT NULL DEFAULT true,
    "in_latest_erp_file" BOOLEAN NOT NULL DEFAULT true,
    "name_ar" TEXT,
    "category_id" UUID,
    "subcategory_id" UUID,
    "image_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID,
    "marketplace_id" TEXT NOT NULL,
    "marketplace_product_id" TEXT NOT NULL,
    "barcodes" TEXT[],
    "name" TEXT,
    "price" DECIMAL(12,3) NOT NULL,
    "available" BOOLEAN NOT NULL,
    "upload_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "default_rule_mode" TEXT NOT NULL DEFAULT 'same',
    "default_rule_value" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rounding" TEXT NOT NULL DEFAULT 'exact',
    "per_marketplace_enabled" BOOLEAN NOT NULL DEFAULT false,
    "compare_reference_default" TEXT NOT NULL DEFAULT 'marketplace',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "pricing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_price_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "subcategory_id" UUID,
    "mode" TEXT NOT NULL,
    "value" DECIMAL(12,3) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "category_price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_price_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "value" DECIMAL(12,3) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "product_price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_offers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price" DECIMAL(12,3) NOT NULL,
    "valid_from" TIMESTAMPTZ,
    "valid_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "product_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_price_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "product_id" UUID,
    "mode" TEXT NOT NULL,
    "value" DECIMAL(12,3) NOT NULL,
    "rounding" TEXT NOT NULL DEFAULT 'exact',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "marketplace_price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "input_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "fields" JSONB NOT NULL,
    "signature" TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "input_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT,
    "size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "checksum_sha256" TEXT,
    "contains" TEXT NOT NULL DEFAULT 'full',
    "template_id" UUID,
    "template_version" INTEGER,
    "uploaded_by_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "step" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "headers" JSONB,
    "sheet_name" TEXT,
    "mapping_suggestion" JSONB,
    "summary" JSONB,
    "error_message" TEXT,
    "applied_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_rows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "upload_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "parsed" JSONB NOT NULL,
    "match_product_id" UUID,
    "change_type" TEXT NOT NULL DEFAULT 'none',

    CONSTRAINT "upload_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_errors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "upload_id" UUID NOT NULL,
    "row" INTEGER NOT NULL,
    "column" TEXT,
    "value" TEXT,
    "reason" TEXT NOT NULL,

    CONSTRAINT "upload_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recon_rows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "marketplace_price" DECIMAL(12,3),
    "marketplace_price_source" TEXT,
    "erp_price" DECIMAL(12,3),
    "actual_price" DECIMAL(12,3),
    "erp_available" BOOLEAN,
    "actual_available" BOOLEAN,
    "price_mismatch_vs_erp" BOOLEAN NOT NULL DEFAULT false,
    "price_mismatch_vs_marketplace" BOOLEAN NOT NULL DEFAULT false,
    "stock_issue" TEXT,
    "status" TEXT NOT NULL,
    "last_updated" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recon_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recon_summaries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "listed" INTEGER NOT NULL DEFAULT 0,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "price" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "has_data" BOOLEAN NOT NULL DEFAULT false,
    "last_upload_at" TIMESTAMPTZ,
    "stale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "recon_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "output_templates" (
    "id" UUID NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "columns" TEXT[],
    "configured" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "output_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "product_count" INTEGER NOT NULL,
    "generated_by_id" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "generated_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_marketplaces_tenant_id_marketplace_id_key" ON "tenant_marketplaces"("tenant_id", "marketplace_id");

-- CreateIndex
CREATE INDEX "categories_tenant_id_parent_id_idx" ON "categories"("tenant_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_id_key" ON "categories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "category_mappings_tenant_id_category_id_marketplace_id_key" ON "category_mappings"("tenant_id", "category_id", "marketplace_id");

-- CreateIndex
CREATE INDEX "products_tenant_id_sku_idx" ON "products"("tenant_id", "sku");

-- CreateIndex
CREATE INDEX "products_tenant_id_status_idx" ON "products"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_normalized_barcode_key" ON "products"("tenant_id", "normalized_barcode");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "listings_tenant_id_marketplace_id_product_id_idx" ON "listings"("tenant_id", "marketplace_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "listings_tenant_id_marketplace_id_marketplace_product_id_key" ON "listings"("tenant_id", "marketplace_id", "marketplace_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_settings_tenant_id_key" ON "pricing_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_price_rules_tenant_id_category_id_subcategory_id_key" ON "category_price_rules"("tenant_id", "category_id", "subcategory_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_price_rules_tenant_id_product_id_key" ON "product_price_rules"("tenant_id", "product_id");

-- CreateIndex
CREATE INDEX "product_offers_tenant_id_product_id_idx" ON "product_offers"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_price_rules_tenant_id_marketplace_id_product_id_key" ON "marketplace_price_rules"("tenant_id", "marketplace_id", "product_id");

-- CreateIndex
CREATE INDEX "input_templates_tenant_id_source_idx" ON "input_templates"("tenant_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "input_templates_tenant_id_source_name_version_key" ON "input_templates"("tenant_id", "source", "name", "version");

-- CreateIndex
CREATE INDEX "uploads_tenant_id_created_at_idx" ON "uploads"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "uploads_tenant_id_source_status_idx" ON "uploads"("tenant_id", "source", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uploads_tenant_id_id_key" ON "uploads"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uploads_tenant_id_storage_key_key" ON "uploads"("tenant_id", "storage_key");

-- CreateIndex
CREATE INDEX "upload_rows_tenant_id_upload_id_change_type_idx" ON "upload_rows"("tenant_id", "upload_id", "change_type");

-- CreateIndex
CREATE UNIQUE INDEX "upload_rows_upload_id_row_number_key" ON "upload_rows"("upload_id", "row_number");

-- CreateIndex
CREATE INDEX "upload_errors_tenant_id_upload_id_idx" ON "upload_errors"("tenant_id", "upload_id");

-- CreateIndex
CREATE INDEX "recon_rows_tenant_id_marketplace_id_status_idx" ON "recon_rows"("tenant_id", "marketplace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recon_rows_tenant_id_product_id_marketplace_id_key" ON "recon_rows"("tenant_id", "product_id", "marketplace_id");

-- CreateIndex
CREATE UNIQUE INDEX "recon_summaries_tenant_id_marketplace_id_key" ON "recon_summaries"("tenant_id", "marketplace_id");

-- CreateIndex
CREATE UNIQUE INDEX "output_templates_marketplace_id_name_version_key" ON "output_templates"("marketplace_id", "name", "version");

-- CreateIndex
CREATE INDEX "generated_files_tenant_id_generated_at_idx" ON "generated_files"("tenant_id", "generated_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_read_at_idx" ON "notifications"("tenant_id", "user_id", "read_at");

-- AddForeignKey
ALTER TABLE "tenant_marketplaces" ADD CONSTRAINT "tenant_marketplaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_marketplaces" ADD CONSTRAINT "tenant_marketplaces_marketplace_id_fkey" FOREIGN KEY ("marketplace_id") REFERENCES "marketplaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_settings" ADD CONSTRAINT "pricing_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_price_rules" ADD CONSTRAINT "category_price_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_rules" ADD CONSTRAINT "product_price_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_rules" ADD CONSTRAINT "product_price_rules_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_offers" ADD CONSTRAINT "product_offers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_offers" ADD CONSTRAINT "product_offers_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_price_rules" ADD CONSTRAINT "marketplace_price_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_templates" ADD CONSTRAINT "input_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_tenant_id_uploaded_by_id_fkey" FOREIGN KEY ("tenant_id", "uploaded_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_rows" ADD CONSTRAINT "upload_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_rows" ADD CONSTRAINT "upload_rows_tenant_id_upload_id_fkey" FOREIGN KEY ("tenant_id", "upload_id") REFERENCES "uploads"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_errors" ADD CONSTRAINT "upload_errors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_errors" ADD CONSTRAINT "upload_errors_tenant_id_upload_id_fkey" FOREIGN KEY ("tenant_id", "upload_id") REFERENCES "uploads"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recon_rows" ADD CONSTRAINT "recon_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recon_rows" ADD CONSTRAINT "recon_rows_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recon_summaries" ADD CONSTRAINT "recon_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_files_tenant_id_generated_by_id_fkey" FOREIGN KEY ("tenant_id", "generated_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── Integrity constraints beyond Prisma's declarative vocabulary ─────────────
ALTER TABLE "products" ADD CONSTRAINT "product_status_valid" CHECK ("status" IN ('active', 'inactive', 'new'));
ALTER TABLE "products" ADD CONSTRAINT "product_barcode_normalized" CHECK ("normalized_barcode" ~ '^[0-9]+$' AND "normalized_barcode" !~ '^0');
ALTER TABLE "products" ADD CONSTRAINT "product_money_valid" CHECK ("erp_price" >= 0 AND ("cost_price" IS NULL OR "cost_price" >= 0) AND "erp_stock" >= 0);
ALTER TABLE "listings" ADD CONSTRAINT "listing_price_valid" CHECK ("price" >= 0);
ALTER TABLE "uploads" ADD CONSTRAINT "upload_source_valid" CHECK ("source" IN ('erp', 'talabat', 'snoonu', 'rafeeq', 'keeta'));
ALTER TABLE "uploads" ADD CONSTRAINT "upload_contains_valid" CHECK ("contains" IN ('full', 'partial'));
ALTER TABLE "uploads" ADD CONSTRAINT "upload_status_valid" CHECK ("status" IN ('uploading', 'uploaded', 'processing', 'needs_mapping', 'needs_review', 'applying', 'applied', 'rejected', 'failed', 'discarded'));
ALTER TABLE "uploads" ADD CONSTRAINT "upload_size_valid" CHECK ("size" > 0 AND "size" <= 26214400);
ALTER TABLE "uploads" ADD CONSTRAINT "upload_progress_valid" CHECK ("progress" BETWEEN 0 AND 100);
ALTER TABLE "upload_rows" ADD CONSTRAINT "upload_row_change_valid" CHECK ("change_type" IN ('new', 'price', 'stock', 'price_stock', 'availability', 'price_availability', 'none', 'unmatched'));
ALTER TABLE "recon_rows" ADD CONSTRAINT "recon_status_valid" CHECK ("status" IN ('in_sync', 'mismatch', 'not_listed', 'missing_from_erp', 'new', 'no_data'));
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_kind_valid" CHECK ("kind" IN ('stock', 'price', 'stock_price', 'new_products') AND "scope" IN ('mismatches', 'all') AND "reference" IN ('erp', 'marketplace'));
ALTER TABLE "pricing_settings" ADD CONSTRAINT "pricing_valid" CHECK ("rounding" IN ('exact', '0.05', '0.25', '0.50') AND "default_rule_mode" IN ('percent', 'amount', 'fixed', 'same'));

-- Platform reference data shared by every tenant (global tables, no tenant_id).
INSERT INTO "marketplaces" ("id", "name") VALUES ('talabat', 'Talabat'), ('snoonu', 'Snoonu'), ('rafeeq', 'Rafeeq'), ('keeta', 'Keeta')
ON CONFLICT ("id") DO NOTHING;

-- ───────────── Row-level security: policies defined now, NOT enabled in Phase 1 ─────────────
-- Phase 1 runs one tenant per database, so enforcement stays in the tenant-scoped data layer.
-- When customers move to one shared deployment, run `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY`
-- (see docs/decisions/008) and set `app.tenant_id` per transaction as the final safety net.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
           WHERE c.table_schema = current_schema() AND c.column_name = 'tenant_id' AND c.is_nullable = 'NO'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
