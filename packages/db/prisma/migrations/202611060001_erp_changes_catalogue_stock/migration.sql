-- ERP change review and catalogue stock (ADR 017). Additive: two new tables, two new recon_rows columns, one partial
-- GIN index. No existing column, constraint or index is changed or dropped.
--
-- OPERATIONS: the UPDATE of recon_rows below rewrites every recon row. Run this migration with the API and the worker
-- STOPPED, then run `ANALYZE recon_rows;` before starting them again (ADR 017, "Running the migration").

-- ───────────── (a) What each applied ERP upload changed: one row per product x field ─────────────
-- CreateTable
CREATE TABLE "erp_upload_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "upload_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "row_number" INTEGER,
    "barcode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "field" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "stock_conflict" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erp_upload_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "erp_upload_changes_tenant_upload_kind_idx" ON "erp_upload_changes"("tenant_id", "upload_id", "kind", "row_number", "id");

ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_change_kind_valid"
  CHECK ("kind" IN ('new', 'price', 'cost', 'stock', 'name', 'active', 'missing', 'returned', 'other'));
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_change_field_valid"
  CHECK ("field" IS NULL OR "field" IN ('sku', 'nameEn', 'nameAr', 'brand', 'erpCategory', 'erpPrice', 'costPrice', 'erpStock', 'erpActive', 'inLatestErpFile'));
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_change_shape_valid"
  CHECK ((("kind" = 'new') = ("field" IS NULL)) AND ("row_number" IS NOT NULL OR "kind" = 'missing')
         AND (NOT "stock_conflict" OR "kind" = 'stock'));

-- AddForeignKey
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (uses the existing unique index uploads_tenant_id_id_key)
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_changes_tenant_id_upload_id_fkey" FOREIGN KEY ("tenant_id", "upload_id") REFERENCES "uploads"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (uses the existing unique index products_tenant_id_id_key)
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_changes_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── (b)+(c) Owner-edited catalogue stock; no row = the catalogue stock is the ERP stock ─────────────
-- set_at, conflict_at and updated_at are compared for optimistic concurrency: stored with millisecond precision.
-- CreateTable
CREATE TABLE "catalogue_stock_edits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "stock" INTEGER NOT NULL,
    "erp_stock_at_edit" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "conflict_upload_id" UUID,
    "conflict_at" TIMESTAMPTZ(3),
    "reason" TEXT,
    "set_by_id" UUID NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalogue_stock_edits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalogue_stock_edits_tenant_id_product_id_key" ON "catalogue_stock_edits"("tenant_id", "product_id");

-- Open conflicts, newest first (the conflict list and the dashboard count). Partial: maintained in SQL only.
CREATE INDEX "catalogue_stock_edits_conflicts_idx" ON "catalogue_stock_edits"("tenant_id", "conflict_at" DESC, "product_id") WHERE "state" = 'conflict';

ALTER TABLE "catalogue_stock_edits" ADD CONSTRAINT "catalogue_stock_edit_valid"
  CHECK ("stock" >= 0 AND "erp_stock_at_edit" >= 0 AND "state" IN ('active', 'conflict')
         AND (("state" = 'conflict') = ("conflict_upload_id" IS NOT NULL AND "conflict_at" IS NOT NULL))
         AND ("reason" IS NULL OR char_length("reason") <= 500));

-- AddForeignKey
ALTER TABLE "catalogue_stock_edits" ADD CONSTRAINT "catalogue_stock_edits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (uses the existing unique index products_tenant_id_id_key)
ALTER TABLE "catalogue_stock_edits" ADD CONSTRAINT "catalogue_stock_edits_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (uses the existing unique index users_tenant_id_id_key)
ALTER TABLE "catalogue_stock_edits" ADD CONSTRAINT "catalogue_stock_edits_tenant_id_set_by_id_fkey" FOREIGN KEY ("tenant_id", "set_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- conflict_upload_id has no foreign key (like uploads.template_id): upload retention must not remove an open conflict.

-- ───────────── Recon: stock per reference ─────────────
-- stock_issue / status: the catalogue (expected) reference, now from the catalogue stock (catalogue_available).
-- stock_issue_vs_erp / status_vs_erp: the ERP reference, from the ERP stock (erp_available, unchanged meaning).
ALTER TABLE "recon_rows" ADD COLUMN "catalogue_available" BOOLEAN;
ALTER TABLE "recon_rows" ADD COLUMN "stock_issue_vs_erp" TEXT;
-- Exact: no catalogue stock edit exists before this migration, so both references currently share one stock result.
UPDATE "recon_rows" SET "catalogue_available" = "erp_available", "stock_issue_vs_erp" = "stock_issue";
ALTER TABLE "recon_rows" ADD CONSTRAINT "recon_stock_issue_vs_erp_valid"
  CHECK ("stock_issue_vs_erp" IS NULL OR "stock_issue_vs_erp" IN ('available_but_out_of_stock', 'unavailable_but_in_stock'));

-- ───────────── Product history: membership of a product in a bulk stock operation ─────────────
-- Same pattern as audit_events_bulk_changes_gin_idx (202611030001_activity_indexes). Maintained in SQL only.
CREATE INDEX "audit_events_stock_bulk_changes_gin_idx"
  ON "audit_events" USING GIN (("details" -> 'changes') jsonb_path_ops)
  WHERE "action" IN ('catalogue.stock_bulk_set', 'catalogue.stock_conflicts_resolved');

-- ───────────── Row-level security: same as 202610280003_catalogue_uploads ─────────────
-- Policy defined now, NOT enabled in Phase 1 (one tenant per database; ADR 008). Same policy name and the same
-- app.tenant_id setting as every other tenant table, so enabling RLS later covers these tables too.
DROP POLICY IF EXISTS tenant_isolation ON "erp_upload_changes";
CREATE POLICY tenant_isolation ON "erp_upload_changes" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON "catalogue_stock_edits";
CREATE POLICY tenant_isolation ON "catalogue_stock_edits" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
