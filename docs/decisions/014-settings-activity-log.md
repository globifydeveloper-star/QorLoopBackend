# ADR 014: Tenant settings, safe activity history, session status and readiness

Date: 3 November 2026

Owner decisions: indexes-only migration approved; Asia/Qatar and QAR remain fixed; aggregate upload history accepted; no audit retention policy yet; only database failure makes readiness fail; session polling must not extend idle expiry.

## Settings

`GET /api/settings` reads existing tenant/store profile, reconciliation thresholds, security flags and pricing settings. `PUT /api/settings` requires `settings.edit` (Owner/Admin), a trusted Origin, CSRF and `expectedRevision`. MFA-policy changes additionally require Owner. Reads require `settings.view`. No roles or permissions are added.

The revision is a SHA-256 snapshot of the returned settings and existing tenant timestamp. The check and write share `Database.run`'s tenant lock. Changed settings advance the tenant timestamp monotonically at millisecond precision, including changes that restore earlier values. Changes through the legacy pricing endpoint also invalidate the revision through the pricing snapshot. Unchanged requests write no audit event and keep the revision.

`tenants.name` and `stores.name` are updated together. No unstored profile fields, currency or time-zone mutation is accepted. Asia/Qatar and QAR are read-only. Generated-file timestamps retain their existing Qatar formatting.

Thresholds use existing storage and consumers: price tolerance (0..100000 QAR, at most three decimals), stock threshold (0..2147483647), and stale hours (integer 1..8760). Stale hours remain canonical; the frontend may convert them to days. Existing defaults remain 0, 0 and 12. These API validation bounds are implementation limits, not new database constraints.

General settings edits write `settings.changed` per changed field, with old/new values and actor/request ID. Pricing edits reuse the existing transactional writer and its `pricing.*` events. Price tolerance, stock threshold and pricing changes enqueue reconciliation after commit. Staleness is already recalculated on summary reads, so changing only stale hours needs no background recompute.

`GET /api/settings/marketplaces` lists enabled marketplaces with last applied upload time and age. It preserves existing semantics: an explicit tenant switch wins; otherwise an applied upload enables the marketplace. No marketplace switches are changed by this API.

## Activity and product history

`GET /api/activity` requires `activity.view`. `GET /api/products/:id/history` additionally checks `products.view` and verifies the product belongs to the current tenant. No client-supplied tenant is accepted.

Filters are product ID, event group, actor ID (or `system`), inclusive UTC date range, cursor and limit (default 50, maximum 200). Groups are `price`, `stock_uploads`, `catalogue`, `team_security`. ERP price/cost field changes belong to price; ERP stock/active/latest-file field changes belong to stock/uploads. Other product field changes belong to catalogue. File and reconciliation events belong to stock/uploads. Settings events belong to team/security.

Pagination orders by `(created_at DESC, id DESC)`. Cursors preserve PostgreSQL's microsecond timestamp precision; converting timestamps to JavaScript milliseconds before creating cursors would lose events around equal timestamps. The pagination is a live feed, not a frozen historical snapshot.

Direct product events use `entity_id`. Bulk product membership uses JSONB containment on the existing `pricing.bulk_applied` compact `details.changes` payload, before loading matching events. Product-specific summaries return only the selected product's old/new rule and price. Actor lookup joins users with both tenant ID and actor ID.

Summaries are built server-side from explicit allowlists. Raw details, idempotency keys, hashes, tokens, MFA secrets, failure messages and IP addresses are not returned. Cost changes omit before/after values from roles without `pricing.edit`, matching the existing product cost-visibility rule. Unknown actions have a generic safe presentation.

### Upload-history limitations accepted by the owner

Do not add per-product rows for every upload. Product history includes store-wide aggregate upload events with `scope: tenant` and `productId: null`. These entries do not prove that the selected product changed. Existing product-level ERP field-change events remain visible where recorded.

Earlier marketplace price and availability changes were not recorded per product and cannot be reconstructed reliably. Newly created rules from historical price-adoption operations also lack individual product events; replacement rules have events. The product-history response includes a plain-English `coverageNotice`. Historical gaps are disclosed, not fabricated or backfilled.

There is no audit retention policy or cleanup job. No audit deletion is introduced.

### Approved indexes-only migration

File: `packages/db/prisma/migrations/202611030001_activity_indexes/migration.sql`.

- `audit_events_tenant_entity_time_idx`: tenant/entity/time/id for direct history.
- `audit_events_tenant_time_id_idx`: tenant/time/id for stable activity pagination.
- `audit_events_bulk_changes_gin_idx`: partial GIN on `(details -> 'changes') jsonb_path_ops`, restricted to `pricing.bulk_applied` events.

The migration only creates indexes. It does not add tables/columns, change data, remove indexes or introduce retention. Prisma declares the two B-tree indexes; the expression/partial GIN index is maintained in SQL because Prisma cannot represent that expression.

The owner backs up the database and runs `npm run db:migrate`. The assistant never runs this migration on the demo database. Test fixtures apply migrations only in isolated PGlite or explicitly throwaway databases.

The integration EXPLAIN uses the production query, default planner settings, ANALYZE and test-only events including a 5,000-product bulk operation. Execution-plan evidence and measured test index size belong in the implementation report after validation. PGlite proof does not establish real PostgreSQL production timings.

GIN size and write cost grow with retained operation membership and values. A 5,000-product event introduces thousands of index keys/postings; repeated operations accumulate because there is no retention. Plan database disk headroom for index construction and future growth, and measure `pg_relation_size` on production-sized data before rollout. No production index-size guarantee is inferred from a synthetic fixture.

## Session and error support

`GET /api/auth/session` resolves the tenant by HOST and checks the session without touching `lastSeenAt`. It does not refresh idle or absolute expiry. It reports authenticated, MFA challenge or MFA enrollment state and the next action. Missing/invalid/revoked cookies return 401 `UNAUTHENTICATED`; recognizable expired or idle-expired sessions return 401 `SESSION_EXPIRED`. When an expired browser cookie is no longer sent, the backend cannot distinguish that from signed out.

Protected endpoints return 403 `MFA_REQUIRED` or `MFA_SETUP_REQUIRED` for restricted sessions, 403 `CSRF_REQUIRED` for invalid CSRF, and 403 `FORBIDDEN` for permission or Origin failures. Existing password-verification and MFA endpoints remain the re-authentication flow; no new password store or session schema is introduced. Login/MFA failures may also return 401, so frontend authentication forms must retain their expected-unauthorized behavior.

The frontend currently treats any `/auth/me` 403 as restricted using a stored browser hint; it should branch on the new explicit codes and the session endpoint instead. A 500 from `/auth/me` remains a server error, not evidence that the session expired.

All API errors use `{ error: { code, message, details? }, requestId }`. A shared serializer handles Nest/Fastify exceptions. Unexpected 500s return only a generic message; raw exceptions and stacks are not sent or logged. `X-Request-ID` is set for responses, exposed to trusted browser origins and recorded as `requestId` in completion/failure logs. Incoming request IDs are not trusted.

## Readiness

`GET /health/ready` checks database, Redis and storage independently with bounded waits. Storage uses a bucket HEAD request, without writing an object. Redis uses PING.

- All available: 200, `data.status: ok`.
- Redis and/or storage unavailable: 200, `data.status: degraded`; affected components are `degraded`.
- Database unavailable: 503 with the standard error body and safe component states in `error.details`.

No dependency hostname, connection string, credential or raw failure text is returned. Readiness does not prove worker liveness or the success of a complete upload/generation workflow.

## Validation

Unit tests cover safe summaries and privacy boundaries. Integration tests cover settings concurrency/audit/consumers, activity filtering/pagination/tenant isolation/permissions/history/index plans, session idle behavior, error envelopes/request IDs/logging and readiness states. Preserve harness teardown order: close app, drain inline recon, then close the database.

Run memory-gated package and app batches separately before the full suite. Record actual outcomes and unverified live behavior in the final report. Demo checks are in `scripts/dev/settings-activity-check.ps1`; only the optional stale-hours edit mutates settings and is reverted with concurrency protection.
