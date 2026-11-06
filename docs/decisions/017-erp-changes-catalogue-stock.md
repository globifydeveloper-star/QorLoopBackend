# ADR 017: ERP change review and an editable catalogue stock

Date: 6 November 2026. Status: built; migration `202611060001_erp_changes_catalogue_stock` approved by the owner, **not yet run on the demo database** (the owner runs it). Step 0 inspection: [2026-11-06-catalogue-stock-step-0-inspection.md](../reports/2026-11-06-catalogue-stock-step-0-inspection.md). API shapes: [catalogue-stock-api.md](../catalogue-stock-api.md).

## Context

The owner's workflow:

1. The ERP Excel file is uploaded into the catalogue, and marketplace files are compared with the catalogue.
2. The next day a new ERP file arrives (new products, changed prices or stock).

Qorloop must show what the new file changed, let the owner edit the catalogue stock, and compare and export with that value.

Before this ADR:

- The apply overwrote ERP-owned fields and wrote one `product.field_changed` audit event per field. There was no per-upload list, new products were only counted, and `uploadId` had no index.
- Stock existed only as `products.erp_stock`.
- The review summary compared prices at 2 decimals; the apply compares at 3.

## Decision

### Per-upload change list

`erp_upload_changes` holds one row per product × field, plus one row per new product and one per product missing from a full list.

- **Source.** The apply writes it in its own transaction, from the same plan that writes the products. It is apply-time truth, not the review's prediction.
- **Kinds.** `new | price | cost | stock | name | active | missing | returned | other`.
- **Retention.** Rows are deleted with their upload (cascade). The existing audit events are unchanged, and product history still reads them.
- **Old uploads.** Uploads applied before this migration have no rows; the API reports `changesRecorded: false`.
- **Applied summary.** `uploads.summary.applied` stores what the apply recorded: `changes`, `stockConflicts` and `stockEditsCleared`.

ERP changes to existing products are still applied automatically (owner's recommendation) and are listed for review afterwards.

### Catalogue stock

`catalogue_stock_edits` holds at most one row per product. No row means the catalogue stock **is** the ERP stock, so every product starts equal to the ERP and nothing is backfilled.

A row holds:

- the owner's value and the ERP stock it was set against (`erp_stock_at_edit`);
- `state`: `active` or `conflict`;
- who, when and why;
- `updated_at`.

Timestamps are `timestamptz(3)`, so they keep millisecond precision for optimistic concurrency.

- **D1 (owner).** While a conflict is open, the **owner's value stays in effect** until it is resolved. One named constant controls this: `STOCK_IN_EFFECT_DURING_CONFLICT = 'owner'` in `packages/core/src/catalogue-stock.ts`. Every reader (recon, generated files, API) goes through `catalogueStock()`.
- **D2.** Only an ERP **stock** change raises a conflict. For each product with an edit whose ERP stock this upload changes:
  - **new ERP stock = the owner's value:** the edit is removed (`product.stock_reset`, reason `erp_matches`);
  - **new ERP stock = the edit's base, while a conflict is open:** the conflict closes (`product.stock_conflict_resolved`, choice `erp_reverted`);
  - **otherwise:** `state = conflict` (`product.stock_conflict`), and the change row gets `stock_conflict = true`.
- **Review prediction.** The review predicts these conflicts (`summary.stockConflicts`, and `stockConflict` on the staged row).
- **Resolution.** "Use ERP" deletes the edit. "Keep mine" re-bases it on the current ERP stock. Both are available for one product or in bulk.
- **Setting the ERP's own value** clears the edit, so a value the owner didn't change can never raise a later conflict.

### Recon and generated files

- **References.** The catalogue (expected) reference uses the expected price and the **catalogue stock** (`recon_rows.catalogue_available`, `stock_issue`). The ERP reference uses the ERP price and the **ERP stock** (`erp_available`, `stock_issue_vs_erp`).
- **Statuses, counts, urgency and the stock filter** each use their own reference's stock issue.
- **D3.** The stock threshold applies to both stocks.
- **D4.** A stock edit never makes a product available if it is not active, is ERP-inactive or is missing from the ERP file.
- **Generated files** write the catalogue availability for `reference = marketplace` and the ERP availability for `reference = erp`. They still write availability only, never a quantity.

This supersedes the earlier idea of per-marketplace availability overrides, which was never built. One catalogue stock drives every enabled marketplace.

### Permissions, audit, concurrency

- **D5.** New permission `catalogue.stock_edit` for Owner, Admin and Catalogue Manager; no role change.
  - Reading changes needs `uploads.view` and reading conflicts needs `products.view`, so the Analyst can read both.
  - Cost change rows are shown only with `pricing.edit`, as in product history.
- **Audit events:**
  - single product: `product.stock_set`, `product.stock_reset`, `product.stock_conflict`, `product.stock_conflict_resolved`;
  - bulk: `catalogue.stock_bulk_set` and `catalogue.stock_conflicts_resolved`. Each is one event with compact `changes` arrays, product id first. The partial GIN index `audit_events_stock_bulk_changes_gin_idx` lets product history find them.
  - All events are in activity group `stock_uploads`.
- **Single edits** use compare-and-set by value under the tenant row lock. `expected` holds the ERP and catalogue stock (or, for a resolve, the ERP and owner stock) as last shown; 409 if either moved.
- **Bulk operations** work like ADR 013:
  - preview, then apply re-planned from current data;
  - a preview token (sha256 of the planned writes): 409 when stale;
  - an idempotency key remembered 24 h (`replayed: true`; another body with the same key is 409);
  - at most 5,000 products, 500 explicit ids;
  - one transaction and one event.
- **Recompute.** Each successful write asks for one coalesced recon recompute (`catalogue.stock`) after commit.
- **D6.** There is no price-conflict model. ERP price rows say `fixedPriceRule: true` when the product's own fixed price still applies.
- **Review summary.** It now compares prices at 3 decimals and counts `nameChanges`, `costChanges` (cost column mapped) and the predicted `stockConflicts`. The marketplace review also compares at 3 decimals.

## Running the migration

The owner takes the backup and runs the migration. The `UPDATE recon_rows` statement rewrites **every** recon row, so:

1. Stop the API and the worker.
2. Take the backup (for example `scripts/dev/db-backup.ps1`).
3. `npm run db:migrate` (that is, `prisma migrate deploy`).
4. `ANALYZE recon_rows;` in `psql` against the same database, so the planner sees the rewritten table.
5. Start the API and the worker.
6. Run `scripts/dev/catalogue-stock-check.ps1` (read-only).

The migration is additive. Until it runs, the new code fails on the missing tables and columns, so deploy the code and the migration together.

## Row-level security

The new tables get the same `tenant_isolation` policy, with the same `app.tenant_id` setting, as every other tenant table in `202610280003_catalogue_uploads`.

Like every existing policy, it is **defined but not enabled**: no migration runs `ENABLE`/`FORCE ROW LEVEL SECURITY`, and Phase 1 never sets `app.tenant_id` (ADR 008). So these policies are inert today, exactly like the others; they exist so that enabling RLS later covers these tables too. Tenant isolation is enforced by the tenant-scoped repositories, and the integration tests prove it.

## Consequences

- One more write per changed field during an ERP apply (`erp_upload_changes`). It uses the same unnest bulk inserts as the audit events, inside the apply's 60 s budget.
- Recon writes two more columns. A recompute right after the migration writes nothing, because the backfill is exact.
- Open gaps G27–G31.
