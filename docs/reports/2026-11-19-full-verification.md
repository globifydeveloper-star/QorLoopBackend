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
