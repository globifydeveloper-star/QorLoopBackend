# ADR 016: Templates screen on saved file layouts, edited as new versions

Date: 4 November 2026. Status: built without a schema change or migration. Step 0 inspection: [2026-11-04-templates-step-0-inspection.md](../reports/2026-11-04-templates-step-0-inspection.md).

## Context

The Templates / File mapping screen showed demo data. The real data already exists:

- saved layouts in `input_templates`: append-only, versioned by `(tenant, source, name, version)`;
- each upload's own copy of its mapping (`uploads.mapping`, `headers`, `template_id`, `template_version`);
- the latest applied upload per marketplace, which is the only input generated files (G1) read for columns.

## Decision

`GET /api/templates` (`settings.view`, every role) returns one entry per source in the order ERP, Talabat, Snoonu, Rafeeq, Keeta:

- the source's fields with their required flags;
- every saved layout name at its newest version;
- a `not_set_up` status with a plain reason when there is none;
- for marketplaces, a read-only `outgoing` description.

Exact shapes are in [templates-api.md](../templates-api.md).

`PUT /api/templates/:source` (`settings.edit`: Owner and Admin) changes the header mapped to the given fields of one named layout. It writes the next version through the existing `saveMapping`; no row is ever updated in place.

- **Validation.** Unknown fields are refused, required fields stay mapped, and one column cannot serve two fields (all compared by `headerKey`).
- **Header source.** A new header must be one of the columns of the newest upload read with any version of the layout. Matching ignores case and spaces and, for Snoonu, the branch name; the file's own spelling is stored. If no such upload is on record, the header is taken by name.
- **Concurrency.** `expectedVersion` is the token: 409 when it is not the newest version. `Database.run` serialises a tenant's writers with the tenant row lock, and the unique version key maps to the same 409 as a last guard.
- **No-op edits** return 200 without writing a version or an event.
- **Audit.** `template.updated` (activity group `stock_uploads`) records source, name, from/to version and `{ field, old, new }` per changed field. Activity shows those as a cleaned before/after for known field keys only.
- **No recompute.** Reconciliation reads products and listings, never layouts, so a layout edit cannot change comparison results.

### What an edit affects

| | Effect |
| --- | --- |
| Applied uploads | None. They keep their own mapping copy and their reference to the old version row, which is never modified. |
| Uploads in review or applying | None. Their mapping is stored and apply uses staged rows. |
| Generated files already made | None. |
| Future generated files | Only after a file read with the new version is applied. Generation keeps reading the latest applied upload's own mapping and original file, and that behaviour is kept. `outgoing.basedOn.layout.current = false` shows when the applied file predates the edit. |
| Recon rows and summaries | None. No recompute is requested. |
| Future uploads | Detection uses the new version. |

### Detection reads only the newest version of each layout

Before this change, detection considered every version. The longest signature won, then the highest version. An older version could therefore beat an edit when it mapped more columns (for example, after an optional field is unmapped), or when the next file fits only the old layout.

`currentVersions` now filters the layouts before `detectTemplate` and `looksLikeOtherSource`. A file that only an older version fits now stops at `needs_mapping` instead of being read with the superseded mapping. This also applies to a re-save under the same name at mapping confirmation (`saveAs`).

### Outgoing description

For each marketplace, `outgoing` comes from the latest applied upload's stored mapping and headers, using the same identifier rule as generation: `fileColumns`, shared with `planGeneratedFile`.

- **Columns:** the match column (`marketplaceProductId` when mapped, else `barcode1`), the price column (written by price and update files) and the availability column (written by stock and update files).
- **Status:** `not_ready` when nothing is applied or those columns are unmapped, ambiguous or missing from the stored headers. Cell-level checks (such as boolean-like availability) still run at generation.
- **Not exposed:** storage keys, upload ids, template ids and tenant ids. `output_templates` remains unused.

## Not included

- No create, rename, delete or restore of a layout from the Templates screen.
- No editing of built-in layouts (`tenant_id IS NULL`): none are seeded, and they would be listed with `editable: false`.
- No per-field enable/disable for generated files.
- No new storage, columns, permissions or migrations.
- Catalogue Managers can still create a layout, or replace one by saving under the same name, at mapping confirmation (`uploads.map`), as before.

## Verification

- **Pure tests:** current-version selection, views, reasons, outgoing derivation, every edit rule, and activity presentation.
- **PGlite integration tests:** the real upload/apply/recon workers cover listing, roles, tenant isolation, validation details, 404/409, audit and activity, no recompute, unchanged applied uploads/catalogue/listings/recon/summaries and generated-file previews, detection of the new version, the superseded-version `needs_mapping` case, and Snoonu branch tolerance.
- **Harness:** teardown order is unchanged (app close, recon drain, database close).
- **Test runs:** require `Memory/Available MBytes >= 1500` before each batch and run `packages/` and `apps/` separately.
