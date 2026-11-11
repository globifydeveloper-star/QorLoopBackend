# Review screen and marketplace export values: API

Branch `feature/marketplace-export-values`, Steps 2 and 3 ([ADR 019](decisions/019-marketplace-export-values.md)). Migration `202611100001_marketplace_value_overrides`, owner-approved on 11 November 2026; you run it on the demo database.

The catalogue is the source of truth. On a marketplace's **Review** screen, the manager sees the products that differ from the catalogue. They can set that marketplace's availability and price for one product, or go back to the catalogue value, and then download the updated file.

Every success is `{ data: ... }`. Errors are `{ error: { code, message, details? }, requestId }`. Dates are ISO strings. Money is QAR, with at most 3 decimals. `marketplaceId` is `talabat | snoonu | rafeeq | keeta`.

Mutations need a trusted Origin and the CSRF header. The store comes from the host and session, never from the body.

| Permission | Who |
| --- | --- |
| `recon.view` (reads) | every role, including the Analyst |
| `marketplace.values_edit` (writes and previews) | Owner, Admin, Catalogue Manager |

## Coverage of the owner's four items

| # | Item | Status |
| --- | --- | --- |
| 1 | One list endpoint for the Review screen | **Covered:** `GET /api/marketplace-values/review` (below). It is a new endpoint, not `GET /api/recon/rows`, because the Review default ("only rows that need a change") would change what the existing reports get by default. |
| 2 | "Use catalogue values" for all rows of the current filter, plus single set and remove | **Covered:** bulk `use_catalogue` (and `set`) on `selection.filter`, the same filter as the list; preview token and idempotency key required; at most 5,000. Single changes use `PUT` and `DELETE`. |
| 3 | Start generation for both enabled marketplaces; files use the export values | **Covered (Step 3):** `POST /api/generated-files/batch` (below). Every file writes the export value in effect, else the reference value (decision C as implemented). |
| 4 | Summary counts per marketplace: to fix, waiting for export, pinned, blocked | **Covered:** `counts` in the Review response, and `marketplaces[].export` in `GET /api/recon/summary` (the Dashboard card). |

## Row states

`exportState` is the most urgent state of the row's two fields, in the owner's order (also the list order):

| State | Label | Meaning |
| --- | --- | --- |
| `to_fix` | "Differs from the catalogue; the next file writes the catalogue value" | No export value, and the marketplace differs from the catalogue (the stored comparison: a stock issue, or a price difference above the tolerance). |
| `waiting_for_export` | "Adjusted, waiting for export" (or "Pinned, waiting for export") | A pending value the marketplace does not show yet. |
| `blocked` | "Adjusted, cannot be exported: <reason>" | A pending export value that cannot be written. `blockedReason` is one of `not_listed`, `marketplace_disabled`, `inactive`, `erp_inactive`, `missing_from_erp`. "No" (unavailable) is only blocked when the product is not listed or the marketplace is off. A blocked field keeps its reason in `fields.<field>.blockedReason` even when the row is in a more urgent state. |
| `pinned` | "Pinned" | A pinned value the marketplace shows (price within the tolerance). |
| `in_sync` | null | Listed; nothing to change. |
| `not_exportable` | the reason | Nothing pending, and the file cannot write this product. `notExportableReason` is one of `no_data`, `not_listed`, `new_product`. |

"Needs a change" means `blocked`, `waiting_for_export` or `to_fix`.

## GET /api/marketplace-values/review

```ts
// Query (unknown keys: 400)
marketplaceId: MarketplaceId                     // required
show?: 'needs_change' | 'all'                    // default needs_change
exportState?: ExportState                        // exactly this state; takes precedence over show
field?: 'availability' | 'price'                 // judge show/exportState on this field only
q?: string                                       // name contains, SKU equals, barcode starts with (as the product list)
categoryId?: uuid; subcategoryId?: uuid
limit?: 1..200 (default 50); cursor?: string (from nextCursor)

data = {
  marketplaceId, marketplaceEnabled: boolean,
  counts: { toFix: number, waitingForExport: number, pinned: number, blocked: number },  // whole marketplace, unfiltered
  latestFile: { uploadId, fileName, uploadedAt, appliedAt } | null,                     // the file generated files are built from
  items: ReviewItem[], nextCursor: string | null
}

type ReviewItem = {
  productId, barcode, sku: string | null, nameEn, nameAr: string | null, productStatus,
  reconStatus: string,                                              // comparison status against the catalogue
  marketplaceCurrent: { available: boolean | null, price: number | null },   // null: not listed
  catalogue: { available: boolean | null, price: number | null /* rule price */, priceSource: string | null,
               stock: number, stockSource: 'erp' | 'owner', stockConflict: boolean },
  export: { available: boolean | null, price: number | null,       // what the next file writes (null: not writable)
            availabilitySource: 'catalogue' | 'override', priceSource: 'catalogue' | 'override' },
  values: { availability: FieldValue<boolean> | null, price: FieldValue<number> | null },  // the stored export values
  fields: { availability: { state: ExportState, blockedReason: string | null }, price: { ... } },
  exportState: ExportState, exportStateLabel: string | null,
  blockedReason: string | null, blockedReasonLabel: string | null, notExportableReason: string | null,
  rulePrice: number | null, differsFromRulePrice: boolean,         // exact, in fils; a note, never blocks a save
  needsChange: boolean,
  version: { id: uuid, version: number } | null,                   // send back as expected / expectedId+expectedVersion
  marketplaceSource: { uploadId, fileName, uploadedAt /* upload created */, appliedAt, isLatestFile: boolean } | null,
  lastUpdated: string                                              // when the stored comparison of this row last changed
}
type FieldValue<V> = { value: V, persistent: boolean /* pinned */, state: 'pending' | 'cleared', fieldState: ExportState,
                       setBy: { id, name }, setAt, reason: string | null, clearedAt: string | null }
```

Catalogue and marketplace values come from the stored comparison. States, export values and counts are live, so an edit shows at once. The cursor is keyset on (state rank, product id).

`GET /api/marketplace-values/:marketplaceId/products/:productId` returns one `ReviewItem`. It returns `null` while a newly enabled marketplace has not been compared yet, and 404 for a product that is not this store's.

## Single changes

```ts
PUT /api/marketplace-values/:marketplaceId/products/:productId
body = {
  values: { availability?: { value: boolean, persistent?: boolean },  // at least one field
            price?: { value: number /* >0, <=100000, 3 decimals */, persistent?: boolean } },
  reason?: string /* <=500 */,
  expected: { id, version } | null                                  // the row as read; null = it had none
}
// persistent false (default) = fix once: a later matching upload of this marketplace clears it (Step 3).
// persistent true = pinned: cleared only by the manager.
// Same value + pin + reason = no change. A pin change alone is a change and counts as a new set.

DELETE /api/marketplace-values/:marketplaceId/products/:productId
       ?fields=availability|price|all (default all)&expectedId=<uuid>&expectedVersion=<n>
// "Use catalogue value": the pending field(s) are cleared; the file writes the CURRENT catalogue value.
// expectedId/expectedVersion are required when the product has an export value.

data = { changed: boolean, operationId: string | null /* audit event */, item: ReviewItem | null }
```

| Status | When |
| --- | --- |
| 400 | invalid body; the marketplace is not enabled (set only); a set on an ineligible product, with the plain reason |
| 403 | role |
| 404 | not this store's product |
| 409 | `expected` is stale |

Audit events: `product.marketplace_values_set` and `product.marketplace_values_cleared`, with entity = product. Details hold the marketplace, the version read and per field `{ field, op, before, after }`.

## Bulk

```ts
type Selection = { productIds: uuid[] /* 1..500 */ }
               | { filter: { show?, exportState?, field?, q?, categoryId?, subcategoryId? } };  // same as the Review query
type Action = { type: 'set', values: <same as PUT values> }
            | { type: 'use_catalogue', fields: ('availability' | 'price')[] };              // "Use catalogue values"
body = { marketplaceId, selection: Selection, action: Action, reason?: string }

POST /api/marketplace-values/bulk/preview          // reads only
data = { marketplaceId, selection, action, reason, limit: 5000,
         selected, willChange, unchanged, blocked,  // selected = willChange + unchanged + blocked
         blockedByReason: { reason: 'not_listed'|'inactive'|'erp_inactive'|'missing_from_erp'|'not_found', label, count }[],
         rows: { productId, nameEn, barcode, changes: { field, op: 'set'|'clear', before, after }[] }[],  // first 10
         previewToken: string /* 64 hex */ }

POST /api/marketplace-values/bulk/apply
body = <preview body> & { previewToken: string /* REQUIRED */, idempotencyKey: string /* 8..100 [A-Za-z0-9_-] */ }
data = { operationId, replayed: boolean, appliedAt, marketplaceId,
         selected, willChange, unchanged, blocked, blockedByReason, created, updated, clearedFields }
```

| Rule | Behaviour |
| --- | --- |
| Selection | A filter selects every matching row of the Review list, in list order, up to 5,000. A larger selection is a 400, never truncated. Ids of another store count as `not_found`. |
| Who may receive a value | `set` blocks products that are not listed, not active, ERP-inactive or missing from the ERP. `use_catalogue` is allowed for every owned product. |
| Apply | Re-plans under the store lock. A plan that differs from the previewed one is a 409 with no writes. |
| Idempotency | The same key and body within 24 h replays the first result; the same key with another body is a 409. |
| Audit | One `marketplace.values_bulk_applied` event, with compact `changes` rows (product id first; GIN-indexed for product history). |

## GET /api/recon/summary (added field)

`marketplaces[].export = { toFix, waitingForExport, pinned, blocked }`: the Review counts for that marketplace. They are always against the catalogue and live, whatever `reference` is.

## Generated files (Step 3)

```ts
POST /api/generated-files/preview   // body unchanged; exportToken in the body is ignored here
data = { ...as before,
         valueBasis: 'export_values',     // an export value in effect wins in every file; otherwise the reference value
         exportToken: string,             // send with the generate request
         exportValueProducts: number,     // written products whose price or availability is an export value
         blockedExportProducts: number,   // products whose export value cannot be written (the reference value is written)
         fromOlderFile: number }          // selected products whose listing came from an older marketplace file

POST /api/generated-files           // 202; body as before + exportToken?: string (64 hex)
// 409 "The catalogue or export values changed since this file was requested. Preview and generate it again."
// when the token no longer matches. The worker checks again before it stores the file, under the tenant lock.

POST /api/generated-files/batch     // 202, files.generate
body = { marketplaceIds?: MarketplaceId[] /* default: every enabled marketplace */,
         kind?: 'stock'|'price'|'stock_price' /* default stock_price */, scope?: 'mismatches'|'all' /* default mismatches */,
         reference?: 'marketplace'|'erp', exportTokens?: { [marketplaceId]: string } }
data = { jobs: { marketplaceId, jobId }[], blocked: { marketplaceId, message }[] }
// poll each job with GET /api/generated-files/jobs/:jobId, then GET /api/generated-files/:id/download
```

In a `mismatches` file:

- a field with a pending value is written even when the difference is within the tolerance;
- a pinned value the marketplace already shows is not rewritten;
- a blocked value falls back to the reference value.

## Pins and acknowledgement (Step 3)

| Topic | Behaviour |
| --- | --- |
| Pins in the comparison | A pinned value in effect is the comparison target of its field for both references. Setting, changing or removing a pin queues a recompute (`'marketplace.values'`). After it, the dashboard's `stock` and `price` counts no longer count a pinned value the marketplace shows. |
| Acknowledgement | When a marketplace file applies, every pending fix-once field it confirms is cleared, with one `marketplace.values_upload_cleared` event (`upload.applied` counts `exportValuesCleared`). It needs a file created after the value was set, a matching accepted row, and every listing of the product showing the value exactly. Pins never clear this way. |

## Not built

- The `ambiguous_listings` block reason.
- A list of stored export values.
- Export fields on `GET /api/recon/rows`.
- Any "disable marketplace" work (not needed now).
