# Copy from marketplace: Step 0

Branch `feature/copy-from-marketplace`, from `main` at `696b21b`. Inspection only; nothing built yet.

**No schema change is needed.** The new action writes ordinary export values (`marketplace_value_overrides`, ADR 019) and records the source in the existing audit event's JSON details.

## How it works today

| Topic | Today |
| --- | --- |
| Bulk preview / apply | `MarketplaceValuesService.planBulk` (`apps/api/src/marketplace-values/marketplace-values.service.ts`) resolves the selection: explicit ids (up to 500), or A's Review filter through `selectionIds`, in list order. More than 5,000 is a 400. It then reads `targets` (live: listed on A, product gates, stored export value) and calls the pure `planMarketplaceValues` (`packages/core/src/marketplace-values.ts`). `previewToken = sha256(marketplaceValuesPlanSignature(plan))`. Apply runs under the tenant lock: it checks the idempotency key (24 h, matched against the request hash), plans again, compares the token (a different plan is a 409), writes set-based with `write`, and records one `marketplace.values_bulk_applied` event. A pin change queues one recompute after commit. |
| B's current values | Two sources. (1) `listings`: live, one row per marketplace product id, with `product_id`, `price`, `available` and `upload_id`. Partial files keep older rows, so a listing can come from an older file. (2) `recon_rows.actual_price/actual_available`: a stored copy of (1), as of the last recompute. It picks the newest `updated_at`, then `marketplace_product_id` (`ReconRepository.listings`). **Proposal: read (1) live, with the same pick as the comparison.** Then preview and apply agree with the data, and the token covers it. |
| Matching | By catalogue `product_id`: B's listing `product_id` equals A's product. Unmatched listings (`product_id` null) are ignored. |
| Latest file of B | `GeneratedFilesRepository.latestApplied(B)`. If B has none, the request is refused. |

## Proposed rules

| Case | Behaviour |
| --- | --- |
| `sourceMarketplaceId` = `marketplaceId` | 400 |
| B is not enabled, or has no applied file | 400, with a plain message |
| A is not enabled | 400 (same as `set`) |
| Product of another store | `blocked`, reason `not_found` (as today) |
| Product blocked on A: not listed on A, inactive, ERP-inactive, missing from the ERP | `blocked`, with the existing `SET_BLOCK_REASONS`, exactly as bulk `set`. Like `set` today, this also applies to availability "No". |
| Product not on B (no matched listing) | `notOnSource`. Nothing is written. |
| B's price outside the allowed range (≤ 0 or > 100,000) | For price, counts as `notOnSource` with reason `source_price_invalid`. Availability can still be copied. |
| Field already equals what A's next file writes | Unchanged. "What A's next file writes" is A's pending value if there is one, otherwise A's catalogue value. So no export values are created that just repeat the catalogue. Prices are compared exactly, in fils. |
| A has a pending fix-once value that differs | Replaced by B's value (a normal set, version + 1). |
| A has a **pin** on the field | **Kept by default** (counted as `pinnedKept`), because a pin is a deliberate choice by the manager. `replacePins: true` overwrites it with B's value, and the field stays pinned. |
| New values | Fix once by default. `persistent: true` pins them. |
| Reason | Defaults to `Copied from <B label>` when no reason is given. This is stored per field, so Review shows it. |
| Several listings of the product on B | The same pick as the comparison (newest). The preview shows the listing's file. |

The catalogue is never written. The copied values are ordinary export values, so Review states, pins in the comparison, acknowledgement by A's next upload and the generated files all work unchanged.

## Proposed API

```ts
type Action = ... | {
  type: 'copy_from_marketplace',
  sourceMarketplaceId: MarketplaceId,             // != marketplaceId
  fields: ('availability' | 'price')[],           // 1..2, each once
  persistent?: boolean,                           // default false (fix once)
  replacePins?: boolean,                          // default false: pinned fields of A are kept
};
// same body, selection, 5,000 limit, previewToken and idempotencyKey as the other bulk actions

POST /api/marketplace-values/bulk/preview
data = { ...as today,
         source: { marketplaceId, latestFile: { uploadId, fileName, uploadedAt, appliedAt } },
         // selected = willChange + unchanged + blocked + notOnSource + pinnedKept
         notOnSource, notOnSourceByReason: { reason: 'not_on_source'|'source_price_invalid', label, count }[],
         pinnedKept,
         rows: { productId, nameEn, barcode,
                 source: { available, price, uploadId, fileName, isLatestFile },
                 changes: { field, op: 'set', before, after }[] }[] }      // first 10

POST /api/marketplace-values/bulk/apply
data = { ...as today, notOnSource, notOnSourceByReason, pinnedKept, sourceMarketplaceId }
```

For `set` and `use_catalogue`, the response is the same as today, plus `notOnSource: 0` and `pinnedKept: 0` (fields are only added, nothing changes).

**Audit:** the same `marketplace.values_bulk_applied` event. `details.action` holds the whole action, including `sourceMarketplaceId`. A top-level `details.sourceMarketplaceId` is added for filtering. The compact `changes` rows are unchanged, so product history keeps working.

**Token:** the plan signature also covers the new counts and B's latest file id. A new B file between preview and apply gives a 409.

## Code plan (Step 1)

- core: `planCopyFromMarketplace(targets, notFound, source map, fields, options)` returns a `MarketplaceValuePlan`, extended with `notOnSource` and `pinnedKept`. Plus the signature.
- db: `sourceListings(sourceMarketplaceId, productIds)` (live, comparison pick, with the file). `targets` also returns A's stored catalogue values from `recon_rows`, for the "unchanged" rule.
- api: the contract variant, the checks in `planBulk`, the counts, the preview rows and the audit field.
- Tests: pure tests, and PGlite tests for every case listed in the task. The harness teardown drain is kept.
- `docs/marketplace-values-api.md` and the ADR 019 note.
- `scripts/dev/copy-from-marketplace-check.ps1`: read-only, calls the preview only.

## Decisions for the owner

1. **Source values:** B's live current listing, which may come from an older partial file (proposed). Or only listings from B's latest applied file, where any other listing counts as `notOnSource`.
2. **Unchanged:** skip a field when A's next file already writes B's value (proposed). Or always write an export value.
3. **Pins on A:** kept unless `replacePins: true` (proposed).
4. **Availability "No" on an inactive, ERP-inactive or missing-from-ERP product:** blocked, as bulk `set` does today (proposed). Or allowed, as decision D allows for a pending "No".
