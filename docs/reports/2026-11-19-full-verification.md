# Full verification: measured accuracy of Qorloop

Date: 19 November 2026. Branch `test/full-verification` (from `main` at `7b7aab9`). Synthetic data only.

This report is built step by step; each step is one commit.

## Step 1: Baseline

Environment: Windows 11, Node **24.22.2** (portable, checksum-verified; the machine's own Node 22.23.1 is below the
`engines` range `>=24.18.0 <25` and cannot run the suite, see below), embedded PGlite database, in-memory queues and storage.
`TEST_DATABASE_URL` and `TEST_REDIS_URL` unset, as in CI.

| Command | Result | Time |
|---|---|---|
| `npm run typecheck` | pass, 0 errors | 18.5 s |
| `npm run lint` | pass, 0 problems | 6.0 s |
| `npm test` (run 1) | 53 of 59 suites passed, 6 skipped; **860 passed, 21 skipped, 0 failed** of 881 | 241.9 s |
| `npm test` (run 2) | identical: 860 passed, 21 skipped, 0 failed | about 4 min |

**Flaky tests:** none seen. Both full runs gave the same result for every test. Two runs cannot prove that nothing is flaky.

**Under Node 22.23.1** every suite fails before running a test: `process.exit called with "1"` from
`@nestjs/common/utils/load-package.util.js` while `@nestjs/swagger` loads `@fastify/static` inside Jest's VM modules. The same
import works in plain Node 22, so this is a Jest/Node 22 interaction, not a product fault. Node 24 is required, as `engines`
and CI say. (Not a bug; recorded because a developer on Node 22 sees every test fail.)

### Skipped tests (21) and why

All are skipped by design when an external service is not configured; none is skipped by `.skip` on an unconditional test.

| Suite | Skipped | Needs |
|---|---|---|
| `tenant-lock.integration.test.ts` ("real PostgreSQL" block) | 10 | `TEST_DATABASE_URL` (row-lock semantics; PGlite is a single backend) |
| `products.performance.test.ts` | 3 | `TEST_DATABASE_URL` |
| `recon.performance.test.ts` | 2 | `TEST_DATABASE_URL` |
| `generated-files.performance.test.ts` | 1 | `TEST_DATABASE_URL` |
| `generated-files-after-apply.performance.test.ts` | 1 | `TEST_DATABASE_URL` |
| `price-adoption.performance.test.ts` | 1 | `TEST_DATABASE_URL` |
| `queue-storage.test.ts` (BullMQ) | 3 | `TEST_REDIS_URL` |

`uploads.integration.test.ts` also runs a smaller case without a real database: 5,000 ERP rows instead of 50,000.

## Step 2: Independent reference calculator

`apps/api/src/__tests__/verification/reference.ts` is plain TypeScript and has **no import statement at all**. A test
(`reference.test.ts`, "imports no product code") enforces this. It works in integer fils (BigInt for products). It was
written from the documents below, not from `packages/core`, `packages/db`, `packages/shared` or `apps/*`:

- `QorloopFrontend/docs/05-business-rules.md` (BR): the business rules that ADR 008 names as the source of truth.
- `QorloopFrontend/docs/04-data-model.md` (DM) and `08-open-questions.md` (OQ).
- Backend ADRs 008, 009, 011, 013 and 017, `docs/products-api.md` (blocked products), `docs/settings-activity-api.md`,
  `docs/pricing-offers-bulk-api.md` and `docs/open-gaps.md`.

`reference.test.ts` checks the calculator against examples worked out by hand from those documents (for example
5.5 × 1.15 = 6.325, a GTIN-14 equal to its EAN-13, and each step of the rule order). That test caught one error in my own
first draft: the percent formula was scaled ×10. It was fixed before any comparison with the product was run.

### Rules used

"ASSUMPTION" marks a point the documents leave open. Where the product differs from an assumption, this report calls it a
documentation gap, not a bug.

| # | Rule | Source |
|---|---|---|
| R01 | Barcode: trim, strip a trailing `.0`, strip non-digits, strip leading zeros (GTIN-14 = EAN-13) | BR 5.5, ADR 008 |
| R02 | An empty normalised barcode is a row error | BR 5.6, G11 |
| R03 | Match on barcode 1..3; with no match, fall back to SKU. **ASSUMPTION:** the marketplace product ID is compared with the ERP SKU | BR 5.5 |
| R04 | Two products matching one marketplace row is an error | BR 5.5 |
| R05 | ERP required: barcode, name (EN), selling price, stock. A missing value or a non-numeric price or stock is a row error, and the row is skipped | BR 5.6 |
| R06 | Rejected when **more than** 20% of rows are invalid (exactly 20% is accepted) | BR 5.6, ADR 008, G6 |
| R07 | **ASSUMPTION:** a duplicate ERP barcode keeps the first row; later rows are row errors (as ADR 011 states for marketplace files) | ADR 011 |
| R08 | **ASSUMPTION:** negative stock is valid numeric stock, at or below the threshold, so never available. The documents only require "numeric" | BR 5.6 |
| R09 | Money is integer fils. More than 3 decimals rounds half-up to fils | DM `numeric(12,3)`, ADR 013 |
| R10 | Order: offer > product > subcategory > category > per-marketplace (only when enabled) > default | BR 5.1 |
| R11 | An offer applies when `valid_from <= now` (or null) and `now <= valid_until` (or null) | offers contract (OfferState) |
| R12 | percent ERP×(1+v/100), amount ERP+v, fixed v, same ERP. Rounding applies to percent/amount only | BR 5.1 |
| R13 | Rounding steps exact/0.05/0.25/0.50, applied once to the exact value, halves up; exact = whole fils. (A first draft rounded to fils, then to the step; ADR 013 says once, so it was corrected in step 5. No golden value changed.) | BR 5.1, ADR 013, OQ Q13 |
| R14 | Reference `marketplace` uses the resolved Marketplace price; `erp` uses the ERP price | BR 5.2 |
| R15 | Should be available ⇔ status active ∧ ERP-active ∧ in latest full ERP file ∧ stock > threshold | BR 5.3, ADR 017 D3/D4 |
| R16 | Marketplace availability accepts True/False, Yes/No, 1/0, or a quantity (> 0 = available) | BR 5.3 |
| R17 | ERP available + marketplace unavailable = `unavailable_but_in_stock`; the reverse = `available_but_out_of_stock` | BR 5.3 |
| R18 | Status order: no file → `no_data`; status new → `new`; no listing → `not_listed` (active, in ERP file, ERP-active), otherwise `in_sync`; not in ERP file but listed → `missing_from_erp` (+ `available_but_out_of_stock` if available); otherwise a price mismatch (\|actual−expected\| > tolerance, in fils) or a stock issue → `mismatch`, else `in_sync` | BR 5.4 |
| R19 | Blocked products are ignored: no recon row, never in a file, not counted | products-api "What skips a blocked product" |
| R20 | Stale when the latest upload is **older than** `stale_hours` (default 12) | BR 5.4, settings API |
| R21 | File rows: listed rows except `missing_from_erp`; with scope mismatches, filtered by kind (`missing_from_erp` stock issues stay selectable) | BR 5.8, ADR 011 |
| R22 | File values: price = the reference's expected price; availability = should-be-available. Every other cell is unchanged, and unselected rows are not written | ADR 011 |
| R23 | Text prices keep their decimals (more only when needed); numbers stay numbers; boolean text keeps its spelling and case | ADR 011 |
| R24 | Formula-like cells (starting with `= + - @`) get a leading apostrophe | ADR 011 |
| R25 | First ERP import: all products active. Later ERP files create status `new` | BR 5.6 |
| R26 | The Arabic name comes from the ERP only when Qorloop's is empty | BR 5.6, DM |
| R27 | A duplicate marketplace identifier keeps the first row; the others are row errors | ADR 011 |
| R28 | A tenant sees only its own rows | ADR 007, ADR 008 |

## Step 3: Golden datasets

Definitions: `apps/api/src/__tests__/verification/datasets.ts`. Rows are written as real `.xlsx` files with ExcelJS. A
"date cell" is a number stored with a `dd/mm/yyyy` format, the way Excel keeps a barcode typed into a date column.
Expected outputs: `expected.ts` simulates the documented pipeline (ERP import(s), Qorloop edits, marketplace uploads,
recon, files) with the reference calculator only. The answers are stored in `verification/expected/*.json`, and
`datasets.test.ts` fails if a fresh computation differs (`UPDATE_GOLDEN=1` rewrites them). Offer windows and upload
ages are relative to the run time, so the stored answers do not depend on the date.

| Dataset | What it covers |
|---|---|
| `barcodes` | leading zeros (ERP and GTIN-14), numeric cell, trailing `.0`, spaces, missing and empty barcode, duplicate and duplicate-after-normalisation, SKU fallback, barcode 3 match, unmatched marketplace row, duplicate marketplace id, barcodes in date-formatted cells (small number and 13-digit) |
| `stock` | threshold 5: stock −3, 0, 5 (= threshold), 4, 6, 100; ERP-inactive (`No`, `false`); stock as text; non-numeric stock and price; missing price, name and stock; Snoonu `Yes`/`no`/`1`/`0`/`12`/unreadable availability |
| `prices` | tolerance 0.050: exactly at ±tolerance, 1 fils inside, 1 fils outside; 99,999.999 and 12,345.678; 4-decimal ERP price (half-fils); float noise `0.1+0.2`; numeric cells; zero price |
| `rules` | each rule source: active, expired, future and open-ended offers; product fixed/same/amount; subcategory over category; per-marketplace (Talabat only, 0.25 rounding) over default; half-fils percent; large percent |
| `names` | Arabic, empty Arabic, 460-character name, `Café "Crème" & <Co> ½` and RTL mark, names starting `=` `@` `+` `-`; a second ERP file (Arabic name kept, empty one filled, a new product) |
| `presence` | ERP only, marketplace only, both, blocked (listed and not), inactive (listed available/unavailable, not listed), ERP-inactive, dropped from the second full ERP file (listed available/unavailable), new in the second file |
| `stale` | Talabat file 13 h old, Snoonu file 11 h old, `stale_hours` 12 |
| `formats` | Talabat `active` booleans with numeric/text prices; Snoonu `Availability for <branch>(Update)` and `Price For Branch <branch>(Update)`, `TRUE`/`false`/`Yes`, 3-decimal and numeric prices |
| `presence-twin` | second tenant: same barcodes, different names (marker `ZZ-OTHER-TENANT`), prices and stock |
| `invalid-21-percent` | 100 rows, 21 invalid: must be rejected |
| `invalid-20-percent` | 100 rows, exactly 20 invalid: accepted, 20 errors listed |
| `large-50000` | generated: 50,000 products. The stored answer is the counts only (3,847 not listed, 6,593 price, 4,196 stock, 35,964 in sync) |

`datasets.test.ts` also asserts that each case in the brief is present in the expected outputs (for example, all five
price sources and every recon status in `presence`).

## Step 4: Accuracy harness

`verification/accuracy.integration.test.ts` and `pipeline.ts` run each dataset through the real product:
`POST /api/uploads` → stored bytes → `complete` → `mapping` → review → `apply` (the real worker functions behind the
inline queues) → block and status edits through the API → pricing rows → marketplace uploads → `recomputeRecon` →
`GET /api/recon/summary` → for each marketplace, kind (`price`, `stock`, `stock_price`) and scope (`mismatches`, `all`):
`POST /api/generated-files/preview` and `POST /api/generated-files`, then the stored `.xlsx` is parsed with ExcelJS.
Each tenant is new; the database is the embedded PGlite one. Rules, offers, categories and upload ages are written with
Prisma. An offer that already ended cannot be created through the API, so the setup writes the rows the product reads.

**How each number is computed** (`verification/metrics.ts`). Every comparison is one *case*.
- **found**: the reference expects a problem and the product flags it.
- **missed**: expected, not flagged.
- **false alarm**: flagged, not expected.
- **wrong value**: the compared value differs (price, status, cell row, and so on), whether or not the flag agreed.
- **exact**: flag and value both agree.
- **precision** = found / (found + false alarms); **recall** = found / (found + missed). "n/a" means there is no
  problem/flag notion, or the denominator is 0.
- Generated files: a *file-rows* case is one identifier, expected in the file or not. A *file-values* case is all cells
  of that identifier's rows, compared exactly, so any changed non-price/availability cell counts as a wrong value.
- *Round trip*: the generated `stock_price`/`mismatches` cells are put back into the source file, which is uploaded as a
  fresh full snapshot and reconciled again. A case is one product the file fixed, and it must have no price or stock
  problem left.

**Attribution.** Each disagreement is re-judged once per finding below. The reference is rerun with that single
observed behaviour switched on (`REF_CONFIG`, clearly labelled attribution-only). A disagreement that disappears is
attributed to that finding. The 23 per-feature tests fail on any disagreement that no finding explains. All headline
numbers use the documented rules.

### Golden datasets (9 datasets and 2 rejection files, PGlite)

| Feature | Cases | Exact | Not exact | Found | Missed | False alarms | Wrong values | Exact-match | Precision | Recall |
|---|---|---|---|---|---|---|---|---|---|---|
| erp-row-validation | 184 | 182 | 2 | 9 | 0 | 2 | 2 | 98.91% | 81.82% | 100.00% |
| barcode-normalisation | 154 | 151 | 3 | 4 | 0 | 1 | 3 | 98.05% | 80.00% | 100.00% |
| catalogue-fields | 151 | 139 | 12 | 0 | 0 | 1 | 12 | 92.05% | 0.00% (1 false alarm, no expected problems) | n/a |
| names (EN, AR) | 150 | 147 | 3 | 0 | 0 | 0 | 3 | 98.00% | n/a | n/a |
| marketplace-row-validation | 119 | 119 | 0 | 2 | 0 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| matching (barcode 1-3, GTIN-14, SKU fallback) | 117 | 116 | 1 | 5 | 0 | 1 | 1 | 99.15% | 83.33% | 100.00% |
| recon-row-present | 247 | 242 | 5 | 242 | 4 | 1 | 5 | 97.98% | 99.59% | 98.37% |
| recon-status | 242 | 240 | 2 | 173 | 2 | 0 | 2 | 99.17% | 100.00% | 98.86% |
| expected-price (value and source) | 242 | 225 | 17 | 0 | 0 | 0 | 17 | 92.98% | n/a | n/a |
| availability (should be available) | 233 | 233 | 0 | 0 | 0 | 0 | 0 | 100.00% | n/a | n/a |
| stock-issue | 233 | 233 | 0 | 20 | 0 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| price-mismatch | 100 | 95 | 5 | 41 | 2 | 0 | 5 | 95.00% | 100.00% | 95.35% |
| blocked-ignored (no row, not in files) | 28 | 28 | 0 | 0 | 0 | 0 | 0 | 100.00% | n/a | n/a |
| stale | 16 | 16 | 0 | 1 | 0 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| summary-counts (stock, price, total, not listed, missing, new) | 16 | 13 | 3 | 0 | 0 | 0 | 3 | 81.25% | n/a | n/a |
| file-blocking (file / blocked / nothing to update) | 96 | 96 | 0 | 25 | 0 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| file-header | 71 | 71 | 0 | 0 | 0 | 0 | 0 | 100.00% | n/a | n/a |
| file-row-order | 71 | 66 | 5 | 0 | 0 | 0 | 5 | 92.96% | n/a | n/a |
| file-rows (right rows, unchanged rows excluded) | 401 | 394 | 7 | 394 | 7 | 0 | 7 | 98.25% | 100.00% | 98.25% |
| file-values (every cell) | 394 | 348 | 46 | 0 | 0 | 0 | 46 | 88.32% | n/a | n/a |
| round-trip | 56 | 56 | 0 | 0 | 0 | 0 | 0 | 100.00% | n/a | n/a |
| upload-rejection (>20%, exactly 20%, message, no partial data) | 4 | 4 | 0 | 1 | 0 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| tenant-isolation (twin tenant) | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 100.00% | n/a | n/a |
| **All** | **3,327** | **3,216** | **111** | | | | | **96.66%** | | |

Not exact, by cause: BUG-1 84, GAP-1 14, BUG-2 12, GAP-2 1. **Unexplained: 0.** Without the two documentation gaps
(GAP-1/GAP-2, where the documents are silent) the product is exact on 3,231 of 3,327 cases (97.11%).
The 96 disagreements from the two bugs are concentrated in `prices`, `rules` and `barcodes`. The other six datasets
(`stock`, `names`, `presence`, `stale`, `formats`, `presence-twin`) have no disagreement except GAP-2 (one stored stock).

### Generated large store (5,000 products, PGlite)

91,775 of 91,775 cases exact (100%), including 15,945 file rows, 660 price mismatches, 420 stock issues and 1,020
round-trip products. Its prices have at most 2 decimals, so BUG-1 cannot show here. 50,000 products: see Step 6.

### Findings from step 4

Each finding has a failing test in `accuracy.integration.test.ts` ("Findings"). These are written with `it.failing`: they
pass while the bug is present, so CI stays green, and they will report a failure once the bug is fixed (then change
them to `it`).

- **BUG-1 (medium): every price is kept to 2 decimals, while the documents specify whole fils.**
  - **Cause:** `round2()` runs on every ERP and marketplace price in `packages/core/src/upload/validate.ts:108,134`, and
    `roundFils(…,'exact')` means "nearest 0.01 QAR" (`packages/core/src/money.ts:13`).
  - **What the documents say:** money is `numeric(12,3)` because "some marketplaces use 3" (DM). Rounding `none` "keeps
    whole fils" (ADR 013). The tolerance allows 3 decimals, and recon compares "in integer fils" (ADR 009).
  - **Effects seen:**
    - Talabat 10.051 is stored as 10.05, so with a 0.050 tolerance a mismatch 1 fils outside it is reported **in sync**
      (2 missed mismatches: 10.051 and 9.949).
    - ERP 99,999.999 is stored as 100,000.000, and a `same`-rule price file writes `100000.000`.
    - 5.500 × 1.05 is stored and written as 5.78, not 5.775. ERP 3.333 becomes 3.33.
    - Two values that differ by less than 0.005 compare equal even at tolerance 0.
  - **Not fixed:** this is not a small, obviously correct change. It changes stored values, the review and recon
    signatures, the core money tests, and every generated file with 3-decimal prices. Whether QAR is used to 2 or 3
    decimals is a business decision; note that QAR's legal minor unit is the dirham (0.01).
  - **Tests:** "BUG-1: …" (4 tests).
- **BUG-2 (medium, already listed as open gap G11): barcodes in date-formatted cells.**
  - **Effects seen:**
    - The number 45000 in a date cell becomes product `20230315000000000` (the date's digits). It is not listed on
      Talabat and the ERP row is not reported as an error.
    - A real 13-digit barcode in a date cell is rejected as "Barcode is empty".
  - **Not fixed:** the right rule (read the cell's number, or reject date-formatted barcode cells) needs a decision
    (G11).
  - **Tests:** "BUG-2: …" (2 tests).
- **GAP-1 (documentation gap): an ERP price of 0 is a row error** ("Price must be a number above 0"). BR 5.6 only
  rejects non-numeric prices. The product's rule is reasonable, but it is not documented.
- **GAP-2 (documentation gap): a negative ERP stock is stored as 0** and counted (`negativeStockClamped`). It does
  not change availability. Not documented.
- **GAP-3 (documentation gap, no effect on values): the price source vocabulary.** The product reports `subcategory`
  as a sixth source; BR 5.1 lists five (`offer | product | category | marketplace | default`). The comparison treats
  `subcategory` as `category`.
- **GAP-4 (documentation gap): an empty selection gives a 409**, "There is nothing to update for this selection.",
  rather than an empty file. ADR 011 does not say what happens. This happened in 19 of 96 file requests (no
  mismatches of that kind). The other 6 non-file outcomes are the documented quantity-availability block (Snoonu
  quantities in `stock`).
- **Agrees with the documents** (no disagreement at all):
  - GTIN-14/EAN-13 and leading-zero matching, SKU fallback, barcode 3 matching, unmatched rows
  - duplicate ERP barcodes (first row wins, the others are errors) and duplicate marketplace ids
  - stock at, above and below the threshold; ERP-inactive and inactive products; missing from the full ERP file; `new`
    in a second ERP file
  - Arabic names (ERP fills only an empty one); blocked products (never a row, never in a file); stale at 13 h / 11 h
  - Talabat booleans and the Snoonu branch columns; text decimals and `True`/`TRUE`/`Yes` spellings kept
  - formula-like names and categories neutralised with `'`; quantity availability blocking generation
  - the 20% rejection (21 of 100 rejected with "21 of 100 rows are invalid", nothing written; exactly 20 accepted)
  - the round trip

## Step 5: Behaviour checks beyond accuracy

The suite is `verification/behaviour.integration.test.ts`: 24 tests, all passing; BUG-3 is an `it.failing` test.
Raw results are written to `.cache/verification/behaviour.json`.

**Limitation:** the embedded PGlite database is one backend. "Concurrent" requests here interleave at await points, but
their transactions run one after another. Truly parallel transactions are covered only by the 10 real-PostgreSQL tests
in `tenant-lock.integration.test.ts` (skipped in Step 1).

### Idempotency

| Check | Result |
|---|---|
| `POST /api/uploads/:id/apply` again on an applied upload | 200, and products, listings, recon rows, change rows and audit count are byte-for-byte unchanged |
| The identical ERP file uploaded and applied again | applied; 0 change rows; products and recon unchanged. 7 audit events are added, all upload lifecycle events (`upload.created` … `upload.applied`); no product event |
| `recomputeRecon` twice | the 22 rows are identical, including `last_updated` |

### Concurrency (interleaved)

| Check | Result |
|---|---|
| Talabat and Snoonu uploads at once | both applied; recon has rows for both |
| Two different ERP files applied at once | both 200; every product carries the values of one file (22.22 / 9), never a mix |
| Recompute during an upload apply | converged: one more recompute changes nothing |
| Burst of 6 price-rule changes | 6 triggers, 2 recompute runs (coalesced). This is the inline queue model; the real BullMQ dedup test needs `TEST_REDIS_URL` |

### Permissions (94 endpoints × owner, admin, catalogue_manager, analyst, unauthenticated)

Every endpoint in the OpenAPI document was called with each role, with random ids and `{}` bodies. The guard runs
before validation, so 403 and 400 are distinguishable. The roles a route allowed (status not 401/403):

| Allowed | Endpoints |
|---|---|
| everyone, also unauthenticated | `GET /health`, `GET /health/ready` |
| unauthenticated (public auth) | `POST /api/auth/invitations/accept`, `login`, `password/forgot`, `password/reset` |
| Owner, Admin, Catalogue Manager, Analyst | 31 `GET` endpoints (lists, reads, downloads, `errors.xlsx`) |
| Owner, Admin, Catalogue Manager | 47 endpoints: every upload, product, category, pricing, offer, stock, export-value, recompute and file-generation mutation, and `GET /api/categories/erp-suggestions` |
| Owner, Admin | 8 endpoints: team invitations (list, create, resend, revoke), role change, member removal, `PUT /api/settings`, `PUT /api/templates/:source` |

Compared with the documents (G1: Analyst read-only; Catalogue Manager no team or settings edits; Admin all but the
security policy):

- **No endpoint is more permissive than the documents say, at endpoint level.** No Analyst mutation, no Catalogue Manager
  team or settings edit, and no unauthenticated business call succeeded.
- Admin changing `security.mfaRequiredForAll` gets 403 (Owner only), as documented.
- **BUG-3 (low/medium): `analystCanExport` has no effect.** It gates only the `reports.export` permission
  (`packages/core/src/roles.ts:85`), and no endpoint checks that permission. With the switch off, the Analyst still
  downloads generated files (200) and error reports. `01-product-overview.md` says the Analyst may "export only if the
  Owner allows it". ADR 011 states the Analyst has `files.download`, so which permission the switch should gate
  (`files.download`, `errors.xlsx`, both) is a decision. **Not fixed.** Test: "BUG-3: …" (`it.failing`).

### Tenant isolation

- **Reads:** all 35 `GET /api/*` endpoints were called as tenant A's Owner. The needles were tenant B's id, its product,
  upload, generated-file, listing and user ids, an invitation, a category, and the marker `ZZ-OTHER-TENANT`. **No
  response contained any of them.** Every read by a B id (`/uploads/{id}`, `/review`, `/errors`, `/errors.xlsx`,
  `/changes`, `/products/{id}`, `/history`, `/stock`, `/generated-files/{id}/download`, `/jobs/{jobId}`,
  `/marketplace-values/…/{productId}`) returned **404**.
- **Writes:** 12 by-id writes on B's rows, with valid bodies (product PATCH, price rule, offer, stock, export value,
  upload apply and discard, invitation revoke, role change, member removal, category PATCH and DELETE), all returned
  **404**, and B's products, listings, recon, change rows, audit count and category were unchanged.
- **Cookies and origins:** a B session cookie on A's host gets 401. A's session with B's Origin gets 403.

### Security

| Check | Result |
|---|---|
| CSRF: no token / wrong token / right token | 403 / 403 / 200 |
| Origin: foreign / missing / other tenant's origin on a POST; foreign origin on a GET | 403 / 403 / 403 / 403 |
| Rate limit (default app settings): `POST /api/auth/login` | 20 × 401, then the 21st is 429 `RATE_LIMITED` |
| Owner before MFA | `GET /api/products`, `/recon/summary`, `/settings`, `/uploads` all 403; wrong TOTP 401; after TOTP 200; the pending session is 401 after MFA |
| Session idle 31 min / past `expires_at` | 401 / 401 |
| Upload size | 25 MB + 1 byte 400; exactly 25 MB 200; 0 bytes 400 |
| File type | `.exe`, `.pdf`, `.xlsm`, no extension: 400; `.xlsx`, `.xls`, `.csv`: 200 |
| Rows | 50,001 data rows rejected: "The file has more than 50,000 rows" |
| Malicious names | `../../../etc/passwd.xlsx`, `..\..\windows\win.ini.xlsx`, a 300-character name and a NUL byte: 400. `<img src=x onerror=alert(1)>.xlsx`, `%2e%2e%2fsecret.xlsx`, `CON.xlsx` and an RTL-override name: accepted, but the storage key is always `tenants/{tenant}/uploads/{uuid}/original.{ext}`. The name is stored as given: the frontend must escape it, and an RTL override can make a name display misleadingly (observation, not a bug) |
| Formula injection | generated file cells `=1+2`, `+cmd\|calc` and `-2+3` written as `'=1+2`, `'+cmd\|calc`, `'-2+3`; the error report writes `'=HYPERLINK(…)`; no formula cells |

### Data integrity

- **Money storage:** all 12 money columns are `numeric(12,3)` (exact decimal, as DM specifies), and the schema has no
  `real` or `double precision` column. Money is **not stored as integer fils**; it is stored as an exact 3-decimal
  numeric. That is what the documents ask for, so it is not a bug. The values written are 2-decimal because of BUG-1.
- **Floating point:** a differential test of 200,000 seeded random cases (2-decimal ERP prices, percent −50…150 and
  amount −5…15 with 3 decimals, all four rounding steps) ran `priceFromRule` against the BigInt reference at the
  product's 0.01 step. **0 disagreements, so no floating-point noise.** The engine uses JS numbers with `Math.round` to
  fils, so this is evidence, not proof.
- **Audit:** 11 kinds of change through the API (product edit, price rule, offer set and delete, catalogue stock, export
  value, settings, pricing settings, invitation, generated file, upload apply). Each wrote at least one audit event in
  the same tenant, with the expected action: `product.field_changed`, `product.price_rule_set`, `product.offer_set`,
  `product.offer_deleted`, `product.stock_set`, `product.marketplace_values_set`, `settings.changed`,
  `pricing.settings_changed`, `invitation.created`, `file.generated`, `upload.applied`.

### Error handling (bad files)

Every file below ended `rejected` with a plain message. None created a product or a staged row, and no message contains
a stack, `Error:` or internal names.

| File | Message |
|---|---|
| truncated `.xlsx` | The workbook is corrupt |
| random bytes `.xlsx` | This does not look like a real .xlsx workbook |
| header row only | The file has a header row but no data rows |
| PDF named `.xlsx` | This does not look like a real .xlsx workbook |
| PNG named `.csv` | This is not a text CSV file |
| password-protected (OLE `EncryptedPackage`) | Password-protected files are not accepted |
| macro workbook named `.xlsx` | Files with macros are not accepted |
| garbage `.xls` | This does not look like a real .xls workbook |
| CSV with one space | No header row was found in the first 10 rows |
