# Offers v1, catalogue export and price source: Step 0 inspection

Date: 11 November 2026. Based on `feature/marketplace-export-values` at `4c789e4`. That branch is **not merged into `main`** yet, so `feature/offers-v1` starts from it.

**Report only.** No code, schema or migration has changed. The migration in section D waits for the owner's approval.

## Working-tree note (not part of this task)

The checkout of `feature/marketplace-export-values` has **uncommitted changes that this task did not make**:

- `GET /api/pricing/active-offers`, plus `PricingRepository.activeOffers` and the `activeOffersQuery` contract;
- `GET /api/products/marketplace-listings`;
- a Fastify `maxParamLength: 200` fix for generation job IDs;
- three untracked integration tests.

They are left untouched, and none of them is in the `feature/offers-v1` commit. `active-offers` overlaps requirement 3 ("see the original price and the offer price"). Decide whether it is committed on the export-values branch first. Step 2 would build on it.

---

## A. `product_offers` today (does the 2026-11-11 offers-flow report still hold? Yes)

**Columns** (migration `202610280003`):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `UUID` | |
| `tenant_id` | `UUID` | |
| `product_id` | `UUID` | |
| `price` | `DECIMAL(12,3) NOT NULL` | |
| `valid_from` | `TIMESTAMPTZ` | nullable, microsecond precision |
| `valid_until` | `TIMESTAMPTZ` | nullable, microsecond precision |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | |

- Index: `(tenant_id, product_id)`. It is **not unique**.
- No CHECK constraints.
- RLS: the `tenant_isolation` policy from the 202610280003 loop. It is defined but not enabled.

**Who sets an offer.** Only `PUT /api/pricing/products/:id/offer` (`pricing.edit`), with the body `{ price, validFrom?, validUntil? }`:

- Dates are ISO instants with an offset.
- `validUntil` must be after `validFrom`.
- An offer that has already ended is refused.
- The price is `> 0` and `< 1e9`, with 3 decimals.

The write deletes the product's offers and inserts one (`replaceOffer`), records `product.offer_set` with old/new values, and queues a recompute `'product.offer'`.

- `DELETE …/offer` records `product.offer_deleted`.
- An inline or product-rule edit is refused while an offer decides the price.
- Price adoption with `onlyWithoutRule` skips products that have an offer.

**Resolver** (`packages/core/src/pricing.ts`):

- The offer is step 1 of `PRICE_RULE_ORDER`, before the product, subcategory, category, marketplace and default rules.
- `offerState`:
  - `scheduled` when `validFrom > now`;
  - `expired` when `validUntil < now`;
  - otherwise `valid`. Both ends are inclusive, and either end is optional.
- If several offers are valid, the one that started last wins.
- The price is used exactly, with no rounding, and the source is `'offer'`.
- One offer price applies to **every** marketplace.

**Comparison and files: unchanged since the report.**

- The recompute resolves at its own `new Date()`.
- `price_mismatch_vs_marketplace` compares against the resolved (offer) price.
- `price_mismatch_vs_erp` compares against `products.erp_price`.
- In generated files:
  - the marketplace reference writes `marketplace_price`;
  - the ERP reference writes `erp_price`;
  - an export value outranks both.
- **No recompute fires at an offer boundary.** `'sweep'` exists as a `ReconReason`, but nothing queues it.

**"Ended" state.** It is not stored; it is derived (`expired`). An ended offer row stays in the table until it is replaced or deleted.

## B. O1 and O2 (approved)

### O1: recompute when an offer starts or ends. Recommendation: a periodic sweep, not delayed jobs

| | Delayed BullMQ job per boundary | Periodic sweep (recommended) |
| --- | --- | --- |
| Offer edit or delete | Must find and remove or replace the old delayed jobs (2 per offer, 10,000 for 5,000 offers) | Nothing to do |
| Redis flush, lost job, worker down at the boundary | The boundary is missed for good | The next tick catches it, because state lives in Postgres |
| Several workers | Fine | Fine with `upsertJobScheduler` (one scheduler entry in Redis, one job per tick), the same as `outbox-poll` |
| Restart | Jobs survive in Redis only | Nothing to persist |
| Per-tenant dedup (`recon-{tenant}`) | Delayed jobs need their own IDs, then call `enqueueRecon` when they fire | The sweep only calls `enqueueRecon(tenant, 'sweep')`, so it coalesces with other triggers for free |
| Latency | Exact | ≤ tick interval + 2 s debounce + recompute time |

**Design.**

- A `recon-sweep` job scheduler runs `every: 60_000` on a new `offer-sweep` queue (concurrency 1).
- Each tick runs **one cross-tenant query** (like `dueMail`):

  ```sql
  SELECT DISTINCT o.tenant_id FROM product_offers o
  WHERE (o.valid_from  > coalesce(w.computed_at, '-infinity') AND o.valid_from  <= now())
     OR (o.valid_until > coalesce(w.computed_at, '-infinity') AND o.valid_until <  now())
  ```

  Here `w.computed_at` is the tenant's oldest `recon_summaries.computed_at`.
- For each tenant found, the tick calls `enqueueRecon(tenantId, 'sweep')`.

**Watermark.** `recon_summaries.computed_at` is written with `now()`, which is the transaction start. That is never later than the `new Date()` the compute uses, so a boundary between them triggers one harmless extra run and is never skipped. A failed run leaves `computed_at` unchanged, so the next tick retries. A tenant with no enabled marketplace has no summaries; the query then uses `-infinity` and runs once, and the run writes nothing.

**End boundary.** `valid_until` is inclusive. The query uses `< now()` (strictly after), so the run after the end resolves `expired`.

**Load.** Promotions starting at midnight across 100 products give **one** run per tenant: the deduplication coalesces them. A full rewrite at 200,000 rows takes 20–30 s. A boundary only changes the promoted rows, so the diff writes only those.

**Side effect.** `exportToken` changes at a boundary. A file previewed before a boundary is refused with `STALE_EXPORT_MESSAGE` after it. That is intended.

**Schema.** None is required. The boundary indexes in D are recommended for when there is more than one tenant per database.

### O2: during an offer, the ERP reference compares with and writes the offer price

- `packages/core/src/recon/status.ts`, line 151:

  ```ts
  priceMismatchVsErp = priceMismatch(listing.price, pin?.price ?? (marketplacePrice.source === 'offer' ? marketplacePrice.price : product.erpPrice), tol)
  ```

- `packages/core/src/generated-files.ts`, `fileValues`: for the ERP reference, write `row.marketplacePrice` when `row.marketplacePriceSource === 'offer'`, otherwise `row.erpPrice`. `FileReconRow` gains `marketplacePriceSource`, which `recon_rows.marketplace_price_source` already stores.
- `erp_price` stays stored and shown everywhere (the "ERP price" column, the Review `erpPrice`).
- Availability and stock do not change.
- Requirement 4 holds once O1 and O2 are both in: both references expect the offer price, so a listing at the promo price is not a mismatch. The offer stays applied until the sweep after `valid_until`.

## C. Review, marketplace values and generated files during an active offer

- **An export value still outranks the offer: confirmed in code.**
  - In the comparison, `pin?.price ?? …` comes first in `status.ts` for both references.
  - In files, `fileValues` writes `exportPrice` first.
- **Review** (`GET /api/marketplace-values/review`):
  - `rulePrice` and `catalogue.price` are the offer price, and `catalogue.priceSource = 'offer'`;
  - `to_fix` is set when the listing is not the offer price. After O2 the same holds for the ERP reference.
  - **Proposed (additive, step 2):** `catalogue.normalPrice`, the resolved price without the offer, and `catalogue.offer: { price, validFrom, validUntil, state } | null`.
- **Generated files** have one price column only, because O3 is out of scope. During an offer, both references write the **promo price into the marketplace's normal price column**. After the end, the next file writes the normal price back. The marketplace shows no "was" price.

  **Risk to flag to the client:** until O3, the marketplace shows the promo price as the regular price, with no strike-through.
- **O5, still open (owner decision).** A pending or pinned price export value set before a promotion keeps winning during it, so the promo never reaches that marketplace's file. Recommendation:
  - warn in the offer preview (single, bulk and upload): "N products have a pending export price on Talabat; it outranks the offer";
  - **do not auto-clear**.

## D. Proposed schema changes (approval required)

**Decisions built into the SQL.** Each one is marked for confirmation.

1. **One offer per product**, enforced by a unique index. Bulk and upload writes then become one `INSERT … ON CONFLICT (tenant_id, product_id) DO UPDATE`, and two concurrent writes cannot leave two rows.
2. **No stored `ended` state.** Ended means `valid_until < now`, derived as today, so no sweep has to write it. The API exposes `state: 'scheduled' | 'active' | 'ended'`, renamed from `valid`/`expired` in the new views; the old `pricing.offer.state` stays as is. An ended offer row is kept, so the product shows "last offer ended 12 Nov", until it is replaced or removed.
3. **Dates are instants.** The API accepts ISO with an offset, as today. The **Excel template uses Qatar calendar dates**:
   - offer start D → `D 00:00:00.000+03:00`;
   - offer end E → `E 23:59:59.999+03:00` (the whole end day, inclusive);
   - Qatar is fixed UTC+3 with no daylight saving time;
   - a blank start means "from now".
4. **Millisecond precision**: `TIMESTAMPTZ(3)` on all four timestamps, like migration 202611100001.
5. **CHECK constraints**: `price > 0 AND price < 1e9`, matching today's contract (new inputs are capped at 100,000 by the API); `valid_until > valid_from` when both are set.
6. **Provenance, optional:** `source` (`manual | bulk | upload`) and `set_by_id`, so the product page can show "set by upload, Sara, 11 Nov". The audit log has this already, so **section D.2 can be dropped** if you prefer.
7. **New tables**: `catalogue_exports` (section E) and `offer_imports` (section F).

**Read-only pre-check for the owner** (run on the demo DB before migrating; both must return 0):

```sql
SELECT count(*) FROM (SELECT 1 FROM product_offers GROUP BY tenant_id, product_id HAVING count(*) > 1) d;
SELECT count(*) FROM product_offers WHERE price <= 0 OR price >= 1000000000 OR (valid_from IS NOT NULL AND valid_until IS NOT NULL AND valid_until <= valid_from);
```

**Migration `202611110001_offers_v1/migration.sql`** (exact):

```sql
-- ───────────── Offers v1 (ADR 020): one offer per product, millisecond dates, checks, boundary indexes ─────────────
-- An offer applies to every marketplace from valid_from to valid_until (both inclusive, either optional). "Ended" is
-- derived (valid_until < now), never stored. All timestamps are stored with millisecond precision.
-- Refuse to run when a product has more than one offer (the API always kept one): the owner resolves it first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "product_offers" GROUP BY "tenant_id", "product_id" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'product_offers has products with more than one offer; resolve them before migration 202611110001';
  END IF;
END $$;

-- D.1 millisecond timestamps
ALTER TABLE "product_offers"
  ALTER COLUMN "valid_from" SET DATA TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "valid_until" SET DATA TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- D.2 provenance (optional): who set the offer and through which route; NULL for offers set before this migration
ALTER TABLE "product_offers" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "product_offers" ADD COLUMN "set_by_id" UUID;
ALTER TABLE "product_offers" ADD CONSTRAINT "product_offer_source_valid" CHECK ("source" IN ('manual', 'bulk', 'upload'));
-- AddForeignKey (uses the existing unique index users_tenant_id_id_key)
ALTER TABLE "product_offers" ADD CONSTRAINT "product_offers_tenant_id_set_by_id_fkey" FOREIGN KEY ("tenant_id", "set_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- D.3 shape
ALTER TABLE "product_offers" ADD CONSTRAINT "product_offer_valid"
  CHECK ("price" > 0 AND "price" < 1000000000
    AND ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_until" > "valid_from"));

-- D.4 one offer per product (replaces the plain index)
DROP INDEX "product_offers_tenant_id_product_id_idx";
CREATE UNIQUE INDEX "product_offers_tenant_id_product_id_key" ON "product_offers"("tenant_id", "product_id");

-- D.5 the offer-boundary sweep (cross-tenant, like the mail outbox): offers starting or ending since the last recompute
CREATE INDEX "product_offers_valid_from_idx" ON "product_offers"("valid_from");
CREATE INDEX "product_offers_valid_until_idx" ON "product_offers"("valid_until");

-- ───────────── Catalogue exports (.xlsx, also the offer template); a row is written when the file is stored ─────────────
-- CreateTable
CREATE TABLE "catalogue_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "filters" JSONB NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "generated_by_id" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalogue_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalogue_exports_tenant_id_generated_at_idx" ON "catalogue_exports"("tenant_id", "generated_at" DESC);

ALTER TABLE "catalogue_exports" ADD CONSTRAINT "catalogue_export_valid"
  CHECK ("row_count" >= 0 AND "row_count" <= 50000 AND "expires_at" > "generated_at"
    AND char_length("file_name") BETWEEN 1 AND 200 AND jsonb_typeof("filters") = 'object');

-- AddForeignKey
ALTER TABLE "catalogue_exports" ADD CONSTRAINT "catalogue_exports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (uses the existing unique index users_tenant_id_id_key)
ALTER TABLE "catalogue_exports" ADD CONSTRAINT "catalogue_exports_tenant_id_generated_by_id_fkey" FOREIGN KEY ("tenant_id", "generated_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Offer imports (the filled template); apply re-plans from the stored file and never reuses the preview ─────────────
-- CreateTable
CREATE TABLE "offer_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "row_count" INTEGER,
    "counts" JSONB,
    "preview_token" TEXT,
    "idempotency_key" TEXT,
    "created_by_id" UUID NOT NULL,
    "applied_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previewed_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offer_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_imports_tenant_id_created_at_idx" ON "offer_imports"("tenant_id", "created_at" DESC);
CREATE UNIQUE INDEX "offer_imports_tenant_id_idempotency_key_key" ON "offer_imports"("tenant_id", "idempotency_key");

ALTER TABLE "offer_imports" ADD CONSTRAINT "offer_import_valid"
  CHECK ("status" IN ('uploading', 'previewed', 'applied', 'discarded', 'failed')
    AND "size" > 0 AND "size" <= 5242880
    AND char_length("file_name") BETWEEN 1 AND 200
    AND ("row_count" IS NULL OR "row_count" BETWEEN 0 AND 5000)
    AND ("counts" IS NULL OR jsonb_typeof("counts") = 'object')
    AND ("preview_token" IS NULL OR "preview_token" ~ '^[a-f0-9]{64}$')
    AND ("idempotency_key" IS NULL OR "idempotency_key" ~ '^[A-Za-z0-9_-]{8,100}$')
    AND (("status" = 'applied') = ("applied_at" IS NOT NULL AND "applied_by_id" IS NOT NULL AND "idempotency_key" IS NOT NULL))
    AND ("status" <> 'previewed' OR ("previewed_at" IS NOT NULL AND "preview_token" IS NOT NULL)));

-- AddForeignKey
ALTER TABLE "offer_imports" ADD CONSTRAINT "offer_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (uses the existing unique index users_tenant_id_id_key)
ALTER TABLE "offer_imports" ADD CONSTRAINT "offer_imports_tenant_id_created_by_id_fkey" FOREIGN KEY ("tenant_id", "created_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_imports" ADD CONSTRAINT "offer_imports_tenant_id_applied_by_id_fkey" FOREIGN KEY ("tenant_id", "applied_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Product history: membership of a product in a bulk or imported offer operation ─────────────
-- Same pattern as audit_events_marketplace_values_changes_gin_idx (202611100001). Maintained in SQL only.
CREATE INDEX "audit_events_offers_changes_gin_idx"
  ON "audit_events" USING GIN (("details" -> 'changes') jsonb_path_ops)
  WHERE "action" IN ('pricing.offers_bulk_set', 'pricing.offers_bulk_removed', 'pricing.offers_imported');

-- ───────────── Row-level security: same as 202610280003_catalogue_uploads ─────────────
-- Policy defined now, NOT enabled in Phase 1 (one tenant per database; ADR 008). Same policy name and the same
-- app.tenant_id setting as every other tenant table, so enabling RLS later covers these tables too.
-- (product_offers already has this policy from 202610280003.)
DROP POLICY IF EXISTS tenant_isolation ON "catalogue_exports";
CREATE POLICY tenant_isolation ON "catalogue_exports" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON "offer_imports";
CREATE POLICY tenant_isolation ON "offer_imports" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

`ALTER … TYPE TIMESTAMPTZ(3)` rewrites `product_offers`. The table is small (a few thousand rows at most), so this is a brief lock. Converting rounds to the millisecond. The matching Prisma schema changes (`@db.Timestamptz(3)`, `@@unique`, the two models) come in the same commit. The partial GIN index is SQL only, as in earlier migrations.

**Why separate tables, and not reuse `generated_files` or `uploads`.**

- `generated_files` has `marketplace_id NOT NULL` and a `kind` CHECK. Its history is the marketplace files list.
- `uploads` has a `source` CHECK and the ERP and marketplace pipeline (`needs_mapping`, `upload_rows`, apply jobs). Branching every stage of it for offers costs more than one small table.

## E. Catalogue export design

**Request.** `POST /api/catalogue-exports` (202) with the **catalogue list filters**:

```ts
{
  q?: string,
  tab?: 'all' | 'active' | 'inactive' | 'new' | 'missing',
  categoryId?: uuid,
  subcategoryId?: uuid,
  offer?: 'any' | 'active' | 'scheduled' | 'ended' | 'none',
}
```

It returns `{ jobId }`. The `offer` filter is new; the others are the same as `productListQuery`.

**Background job.** A `catalogue-exports` queue on the worker, the same as generated files:

- the job ID is the tenant, the canonical filters and the minute;
- `GET /api/catalogue-exports/jobs/:jobId` returns `{ state, fileId?, message? }`;
- the worker streams `exceljs`, `WorkbookWriter` (already a dependency), page by page by keyset, so 50,000 rows do not sit in memory;
- the object is stored at `storageKeys.catalogueExport(tenant, id)`, then the row is inserted.

**Limit: 50,000 rows.** Preview (`POST /api/catalogue-exports/preview` returns `{ rows, limit }`) and create refuse more with a 400 "Narrow the filter".

**History and download.**

- `GET /api/catalogue-exports` lists the last 30 days (`expires_at = generated_at + 30 days`).
- `GET /api/catalogue-exports/:id/download` returns a signed URL with a TTL of 300 s or less. An expired file returns 404.
- Storage cleanup reuses the existing generated-files lifecycle rule, if the bucket has one. **This is not verified:** the bucket lifecycle could not be checked from the repo.

**Permission.** `reports.export`, which honours `analystCanExport`, plus `products.view`. One `catalogue.exported` audit event, holding the filters and the row count only.

**Columns** (row 1 headers, frozen; one row per product; the order is fixed because the upload reads it back):

| # | Header | Value |
| --- | --- | --- |
| 1 | SKU | `products.sku` |
| 2 | Barcode | `products.barcode`, as text so leading zeros are kept |
| 3 | Name (English) | |
| 4 | Name (Arabic) | |
| 5 | Category | "Category / Subcategory" |
| 6 | Status | active / inactive / new (+ "missing from ERP" note) |
| 7 | ERP price | `erp_price` |
| 8 | Expected marketplace price | the price without the offer (the rule price). With per-marketplace rules on, one column per enabled marketplace ("Expected price: Talabat", …). **Uncertain, confirm.** |
| 9 | ERP stock | |
| 10 | Catalogue stock | `catalogueStock(erpStock, edit)` |
| 11 | Before price | the normal price during an offer: the default, product and category chain without the offer and without the per-marketplace rule. **Uncertain when per-marketplace rules are on.** |
| 12 | After price | the active or scheduled offer price; blank when there is none or it ended |
| 13 | Offer start | Qatar date `YYYY-MM-DD` (an Excel date cell); blank = no start |
| 14 | Offer end | Qatar date, inclusive |

A second, hidden sheet `_qorloop` holds the template version and the export ID, so the upload can warn "this template is from an older export".

## F. Offer upload design (Excel template)

**Flow.** It matches uploads and the bulk price change:

1. `POST /api/offer-imports` with `{ fileName, size }` returns `{ id, uploadUrl, expiresAt }`. The client PUTs the file directly to storage, because the API's body limit is 32 KB.
2. `POST /api/offer-imports/:id/preview` parses synchronously in the API. At 5,000 rows this is under a second. It returns:

   ```ts
   {
     counts: { rows, matched, toSet, unchanged, notFound, invalid, duplicate, warnings },
     sample: Row[50],
     previewToken,
   }
   ```

   The status becomes `previewed`.
3. `GET /api/offer-imports/:id/rejected` returns the rejected rows as .xlsx: the original columns + "Row" + "Reason". It is generated on request by re-planning; nothing is stored.
4. `POST /api/offer-imports/:id/apply` with `{ previewToken, idempotencyKey }`:
   - it re-reads the file and re-plans;
   - a different token gives a 409;
   - **one transaction** under the tenant lock: an upsert per product (`source = 'upload'`), and **one** `pricing.offers_imported` audit event whose `changes` holds the product IDs with old and new values;
   - after the commit, **one** `enqueueRecon('product.offer')`;
   - a repeat with the same key returns the first result.
5. `POST /api/offer-imports/:id/discard`.

**Limits.**

- `.xlsx` only, 5 MB or less, the first sheet, at most 5,000 data rows, headers matched by name (case- and space-insensitive).
- Only SKU, Barcode, After price, Offer start, Offer end and Before price are read. The other columns are ignored.

**Matching.**

- A barcode is normalised and matched like the ERP file. If the barcode is blank, the SKU is matched exactly.
- If both are given and point to different products, the row is rejected.

**Row outcomes and rejection reasons** (the codes and labels go into the contract):

| Outcome | Code | Rule |
| --- | --- | --- |
| set | — | valid; creates or replaces the offer |
| unchanged | `unchanged` | same price and dates as the current offer |
| skipped | `no_offer_values` | After price, start and end all blank. **Means "no change", not "remove"** (decision; removal is in the app) |
| rejected | `not_found` | no product with this barcode or SKU |
| rejected | `sku_barcode_conflict` | the SKU and barcode match different products |
| rejected | `duplicate_row` | the product appears in more than one row (all of its rows are rejected) |
| rejected | `product_not_active` | the product is new or inactive (offers apply to active products; **confirm**) |
| rejected | `invalid_price` | not a number, ≤ 0, more than 3 decimals, or > 100,000 |
| rejected | `price_not_below_normal` | After ≥ the normal price. **Recommended reject; confirm** (it could be a warning instead) |
| rejected | `invalid_date` | not an Excel date, `YYYY-MM-DD` or `DD/MM/YYYY` (MM/DD is never assumed) |
| rejected | `end_required` | Offer end is blank. **Recommended so no promotion runs forever; confirm** (the API allows open-ended) |
| rejected | `end_before_start` | end < start |
| rejected | `already_ended` | end < today (Qatar) |
| warning | `before_price_changed` | the file's Before price differs from today's normal price (old template) |
| warning | `export_value_outranks` | a pending or pinned price export value exists on a marketplace (O5) |
| warning | `replaces_offer` | the product already has a different offer |

## G. Step plan, effort and risks

| Step | Content | Schema | Effort |
| --- | --- | --- | --- |
| 1 | O1 boundary sweep (scheduler, cross-tenant query, `'sweep'` reason), O2 in `status.ts` and `fileValues`; pure + PGlite tests (offer starts, offer ends, both references, files, pin outranks offer); ADR 020 + open gaps | none | ~1 day |
| 2 | Migration (after approval), Prisma; upsert on the unique key; offer views: `normalPrice`, `offer {price, validFrom, validUntil, state, source}` on the product list, product detail and Review; `offer` filter on the product list; Qatar date helpers; comparison tests with an active offer | yes | ~1 day |
| 3 | Catalogue export: worker job, streaming xlsx, 5 endpoints, 50,000 limit, 30-day history, permission | `catalogue_exports` | ~1.5 days |
| 4 | Offer upload: signed upload, preview, rejected file, apply (one transaction, idempotency, one event, one recompute), discard | `offer_imports` | ~2 days |
| 5 | Bulk offers API: `POST /api/pricing/offers/bulk/preview\|apply` with `{ selection, offer: { price, validFrom?, validUntil } }`, where `selection` is the bulk price selection (ticked IDs ≤ 500, the same as `BULK_PRODUCT_IDS_MAX`, or the filter ≤ 5,000); `…/bulk-remove/preview\|apply` | none | ~1 day |

**Risks.**

1. The base branch is unmerged. When `feature/marketplace-export-values` merges, `feature/offers-v1` needs a rebase. In this environment the rebase needs a force-push, which the owner does.
2. `.github/workflows/ci.yml` only runs on `main` and on pull requests. **A push of `feature/offers-v1` does not run CI** until `ci/run-on-branches` is merged or a PR is opened. Opening a PR needs your go-ahead.
3. The memory gate: local runs may be blocked, and then nothing is verified locally.
4. Excel dates: serial numbers versus text, and the 1900 leap-year bug. A cell can carry a time and time zone, while the template promises Qatar calendar dates.
5. The promo price lands in the marketplace's normal price column until O3 (section C).
6. A boundary refuses files previewed before it (by design, but users will see it at midnight).
7. The `RAISE EXCEPTION` in the migration stops if duplicate offers exist. Run the pre-check first.

## Price source (requirement 2): a mismatch with `compareReferenceDefault` (decision needed)

`compareReferenceDefault` today chooses **which comparison the dashboard, Review and summaries show by default**:

- `'marketplace'`: the expected price = ERP price + rules (and offers);
- `'erp'`: the **raw ERP price, no rules**.

The client's two options map differently:

| Client option | What it is in Qorloop today |
| --- | --- |
| "ERP price plus rules" | the `'marketplace'` reference (the rule chain) |
| "Marketplace prices as the baseline" | **price adoption** (`/api/pricing/adopt`: the listing prices become product rules), then the `'marketplace'` reference |

Reusing `compareReferenceDefault` as "price source" would make `'erp'` mean "rules", which is wrong. **Recommendation:** add no setting and do not relabel the field. Present "price source" in the UI as:

1. the rule chain, which is the default;
2. "Use Talabat's prices" = run the adoption flow, offered in onboarding and settings.

Stock stays ERP/catalogue versus marketplace. **Not decided here: owner and client to confirm.**

## Products missing from a FULL ERP file (not decided; options for the owner)

**Today.** The review lists them. Apply sets `in_latest_erp_file = false` (and back to `true` when they reappear). The product stays `active`:

- the catalogue shows it under the "missing" tab;
- recon marks it `missing_from_erp` when it is listed, and flags `available_but_out_of_stock` when the listing is available;
- nothing is made inactive or unavailable.

| Option | Effect | Pros | Cons |
| --- | --- | --- | --- |
| A. Keep flagging only | as today | no surprise; reversible | the marketplace keeps selling items the ERP dropped |
| B. Auto-inactivate on a full file | `status = inactive` | matches the client hint | one wrong "full" file (a truncated export) inactivates half the catalogue |
| C. **Ask in the ERP change preview** (your suggestion) | a choice on the review: "N products are not in this full file: keep / make unavailable / make inactive", default **keep**, applied in the same transaction with one audit event | explicit, per file, auditable | one more decision per full upload |
| D. Make unavailable (catalogue stock 0) | the files set them unavailable; the product stays active | reversible by the next file; no catalogue churn | it hides a dropped product instead of retiring it |
| E. Grace period | inactivate after N consecutive full files or X days missing | tolerant of one bad file | more state; harder to explain |

**Recommendation:** C, offering both "make unavailable" (D) and "make inactive" as the actions, defaulting to keep, and never automatic. Add a safety warning when more than 20% of active products are missing ("Is this really a full file?"). Still to define: whether a product that reappears returns to active automatically (recommended for "unavailable", not for "inactive").

## Out of scope: what O3 (before/after columns in marketplace sheets) would need

- Real Talabat and Snoonu promo sheets (open gap G4):
  - column names for the original and the promo price, and the date columns;
  - their format and time zone;
  - whether promos are a separate sheet or portal campaign rather than columns of the catalogue sheet;
  - per-branch scope.
- Then:
  - mapping fields `originalPrice` / `promoPrice` / `promoStart` / `promoEnd`;
  - new `listings` columns (a migration);
  - comparing the promo column with the offer and the normal column with the normal price;
  - writing both in generated files.
- Not built.

## Not verified

- The demo database: offer duplicates and CHECK violations. Run the pre-check queries.
- The storage lifecycle and retention rule.
- How Talabat and Snoonu treat a lowered regular price (section C).
- No tests were run. This step has no code.
