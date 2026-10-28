-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "two_factor_enabled" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "token" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ,
    "refresh_token_expires_at" TIMESTAMPTZ,
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factors" (
    "id" UUID NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "verified" BOOLEAN DEFAULT true,
    "failed_verification_count" INTEGER DEFAULT 0,
    "locked_until" TIMESTAMPTZ,

    CONSTRAINT "two_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'QA',
    "currency" TEXT NOT NULL DEFAULT 'QAR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Qatar',
    "erp_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "onboarding_step" TEXT NOT NULL DEFAULT 'store',
    "onboarding_completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "price_tolerance" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "stock_threshold" INTEGER NOT NULL DEFAULT 0,
    "stale_hours" INTEGER NOT NULL DEFAULT 12,
    "mfa_required_for_all" BOOLEAN NOT NULL DEFAULT false,
    "analyst_can_export" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

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
    "updated_at" TIMESTAMPTZ NOT NULL,

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
CREATE TABLE "activity_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "field" TEXT,
    "old_value" TEXT,
    "new_value" TEXT,
    "source" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "two_factors_secret_idx" ON "two_factors"("secret");

-- CreateIndex
CREATE INDEX "two_factors_user_id_idx" ON "two_factors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_subdomain_key" ON "tenants"("subdomain");

-- CreateIndex
CREATE INDEX "stores_tenant_id_idx" ON "stores"("tenant_id");

-- CreateIndex
CREATE INDEX "memberships_tenant_id_role_idx" ON "memberships"("tenant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenant_id_token_hash_key" ON "invitations"("tenant_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_settings_tenant_id_key" ON "tenant_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_marketplaces_tenant_id_marketplace_id_key" ON "tenant_marketplaces"("tenant_id", "marketplace_id");

-- CreateIndex
CREATE INDEX "categories_tenant_id_parent_id_idx" ON "categories"("tenant_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_parent_id_name_en_key" ON "categories"("tenant_id", "parent_id", "name_en");

-- CreateIndex
CREATE UNIQUE INDEX "category_mappings_tenant_id_category_id_marketplace_id_key" ON "category_mappings"("tenant_id", "category_id", "marketplace_id");

-- CreateIndex
CREATE INDEX "products_tenant_id_sku_idx" ON "products"("tenant_id", "sku");

-- CreateIndex
CREATE INDEX "products_tenant_id_status_idx" ON "products"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_normalized_barcode_key" ON "products"("tenant_id", "normalized_barcode");

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
CREATE INDEX "activity_log_tenant_id_at_idx" ON "activity_log"("tenant_id", "at" DESC);

-- CreateIndex
CREATE INDEX "activity_log_tenant_id_entity_type_entity_id_idx" ON "activity_log"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_read_at_idx" ON "notifications"("tenant_id", "user_id", "read_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_marketplaces" ADD CONSTRAINT "tenant_marketplaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_marketplaces" ADD CONSTRAINT "tenant_marketplaces_marketplace_id_fkey" FOREIGN KEY ("marketplace_id") REFERENCES "marketplaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_rows" ADD CONSTRAINT "upload_rows_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_errors" ADD CONSTRAINT "upload_errors_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
