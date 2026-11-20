-- How the store sets its prices (onboarding step d, docs/plans/onboarding-redesign-backend.md):
--   erp_markup: the store-wide default rule on the ERP price (pricing_settings.default_rule_*)
--   adopt:      today's prices of one marketplace adopted as product rules (POST /api/pricing/adopt/apply)
-- Only the explicit choice is stored; every other onboarding step is derived from existing data.
ALTER TABLE "pricing_settings"
  ADD COLUMN "price_source" TEXT,
  ADD COLUMN "price_source_marketplace_id" TEXT,
  ADD COLUMN "price_source_confirmed_at" TIMESTAMPTZ;

ALTER TABLE "pricing_settings"
  ADD CONSTRAINT "pricing_settings_price_source_marketplace_id_fkey"
  FOREIGN KEY ("price_source_marketplace_id") REFERENCES "marketplaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pricing_settings_price_source_check"
  -- CASE, not OR of comparisons: "price_source" = 'x' is NULL when price_source is NULL, and a NULL CHECK passes.
  CHECK (CASE "price_source"
    WHEN 'erp_markup' THEN "price_source_marketplace_id" IS NULL AND "price_source_confirmed_at" IS NOT NULL
    WHEN 'adopt' THEN "price_source_marketplace_id" IS NOT NULL AND "price_source_confirmed_at" IS NOT NULL
    ELSE "price_source" IS NULL AND "price_source_marketplace_id" IS NULL AND "price_source_confirmed_at" IS NULL
  END);

-- BACKFILL (owner decision D6). Stores that already have a comparison with matched marketplace data count as having
-- chosen: 'adopt' from their newest adoption event, otherwise 'erp_markup'. Stores without matched data choose in
-- onboarding. The statements below are also run by apps/api/src/__tests__/price-source.integration.test.ts.
INSERT INTO "pricing_settings" ("id", "tenant_id", "updated_at")
SELECT gen_random_uuid(), t."id", CURRENT_TIMESTAMP FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "pricing_settings" p WHERE p."tenant_id" = t."id")
  AND EXISTS (SELECT 1 FROM "recon_summaries" r WHERE r."tenant_id" = t."id" AND r."has_data" AND r."listed" > 0);

UPDATE "pricing_settings" p
SET "price_source" = 'adopt', "price_source_marketplace_id" = a."marketplace_id", "price_source_confirmed_at" = a."created_at"
FROM (
  SELECT DISTINCT ON (e."tenant_id") e."tenant_id", e."details"->>'sourceMarketplaceId' AS "marketplace_id", e."created_at"
  FROM "audit_events" e
  WHERE e."action" = 'pricing.prices_adopted' AND e."details"->>'sourceMarketplaceId' IN (SELECT "id" FROM "marketplaces")
  ORDER BY e."tenant_id", e."created_at" DESC
) a
WHERE p."tenant_id" = a."tenant_id" AND p."price_source" IS NULL
  AND EXISTS (SELECT 1 FROM "recon_summaries" r WHERE r."tenant_id" = p."tenant_id" AND r."has_data" AND r."listed" > 0);

UPDATE "pricing_settings" p
SET "price_source" = 'erp_markup', "price_source_confirmed_at" = p."updated_at"
WHERE p."price_source" IS NULL
  AND EXISTS (SELECT 1 FROM "recon_summaries" r WHERE r."tenant_id" = p."tenant_id" AND r."has_data" AND r."listed" > 0);
