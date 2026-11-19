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
| R13 | Rounding steps exact/0.05/0.25/0.50, applied once, halves up. **ASSUMPTION:** a percent result is first rounded half-up to whole fils | BR 5.1, ADR 013, OQ Q13 |
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
