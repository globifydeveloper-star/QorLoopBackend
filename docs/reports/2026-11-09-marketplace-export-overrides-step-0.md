# Marketplace values to export: Step 0 inspection and approval proposal

Date: 9 November 2026. Inspected baseline: `36b3280`. **Proposed, not approved or implemented.**
Only this report changes in Step 0. No Prisma schema, migration file, database, application code or test harness changes.
No tests, builds, typecheck, lint, database connections or migrations were run. No credentials were read or printed.

## 1. Current value paths

| Layer | Code and current behaviour |
| --- | --- |
| ERP apply | `apps/worker/src/apply-upload.ts`, `packages/core/src/upload/apply.ts`, `packages/db/src/uploads.ts`: apply-time plan writes mapped ERP-owned product fields in one tenant-locked transaction. Full uploads mark missing products; partial uploads do not. Stock changes also run `planErpStockConflicts`. |
| Catalogue stock | `packages/core/src/catalogue-stock.ts`, `packages/db/src/recon.ts::products`: `catalogueStock = catalogue_stock_edits.stock` when an edit exists, including an open conflict; otherwise `products.erp_stock`. Owner decision D1 in ADR 017 keeps the owner's stock in effect during a conflict. |
| Catalogue availability | `packages/core/src/recon/status.ts`: active product AND ERP-active AND present in latest ERP file AND catalogue stock **strictly greater than** stock threshold. ERP availability uses the same gates with ERP stock. |
| Catalogue expected price | `packages/core/src/pricing.ts`: first applicable step wins: valid offer, product rule, subcategory rule, category rule, enabled per-marketplace rule, tenant default. Valid offers include both date endpoints; latest validFrom wins (stable input order for ties). Percent/amount results use configured rounding and clamp to zero; fixed/same/offers use integer fils (QAR x 1000). |
| Recon computation | `packages/core/src/recon/compute.ts::computeReconRows`: one product x enabled marketplace; calculates the rule price per marketplace when necessary and calls `reconcile`. `status`/`stock_issue`/`price_mismatch_vs_marketplace` compare catalogue-derived values with the listing. ERP counterparts compare raw ERP values. Price mismatch means absolute difference in fils **greater than** tolerance. |
| Listing chosen | `packages/db/src/recon.ts::listings`: per tenant/marketplace/product, newest `updated_at`, then ascending marketplace product ID. Several listing IDs can point to one product; only one wins recon. |
| Recon persistence | `apps/worker/src/recompute-recon.ts`, `packages/db/src/recon.ts`: repeatable-read snapshot with per-tenant recon advisory lock, signatures compared in core and SQL, changed rows written in batches; both reference summaries counted from stored rows in the same transaction. It does not hold the tenant row lock. |
| Report reads | `apps/api/src/recon/recon.controller.ts`, `recon.service.ts`, `packages/db/src/recon.ts::rows`: stock and price reports use the same recon endpoints below. There is **no dedicated stock-report or price-report controller/route** in the registered app. Stock/price filters, urgency and status follow the requested reference. Catalogue stock/source/conflict are joined live, while availability, prices, actual values and flags come from stored recon, so a recompute lag can already mix generations. |
| File database inputs | `packages/db/src/generated-files.ts::reconRows`: reads stored recon; availability and stock issue follow reference; selects the same listing winner to recover its marketplace product ID. `latestApplied` supplies the original file, headers and mapping. |
| File core plan | `packages/core/src/generated-files.ts::planGeneratedFile`: uses supplied flags/values; never recalculates price or stock. Price cell = ERP price for `erp`, rule-derived marketplace price for `marketplace`. Availability cell = the reference-specific availability. Stock-only preserves original price; price-only preserves original availability. |
| File selection/format | Requires a listing (`actualPrice !== null`). `mismatches` selects the requested stock/price issue; `all` excludes missing-from-ERP rows. Missing-from-ERP rows can still enter a stock mismatch export to disable them. Uses mapped marketplaceProductId, else first barcode; writes every duplicate source row for the chosen ID. Preserves preamble/header and unmapped cell values, not Excel formatting/formulas. Quantity-like availability blocks every kind, including price-only; only boolean-like encodings are supported. |
| File API/worker | `packages/shared/src/generated-files.ts`, API generated-files service, `apps/worker/src/generate-file.ts`: preview and worker share loading/planning. Worker reloads a snapshot, parses outside DB locks, serializes, writes an object and a generated-file row plus audit event. It rechecks an existing output ID before storage, but **does not recheck input freshness before publishing**. Jobs deduplicate identical tenant/marketplace/kind/scope/reference within a minute; an edit within that minute can currently return an earlier file. |

An inline price edit today (`PUT /api/pricing/products/:id`) writes a **product rule shared by all marketplaces**.
Bulk price changes do too. Neither is suitable for this new comparison-list action. The unused
`marketplace_price_rules.product_id` is not a suitable substitute: it would change the pricing chain rather than add
an export instruction with acknowledgement and audit lifecycle. ADR 017's earlier supersession of marketplace
overrides described the previous scope; this proposal adds a separate layer without replacing catalogue stock.

## 2. Existing endpoints and exact wire shapes

All JSON successes below have `{ data: ... }`; dates serialize as ISO strings. Marketplace IDs are
`talabat | snoonu | rafeeq | keeta`. References are `marketplace | erp`; omitted reference uses the tenant default.

```ts
GET /api/recon/summary?reference=marketplace
data = {
  reference, computedAt: string | null, stockConflicts: number,
  marketplaces: Array<{
    marketplaceId, hasData: boolean, stock: number, price: number, total: number,
    listed: number, notListed: number, noData: number, missingFromErp: number,
    newCount: number, lastUploadAt: string | null, stale: boolean
  }>
}
// total = stock + price, not distinct affected products.

GET /api/recon/rows?marketplaceId=talabat&type=stock|price|all
// Optional status, reference, cursor (max 200 characters), limit (1..200, default 50).
// type defaults to all. Cursor encodes [urgencyRank, productId].
data = { reference, items: Array<{
  productId: string, barcode: string, sku: string | null, nameEn: string,
  nameAr: string | null, productStatus: string, erpStock: number,
  status: 'in_sync'|'mismatch'|'not_listed'|'missing_from_erp'|'new'|'no_data',
  stockIssue: 'available_but_out_of_stock'|'unavailable_but_in_stock'|null,
  priceMismatch: boolean, priceMismatchVsErp: boolean, priceMismatchVsMarketplace: boolean,
  expectedPrice: number|null, erpPrice: number|null, marketplacePrice: number|null,
  marketplacePriceSource: 'offer'|'product'|'subcategory'|'category'|'marketplace'|'default'|null,
  actualPrice: number|null, erpAvailable: boolean|null, actualAvailable: boolean|null,
  lastUpdated: string, catalogueStock: number, catalogueStockSource: 'erp'|'owner',
  stockConflict: boolean, catalogueAvailable: boolean|null,
  stockIssueVsCatalogue: string|null, stockIssueVsErp: string|null
}>, nextCursor: string|null }

POST /api/recon/recompute       // pricing.edit; data = { queued: true }

POST /api/generated-files/preview
POST /api/generated-files      // 202
body = { marketplaceId, kind: 'stock'|'price'|'stock_price',
         scope?: 'mismatches'|'all', reference?: 'marketplace'|'erp' }
// scope defaults to mismatches.
preview.data = {
  productCount: number, rowsToWrite: number, priceChanges: number,
  availabilityChanges: number, notInFile: number,
  largestPriceChange: { name: string, from: number, to: number }|null,
  firstRows: Array<Record<string, string|number|boolean|null>>, // at most 10
  sourceFile: { name: string, uploadedAt: string }, warnings: string[], referenceUsed
}
generate.data = { jobId: string }
GET /api/generated-files/jobs/:jobId
data = { state: 'queued'|'running'|'done'|'failed', fileId?: string, message?: string }
GET /api/generated-files
data = Array<{ id, marketplaceId, kind, scope, reference, fileName, productCount,
               generatedAt, generatedBy: string, expiresAt }>
GET /api/generated-files/:id/download
data = { url: string, fileName: string, expiresAt: string }
```

Recon reads require `recon.view`; generated-file routes have their respective `files.*` permissions. Mutations require
trusted Origin and cookie-session CSRF; tenant comes from the resolved host/session, never the body.
Errors have `{ error: { code, message, details? }, requestId }`.

## 3. Recommended semantics (approval required)

1. **Separate export layer.** `exportPrice = pending price override ?? catalogue rule price`;
   `exportAvailable = pending availability override ?? catalogue availability`, subject to the lifecycle guard in D3.
   The override belongs only to this tenant/product/marketplace. It never writes products, catalogue stock, rules,
   offers or marketplace listings. Availability is a boolean, not a stock quantity.
2. **Keep comparison truth.** Existing statuses, summary counts and filters continue to show catalogue-versus-listing
   (or ERP-versus-listing). A correction does not pretend that the marketplace changed. Add a separate state with
   label **"fixed in Qorloop, waiting for export"**. Generating/downloading a file never acknowledges it.
3. **Two independent fields.** One row per tenant/product/marketplace, with availability and price values, separate
   pending/cleared states and separate who/when/reason/clear timestamps. Updating or clearing price must not change
   availability provenance or vice versa. A row retained after clearing provides a stable version/tombstone; complete
   change history is the audit log. No automatic expiry or history backfill.
4. **Later marketplace upload acknowledges each field independently.** After upsert and full-list removal, within
   the same apply transaction, examine only accepted, uniquely matched incoming listings of this marketplace. Require
   the upload's `createdAt`, truncated to milliseconds, to be strictly greater than `field.setAt` (a file staged before
   the edit must not clear it merely because it applies later; same-millisecond uploads conservatively do not clear).
   Availability matches exactly; price matches exactly in integer fils, **not** the recon price tolerance. Mark a field
   cleared and audit its saved value, matched value and upload ID. A skipped, absent, ambiguous/unmatched row, another
   marketplace, or an unchanged old listing is not evidence. Partial uploads can acknowledge their accepted rows only.
   For multiple listing IDs of one product, require **all retained listings** to agree with that field, and at least one
   accepted incoming listing as evidence. A conflicting duplicate keeps it pending; expose `ambiguous_listings`.
   Retrying an already-applied upload does nothing. No clearing in the recon worker.
5. **After acknowledgement, fallback resumes.** Example: catalogue 10, override 12, later marketplace file 12 ->
   override clears, catalogue is still 10, and a later export may propose 10 again. This is the requested clear-on-match
   behaviour, not a permanent marketplace price policy. An owner wanting to retain 12 indefinitely needs a separate
   product/marketplace pricing feature, or must choose different clearing semantics before implementation.
6. **ERP uploads and catalogue edits.** Do not clear/rebase these overrides. ERP updates the catalogue as today;
   existing catalogue stock conflicts continue unchanged with owner stock in effect. Catalogue stock edits/resolutions,
   product price rules, category/default/per-marketplace rules, offer starts/expiry and threshold changes update the
   displayed catalogue value. A pending field remains the export instruction; unoverridden fields follow the catalogue.
   Even if the catalogue catches up, only a later matching marketplace upload or explicit reset clears the instruction.
7. **Use catalogue value.** Explicit field reset marks that field cleared, without editing the catalogue or marketplace.
   It follows the latest catalogue calculation, not a snapshot copied at reset time. Setting an explicit value equal to
   the current listing is still a pending instruction until later evidence; setting equal to catalogue is also allowed.
8. **Eligibility.** Only enabled marketplaces and already listed, active products may receive new overrides. A pending
   `true` can bypass stock quantity/threshold, because it is a marketplace availability instruction. It cannot bypass
   inactive status, ERP-inactive or missing-from-ERP gates (D3). If eligibility later disappears, retain the pending
   value, expose `blocked`, write `false` availability where disabling is supported, and do not acknowledge `true`
   using a `false` upload. Disabled marketplaces are blocked; pending fields remain for review/reset.
9. **Price/offer precedence.** Override is an absolute QAR value after the existing chain and rounding; it outranks an
   active offer on this marketplace only. Proposed manually set bounds: greater than zero, at most 100,000 QAR,
   maximum 3 decimals, matching existing manual-price limits. Catalogue-derived zero prices remain possible.
10. **Reference.** Recommended: `reference` continues to select comparison/filter context. Files always write the
    marketplace export instruction (override else catalogue), even with `reference=erp`; preview explicitly reports
    `valueBasis: 'marketplace_export'`. Thus the ERP view cannot bypass a correction. This changes the old ERP-file
    write behaviour and requires D2 approval. Alternative: preserve legacy ERP files and block them whenever a pending
    override exists, directing the owner to the catalogue export.

## 4. Minimal implementation seams and freshness

No extra `recon_rows` columns are proposed. Preserve stored catalogue/ERP values and comparisons. Add a tenant-scoped
override repository and a pure effective-value resolver. Join overrides to recon reads and generated-file reads by
**tenant + product + marketplace**; use shared pure projection rules and SQL equivalents for filtering. Pending state
then appears immediately without waiting for recon. A coalesced recompute still follows each committed mutation,
and marketplace apply already queues one; auto-clear must not queue a second one.

The export plan must have explicit `exportPrice`, `exportAvailable`, `exportPriceMismatch`, `exportStockIssue`,
`exportState` inputs. The writer must consume them directly, without overloading `marketplacePrice` or `erpPrice`.
For mismatch-scope files, select a field if its export value differs from marketplace current **exactly**, or it has
a pending instruction, even when the catalogue recon flag is false or price difference is within tolerance. Combined
files take the union; stock-only/price-only still preserve the other source cell. Keep original-file safety checks.

Before Step 3 is complete, close both existing freshness gaps: read current catalogue/pricing/settings/listings and
overrides in one snapshot for the export projection (do not combine old recon values with new overrides); include
source upload ID and an export-input fingerprint in generation job identity. Before storing a finished file, recheck
that fingerprint under the tenant mutation lock; if changed, reject with a safe retry message. This includes time-based
offer transitions, product eligibility and marketplace switches. Preview can return the fingerprint as `exportToken`;
generation accepts it and rejects a stale preview. Existing output files are immutable historical artifacts; the action
must create/identify the file for the current inputs, never reuse a minute-cached result from before the edit.

Live export projection can reuse `ReconRepository.products`, pricing snapshot/settings and listing winner bulk reads;
it is more work than simply joining a row, but avoids inventing stale export values. Report pagination may keep the
stored comparison result and `lastUpdated` while clearly marking it as such. Export values are fresh, with `exportAsOf`.
Measure the bulk reads and predicate plans on real PostgreSQL later; no performance claim is made here.

## 5. Proposed API contracts (not existing endpoints)

Strict JSON; unknown keys fail. All results below remain wrapped in `{ data }`. Read permission `recon.view`;
new `marketplace.values_edit` for Owner/Admin/Catalogue Manager for all mutation/preview routes; Analyst read-only.
Do not route this action through existing catalogue/pricing mutations.

```ts
type Field = 'availability'|'price';
type Version = { id: string /* UUID */, version: number /* positive int */ } | null;
// null means no row was observed; retained cleared row has a non-null version.
type SetAction = { type: 'set', values: { availability?: boolean, price?: number } };
type ResetAction = { type: 'use_catalogue', fields: Field[] };
// values must contain >=1 field; fields must contain 1..2 distinct names.

PUT /api/marketplace-values/:marketplaceId/products/:productId
body = { values: { availability?: boolean, price?: number },
         reason?: string /* trimmed, <=500 */, expected: Version }
// Partial field update; expected required. Same value/state/reason is a no-op.

DELETE /api/marketplace-values/:marketplaceId/products/:productId
// Query: fields=availability|price|all, expectedId=<uuid>&expectedVersion=<int>
// Or expectedAbsent=true, mutually exclusive with expectedId/expectedVersion.
// Equivalent to use_catalogue; never deletes the product or the retained override row.
data = { changed: boolean, operationId: string|null, item: MarketplaceValueItem }

type Selection = { productIds: string[] } | { filter: {
  q?: string, categoryId?: string, subcategoryId?: string,
  type?: 'stock'|'price'|'all', reference?: 'marketplace'|'erp',
  status?: 'in_sync'|'mismatch'|'not_listed'|'missing_from_erp'|'new'|'no_data',
  exportState?: 'catalogue'|'waiting_for_export'|'blocked'|'cleared'
} };
type BulkBody = { marketplaceId, selection: Selection,
                  action: SetAction|ResetAction, reason?: string };
POST /api/marketplace-values/bulk/preview
body = BulkBody
data = { marketplaceId, selection, action, reason: string|null, limit: 5000,
         selected: number, willChange: number, unchanged: number, blocked: number,
         blockedByReason: Record<string, number>,
         rows: Array<{ productId, before: MarketplaceValueItem,
                       after: MarketplaceValueItem, blockedReason: string|null }>,
         previewToken: string /* 64 lowercase hex */ }
// first 10 rows; selected = willChange + unchanged + blocked
POST /api/marketplace-values/bulk/apply
body = BulkBody & { previewToken: string /* REQUIRED */,
                    idempotencyKey: string /* 8..100 letters/digits/_/- */ }
data = { operationId: string, replayed: boolean, appliedAt: string,
         marketplaceId, selected: number, willChange: number, unchanged: number,
         blocked: number, blockedByReason: Record<string, number>,
         created: number, updated: number, clearedFields: number }

GET /api/marketplace-values?marketplaceId=talabat
// Optional productId, field=availability|price, state=pending|cleared,
// q (1..200), limit (1..200, default 50), cursor (<=200).
// Keyset order productId; only persisted rows returned. No tenant parameter.
data = { items: MarketplaceValueItem[], nextCursor: string|null }

type FieldMeta = { state: 'pending'|'cleared', setById: string, setAt: string,
                   reason: string|null, clearedAt: string|null };
type MarketplaceValueItem = {
  productId: string, marketplaceId, version: Version,
  catalogue: { stock: number, stockSource: 'erp'|'owner', stockConflict: boolean,
               available: boolean, price: number, priceSource: string },
  marketplaceCurrent: { available: boolean|null, price: number|null },
  export: { available: boolean, price: number,
            availabilitySource: 'catalogue'|'override'|'eligibility_guard',
            priceSource: 'catalogue'|'override' },
  overrides: {
    availability: (FieldMeta & { value: boolean })|null,
    price: (FieldMeta & { value: number })|null
  },
  exportState: 'catalogue'|'waiting_for_export'|'blocked'|'cleared',
  exportStateLabel: string|null,
  blockedReason: 'not_listed'|'inactive'|'erp_inactive'|'missing_from_erp'|
                 'marketplace_disabled'|'ambiguous_listings'|null,
  exportAsOf: string
};
// 'cleared' = retained row with no pending fields; exports follow catalogue.
// 'catalogue' = no persisted row. waiting_for_export has the owner's exact label.
// blocked takes precedence while a pending instruction cannot safely be exported.

// Add to every existing recon row (both stock/price reports):
{ marketplaceId, marketplaceValues: MarketplaceValueItem }
// Keep existing names and comparison meanings. Add optional exportState filter.
// Add pendingExportProducts and blockedExportProducts per marketplace to summary;
// count these from current overrides/projection rather than stale recon summaries.

// Extend generated-files preview with:
{ valueBasis: 'marketplace_export', exportToken: string,
  pendingExportProducts: number, blockedExportProducts: number }
// Extend generate body with optional exportToken (required by new comparison-list UI).
// Worker freshness recheck applies even to callers without a preview token.
```

At most **5,000 selected products** (not merely changed products); reject >5,000, never truncate. As existing bulk price
change: at most 500 explicit IDs because the global body limit is 32 KB; use a filter for up to 5,000. Deduplicate IDs,
count foreign/unknown IDs as `not_found`, do not reveal the other tenant. Set blocks ineligible products; reset is
allowed for owned products regardless of current listing/status/switch. Existing records can always be reset.

Concurrency: single mutations require row ID + integer version, checked under `Database.run`'s tenant
`FOR NO KEY UPDATE` lock; increment on every real change, including partial auto-clear. Version handles same-millisecond
updates and retained rows prevent delete/recreate ABA. Bulk preview hashes canonical selection/action, all selected
IDs, versions, eligibility, catalogue/current/export values, relevant settings and plan outcomes (including no-ops and
blocked rows); apply replans under that lock and requires the token to match. Time-dependent offers must be reevaluated.
Stale state -> 409 with no writes. Preview is read-only. Bind token to tenant/marketplace and normalized body.

Reuse bulk-price idempotency: audit-event lookup scoped to tenant/action/key over 24 h, request hash excluding token/key,
canonical IDs, replay before replan, different request on same key -> 409, one transaction for changes and event.
Even an all-no-op bulk apply records its result for replay; it queues no recompute. One recompute after a changed commit,
none for a replay. Required tokens are intentionally stricter than the older optional bulk-price token.

Audit: `product.marketplace_values_set`, `product.marketplace_values_cleared`,
`marketplace.values_bulk_applied`, `marketplace.values_upload_cleared`. Single events use product entity ID; bulk/upload
events use compact `changes` arrays with product ID first. Include marketplace, affected fields, before/after values and
states, version, reason and source upload ID for acknowledgement; actor is the owner for manual changes and apply
requester for upload changes. Add activity presentation, group assignment and indexed per-product membership branches;
do not leave the new events invisible in product history. Never copy arbitrary details into API responses.

## 6. Proposed storage and exact migration SQL

Candidate migration name: `202611090001_marketplace_value_overrides`. **SQL below is a review proposal only.**
One new table plus one partial audit membership index. No recon schema alteration, backfill, RLS enablement or existing
constraint changes. All new timestamps use millisecond precision. Unique key is exactly tenant/product/marketplace;
independent availability and price fields avoid an additional kind key and allow independent acknowledgement.
Nullable state means that field has never been set; cleared values/provenance remain until the next set of that field.
An integer version is concurrency control; timestamps are audit information rather than the sole version check.

```sql
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

CREATE UNIQUE INDEX "marketplace_value_overrides_tenant_product_marketplace_key"
  ON "marketplace_value_overrides" ("tenant_id", "product_id", "marketplace_id");
CREATE INDEX "marketplace_value_overrides_tenant_marketplace_product_idx"
  ON "marketplace_value_overrides" ("tenant_id", "marketplace_id", "product_id");
CREATE INDEX "marketplace_value_overrides_pending_idx"
  ON "marketplace_value_overrides" ("tenant_id", "marketplace_id", "product_id")
  WHERE "availability_state" = 'pending' OR "price_state" = 'pending';

ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_override_valid"
  CHECK ("version" > 0
    AND "marketplace_id" IN ('talabat', 'snoonu', 'rafeeq', 'keeta')
    AND ("availability_state" IS NOT NULL OR "price_state" IS NOT NULL));

ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_override_availability_shape"
  CHECK (
    ("availability_state" IS NULL AND "availability_value" IS NULL
      AND "availability_set_by_id" IS NULL AND "availability_set_at" IS NULL
      AND "availability_reason" IS NULL AND "availability_cleared_at" IS NULL)
    OR
    ("availability_state" IS NOT NULL AND "availability_state" IN ('pending', 'cleared')
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
    ("price_state" IS NOT NULL AND "price_state" IN ('pending', 'cleared')
      AND "price_value" IS NOT NULL AND "price_value" > 0 AND "price_value" <= 100000
      AND "price_set_by_id" IS NOT NULL AND "price_set_at" IS NOT NULL
      AND ("price_reason" IS NULL OR char_length("price_reason") <= 500)
      AND (("price_state" = 'pending' AND "price_cleared_at" IS NULL)
        OR ("price_state" = 'cleared' AND "price_cleared_at" IS NOT NULL
          AND "price_cleared_at" >= "price_set_at")))
  );

ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_product_fkey"
  FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_marketplace_fkey"
  FOREIGN KEY ("marketplace_id") REFERENCES "marketplaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_availability_actor_fkey"
  FOREIGN KEY ("tenant_id", "availability_set_by_id") REFERENCES "users"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketplace_value_overrides" ADD CONSTRAINT "marketplace_value_overrides_price_actor_fkey"
  FOREIGN KEY ("tenant_id", "price_set_by_id") REFERENCES "users"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "audit_events_marketplace_values_changes_gin_idx"
  ON "audit_events" USING GIN (("details" -> 'changes') jsonb_path_ops)
  WHERE "action" IN ('marketplace.values_bulk_applied', 'marketplace.values_upload_cleared');

-- Exactly the explicit policy pattern from 202611060001_erp_changes_catalogue_stock.
-- Defined, NOT enabled or forced; same tenant_isolation name and app.tenant_id setting.
DROP POLICY IF EXISTS tenant_isolation ON "marketplace_value_overrides";
CREATE POLICY tenant_isolation ON "marketplace_value_overrides" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

The existing migrations define policies without enabling RLS (ADR 008/017); runtime does not set `app.tenant_id`.
Therefore application scoping is mandatory on **every** read/write/join, including replay lookup, auto-clear and bulk
selection. Composite product/actor foreign keys prevent cross-tenant references. No FK to `tenant_marketplaces`:
legacy marketplaces may be enabled through an applied upload without a switch row. Enabled status is checked in logic.
No upload FK is needed; matched upload IDs belong to audit details so upload retention cannot erase overrides.
Retain tombstones without a new cleanup policy; retention/disk growth remains an owner decision (existing G17).

## 7. Implementation and validation after approval

One local logical commit per step; no push. Proposed file groups:

| Step | Expected changes |
| --- | --- |
| 0 (this commit) | This inspection/proposal only. |
| 1 | Approved migration and Prisma model/relations; new pure `packages/core/src/marketplace-values.ts` and focused pure tests; resolver and acknowledgement planning. No demo migration deployment. |
| 2 | New db repository, shared contracts, controller/service and app registration; roles/queue reason; bulk plans, mandatory preview token, replay, concurrency, audit/activity membership and tenant isolation. |
| 3 | Recon reads/summary/report shapes; generated-file DB/shared/core/API/worker projection, selection and freshness; marketplace apply acknowledgement in one transaction; integration tests for these paths. |
| 4 | Focused pure + PGlite coverage, API examples, ADR 018, open-gaps updates (including G13/G28 distinction), read-only PowerShell script/checks; typecheck/lint and final evidence report. |

Required scenarios: one marketplace only; independent field set/reset/ack; exact fils vs tolerance; older staged upload;
full/partial/missing/skipped/ambiguous rows; retained conflicting listing IDs; upload rollback/retry; ERP changes and
catalogue conflicts; offer/rule/threshold changes; inactive/missing gates; stale single versions including same-ms changes;
stale mandatory bulk token including no-op/blocked changes; duplicate apply/idempotency and tenant isolation; >5,000
selection/500 explicit ID bounds; one coalesced recompute; pending corrections inside price tolerance; both references;
duplicate Excel rows, quantity block, preserved unrelated cells; fresh generation after edit in same minute; drift during
serialization; never clear on generate/download. PGlite cannot establish real PostgreSQL performance/lock timings.

Preserve `apps/api/src/__tests__/harness.ts` shutdown sequence exactly: close app, **await recon.drain()**, close fixture.
Before **each test invocation**, read Available MBytes and require >=1500. Run `packages/` first, then `apps/` in a separate
invocation with a fresh gate. Stop at the first memory crash; no retry or broader run after it. Do not run package and
app suites concurrently. Apply the same memory check before typecheck/lint as a precaution.

Read-only commands for later validation (do not source/print `.env` or output authenticated headers):

```powershell
# In a fresh check immediately before every permitted test run:
$availableMB = [long](Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes
if ($availableMB -lt 1500) { throw "Memory gate: $availableMB MB available; need 1500 MB" }
# Then run ONLY the relevant approved packages/ OR apps/ test command, never both together.

git status --short
git diff --check
rg -n 'marketplace_value_overrides|tenant_isolation|TIMESTAMPTZ\(3\)' packages/db/prisma
rg -n 'marketplaceValues|exportPrice|exportAvailable|previewToken' apps packages -g '*.ts' -g '!generated/**'
rg -n 'await recon.drain\(\)' apps/api/src/__tests__/harness.ts
```

Step 0 verification: source inspection and documentation diff checks only. SQL has not been executed or validated with
PostgreSQL/PGlite; migration deploy status, real database constraints/plans, real marketplace workbooks and worker/queue
behaviour were not verified. No test success is claimed. No external documentation or network access was needed.

## 8. Owner approval gate

Approve or amend the exact storage/migration above and these decisions before Step 1:

- **D1:** Overrides survive ERP/catalogue/rule/offer/threshold changes; clear per field only on a later-created matching
  marketplace upload or explicit use-catalogue. Clearing resumes catalogue fallback, including the 10 -> 12 -> 10 example.
- **D2:** All generated files write override-else-catalogue regardless of comparison reference (an intentional change
  to legacy ERP exports), or choose the blocking alternative in section 3.10.
- **D3:** Boolean availability may bypass stock/threshold but keeps active/ERP-active/presence gates; blocked instructions
  remain visible. Price override outranks offers. No quantity export is introduced.
- **D4:** Proposed limits/permissions, triple-key paired-field table with independent provenance/tombstones, exact-fils
  acknowledgement, conservative duplicate-listing handling, mandatory bulk tokens and 24-hour idempotency window.

**STOP after Step 0. Owner approval is required by the task before any schema/migration or implementation work.**
