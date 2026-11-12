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
> into that marketplace's generated file, never the catalogue stock, pricing rules, offers or listings. Each field is
> either **fix once** (`persistent = false`, the default: it clears when a later upload from that marketplace matches
> it) or **pinned** (`persistent = true`: it never clears automatically, and while the marketplace matches the pinned
> value no mismatch is raised). Either kind clears when the manager chooses "use catalogue value".
>
> Example (availability, yes/no): the catalogue says Available; the owner wants the product Unavailable on Talabat only.
> *Fix once:* the export writes Unavailable; the next Talabat file shows Unavailable, so the override clears; the
> catalogue (Available) is compared again, a "Lost sales" mismatch appears and the next export writes Available.
> *Pinned:* the export keeps writing Unavailable; while Talabat shows Unavailable the row is "Pinned" with no
> mismatch; if Talabat shows Available again, the mismatch is raised against the pinned value. Other marketplaces
> keep following the catalogue.

## 3. "Adjusted, waiting for export" and the recon status model

The phrase does not exist in the code today. The recon `status` values are `in_sync | mismatch | not_listed |
missing_from_erp | new | no_data`, computed from catalogue (or ERP) versus listing. **Proposal:** it is not a new
recon `status`. It is a separate per-row `exportState`:

| exportState | Label (UI) | Meaning |
| --- | --- | --- |
| `catalogue` | null | no override row; the file writes the catalogue value |
| `waiting_for_export` | **"Adjusted, waiting for export"** (or "Pinned, waiting for export" when every waiting field is pinned) | a pending field the marketplace does not yet show |
| `pinned` | **"Pinned"** | every pending field is pinned and the marketplace shows exactly the pinned value |
| `blocked` | "Adjusted, cannot be exported: <plain reason>" | pending, but a gate prevents writing it (approved D) |
| `cleared` | null | override row kept as a record; all fields cleared; the file writes the catalogue value |

Per field, the API also returns `fieldState: 'waiting_for_export' | 'pinned' | 'blocked' | null`. The row state is
the most urgent of its fields: `blocked`, then `waiting_for_export`, then `pinned`, then `cleared` or `catalogue`.
Plain blocked reasons: `inactive` "Product is inactive", `erp_inactive` "Inactive in the ERP", `missing_from_erp` "Not
in the latest ERP file", `not_listed` "Not listed on this marketplace", `marketplace_disabled` "Marketplace is
switched off", `ambiguous_listings` "Listed twice on this marketplace with different values".

This replaces the label "fixed in Qorloop, waiting for export" in the 9 Nov report with the owner's wording. Generating
or downloading a file does **not** change the state: Qorloop cannot know that the file was uploaded to the marketplace.

**Comparison (approved E, plus pins):**

- Fix-once field: the comparison is still catalogue (or ERP) versus marketplace. The row stays `mismatch` and counts
  as a mismatch until the matching upload clears it; it also counts in `waitingForExport`.
- Pinned field (pending, `persistent = true`, not blocked): the comparison target for that field becomes the pinned
  value, for both references (the pin is the owner's decision for that marketplace, and approved C writes it in every
  file). Price uses the existing price tolerance, availability compares exactly. A match means no stock or price issue
  and no mismatch count; it counts in `pinned`. A difference raises the issue against the pinned value and counts as a
  mismatch and in `waitingForExport`. Row fields `stockComparedWith` and `priceComparedWith`:
  `'catalogue' | 'erp' | 'pinned'` say which target was used.
- A blocked pin is compared with the catalogue again (the gate wins), and the reason is shown.
- This means the recon worker reads pinned overrides, so they become part of the recon signature. No `recon_rows`
  column is added: `*ComparedWith` comes from the live override join. A pin change queues the one coalesced recompute,
  and until it has run the stored flags can lag by one recompute, as catalogue stock edits already do.
- Summary per marketplace adds `waitingForExport` and `pinned` (counted from current overrides).

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
| Later marketplace upload, same marketplace, accepted row matches exactly (price in fils; availability) and the upload was created after the value was set | fix-once field clears (per field), audited, in the apply transaction; **pinned field never clears** (it shows "Pinned") |
| Same upload, value differs / row absent / skipped / partial without the row / ambiguous duplicate listings | stays pending (a pinned field raises the mismatch against the pinned value) |
| Pin turned off (`persistent` true to false) with the same value | counts as a new set (`set_at` = now), so only an upload created afterwards can clear it; never clears on the spot |
| ERP upload; catalogue stock edit; stock conflict; conflict resolution | no change; catalogue values update; the export value still wins |
| Price rule, offer start/expiry, per-marketplace rule, tenant default | no change; `rulePrice` and `differsFromRulePrice` update |
| Stock threshold change | no change; catalogue availability updates |
| Product inactive / ERP-inactive / missing from ERP / marketplace disabled | stays pending, `blocked`; availability written `false` where disabling is supported |
| "Use catalogue value" (DELETE or bulk `use_catalogue`) | that field clears; the file writes the catalogue value |
| Generate / download a file | no change |

## 7. Permission

`marketplace.values_edit` for Owner, Admin and Catalogue Manager in `packages/core/src/roles.ts`; no role is added.
Reads use `recon.view` (the Analyst can read).

## 7a. API, audit and test changes for `persistent`

These change section 5 of the 9 Nov report:

```ts
// PUT /api/marketplace-values/:marketplaceId/products/:productId
body = {
  values: {                                     // at least one field
    availability?: { value: boolean, persistent?: boolean },   // persistent defaults to false
    price?:        { value: number,  persistent?: boolean }
  },
  reason?: string, expected: Version
}
// Same value + same persistent + same reason = no-op. Changing persistent alone is a real change (version + 1).

// Bulk: SetAction = { type: 'set', values: <same shape as PUT values> }
//       ResetAction = { type: 'use_catalogue', fields: Field[] }   (removes pinned and fix-once fields alike)
// Bulk filter gains exportState 'pinned' and persistent?: boolean.

type FieldMeta = { state: 'pending'|'cleared', persistent: boolean,
                   fieldState: 'waiting_for_export'|'pinned'|'blocked'|null,
                   setById: string, setAt: string, reason: string|null, clearedAt: string|null };
MarketplaceValueItem.exportState: 'catalogue'|'waiting_for_export'|'pinned'|'blocked'|'cleared'
MarketplaceValueItem.exportStateLabel: string|null
MarketplaceValueItem.blockedReason / blockedReasonLabel: plain text from §3
MarketplaceValueItem.price adds: rulePrice: number, differsFromRulePrice: boolean
Recon row adds: marketplaceValues, marketplaceSource (§5), stockComparedWith, priceComparedWith
Summary per marketplace adds: waitingForExport: number, pinned: number
GET /api/marketplace-values adds the filter persistent=true|false
```

Audit: `product.marketplace_values_set`, `product.marketplace_values_cleared` and `marketplace.values_bulk_applied`
record `persistent` before and after for each changed field (pin and unpin are visible in product history);
`marketplace.values_upload_cleared` only ever lists fix-once fields.

Tests added to the 9 Nov list:

- a pinned field never clears on a matching upload, and a fix-once field does;
- no mismatch while the marketplace matches a pin, and a mismatch against the pinned value when it differs;
- pinned price within tolerance;
- a blocked pin falls back to the catalogue comparison;
- unpinning resets `set_at`, so an earlier upload cannot clear the field;
- a bulk set with `persistent`, and `use_catalogue` on pinned fields;
- summary `pinned` and `waitingForExport` counts;
- one marketplace pinned while the others follow the catalogue;
- the `persistent` check constraint.

## 8. Final migration SQL for approval

Changes from the 9 Nov SQL: per-field `persistent` flags (NOT NULL, default false; must be false while a field has
never been set; kept with the field's other provenance after it clears); the name uses today's date; the hard-coded marketplace list check is removed (the
foreign key to `marketplaces` already guards it, and a list would need a migration for each new marketplace). All
timestamps are `TIMESTAMPTZ(3)`. The row-level security block is a copy of `202611060001_erp_changes_catalogue_stock`
lines 105 to 111: policy defined, not enabled, same name and setting.

`packages/db/prisma/migrations/202611100001_marketplace_value_overrides/migration.sql`:

```sql
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
```

Tenant scoping: RLS is defined but not enabled (as in every table), so every repository query filters
`tenant_id = <resolved tenant>`; composite foreign keys stop cross-tenant product or user references.

## 9. Decisions needed before Step 1

Decided by the owner (10 Nov):

- marketplace-only edit; typed price goes into the export with a "differs from the rule price" note;
- **B** `marketplace.values_edit` for Owner, Admin and Catalogue Manager, no new roles;
- **C** every generated file, including ERP-reference files, writes the export value; the existing warning that an
  ERP-reference price file must never be uploaded to a real marketplace stays;
- **D** an availability "yes" can override stock and threshold, never inactive, ERP-inactive or missing-from-ERP;
  those rows are `blocked` with a plain reason;
- **E** the mismatch count stays; `waitingForExport` is added per marketplace;
- **F** amended: per-field `persistent` flag (fix once by default, clears on a match; pinned never auto-clears, shows
  "Pinned", no mismatch while the marketplace matches). The example now uses availability (§2).

Still open:

- **A. Approve the SQL in §8** (with the `persistent` flags).
- Two points in this design, both with a recommendation, which I will follow unless told otherwise:
  - a pin also changes the comparison for the ERP reference;
  - turning a pin off counts as a new set.

**STOP: waiting for owner approval of the migration. No schema change or migration has been made.**
