# ADR 019: Per-marketplace export values and the Review screen

Date: 11 November 2026. Status: built in three steps on `feature/marketplace-export-values`. The SQL comment in migration `202611100001_marketplace_value_overrides` says "ADR 018"; that number went to the reset script, so this is ADR 019 (owner, 11 November). The migration was approved as written and is not yet run on the demo database (you run it).

Step 0 inspection: [2026-11-09](../reports/2026-11-09-marketplace-export-overrides-step-0.md) and [2026-11-10 addendum](../reports/2026-11-10-marketplace-export-values-step-0-addendum.md). API: [marketplace-values-api.md](../marketplace-values-api.md).

## Context

The catalogue is the source of truth. A manager opens a marketplace's **Review** screen from the Dashboard card and sees the products whose marketplace values differ from the catalogue. They can set that marketplace's availability and price for one product, or go back to the catalogue value, and then download the updated files.

## Decision

### Layers

| Layer | Owner | Changed by |
| --- | --- | --- |
| 1. ERP values | ERP file | ERP upload |
| 2. Catalogue stock (ADR 017) | Qorloop, one per product | stock edit |
| 3. Catalogue-derived marketplace values (availability; rule price, including offers) | computed | rules, offers, threshold |
| 4. **Export values (new)**: availability yes/no and/or an absolute price, per product and marketplace | manager | this feature only |
| 5. Marketplace current values | marketplace file | marketplace upload |

Layer 4 never writes layers 1 to 3 or 5.

**ADR 017 is amended.** One catalogue stock still drives every marketplace's catalogue availability. On top of it, an export value changes only what that marketplace's file writes.

### Owner decisions

| # | Decision |
| --- | --- |
| A | The migration, as written |
| B | Permission `marketplace.values_edit`: Owner, Admin, Catalogue Manager. The Analyst reads. |
| C | Every generated file writes the export value. Implemented as: an export value in effect wins in every file. A row without one keeps the file's reference value, catalogue or ERP, so files without export values are exactly as before and the ERP-file warning stays. **Please confirm this reading.** |
| D | "Yes" never for an inactive, ERP-inactive or missing-from-ERP product; such a value is `blocked` with a plain reason. "No" can always be written to a listed product. |
| E | Mismatch counts stay; the Review counts are added. |
| F | Fix once (the default) clears on a later matching upload. A pin never clears automatically, and is the comparison target of its field while it is in effect. |
| (11 Nov) | "Use catalogue value" **clears** the export value; the file follows the current catalogue. |
| (11 Nov) | Row order: `to_fix`, `waiting_for_export`, `blocked`, `pinned`, `in_sync`, `not_exportable`. |
| (11 Nov) | Freshness approach accepted. ADR number 019. |
| (11 Nov) | "Disable marketplace" is not needed now. No work beyond the existing switch, and the `marketplace_disabled` block reason that the switch already gives. |

### Behaviour

**Review list and counts (Step 2).** Field states are computed in SQL, with the same rules as core `reviewRow`, from:

- the stored comparison (catalogue reference),
- the product's gates,
- the live export value,
- the live marketplace switch.

So filters, counts and paging are server-side, and an edit shows at once. The catalogue and marketplace values themselves are as of the last recompute (`lastUpdated`). The Dashboard reads the counts from `GET /api/recon/summary` (`marketplaces[].export`).

**Changes (Step 2).**

| Change | Rule |
| --- | --- |
| Single | Version-checked (`expected` / `expectedId` + `expectedVersion`). |
| Bulk | Explicit ids or the Review filter, at most 5,000. The preview token is required; the idempotency key is remembered for 24 h. |
| Writes | Set-based, ms timestamps, `version + 1` per changed row. |
| Audit | `product.marketplace_values_set`, `product.marketplace_values_cleared`, `marketplace.values_bulk_applied`, `marketplace.values_upload_cleared`. The bulk and upload events carry compact `changes` rows (product id first), so product history finds them through the new partial GIN index. |

**Pins in the comparison (Step 3).**

- The recompute reads the pending pinned values (`MarketplaceValuesRepository.pins`) in its snapshot.
- `reconcile` compares a pinned field with the pin, for both references, with the price tolerance.
- A pin of a product that cannot be exported is ignored (`pinInEffect`), as Review shows it.
- Stored catalogue values (`marketplace_price`, `catalogue_available`) do not change; only the flags and statuses do.
- Setting, changing or removing a pin queues one coalesced recompute (`'marketplace.values'`). After it, the dashboard's `stock` and `price` counts no longer count a pinned value the marketplace shows.

**Acknowledgement (Step 3).** In the marketplace apply transaction, after the listings are written, `acknowledgeExportValues` clears each pending fix-once field of a product this file matched, when:

- the file was created strictly after the value was set (ms; the same millisecond does not count);
- at least one accepted row matched exactly that product;
- **every** listing of the product on that marketplace shows the value exactly (price in fils, not within the tolerance).

Partial files confirm only their own rows. Pins are never cleared here. One `marketplace.values_upload_cleared` event is written, and the upload's `upload.applied` event counts `exportValuesCleared`.

**Generated files (Step 3).**

- **Values:** `GeneratedFilesRepository.reconRows` joins the export values and computes each row's export fields with `reviewRow`. The planner writes `fileValues(row)`: the export value in effect, else the reference value.
- **Selection:** a `mismatches` file also selects a field with a pending value, even within the tolerance. It does not rewrite a pinned value the marketplace already shows. A blocked value falls back to the reference value and the reference flags.
- **Preview:** reports `valueBasis: 'export_values'`, `exportToken`, `exportValueProducts`, `blockedExportProducts` and `fromOlderFile`.

**Freshness (Step 3).** `exportToken` is a fingerprint of what the file would write: source upload, reference, kind, scope, and per product the identifier, selection, written price and availability, listed price and status. It is checked three times:

1. On the request: a generate request with an older token is a 409.
2. When the worker starts: its own snapshot must give the same token.
3. Just before storing the file: the inputs are re-read under the tenant row lock, which every writer takes, and a moved token is refused with a plain retry message.

The job id includes the token, so an edit within the same minute gives a new file instead of an earlier one.

**Both marketplaces at once (Step 3).** `POST /api/generated-files/batch` queues the files of every enabled marketplace, or of the given ones. Each marketplace is checked exactly like `POST /api/generated-files`. One that cannot be generated is listed with its reason and does not stop the others.

## Not included

- A list of stored export values (`GET /api/marketplace-values`) and export fields on `GET /api/recon/rows`: the Review endpoint covers the screen.
- The `ambiguous_listings` block reason. Acknowledgement already requires every listing to agree.
- Any "disable marketplace" work (the client does not need it now).
- Offers in marketplace sheets: see the [offers report](../reports/2026-11-11-offers-flow.md). Planning only; nothing built.

## Verification

Written:

- Pure tests: Review states, order, labels, plans, signature, acknowledgement, pins in `reconcile` and `computeReconRows`, the planner with export values, tokens and job ids.
- PGlite integration tests: Review list, state filters versus core, single and bulk changes, token, idempotency, roles, tenants, summary counts, a pin queueing a recompute and lowering the dashboard price count, acknowledgement cases, files writing export values in both references, a stale token refused, the batch request.

**Not run locally:** the memory gate (at least 1,500 MB free) was never met (650 to 1,100 MB), so neither Jest nor `tsc` ran. ESLint on every changed file and `prisma validate` passed. CI runs them once `ci/run-on-branches` is merged.

The in-lock re-read before a file is stored doubles the generation reads. It is not measured on real PostgreSQL; `*.performance.test.ts` needs `TEST_DATABASE_URL`.
