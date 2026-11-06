# ERP change review and catalogue stock: Step 0 inspection

Date: 6 November 2026. Read-only inspection of the committed code (`d8fd3ff`) before any work. Nothing has been changed.
A migration is proposed at the end and is **not applied** until the owner approves it.

## 1. What an ERP upload does today

### Review (before apply): `apps/worker/src/process-upload.ts` + `packages/core/src/upload/review.ts`

`buildErpReview` compares the validated file with a catalogue snapshot read **at review time**
(`UploadRepository.productSnapshot`: id, barcode, sku, nameEn, erpPrice, erpStock, inLatestErpFile).

| Summary count (`uploads.summary`) | Based on |
| --- | --- |
| `newProducts` | file barcodes not in the catalogue |
| `priceChanges` | `erp_price` differs, compared with **2 decimals** (`round2`) |
| `stockChanges` | `erp_stock !== file stock` |
| `missingFromFile` | full lists only: products with `in_latest_erp_file` that the file does not contain |
| `matched`, `rowsWithErrors`, `costIgnored`, `negativeStockClamped` | as named |

Not counted at all: name, SKU, brand, ERP category, cost and active-flag changes.

Per-row data stored: one `upload_rows` row per kept file row with `change_type` (`new | price | stock | price_stock | none`)
and `parsed.change = { price: {old,new}, stock: {old,new} }`. Only price and stock, and only as the review saw them.
Missing products are **not** rows: only `summary.missingSample` (first 20). Staging rows are kept after apply and deleted
only on discard.

### Apply: `apps/worker/src/apply-upload.ts` + `packages/core/src/upload/apply.ts` (`planErpApply`)

One transaction under the tenant lock; the plan is recomputed **against the catalogue at apply time**.

| Field | Existing product | New product |
| --- | --- | --- |
| `erp_price`, `cost_price`, `erp_stock`, `name_en`, `sku`, `brand`, `erp_category`, `erp_active` | overwritten with the absolute file value, only for columns in the confirmed mapping (an empty mapped cell clears an optional field) | from the file |
| `name_ar` | filled only when empty | from the file |
| `in_latest_erp_file` | `true` for every row; `false` for products missing from a full list (never deactivated) | `true` |
| `status`, `category_id`, `subcategory_id`, image, price rules, offers | never touched | `new` (`active` on a first import) |

Changes are applied automatically; there is no per-change approval. After commit: `ANALYZE products`, then one coalesced
recon recompute (`enqueueRecon(tenantId, 'upload.applied')`).

### `product.field_changed` audit events

Written in the same transaction, one per changed field of an **existing** product: `actor_id` = who requested the apply,
`entity_id` = product id, `details = { field, old, new, uploadId }`. Fields: any of the ERP fields above, `nameAr`
(fill), `inLatestErpFile` (true→false for missing, false→true for returning). Not recorded: new products (only the
`upload.applied` count), row numbers, barcodes. There is no index on `details->>'uploadId'`, so listing one upload's
changes from audit events means scanning every `product.field_changed` event of the tenant.

### Findings

1. **Review and apply can disagree.** The review compares price at 2 decimals, the apply at 3 (`money3`): 1.234→1.235
   is not a "price change" in the summary but is applied and audited. The review also predates the apply, so another
   upload applied in between makes the summary stale. The apply is the truth.
2. The review counts only price/stock; the owner cannot see name or cost changes before or after apply, except one by
   one in product history.
3. "Missing from file" is a count plus 20 examples; the full list is not stored anywhere except as audit events.

## 2. Field ownership, stock and price today

- `packages/core/src/constants.ts`: `ERP_OWNED_FIELDS` (barcode, sku, name_en, brand, size, erp_category, erp_price,
  cost_price, erp_stock, erp_active, in_latest_erp_file) and `QORLOOP_MANAGED_FIELDS` (name_ar, category, subcategory,
  image, status, price rule, offers).
- **Price** already has a catalogue layer separate from the ERP value: the expected ("Marketplace") price is resolved
  from the product rule, offers, category / per-marketplace / default rules (`resolveMarketplacePrice`). It is not stored
  on the product.
- **Stock** has no catalogue value. Only `products.erp_stock`.
- **Recon** (`packages/core/src/recon/status.ts`): `erpAvailable = status = 'active' AND erp_active AND
  in_latest_erp_file AND erp_stock > stock_threshold`. One `stock_issue` and one `erp_available` per row, shared by both
  references; only the price differs between `status` (marketplace/expected) and `status_vs_erp`.
- **Generated files** (`packages/core/src/generated-files.ts`) write the availability column from the recon row's
  `erp_available` for both references; they never write a quantity (a quantity-like availability column blocks
  generation). So stock reaches marketplaces only as available / unavailable.
- **Stock threshold**: `tenant_settings.stock_threshold` (default 0), a change triggers a recompute.
- **Per-marketplace availability overrides**: not in the repository (no table, column, code or document).

## 3. Proposed model

### (a) `erp_upload_changes`: what each applied ERP upload changed

One row per product × field, written by the apply from the same plan that writes the products (so it is apply-time
truth). A new product is one row (`kind = new`, no field); a product missing from a full list is one row
(`kind = missing`, `field = inLatestErpFile`, no row number). `kind` is the filter: `new | price | cost | stock | name |
active | missing | returned | other` (other = sku, brand, ERP category, Arabic-name fill). `stock_conflict` marks a stock
change that met an owner-edited catalogue stock. Deleted with its upload (cascade). The existing
`product.field_changed` audit events stay as they are (product history reads them).

### (b)+(c) `catalogue_stock_edits`: owner-edited catalogue stock and conflicts

At most one row per product, like `product_price_rules`. No row = the catalogue stock **is** the ERP stock, so every
product "starts equal to ERP" without a backfill or a second value to keep in step.

| Column | Meaning |
| --- | --- |
| `stock` | the owner's value |
| `erp_stock_at_edit` | ERP stock when the value was set or last "kept"; a later ERP stock different from it is a conflict |
| `state` | `active` (in effect) or `conflict` (ERP changed since) |
| `conflict_upload_id`, `conflict_at` | which ERP upload raised the conflict, when |
| `reason`, `set_by_id`, `set_at`, `updated_at` | who / when / why; `updated_at` for compare-and-set |

ERP apply, per product with an edit whose new ERP stock ≠ `erp_stock_at_edit`:
- new ERP stock = owner's `stock` → the edit is removed (ERP caught up), audited, no conflict;
- otherwise → `state = conflict`, change row `stock_conflict = true`, counted in `upload.applied`.
An ERP upload that does not change the stock leaves the edit in effect. Other field changes (price, name) never raise a
stock conflict.

Resolution: **use ERP** deletes the row; **keep mine** sets `erp_stock_at_edit = current erp_stock`, `state = active`.
Single and bulk, audited.

Effective catalogue stock = `stock` when `state = active`, else `erp_stock` (recommended D1; the alternative keeps
`stock` in effect during a conflict and needs no schema change).

### Recon and generated files

`recon_rows` gains `catalogue_available` and `stock_issue_vs_erp`:
- catalogue / expected reference (`status`, `stock_issue`): expected price + `catalogue_available`
  (same rule as today with the catalogue stock);
- ERP reference (`status_vs_erp`, `stock_issue_vs_erp`): ERP price + `erp_available` (ERP stock), unchanged meaning.
The stock threshold applies to both. A catalogue stock edit never makes a product available that is inactive,
`erp_active = false` or missing from the ERP file. Summaries count `stock` per reference from the matching column.
Generated files write `catalogue_available` for `reference = marketplace` and `erp_available` for `reference = erp`.
Recon read responses show `catalogueStock`, `catalogueStockSource` (`erp | owner`) and `stockConflict` next to `erpStock`
(joined at read time, not stored).

This supersedes the per-marketplace availability override idea: one catalogue stock drives every enabled marketplace.

## 4. Migration SQL (proposed, `202611060001_erp_changes_catalogue_stock`)

Additive only: two new tables, two new nullable `recon_rows` columns (backfilled from the existing ones, which is exact
because no edits exist yet), one partial GIN index. No existing column, constraint or index is changed or dropped.

```sql
-- (a) What each applied ERP upload changed: one row per product x field.
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
CREATE INDEX "erp_upload_changes_tenant_upload_kind_idx"
  ON "erp_upload_changes" ("tenant_id", "upload_id", "kind", "row_number", "id");
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_change_kind_valid"
  CHECK ("kind" IN ('new', 'price', 'cost', 'stock', 'name', 'active', 'missing', 'returned', 'other'));
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_change_field_valid"
  CHECK ("field" IS NULL OR "field" IN ('sku', 'nameEn', 'nameAr', 'brand', 'erpCategory', 'erpPrice', 'costPrice', 'erpStock', 'erpActive', 'inLatestErpFile'));
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_change_shape_valid"
  CHECK ((("kind" = 'new') = ("field" IS NULL)) AND ("row_number" IS NOT NULL OR "kind" = 'missing')
         AND (NOT "stock_conflict" OR "kind" = 'stock'));
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_changes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_changes_tenant_id_upload_id_fkey"
  FOREIGN KEY ("tenant_id", "upload_id") REFERENCES "uploads"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "erp_upload_changes" ADD CONSTRAINT "erp_upload_changes_tenant_id_product_id_fkey"
  FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- (b)+(c) Owner-edited catalogue stock; no row = the catalogue stock is the ERP stock.
CREATE TABLE "catalogue_stock_edits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "stock" INTEGER NOT NULL,
    "erp_stock_at_edit" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "conflict_upload_id" UUID,
    "conflict_at" TIMESTAMPTZ,
    "reason" TEXT,
    "set_by_id" UUID NOT NULL,
    "set_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "catalogue_stock_edits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "catalogue_stock_edits_tenant_id_product_id_key"
  ON "catalogue_stock_edits" ("tenant_id", "product_id");
CREATE INDEX "catalogue_stock_edits_conflicts_idx"
  ON "catalogue_stock_edits" ("tenant_id", "conflict_at" DESC, "product_id") WHERE "state" = 'conflict';
ALTER TABLE "catalogue_stock_edits" ADD CONSTRAINT "catalogue_stock_edit_valid"
  CHECK ("stock" >= 0 AND "erp_stock_at_edit" >= 0 AND "state" IN ('active', 'conflict')
         AND (("state" = 'conflict') = ("conflict_upload_id" IS NOT NULL AND "conflict_at" IS NOT NULL))
         AND ("reason" IS NULL OR char_length("reason") <= 500));
ALTER TABLE "catalogue_stock_edits" ADD CONSTRAINT "catalogue_stock_edits_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "catalogue_stock_edits" ADD CONSTRAINT "catalogue_stock_edits_tenant_id_product_id_fkey"
  FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "catalogue_stock_edits" ADD CONSTRAINT "catalogue_stock_edits_tenant_id_set_by_id_fkey"
  FOREIGN KEY ("tenant_id", "set_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- conflict_upload_id has no foreign key (like uploads.template_id): upload retention must not delete a conflict.

-- Recon: stock per reference. Existing columns keep their meaning for the catalogue/expected reference
-- (stock_issue) and the ERP availability (erp_available).
ALTER TABLE "recon_rows" ADD COLUMN "catalogue_available" BOOLEAN;
ALTER TABLE "recon_rows" ADD COLUMN "stock_issue_vs_erp" TEXT;
UPDATE "recon_rows" SET "catalogue_available" = "erp_available", "stock_issue_vs_erp" = "stock_issue";
ALTER TABLE "recon_rows" ADD CONSTRAINT "recon_stock_issue_vs_erp_valid"
  CHECK ("stock_issue_vs_erp" IS NULL OR "stock_issue_vs_erp" IN ('available_but_out_of_stock', 'unavailable_but_in_stock'));

-- Product history: membership of a product in a bulk stock edit (same pattern as audit_events_bulk_changes_gin_idx).
CREATE INDEX "audit_events_stock_bulk_changes_gin_idx"
  ON "audit_events" USING GIN (("details" -> 'changes') jsonb_path_ops)
  WHERE "action" IN ('catalogue.stock_bulk_set', 'catalogue.stock_conflicts_resolved');

-- Row-level security policies (defined, not enabled in Phase 1), as for every other tenant table.
CREATE POLICY tenant_isolation ON "erp_upload_changes"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON "catalogue_stock_edits"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

## 5. Recommended behaviour and decisions

| Question | Recommendation |
| --- | --- |
| Existing-product ERP changes | Applied automatically (as today) and listed per upload from `erp_upload_changes`. Agrees with the owner. |
| Owner value vs new ERP value | Flagged with both values; "use ERP" / "keep mine", single and bulk. Agrees with the owner. |
| **D1** Which stock applies while a conflict is open | ERP value (the owner's rule "a manual edit lasts until the next ERP upload changes that product"); "keep mine" restores the owner's value. Risk: an owner's 0 (damaged / not on shelf) followed by a higher ERP stock makes the product available again until resolved. Alternative: the owner's value stays in effect until resolved. Same schema either way. |
| **D2** What "changes that product" means | Only an ERP **stock** change. A price or name change does not touch the stock edit. |
| Comparison | Both references kept; catalogue stock beside ERP stock in recon reads. |
| **D3** Threshold | `stock_threshold` applies to both the catalogue stock and the ERP stock. |
| **D4** Missing / inactive products | A stock edit never makes a product available that is not active, ERP-inactive or missing from the ERP file. |
| **D5** Permissions | New permission `catalogue.stock_edit` for Owner, Admin, Catalogue Manager (no role change); reading changes/conflicts uses `uploads.view` / `products.view` (Analyst can read). Cost rows hidden without `pricing.edit`, as in product history. |
| **D6** Price | No price conflict model: the catalogue price is already the rule layer. The change list marks ERP price changes on products with a `fixed` product rule ("your fixed price still applies"), computed at read time. |
| Per-marketplace availability overrides | Superseded by the single catalogue stock; nothing to remove (never built). |
| Review summary | Fix the 2-vs-3-decimal price comparison; add predicted `stockConflicts` and name/cost counts to `uploads.summary` (JSON, no schema). |
