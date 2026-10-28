# Upload pipeline and catalogue schema

Date: 2026-10-28

## Context

ADR 007 delivered authentication, teams and tenant-scoped persistence. This milestone adds the ERP and
marketplace upload engine (Task 6, steps 1-11) and the tenant-ready catalogue schema it writes to. It builds on
ADR 007's security invariants unchanged: tenant from the exact host, composite `(tenant_id, id)` foreign keys,
permission checks inside the tenant transaction, audit events in the same transaction.

Business rules come from `docs/05-business-rules.md` in the frontend repository. Where the earlier backend
helpers disagreed with those rules they were corrected:

- **Barcodes**: strip trailing `.0`, non-digits and leading zeros (rule 5.5). The old helper padded to 14 digits,
  which would not match a Talabat GTIN-14 against a 13-digit EAN. Fixed; tests cover it.
- **Money**: pricing and rounding run in integer fils (rule 5.1 warns that floats give 6.3249999).

## Pipeline

```
Client ──POST /api/uploads──────────▶ API   creates Upload(uploading), returns a signed PUT URL
Client ──PUT file───────────────────▶ private object storage (size and type are part of the signature)
Client ──POST /api/uploads/:id/complete▶ API   HEAD-checks size, uploading→processing, enqueues (idempotent)
Worker   scan → check → read → detect → validate → review      (status/step/progress saved at each stage)
         • layout unknown → needs_mapping (headers + suggested mapping returned)
         • review ready   → needs_review  (rows staged in upload_rows, errors in upload_errors)
Client ──POST /api/uploads/:id/mapping▶ confirms/saves a mapping, re-queues (new revision)
Client ──GET  /api/uploads/:id/review ▶ the proposed change by tab, paginated
```

Decisions:

- **Direct upload, never through the API.** The signed URL binds `Content-Length` and `Content-Type`; the API
  re-checks the object size on `complete`, and the worker re-checks it again before parsing.
- **Never trust the extension or MIME type.** The worker identifies the real format from magic bytes, rejects
  macros, password-protected files (OOXML in an OLE container), and zip bombs (entry count, total expansion,
  compression ratio) before any parser sees the file.
- **Heavy work outside transactions.** `Database.run` locks the tenant row (ADR 007). Download, parsing and
  diffing happen outside it; each state change is a short transaction. 50,000 rows run end to end in about 14 s
  against local PostgreSQL (target: under 3 minutes).
- **Idempotent and recoverable queueing.** The BullMQ job ID is `process-{tenant}-{upload}-{revision}`, so the
  same revision enqueued twice runs once. The API enqueues *after* commit; if that fails, or the API dies
  between commit and enqueue, a worker sweep re-queues uploads stuck in `processing` for more than 10 minutes.
  Stale jobs (revision no longer current, status not `processing`) return `skipped`.
- **Rejections are outcomes, not errors.** Unsafe, unreadable, wrong-source or more-than-20%-invalid files end in
  `rejected` with a human message and are not retried. Unexpected errors are retried 3 times with exponential
  backoff, then the upload becomes `failed` with a generic message (details stay in logs).
- **Nothing is written to the catalogue by processing.** Review rows are staged; applying is a separate,
  explicit step (not part of this milestone).
- **Storage keys** are built server-side as `tenants/{tenant_id}/uploads/{upload_id}/original.{ext}`; client input
  never reaches a key. Buckets are private and encrypted (`AES256`).

## Schema additions (migrations 0003-0005)

Marketplaces (global), tenant marketplaces, categories, category mappings, products, listings, the five pricing
tables, input mappings (`tenant_id` null = built-in), uploads, upload rows, upload errors, recon rows/summaries,
output templates, generated files, notifications.

- Every customer-owned table carries `tenant_id`; references between tenant-owned rows use composite
  `(tenant_id, id)` foreign keys, so the database itself refuses cross-tenant references (tested).
- Tenant-aware uniques: `(tenant_id, normalized_barcode)`, `(tenant_id, marketplace_id, marketplace_product_id)`, ...
- `CHECK` constraints on statuses, sizes, money and barcode shape.
- `tenant_isolation` RLS policies are **defined but not enabled** (Phase 1 is one tenant per database). Enable with
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and set `app.tenant_id` per transaction when moving to a shared
  deployment.
- `pg_trgm` index on `products.name_en` lives in its own `_extensions` migration because the embedded test
  database has no contrib extensions.

## Not in this milestone

Applying a reviewed upload to the catalogue, reconciliation, price rules UI/API, report endpoints, marketplace
file generation, onboarding, settings endpoints, categories/products CRUD, activity-log queries. Production
infrastructure provisioning (see `docs/open-gaps.md`). Tables for these exist so migrations stay additive.

## Consequences

- `xlsx` (SheetJS 0.18.5, the last npm release) is used **only** for legacy `.xls`. It has known advisories for
  crafted files; mitigated by the pre-parse safety checks, the 25 MB limit and isolation in the worker, but the
  .xls path should be reviewed before accepting files from untrusted retailers, or `.xls` support dropped.
