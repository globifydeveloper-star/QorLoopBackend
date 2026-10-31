-- R1 reconciliation: every count and every row status exists once per comparison reference.
-- Both tables were created empty by 202610280003 and were not written before this migration.

-- recon_summaries: one row per tenant x marketplace x reference ('marketplace' = the resolved Marketplace price,
-- 'erp' = the ERP price). The dashboard and the reports read these rows, so their counts can never differ.
ALTER TABLE "recon_summaries"
  ADD COLUMN "reference"        TEXT NOT NULL DEFAULT 'marketplace',
  ADD COLUMN "not_listed"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "no_data"          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "missing_from_erp" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "new_count"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "computed_at"      TIMESTAMPTZ;
ALTER TABLE "recon_summaries" ADD CONSTRAINT "recon_summary_reference_valid" CHECK ("reference" IN ('erp', 'marketplace'));
DROP INDEX "recon_summaries_tenant_id_marketplace_id_key";
CREATE UNIQUE INDEX "recon_summaries_tenant_id_marketplace_id_reference_key" ON "recon_summaries"("tenant_id", "marketplace_id", "reference");
COMMENT ON COLUMN "recon_summaries"."reference" IS 'Comparison reference of these counts: marketplace (resolved Marketplace price) or erp (ERP price)';

-- recon_rows: "status" is the status against the MARKETPLACE reference (expected price = the resolved Marketplace price);
-- "status_vs_erp" is the status against the ERP reference (expected price = the ERP price).
ALTER TABLE "recon_rows" ADD COLUMN "status_vs_erp" TEXT NOT NULL DEFAULT 'no_data';
ALTER TABLE "recon_rows" ADD CONSTRAINT "recon_status_vs_erp_valid" CHECK ("status_vs_erp" IN ('in_sync', 'mismatch', 'not_listed', 'missing_from_erp', 'new', 'no_data'));
CREATE INDEX "recon_rows_tenant_id_marketplace_id_status_vs_erp_idx" ON "recon_rows"("tenant_id", "marketplace_id", "status_vs_erp");
COMMENT ON COLUMN "recon_rows"."status" IS 'Status against the MARKETPLACE reference (expected price = the resolved Marketplace price)';
COMMENT ON COLUMN "recon_rows"."status_vs_erp" IS 'Status against the ERP reference (expected price = the ERP price)';
