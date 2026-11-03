# O1 onboarding implementation

Date: 3 November 2026. Owner-approved scope: schema-free GET only. Nothing pushed.

## Delivery and contract

Step 0 inspection commit: `0b420c7`. Step 1 implementation/core-tests commit: `704aa22`. Step 2 intentionally omitted by the owner's decision: no skip/dismiss storage or endpoints. Step 3 contains integration tests, documentation and the read-only demo check script.

`GET /api/onboarding` requires full authentication and `settings.view`. Its envelope is `{ data: { steps, percent, nextStepId, complete, marketplaces } }`. Each step has `{ id, title, description, required, status, doneAt, action: { kind, target } }`. Status is done/next/todo; timestamps are UTC ISO or null. Exact types, IDs, order, navigation keys and role responses are in [onboarding-api.md](../onboarding-api.md); runtime OpenAPI is emitted by the registered controller. No POST routes, category/profile steps, schema changes, migrations or new settings/pricing audit writes were added.

Only active Owner MFA, applied ERP, at least one applied marketplace and computed comparison with matched data count toward percent (25 each). All four done means complete true and nextStepId null. Optional invitations, nondefault current pricing and successful file generation never block completion. Other roles receive empty progress. MFA doneAt is null because there is no dedicated enrollment timestamp. Other dates identify a retained matching record, not a guarantee of first-ever completion.

Queries are fixed-size tenant-scoped probes. No product/listing/recon-row loading or audit-history scans are introduced. The inline recon drain and harness close order are unchanged.

## Files changed

- Runtime registration: `apps/api/src/app.ts`.
- New controller/service: `apps/api/src/onboarding/onboarding.controller.ts`, `apps/api/src/onboarding/onboarding.service.ts`.
- Pure calculation and export: `packages/core/src/onboarding.ts`, `packages/core/src/index.ts`.
- Tenant-scoped persistence reads and wiring: `packages/db/src/onboarding.ts`, `packages/db/src/database.ts`.
- Tests: `packages/core/src/__tests__/onboarding.test.ts`, `apps/api/src/__tests__/onboarding.integration.test.ts`.
- Documentation: `docs/decisions/015-onboarding.md`, `docs/onboarding-api.md`, `docs/open-gaps.md`, this report and the supersession note in the Step 0 report.
- Read-only demo script: `scripts/dev/onboarding-check.ps1`.

## Verification

- Memory gate initially blocked tests at 817, 1422 and 829 MB. No tests started below the threshold. After the user requested freeing memory, cached working-set pages were released from Chrome/IDE processes without closing applications; API/worker/database processes were preserved.
- `npm.cmd test -- packages/`: gate 1801 MB; 19 suites and 279 tests passed.
- `npm.cmd test -- apps/`: gate 1551 MB; 13 suites and 293 tests passed; 6 suites/20 tests skipped (external PostgreSQL performance/concurrency and real Redis coverage).
- Full `npm.cmd test`: gate 2131 MB; 32 suites and 572 tests passed; 6 suites/20 tests skipped. No memory crash occurred in any run.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed.
- PowerShell parser check for the new demo script: passed.
- `git diff --check`: passed.

No external test database variable is configured: integration tests use the embedded PGlite harness. The new suite exercises actual Owner MFA endpoints, upload parsing/mapping/application, explicit recon computation and successful file generation, with separate assertions between transitions. It also covers tenant/session isolation, empty role responses, initial operations invitation exclusion, default pricing/no-op behavior, comparison evidence rejection and secret-free response fields.

## Demo verification and limits

No live demo business data was changed. No demo credentials were read or printed. A credential-free connectivity probe to the demo onboarding URL could not connect (curl exit 7, HTTP status 000). Live authenticated progress and optional remaining steps have not been verified: the API was unreachable from this environment and the assistant has no existing authenticated demo session. Exact read-only PowerShell commands and expected output are in [onboarding-api.md](../onboarding-api.md). The check uses an existing authenticated browser cookie supplied at a hidden local prompt, performs only GET /api/onboarding and checks all four required steps done plus Talabat/Snoonu applied. It does not login/logout, upload, recompute, change settings/pricing or generate files. The ordinary session-activity touch still occurs server-side.

The frontend repository is absent. Navigation targets are documented symbolic keys for the frontend to map to its actual routes. Whether the external Help & onboarding page contains demo content remains unverified. No owner decision remains for this approved scope.
