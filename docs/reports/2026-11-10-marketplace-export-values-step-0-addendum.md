# Marketplace values to export: Step 0 addendum (10 November 2026)

**Proposed, not approved or implemented.** This adds to `2026-11-09-marketplace-export-overrides-step-0.md`
("the 9 Nov report"). Branch `feature/marketplace-export-values`. Only documentation changes. No schema, migration,
application code, tests, database connections or credentials were touched or read.

## 1. Is the 9 Nov report still accurate?

It inspected `36b3280`. The only later commit (`18f8740`) adds that report, so the code is unchanged. Spot-checked
again: catalogue stock/availability (`packages/core/src/recon/status.ts`, `packages/db/src/recon.ts::products`), the
listing winner (`recon.ts::listings`: `DISTINCT ON (marketplace_id, product_id) ... ORDER BY updated_at DESC,
marketplace_product_id`), the generated-file source file (`packages/db/src/generated-files.ts`: latest `applied`
upload by `applied_at DESC NULLS LAST, created_at DESC, id DESC`), listing upsert/removal (`packages/db/src/uploads.ts`
`upsertListings`, `removeListingsNotIn`), roles (`packages/core/src/roles.ts`). Sections 1 to 5 of that report still
apply, with the changes listed below.

## 2. How the new layer coexists with ADR 017

ADR 017, "Recon and generated files" says: *"This supersedes the earlier idea of per-marketplace availability
overrides, which was never built. One catalogue stock drives every enabled marketplace."*

| Layer | Owner | Scope | What it holds | Changed by |
| --- | --- | --- | --- | --- |
| 1. ERP values | ERP file | product | `erp_stock`, `erp_price`, ERP active | ERP upload |
| 2. Catalogue stock (ADR 017) | Qorloop | product, **all marketplaces** | one quantity: owner edit else ERP | stock edit / conflict resolution |
| 3. Catalogue-derived marketplace values | computed | product x marketplace | availability (stock > threshold + gates), rule price | rules, offers, threshold, layers 1-2 |
| 4. **Export values (new, ADR 018)** | manager | product x marketplace | optional boolean availability and/or absolute price | this feature only |
| 5. Marketplace current values | marketplace file | listing | listed price and availability | marketplace upload |

Layer 4 never writes layers 1 to 3 or 5. It holds **no quantity**, so "one catalogue stock drives every marketplace"
remains true: there is still exactly one stock number, and ADR 017's conflict model (D1 to D5) is untouched. What
changes is the sentence that per-marketplace overrides are superseded: an export instruction may now set
**availability (a boolean) and price** for one marketplace. Comparisons (status, stock/price issue, counts) still use
layer 3 versus layer 5. Only the file writer and the new export columns read layer 4.

Proposed ADR 018 wording for the amendment (written in Step 4):

> ADR 017's sentence "This supersedes the earlier idea of per-marketplace availability overrides ... One catalogue
> stock drives every enabled marketplace" is amended: one catalogue stock still drives every enabled marketplace's
> *catalogue* availability, and stock cannot differ per marketplace. On top of it, a per-marketplace **export value**
> (availability yes/no and/or price) may be set for one product on one marketplace. It changes only what is written
> into that marketplace's generated file, never the catalogue stock, pricing rules, offers or listings, and clears
> when a later upload from that marketplace matches it or when the manager chooses "use catalogue value".

## 3. "Adjusted, waiting for export" and the recon status model

The phrase does not exist in the code today. The recon `status` values are `in_sync | mismatch | not_listed |
missing_from_erp | new | no_data`, computed from catalogue (or ERP) versus listing. **Proposal:** it is not a new
recon `status`. It is a separate per-row `exportState`:

| exportState | Label (UI) | Meaning |
| --- | --- | --- |
| `catalogue` | null | no override row; the file writes the catalogue value |
| `waiting_for_export` | **"Adjusted, waiting for export"** | at least one field is pending and exportable |
| `blocked` | "Adjusted, cannot be exported" + `blockedReason` | pending, but a gate prevents writing it (9 Nov report §3.8) |
| `cleared` | null | override row kept as a record; all fields cleared; the file writes the catalogue value |

This replaces the label "fixed in Qorloop, waiting for export" in the 9 Nov report with the owner's wording. A row
stays `mismatch` (the marketplace still differs) and also shows `waiting_for_export`, until a matching marketplace
upload clears the override. Generating or downloading a file does **not** change the state: Qorloop cannot know that
the file was uploaded to the marketplace.

## 4. Price typed here versus the pricing rules (decided by the owner)

The override price goes into the export as typed, after the rule chain, so it also outranks an active offer for that
marketplace. Each row exposes `rulePrice` (the catalogue rule price) and `differsFromRulePrice: boolean` (exact
comparison in fils, not the recon tolerance), with the note label "Differs from the rule price". No warning blocks the
save.

## 5. Upload time of the marketplace values per row (no schema change)

- `listings.upload_id` (nullable UUID, no foreign key) is set by every `upsertListings`, together with `updated_at`.
  So the winning listing's `upload_id` is the last marketplace file that contained that listing.
- No code deletes `uploads` rows (retention sets `expires_at`; no delete statement was found), so the join keeps
  working. Listings written before `upload_id` existed can have null: the source is then `null`.
- Recon rows, the stock report and the price report (the same `GET /api/recon/rows` endpoint; there is no separate
  report route) and the marketplace-values list get:

```ts
marketplaceSource: {
  uploadId: string, fileName: string,
  uploadedAt: string,          // uploads.created_at
  appliedAt: string | null,    // uploads.applied_at
  isLatestFile: boolean        // equals the upload the generated file uses as its source file
} | null                       // no listing, or a listing with no upload_id
```

- Read: a `LEFT JOIN` from the same listing-winner subquery (same `DISTINCT ON` and order as `recon.ts::listings`)
  to `uploads` on `(tenant_id, id)`, both scoped to the tenant, plus one `latestApplied` lookup per marketplace. The
  existing `listings (tenant_id, marketplace_id, product_id)` index and the uploads primary key cover it.
- Consequence: a row whose listing came from an older partial file is usually not in the latest file, so a generated
  file counts it in `notInFile`. With `isLatestFile = false` the UI can say "from the file of <date>" instead of
  "latest file". The generated-file preview will also return the number of rows with `isLatestFile = false`.
- This part needs no approval for the schema and is built in Step 3.

## 6. Interactions (summary; details in the 9 Nov report §3)

| Event | Effect on a pending override |
| --- | --- |
| Later marketplace upload, same marketplace, accepted row matches exactly (price in fils; availability) and the upload was created after the value was set | that field clears (per field), audited, in the apply transaction |
| Same upload, value differs / row absent / skipped / partial without the row / ambiguous duplicate listings | stays pending |
| ERP upload; catalogue stock edit; stock conflict; conflict resolution | no change; catalogue values update; the export value still wins |
| Price rule, offer start/expiry, per-marketplace rule, tenant default | no change; `rulePrice` and `differsFromRulePrice` update |
| Stock threshold change | no change; catalogue availability updates |
| Product inactive / ERP-inactive / missing from ERP / marketplace disabled | stays pending, `blocked`; availability written `false` where disabling is supported |
| "Use catalogue value" (DELETE or bulk `use_catalogue`) | that field clears; the file writes the catalogue value |
| Generate / download a file | no change |

## 7. Permission

`marketplace.values_edit` for Owner, Admin and Catalogue Manager in `packages/core/src/roles.ts`; no role is added.
Reads use `recon.view` (the Analyst can read).

## 8. Final migration SQL for approval

Changes from the 9 Nov SQL: the name uses today's date; the hard-coded marketplace list check is removed (the
foreign key to `marketplaces` already guards it, and a list would need a migration for each new marketplace). All
timestamps are `TIMESTAMPTZ(3)`. The row-level security block is a copy of `202611060001_erp_changes_catalogue_stock`
lines 105 to 111: policy defined, not enabled, same name and setting.

`packages/db/prisma/migrations/202611100001_marketplace_value_overrides/migration.sql`:

```sql
-- ───────────── Per-marketplace export values (ADR 018); no row = the file writes the catalogue value ─────────────
-- Two independent fields (availability, price), each with its own state and provenance. version is the optimistic
-- concurrency check; all timestamps are stored with millisecond precision.
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
    "price_value" DECIMAL(12,3),
    "price_state" TEXT,
    "price_set_by_id" UUID,
    "price_set_at" TIMESTAMPTZ(3),
    "price_reason" TEXT,
    "price_cleared_at" TIMESTAMPTZ(3),
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
-- Pending instructions per marketplace (exports, summary counts, auto-clear). Partial: maintained in SQL only.
CREATE INDEX "marketplace_value_overrides_pending_idx"
  ON "marketplace_value_overrides"("tenant_id", "marketplace_id", "product_id")
  WHERE "availability_state" = 'pending' OR "price_state" = 'pending';

ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_override_valid"
  CHECK ("version" > 0 AND ("availability_state" IS NOT NULL OR "price_state" IS NOT NULL));

ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_override_availability_shape"
  CHECK (
    ("availability_state" IS NULL AND "availability_value" IS NULL
      AND "availability_set_by_id" IS NULL AND "availability_set_at" IS NULL
      AND "availability_reason" IS NULL AND "availability_cleared_at" IS NULL)
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
      AND "price_reason" IS NULL AND "price_cleared_at" IS NULL)
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
```

Tenant scoping: RLS is defined but not enabled (as in every table), so every repository query filters
`tenant_id = <resolved tenant>`; composite foreign keys stop cross-tenant product or user references.

## 9. Decisions needed before Step 1

Already decided by the owner: marketplace-only edit; auto-clear on a matching later upload or manual removal; typed
price goes into the export with a "differs from the rule price" note; Owner/Admin/Catalogue Manager.

- **A. Approve the SQL in §8** (or amend it).
- **B. Permission name** `marketplace.values_edit`.
- **C. ERP-reference files** (9 Nov §3.10, D2): recommended, every generated file writes the export value whatever
  the comparison reference; alternative, keep legacy ERP files and block them while an override is pending.
- **D. Gates** (9 Nov D3): an availability `true` can bypass stock and threshold, but not inactive, ERP-inactive or
  missing-from-ERP (row becomes `blocked`). The price override also outranks an active offer.
- **E. Summary counts:** recommended, a row with a pending override still counts as a mismatch (the marketplace still
  differs) and a separate `waitingForExport` count is added per marketplace.
- **F. After auto-clear the catalogue value resumes** (catalogue 10, override 12, marketplace file 12, then the next
  export proposes 10 again unless the catalogue changed). Confirm, or ask for a permanent per-marketplace price instead.

**STOP: waiting for owner approval. No schema change or migration has been made.**
