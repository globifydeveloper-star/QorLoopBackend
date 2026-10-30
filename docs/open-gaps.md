# Open gaps and assumptions

Things the repository documents ambiguously or not at all. Each is built on a stated default so work continues;
please confirm or correct.

| # | Gap | What was built | Needs |
|---|-----|----------------|-------|
| G1 | **No per-action permission matrix.** Roles are described in prose only (`01-product-overview.md`). | `packages/core/src/roles.ts` keeps the matrix inherited from the earlier backend: Owner all; Admin all but security policy; Catalogue Manager operates (upload, map, apply, price, generate), no team/settings edits; Analyst read-only, export gated by `analystCanExport`. | A reviewed matrix from Globify/the client. Upload endpoints use `uploads.view/upload/map/apply/discard`. |
| G2 | Several Owners allowed? | Yes; the last active Owner can never be demoted or removed (ADR 007). | Confirm. |
| G3 | Who may complete an upload? | Only the person who created it. | Confirm. |
| G4 | **Marketplace file formats** (Q10): Rafeeq, Keeta/Jahez unknown; Talabat/Snoonu column names come from the docs. | No built-in input mappings are seeded. The first file for each source goes through the mapping screen and can be saved; a saved layout is recognised next time. Output templates exist as a table with `configured = false`. | Real sample files per marketplace. |
| G5 | Which Excel sheet to read. | First visible, non-empty sheet; header = first row with 2+ filled cells within the first 10 rows. | Confirm with real ERP exports. |
| G6 | Invalid-row threshold. | More than 20% invalid rows rejects the file (blueprint J1). Invalid rows below that are skipped and listed. | - |
| G7 | Retention (Q14). | Uploads 90 days (`expires_at` set); generated files 30 days. A cleanup job is not built yet. | Confirm and schedule. |
| G8 | Provisioning. | `npm run provision:store` migrates the database, creates the tenant, Store, settings and the Owner invitation, idempotently. It does **not** create servers, DNS, TLS, buckets, Redis or backups (ADR 007 says so). | Hosting decision (Q8, Q16) before an infrastructure provisioner can be written. |
| G9 | Better Auth. | Custom auth from ADR 007 retained. Better Auth 1.7.14 installs cleanly in a fresh tree, so the ADR's ERESOLVE finding is specific to the Vitest/Vite versions in the original lockfile. | Decide whether to revisit. |
| G10 | `src/`, `drizzle.config.ts` | Old Fastify/Drizzle scaffolding is still in the repository, unused. | Delete when no longer wanted as reference. |
| G11 | **Barcodes read from date-formatted spreadsheet cells are accepted with a wrong value**, for example `20260315000000000`, and there is no barcode length check. | `normalizeBarcode` keeps any digits it finds; only an empty result is rejected. A number too large to be a date (a real 13-digit barcode in a date-formatted cell) reads as empty, so that row is rejected with "Barcode is empty". | A validation rule from `docs/05-business-rules.md`. |
