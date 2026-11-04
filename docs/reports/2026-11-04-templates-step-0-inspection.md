# Templates / file mapping: Step 0 inspection

Date: 4 November 2026. Read-only inspection of the committed code before any Templates work. No schema change is needed (see the end).

## How mappings are stored

| What | Where | Notes |
| --- | --- | --- |
| Per upload | `uploads.mapping` (JSON, field -> header), `uploads.headers` (JSON array), `uploads.sheet_name`, `uploads.template_id` + `uploads.template_version` | A copy, written when the worker reaches review (`apps/worker/src/process-upload.ts`) or when the user confirms a mapping. `template_id` has no foreign key. |
| Saved layouts | `input_templates`: `tenant_id` (null = built-in), `source`, `name`, `version`, `fields` (field -> header), `signature` (headers that identify the layout), `created_at`. Unique `(tenant_id, source, name, version)`. | Append-only: `UploadRepository.saveMapping` never updates a row; saving an existing name inserts `version + 1`. No `updated_at` / `updated_by` columns. |
| Built-in layouts | `input_templates` rows with `tenant_id IS NULL` | None are seeded (open gap G4). Detection would read them. |
| Output templates | `output_templates` (`marketplace_id`, `columns`, `configured`) | Never seeded and never read by any code. |

**Who creates a layout:** only `POST /api/uploads/:id/mapping` with `saveAs` (permission `uploads.map`: Owner, Admin, Catalogue Manager). It validates with `validateMapping` against the upload's headers, then saves `fields` with `signature = signatureFor(fields, headers)` (the mapped headers) and points the upload at the new version. Without `saveAs` the upload keeps its mapping but nothing is saved.

**How a later upload picks one up:** the worker's detect step (`process-upload.ts`) reads `allMappings()` (tenant + built-in, **every version**). If the upload has no confirmed mapping, it calls `detectTemplate`:

- A layout matches when all of its `signature` headers are present, compared by `headerKey`: lower-case, spaces collapsed and, for Snoonu only, `Availability for <branch>(Update)` / `Price For Branch <branch>(Update)` with the branch replaced by `*`.
- The candidate with the longest signature wins, then the highest version.
- `remapFields` points each field at the file's own header with the same key. A key matching zero or several headers disqualifies the candidate.
- Otherwise `looksLikeOtherSource` rejects a file that matches another source's layout. Failing that, the upload stops at `needs_mapping` with `suggestMapping`.

## Fields per source (`packages/core/src/upload/fields.ts`)

| Source | Required | Optional |
| --- | --- | --- |
| ERP | barcode, nameEn, price, stock | nameAr, cost, active, category, brand, sku |
| Talabat | marketplaceProductId, barcode1, price, available | barcode2, barcode3, name |
| Snoonu, Rafeeq, Keeta | barcode1, price, available | marketplaceProductId, barcode2, barcode3, name |

`available` accepts True/False or a stock quantity on input. Only ERP has `cost`/`category`.

## How generated files (G1) use mappings

`GeneratedFilesRepository.latestApplied(marketplace)` takes the **latest applied upload** and `planGeneratedFile` uses **that upload's own stored `mapping` and `headers` and its stored original file**. The saved layout is never read. The identifier column is `marketplaceProductId` when mapped, else `barcode1`. Price files write the price column, stock files the availability column, and update files both. Generation is blocked (409) when those three columns are unmapped, missing from the stored headers or ambiguous.

The ERP apply (`apply-upload.ts`) also reads the upload's own `mapping` (to know which ERP fields to write). Recon reads products and listings only, never mappings.

## What editing a saved layout could change

| Thing | Affected by an edit? |
| --- | --- |
| Applied uploads (`uploads.mapping`, `headers`, `template_id/version`) | No. They hold a copy and a reference to the old version row, which is never modified. |
| Uploads in `needs_review` / `applying` | No. Their mapping is already stored; apply uses staged rows. |
| An upload still `processing` before its detect step | Yes, it reads layouts at detect time (inherent; same as a concurrent `saveAs` today). |
| Generated files already made | No. They are stored objects. |
| Future generated files | Not directly. They follow the latest **applied** upload's own mapping until a new file read with the edited layout is applied. Kept as is. |
| Recon rows / summaries | No. No recompute is ever needed for a layout edit. |
| Future uploads | Yes, through detection. **Caveat:** detection reads every version, so an older version with a longer signature, or the only one matching an old-layout file, can still win over the edit. |

## Existing endpoints and permissions

- `GET /api/uploads`, `GET /api/uploads/:id` (`uploads.view`). They expose `headers`, `mappingSuggestion` and `fields` only while `needs_mapping`; uploads never return `mapping` or `templateId`.
- `POST /api/uploads/:id/mapping` (`uploads.map`) is the only writer of layouts.
- `GET/PUT /api/settings` (`settings.view` / `settings.edit`, `expectedRevision` hash, 409 on conflict, `settings.changed` audit per field).
- No endpoint lists saved layouts. Reusable pieces: `fieldsFor`, `headerKey`, `validateMapping`, `signatureFor`, `saveMapping`'s versioning, `latestApplied`, the per-tenant `Database.run` lock (`FOR NO KEY UPDATE`; serialises a tenant's writes) and the settings conflict pattern.
- Roles: `settings.edit` is exactly Owner and Admin; `settings.view` and `uploads.view` include every role.

## Can it be done without a schema change?

Yes.

- **List:** `input_templates` plus `uploads` grouped by `template_id` (usage count, last used) plus the latest referencing upload's `headers` (the last file's columns).
- **Outgoing description:** derived from `latestApplied`'s stored mapping.
- **Edit:** insert a new version of the same name (the existing mechanism), with `expectedVersion` as the concurrency token under the tenant lock. The unique key rejects a duplicate version as a further guard. Audit goes to `audit_events`.

## Plan

1. `GET /api/templates` (`settings.view`): one entry per source with its layouts (latest version of each name), usage, mapping, required/mapped fields, the last file's headers, a "not set up" reason, and a read-only outgoing description (marketplaces only).
2. `PUT /api/templates/:source` (`settings.edit`): replace the mapping of a named layout. It is validated against the last file's headers, rejects unmapped required fields and duplicates, uses `expectedVersion` (409), writes the new version and a `template.updated` audit with old/new per field, and never recomputes.
   - Detection is changed to consider only the latest version of each saved layout, so an edit cannot be overridden by its own older version.
3. Pure + PGlite tests, ADR 016, open gaps, API doc and a demo check script with one reverted edit.

Decisions to confirm (defaults built):

- **(a) Latest version only in detection:** a file matching only a superseded version of a name now asks for a mapping instead of silently using the old one.
- **(b) Who edits:** Catalogue Managers keep creating and replacing layouts through `saveAs` at mapping confirmation; the Templates edit is Owner/Admin only.
- **(c) Several layouts per source:** a source can have several layout names; all are listed.
