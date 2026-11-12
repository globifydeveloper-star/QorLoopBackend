-- ───────────── Per-marketplace export values (ADR 018); no row = the file writes the catalogue value ─────────────
-- Two independent fields (availability, price), each with its own state and provenance. *_persistent: false = fix once
-- (cleared by a later matching marketplace upload), true = pinned (cleared only by the manager). version is the
-- optimistic concurrency check; all timestamps are stored with millisecond precision.
-- CreateTable
CREATE TABLE "marketplace_value_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "availability_value" BOOLEAN,
    "availability_state" TEXT,
    "availability_set_by_id" UUID,
    "availability_set_at" TIMESTAMPTZ(3),
    "availability_reason" TEXT,
    "availability_cleared_at" TIMESTAMPTZ(3),
    "availability_persistent" BOOLEAN NOT NULL DEFAULT false,
    "price_value" DECIMAL(12,3),
    "price_state" TEXT,
    "price_set_by_id" UUID,
    "price_set_at" TIMESTAMPTZ(3),
    "price_reason" TEXT,
    "price_cleared_at" TIMESTAMPTZ(3),
    "price_persistent" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "marketplace_value_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_value_overrides_tenant_id_product_id_marketplace_id_key"
  ON "marketplace_value_overrides"("tenant_id", "product_id", "marketplace_id");
CREATE INDEX "marketplace_value_overrides_tenant_id_marketplace_id_product_id_idx"
  ON "marketplace_value_overrides"("tenant_id", "marketplace_id", "product_id");
-- Pending instructions per marketplace (exports, recon pins, summary counts, auto-clear). Partial: maintained in SQL only.
CREATE INDEX "marketplace_value_overrides_pending_idx"
  ON "marketplace_value_overrides"("tenant_id", "marketplace_id", "product_id")
  WHERE "availability_state" = 'pending' OR "price_state" = 'pending';

ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_override_valid"
  CHECK ("version" > 0 AND ("availability_state" IS NOT NULL OR "price_state" IS NOT NULL));

ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_override_availability_shape"
  CHECK (
    ("availability_state" IS NULL AND "availability_value" IS NULL
      AND "availability_set_by_id" IS NULL AND "availability_set_at" IS NULL
      AND "availability_reason" IS NULL AND "availability_cleared_at" IS NULL
      AND "availability_persistent" = false)
    OR
    ("availability_state" IN ('pending', 'cleared')
      AND "availability_value" IS NOT NULL AND "availability_set_by_id" IS NOT NULL
      AND "availability_set_at" IS NOT NULL
      AND ("availability_reason" IS NULL OR char_length("availability_reason") <= 500)
      AND (("availability_state" = 'pending' AND "availability_cleared_at" IS NULL)
        OR ("availability_state" = 'cleared' AND "availability_cleared_at" IS NOT NULL
          AND "availability_cleared_at" >= "availability_set_at")))
  );

ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_override_price_shape"
  CHECK (
    ("price_state" IS NULL AND "price_value" IS NULL
      AND "price_set_by_id" IS NULL AND "price_set_at" IS NULL
      AND "price_reason" IS NULL AND "price_cleared_at" IS NULL
      AND "price_persistent" = false)
    OR
    ("price_state" IN ('pending', 'cleared')
      AND "price_value" IS NOT NULL AND "price_value" > 0 AND "price_value" <= 100000
      AND "price_set_by_id" IS NOT NULL AND "price_set_at" IS NOT NULL
      AND ("price_reason" IS NULL OR char_length("price_reason") <= 500)
      AND (("price_state" = 'pending' AND "price_cleared_at" IS NULL)
        OR ("price_state" = 'cleared' AND "price_cleared_at" IS NOT NULL
          AND "price_cleared_at" >= "price_set_at")))
  );

-- AddForeignKey
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (uses the existing unique index products_tenant_id_id_key)
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_marketplace_id_fkey" FOREIGN KEY ("marketplace_id") REFERENCES "marketplaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (uses the existing unique index users_tenant_id_id_key)
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_tenant_id_availability_set_by_id_fkey" FOREIGN KEY ("tenant_id", "availability_set_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_tenant_id_price_set_by_id_fkey" FOREIGN KEY ("tenant_id", "price_set_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No foreign key to uploads: the matched upload ID lives in audit details, so upload retention cannot remove an override.

-- ───────────── Product history: membership of a product in a bulk or upload-cleared operation ─────────────
-- Same pattern as audit_events_stock_bulk_changes_gin_idx (202611060001). Maintained in SQL only.
CREATE INDEX "audit_events_marketplace_values_changes_gin_idx"
  ON "audit_events" USING GIN (("details" -> 'changes') jsonb_path_ops)
  WHERE "action" IN ('marketplace.values_bulk_applied', 'marketplace.values_upload_cleared');

-- ───────────── Row-level security: same as 202610280003_catalogue_uploads ─────────────
-- Policy defined now, NOT enabled in Phase 1 (one tenant per database; ADR 008). Same policy name and the same
-- app.tenant_id setting as every other tenant table, so enabling RLS later covers this table too.
DROP POLICY IF EXISTS tenant_isolation ON "marketplace_value_overrides";
CREATE POLICY tenant_isolation ON "marketplace_value_overrides" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
