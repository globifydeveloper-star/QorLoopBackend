# G1: marketplace update files (OUT-001/002)

The backend previews and generates a marketplace's latest applied `.xlsx` or `.csv` upload. It reads the original
from private storage with the upload parser's non-streaming ExcelJS/CSV reader, selecting the first visible non-empty
sheet and the first header row with at least two filled cells among the first ten rows. It does not use OutputTemplate.
There is no migration. Existing GeneratedFile columns hold the result; BullMQ holds job status.

## API

All responses have the existing `{ data: ... }` envelope. Tenant resolution, authentication, permissions, Origin and CSRF
use the existing guard. POST bodies reject extra fields and accept:

```json
{"marketplaceId":"talabat","kind":"price","scope":"mismatches","reference":"marketplace"}
```

`marketplaceId` is talabat/snoonu/rafeeq/keeta. `kind` is stock/price/stock_price. `scope` defaults to mismatches;
the other value is all. `reference` is erp/marketplace, defaulting to the store's compareReferenceDefault.

| Route | Permission | Result inside data |
| --- | --- | --- |
| POST /api/generated-files/preview | files.preview | productCount, priceChanges, availabilityChanges, notInFile, largestPriceChange, firstRows, sourceFile, warnings, referenceUsed |
| POST /api/generated-files | files.generate | HTTP 202, `{jobId}` |
| GET /api/generated-files/jobs/:jobId | files.view | `{state, fileId?, message?}` |
| GET /api/generated-files | files.view | Array of history records, newest first |
| GET /api/generated-files/:id/download | files.download | `{url, fileName, expiresAt}` |

Preview counts are numbers. `largestPriceChange` is null or `{name, from, to}` (numeric prices).
`firstRows` is up to ten objects keyed by source column headers, containing the plain values to be written.
`sourceFile` is `{name, uploadedAt}`. `warnings` is an array of plain messages. `referenceUsed` is the resolved reference.
Preview creates no generated object, row, job or audit event; normal authentication still touches the session.

Job states are queued/running/done/failed. BullMQ's delayed retry is queued. Failures return a generic message,
never failedReason or stacktrace. Jobs are tenant-scoped, and missing/other-tenant jobs return 404. Queue retention
uses the existing job defaults (completed jobs up to 24 hours; failed jobs seven days); file history lasts 30 days.

History exposes only id, marketplaceId, kind, scope, reference, fileName, productCount, generatedAt, generatedBy
(display name string), expiresAt. Download checks tenant, expiry and object existence. Signed URLs last up to
300 seconds, bounded by file expiry. Storage keys are never returned as API fields. An S3 signed URL necessarily
contains its object path; it is a temporary authenticated capability rather than a raw storage-key download API.

Analyst currently has files.view and files.download, but not files.preview or files.generate. G1 does not change roles.ts.

## Selection and output

The selected rows come from stored recon rows, with the same listing winner as reconciliation (updated_at DESC,
then marketplace_product_id). Mismatches use stock_issue and/or the selected reference's price mismatch flag.
All includes listed rows except missing_from_erp. A missing_from_erp stock issue remains selectable in mismatches,
matching the stock report. Unlisted products are excluded; new-products generation is G2.

The output contains the original preamble/header and only the selected rows found in the source file, in source
order. It retains every source column, including columns outside Qorloop's mapping. Confirm with the marketplace/client
that partial updates are accepted before uploading a mismatches file; Qorloop does not upload marketplace files itself.
The saved mapping identifies columns. Barcode fallback uses the existing barcode normalisation; marketplace IDs use
the upload parser's trimmed string identity. Missing source rows increment notInFile and are skipped. Ambiguous duplicate
source IDs block generation. No IDs or column roles are guessed from header text.

Only the fields requested by kind are written, using stored recon expected prices and erp_available. Changes count
actual differences from the source values. Numbers and booleans keep their types. Text prices keep existing decimal
places, increasing precision only if needed to avoid losing the recon value. Boolean text keeps its spelling family and
case. Quantity-like availability blocks every kind, including price-only generation. Missing/unsupported cell types
block rather than invent a representation. Legacy `.xls` originals require a fresh `.xlsx` or `.csv` upload.

Raw header values are retained in the output; duplicate/blank header names use the upload parser's aliases in preview
objects. Files contain plain values only: formulas use cached results, hyperlinks use display text, and rich text is
flattened. Formula-like strings are neutralised with the error-report safeCell helper, including CSV and header cells.
This intentional safety transformation is the exception to unchanged-cell preservation. CSV retains the detected
delimiter and uses UTF-8, CRLF and standard quoting. XLSX contains only the selected data sheet, without source styles,
external links, macros, drawings or additional sheets.

## Jobs, consistency and failures

The dedicated generated-files queue hashes no secrets. Its deterministic job ID includes tenant, marketplace, kind,
scope, resolved reference and UTC minute. Repeated requests in that minute share the original actor and job.
A SHA-256-derived UUID gives retries the same file row. Each uncommitted attempt owns a unique storageKeys.generated
object key, so a stalled or timed-out attempt cannot overwrite or remove a later winner's object. Inputs are read in a short
REPEATABLE READ snapshot; parsing/serialisation hold no database lock. After serialisation a short tenant-locked
transaction rechecks the file ID, uploads the object, inserts the row and writes one file.generated event with counts.
Failed insert/audit operations remove that attempt's object. A retry after commit returns the existing ID without uploading.

The worker repeats validation against its current snapshot, so intervening uploads/recon changes can change the result
from an earlier preview. This avoids keeping stale preview contents in Redis. A failure logs/audits safe phase/type/codes
and a fixed or known blocking message, then throws a safe error to BullMQ for retry. No raw exception, row or secret is logged.
expiresAt enforces 30-day access/history retention. Physical object deletion remains the storage retention policy's job.

## Validation

Fixtures use headers and cell types inspected from the actual Talabat and Snoonu exports in D:/Qorloop-test.
Core tests compare every non-target cell, selection/reference combinations, CSV quoting, safety and blocked cases.
API tests run the actual upload/apply/recon/generation pipeline with in-memory storage/queues and isolated PostgreSQL.
The same harness supports embedded PGlite. The real PostgreSQL scale check uses 25,000 source rows and 14,000 updates.

Run sequentially, after checking free RAM >= 2 GB and free commit >= 9 GB:

```powershell
npm run typecheck
npm run lint
npm test -- packages/
npm test -- apps/api/src/__tests__/generated-files.integration.test.ts
node scripts/test-real-postgres.mjs apps/api/src/__tests__/generated-files.integration.test.ts apps/api/src/__tests__/generated-files.performance.test.ts
```

The runner reads connection configuration internally, connects to the administrative postgres database, creates a random
qorloop_test database, runs tests there, and drops it in finally (also on normal interruption). It never runs tests on qorloop.
No fixture or test migration targets the development database. Stop at the first process memory crash.
The uncommitted Owner smoke script is in `.cache/scratchpad/g1-owner-smoke.ps1`; parse-check it, but run it manually only.
