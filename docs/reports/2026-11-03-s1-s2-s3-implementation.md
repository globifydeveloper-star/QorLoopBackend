# BACKEND implementation report: S1, S2 and S3

Date: 3 November 2026

Status: S1-S3 implemented and automated checks passed. The code is committed locally; this report, contracts and demo checker ship in the fourth documentation commit. Nothing is pushed. Authenticated real-demo verification remains pending the owner's backup and migration.

## Delivered source and contracts

- S1: `GET/PUT /api/settings`, optimistic revision checks, stored profile/threshold/security/pricing changes, per-change audit, Owner/Admin edit gate and Owner-only MFA policy; read-only Asia/Qatar and QAR.
- Marketplaces: `GET /api/settings/marketplaces`, enabled-marketplace semantics and latest applied-upload age.
- S2: `GET /api/activity` and `GET /api/products/:id/history`, filtered cursor pagination preserving microseconds, safe summaries, tenant isolation, indexed bulk membership and explicit upload coverage notice.
- S3: `GET /api/auth/session` without touching idle time, explicit session/MFA/CSRF codes, consistent safe errors and Request IDs, component readiness with Redis/storage degradation remaining HTTP 200.
- Exact request/response types and PowerShell demo commands: [API contracts](../settings-activity-api.md).
- Decisions: [ADR 014](../decisions/014-settings-activity-log.md).
- Gaps: [open-gaps](../open-gaps.md), G16-G20.
- Local demo checker: [settings-activity-check.ps1](../../scripts/dev/settings-activity-check.ps1).

### Files changed

| Area | Files |
| --- | --- |
| Settings API | `apps/api/src/settings/settings.controller.ts`, `settings.service.ts`; shared pricing writer in `apps/api/src/pricing/pricing.service.ts` |
| Settings storage/validation | `packages/db/src/settings.ts`, `packages/db/src/database.ts`, `packages/shared/src/contracts.ts`, `packages/shared/src/recon.ts` |
| Activity API | `apps/api/src/activity/activity.controller.ts`, `activity.service.ts` |
| Activity summaries/query | `packages/core/src/activity.ts`, `packages/db/src/activity.ts`; shared activity query contract |
| Approved indexes | `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/202611030001_activity_indexes/migration.sql` |
| Sessions | `apps/api/src/auth/auth.controller.ts`, `auth.service.ts` |
| Errors/readiness | `apps/api/src/app.ts`, `http/errors.ts`, `http/readiness.ts`, `http/contracts.ts`, `tokens.ts`; `packages/shared/src/storage.ts` |
| Tests | `packages/core/src/__tests__/activity.test.ts`; API `settings.integration.test.ts`, `activity.integration.test.ts`, `session-errors.integration.test.ts`; test-service readiness double in `harness.ts` |
| Docs/checks | ADR 014, `docs/open-gaps.md`, `docs/settings-activity-api.md`, the inspection/implementation/EXPLAIN Markdown reports, `scripts/dev/settings-activity-check.ps1` |

## Migration

Exact file: `packages/db/prisma/migrations/202611030001_activity_indexes/migration.sql`.

It contains only three additive `CREATE INDEX` statements:

1. `audit_events_tenant_entity_time_idx`.
2. `audit_events_tenant_time_id_idx`.
3. `audit_events_bulk_changes_gin_idx`, partial on bulk pricing events and indexing `details -> 'changes'` with `jsonb_path_ops`.

No new tables/columns, data changes, dropped indexes or retention changes are included. The assistant has not run migrations on the demo database. The owner takes a backup and runs `npm.cmd run db:migrate` from `D:\Qorloop-backend`.

The GIN index can accumulate thousands of entries/postings for an operation with 5,000 products. With no retention policy, repeated operations increase index size and write cost. Production-sized measurements and disk headroom are needed; a synthetic PGlite fixture is not a production size/timing estimate.

## Validation evidence

| Check | Current result |
| --- | --- |
| PowerShell demo script parser | Passed |
| Tracked-file whitespace check | Passed |
| Typecheck | Passed; final gate 2,048 MB (earlier pass at 1,525 MB) |
| Lint | Passed; gate 2,115 MB |
| Packages tests | Passed: 18 suites, 260 tests; gate 1,637 MB |
| Apps/PGlite integration tests | Initial batch: 11 suites passed, 1 failed on two new test fixture/assertion issues. Both corrected; targeted rerun passed 2 suites/21 tests at 2,141 MB. Full suite subsequently confirms every active app suite passes. |
| Full `npm test` | Passed: 30 suites, 548 tests; 6 suites/20 tests skipped; gate 1,994 MB; 201.535 seconds |
| Production-query EXPLAIN on test data | Passed: direct-history B-tree and partial bulk GIN used, with default planner settings |
| Read-only live smoke checks after restart | Readiness: database/Redis/storage all `ok`; no-cookie session endpoint returns standard `UNAUTHENTICATED`; frontend HTTP 200 |
| Authenticated real-demo data/workflow | Not run; owner backup/migration and demo checks pending |
| Live CI | Not checked; no push authorized |

The EXPLAIN test uses the actual product-history SQL, including aggregate upload context, with default planner settings, 12,000 direct events, 1,200 small bulk events and one 5,000-product bulk event, then ANALYZE. The direct event branch used `audit_events_tenant_entity_time_idx`; bulk membership used `audit_events_bulk_changes_gin_idx`. The measured synthetic GIN size was **221,184 bytes (216 KiB)**. Full plan: [activity-history-explain.md](2026-11-03-activity-history-explain.md).

The store-wide aggregate upload branch used a sequential scan on this fixture (13,220 rows removed by its filter). The proof establishes indexed direct/bulk lookup, not that every activity filter or aggregate branch always uses an index. Real PostgreSQL plans, production-scale latency and index growth remain unverified. No extra index was added beyond the three approved indexes.

The existing harness close order is preserved: close app, drain inline recon, close database.

No memory crash occurred. The existing `pg` overlapping-query deprecation warning remains; this work does not resolve that separate debt. External PostgreSQL/Redis/storage and performance suites remain skipped without dedicated test-service variables.

## Local commits

| Step | Local commit |
| --- | --- |
| S1 settings | `ad86145` — editable tenant settings with concurrency and audit |
| S2 activity/history and indexes | `a303e08` — safe product history with indexed bulk lookups |
| S3 sessions/errors/readiness | `18cceab` — session status and safe dependency error support |
| S4 docs/demo checks | The documentation commit containing this report; use `git --no-pager log --oneline -4` to see all four hashes. |

No push. The final committed contracts are in `docs/settings-activity-api.md`; frontend implementation should read these and the committed backend code.

## Environment notes

The 1,500 MB Available MBytes gate initially blocked checks; no test was started below it. Chrome, Phone Link and standalone ChatGPT were closed. Five specifically identified Qorloop API/worker/frontend development processes were temporarily stopped to free memory. Protected IDE, security, Memory Compression and PostgreSQL processes were left running.

The owner additionally approved temporarily stopping MySQL and SeaweedFS. Windows denied control of MySQL80, so it stayed running. SeaweedFS was stopped and restarted after validation. Its first restart inherited an incompatible `debug` environment value; restarting with a valid child-only debug flag fixed startup. The existing `D:\SeaweedFS\data` directory was preserved.

The API, worker and frontend development commands were relaunched hidden after validation. Live readiness subsequently reported all three components `ok`, and the frontend responded HTTP 200. Startup logs are local under `.cache/service-logs/` and were not dumped into chat. No demo migration or authenticated mutation check was executed.

Automatic approval review rejected an earlier attempt that also included Twinkle Tray, citing missing authorization and possible application-state loss. That action was not retried; subsequent approved closures excluded Twinkle Tray.

## Remaining owner actions and verification

- Owner backup and migration on the demo database.
- Owner-run authenticated demo checks, including the optional edit/revert; confirm actual dashboard baseline and frontend behavior.
- Audit retention remains an explicitly accepted open gap.
- No further schema or role decision is needed for the implemented scope. Real PostgreSQL performance and complete real-data workflows are not certified by the embedded tests.

Run the commands in [API contracts and PowerShell checks](../settings-activity-api.md). The only optional settings mutation changes `staleHours` and reverts it with optimistic concurrency; it does not create price rules or change stock/prices.
