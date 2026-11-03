# BACKEND: S1 Settings, S2 Activity and Product History, S3 Session and Error Support

Date: 3 November 2026

Status: Step 0 inspection complete. Implementation is waiting for the owner's schema decision.

Historical snapshot before the owner's approval. For the completed implementation and current verification status, see [the implementation report](2026-11-03-s1-s2-s3-implementation.md).

This report records findings from the active source code. It does not claim runtime or real-data verification. Proposed API contracts below are not implemented contracts for frontend development yet.

No application code, Prisma schema, migrations or demo data were changed. No tests were run, commits created or changes pushed. This Markdown report is the only added file.

## Decision needed before coding

Product-history lookup needs database indexes to meet the requirement to find affected products without scanning every audit event. An editable time zone would also require a column because no stored time-zone setting exists.

Recommended migration scope:

- Tenant/entity/time indexes for direct product events.
- Cursor-order indexing for activity pagination.
- A partial GIN index over bulk-event `details.changes`, allowing PostgreSQL to find events that contain a product without loading every event into application code.

No new history table is necessary. Index definitions and query plans still need implementation and validation.

Choose one time-zone approach:

1. Keep `Asia/Qatar` read-only, alongside read-only QAR, using only existing settings storage.
2. Approve a stored, editable `time_zone` column defaulting to `Asia/Qatar`, and wire the existing timestamp consumer to it.

The owner must approve schema changes before coding proceeds. After approval, the owner takes a backup and runs `npm run db:migrate`; the assistant does not migrate the demo database.

## Existing settings

The active application uses NestJS and Prisma. The root `src/` directory is unused legacy scaffolding.

| Area | Existing storage and behavior |
| --- | --- |
| Store profile | `tenants.name` and `stores.name`. `/api/auth/me` returns the tenant name. No profile-edit endpoint; no address/contact profile fields. |
| Time zone | No stored setting. Generated-file timestamps currently hardcode `Asia/Qatar`. |
| Currency | No stored setting. Pricing and upload labels use QAR. Currency should remain read-only. |
| Reconciliation thresholds | `tenant_settings.price_tolerance` defaults to 0, `stock_threshold` to 0, and `stale_hours` to 12. All have existing consumers. |
| Security/export policy | `mfa_required_for_all` defaults to false; `analyst_can_export` defaults to true. Both affect existing authorization. |
| Pricing | `pricing_settings` stores default rule mode/value, rounding, the per-marketplace switch, the default comparison reference, and timestamps. |
| Marketplace switches | `tenant_marketplaces` stores marketplace, enabled flag and timestamps. Existing behavior honors an explicit switch; otherwise an applied upload enables the marketplace. |

Sources:

- [Prisma schema](../../packages/db/prisma/schema.prisma)
- [Pricing service](../../apps/api/src/pricing/pricing.service.ts)
- [Reconciliation repository](../../packages/db/src/recon.ts)
- [Enabled marketplace resolution](../../packages/core/src/recon/compute.ts)
- [Generated-file timestamp formatting](../../packages/core/src/generated-files.ts)

### Existing pricing settings endpoints

`GET /api/pricing/settings` and `PUT /api/pricing/settings` already exist. The GET response, and the successful PUT response, have this shape:

```ts
{
  data: {
    defaultRule: PriceRule,
    rounding: "exact" | "0.05" | "0.25" | "0.50",
    perMarketplaceEnabled: boolean,
    compareReferenceDefault: "marketplace" | "erp",
    marketplaceRules: MarketplaceRule[],
    order: string[],
    updatedAt: string | null
  }
}
```

`PriceRule` is `{ mode: "same" }` or `{ mode: "percent" | "amount" | "fixed", value: number }`. A marketplace rule also includes `marketplaceId` and `rounding`.

Updates validate through Zod, audit changed fields, and enqueue reconciliation. They currently have no optimistic concurrency check. The existing PUT uses `pricing.edit`, which includes Catalogue Manager; the new general settings mutation must use Owner/Admin's `settings.edit` while preserving the existing pricing API's compatibility.

The dashboard re-evaluates staleness on reads using `staleHours`. Keep hours canonical so the existing 12-hour default survives; the frontend can display days.

## Audit storage

`audit_events` contains:

```text
id             UUID, primary key
tenant_id      UUID
actor_id       UUID, nullable
action         text
entity_id      UUID, nullable
request_id     text, nullable
details        JSONB, nullable
created_at     timestamptz
```

Besides its primary key, the table has only `(tenant_id, created_at)` indexed.

Product IDs normally occupy `entity_id`; upload events use the upload ID there. ERP field-change details also contain `uploadId`. Actor IDs have their own column. None of these lookup fields has a dedicated index.

### Current event writers

| Writer | Events currently written |
| --- | --- |
| Auth service | `invitation.created`, `invitation.accepted`, `invitation.resent`, `store.provisioned`, `auth.login_failed`, `auth.password_verified`, `auth.logout`, `auth.password_reset_requested`, `auth.password_reset`, `auth.mfa_setup_started`, `auth.mfa_failed`, `auth.mfa_enrolled`, `auth.mfa_verified`, `auth.recovery_failed`, `auth.recovery_used` |
| Team service | `invitation.revoked`, `team.role_changed`, `team.member_deactivated` |
| Upload API | `upload.created`, `upload.rejected`, `upload.queued`, `upload.mapping_confirmed`, `upload.apply_requested`, `upload.discarded` |
| Upload workers | `upload.rejected`, `upload.needs_mapping`, `upload.reviewed`, `upload.failed`, `upload.applied`, `upload.apply_failed`; ERP changes write `product.field_changed` |
| Pricing service | `pricing.settings_changed`, `pricing.marketplace_rule_set`, `pricing.marketplace_rule_deleted`, `pricing.category_rule_set`, `pricing.category_rule_deleted`, `pricing.prices_adopted`, `product.price_rule_set`, `product.price_rule_deleted`, `product.offer_set`, `product.offer_deleted` |
| Bulk pricing | `pricing.bulk_applied` |
| Catalogue services | `product.field_changed`, `products.activated`, `category.created`, `category.updated`, `category.deleted`, `category.assigned_from_erp` |
| Reconciliation | `recon.recompute_requested`, `recon.failed` |
| File worker | `file.generated`, `file.generation_failed` |

Sources:

- [Auth service](../../apps/api/src/auth/auth.service.ts)
- [Team service](../../apps/api/src/team/team.service.ts)
- [Uploads service](../../apps/api/src/uploads/uploads.service.ts)
- [Process upload worker](../../apps/worker/src/process-upload.ts)
- [Apply upload worker](../../apps/worker/src/apply-upload.ts)
- [Pricing service](../../apps/api/src/pricing/pricing.service.ts)
- [Bulk pricing service](../../apps/api/src/pricing/bulk-pricing.service.ts)
- [Products service](../../apps/api/src/products/products.service.ts)
- [Categories service](../../apps/api/src/products/categories.service.ts)
- [Recon service](../../apps/api/src/recon/recon.service.ts)
- [Recompute worker](../../apps/worker/src/recompute-recon.ts)
- [Generate file worker](../../apps/worker/src/generate-file.ts)

### Bulk product history

Bulk operations store their changes in one `pricing.bulk_applied` event:

```text
details.changeColumns:
productId, oldMode, oldValue, newMode, newValue, oldPrice, newPrice

details.changes:
one compact array per affected product
```

The payload preserves the information needed for bulk product history, but no JSON lookup index exists.

### Historical coverage and retention

- ERP changes to existing products record field-level before/after values.
- Marketplace uploads overwrite listings without recording product-level price/availability differences.
- Price adoption writes individual rule events only when replacing an existing rule; newly created rules have only the aggregate adoption event.
- Activation has individual product status events.
- No audit cleanup job or defined audit-retention period exists.
- Upload retention metadata is 90 days; generated files are 30 days. Cleanup remains unimplemented.

Missing historical differences cannot be reconstructed reliably. New writes can record them going forward; old gaps must remain explicit.

## Permissions

Existing permissions are sufficient; no new role or permission is needed.

| API | Existing gate |
| --- | --- |
| Read settings | `settings.view`: all four roles |
| Edit ordinary settings | `settings.edit`: Owner/Admin |
| Change MFA policy | `settings.security`: Owner only |
| Activity log | `activity.view`: all four roles |
| Product history | `activity.view` plus `products.view` |

Activity responses will use explicit field allowlists, including summaries and before/after values. They will never return raw audit payloads, tokens, password hashes, MFA data or IP addresses.

Source: [Role and permission matrix](../../packages/core/src/roles.ts).

## Current sessions and errors

| Condition | Current API response |
| --- | --- |
| Missing, invalid, expired, idle-expired session, or inactive membership | 401 `UNAUTHENTICATED` |
| Restricted session accessing business endpoints | 403 `FORBIDDEN`, message `MFA verification required` |
| Missing/invalid CSRF | 403 `FORBIDDEN` |
| Permission denied | 403 `FORBIDDEN` |
| Unexpected application error | 500 `INTERNAL_ERROR`, message `Internal server error` |

Restricted sessions last 10 minutes. Full sessions default to 12 hours, with 30-minute idle expiry; both full-session limits are configurable. These are code defaults, not a verification of the running environment's settings. Successful session checks update `lastSeenAt`.

`GET /api/auth/me` requires a full session. It does not distinguish signed out from expired, or MFA enrollment from verification through machine-readable codes.

The frontend currently:

- Treats `/api/auth/me` 401 as anonymous; it shows session-expired when it remembers a previous login.
- Treats any `/api/auth/me` 403 as restricted, using a browser hint to choose enrollment versus verification.
- Shows `We could not reach Qorloop`, the generic server message and Request ID for `/api/auth/me` 500.

This explains the displayed screen. It does not establish what caused that particular 500.

The Nest error filter already sanitizes unexpected errors, returns `requestId`, and logs a sanitized failure with that ID. `X-Request-ID` is set by a request hook. Framework/parser errors and early failures still need explicit coverage before claiming every path complies.

Sources:

- [Auth service](../../apps/api/src/auth/auth.service.ts)
- [API app, error filter and request hooks](../../apps/api/src/app.ts)
- Frontend inspected read-only: `D:\Qorloop\src\api\client.ts`, `src\auth\AuthContext.tsx`, `src\components\common\States.tsx`, and `src\App.tsx`.

## Current readiness endpoint

`GET /health/ready` checks only PostgreSQL. Redis and storage readiness checks are missing. Object storage and queue interfaces currently have no dedicated readiness method.

Source: [API system controller](../../apps/api/src/app.ts).

## Proposed implementation plan

These contracts are proposals only. The frontend must use the final implemented and committed backend contracts.

| Step | Endpoints and behavior |
| --- | --- |
| S1 settings | `GET /api/settings` and `PUT /api/settings`. Return profile, existing thresholds, pricing and an opaque `revision`. PUT requires `expectedRevision`, validates strictly, compares under the existing tenant lock, audits old/new values, and schedules reconciliation where needed. Keep existing pricing endpoints compatible. Time-zone mutability depends on the owner's decision. |
| Marketplaces | `GET /api/settings/marketplaces`. Read-only. Return `{ data: { items: [{ marketplaceId, enabled, hasData, lastUploadAt, ageHours }] } }`; missing timestamps and ages are `null`. Reuse existing enabled-marketplace semantics. |
| S2 activity | `GET /api/activity` and `GET /api/products/:id/history`. Filters: `productId`, `eventType`, `actorId`, `from`, `to`, `cursor`, `limit`. Use descending `(created_at, id)` cursor ordering. |
| Activity response | `{ data: { items: [{ id, time, actor, type, summary, beforeAfter }], nextCursor } }`. UTC timestamps, tenant-scoped actor lookup, `system` for system events, and allowlisted before/after fields only. Bulk product history extracts only the requested product's change. |
| S3 sessions | Add `GET /api/auth/session` to report healthy/restricted state without keeping an idle session alive. Distinguish expired sessions when the browser still supplies a recognizable session cookie. An absent cookie cannot prove whether someone signed out or its cookie expired. |
| S3 errors/readiness | Preserve the standard error envelope, introduce documented session/MFA branch codes, cover early error paths, and report database/Redis/storage readiness separately using safe component statuses. |

### Planned files

- New settings and activity controllers/services under `apps/api/src/`.
- New tenant-scoped settings/activity repositories under `packages/db/src/`.
- Shared Zod contracts under `packages/shared/src/`.
- A pure activity-summary module under `packages/core/src/`.
- Updates to auth, error handling, readiness support and missing audit writers.
- Unit and PGlite integration tests.
- `docs/decisions/014-settings-activity-log.md` and updates to `docs/open-gaps.md`.
- Migration/schema files only after explicit approval.

### Validation and commits after approval

- One logical local commit per step; no push.
- Before every test run, require Available MBytes >= 1500.
- Run `packages/` then `apps/` separately and sequentially; stop at the first memory crash.
- Then run full `npm test`, typecheck and lint, subject to the same memory rules.
- Preserve the harness teardown that drains inline recon before closing the database.
- Test settings validation/concurrency/audit, activity filters/cursors/isolation/permissions, product history, safe summaries, session outcomes, and error body/header/log request IDs.
- Supply exact PowerShell demo checks with the implemented contracts. Any settings edit in those checks must be reversible and reverted.
- Do not claim real-data verification until its workflow and independent answer key pass.

## Checks performed and limits

- Read the active schema, migrations, repositories, controllers, services, workers, contracts, permission matrix and relevant test harness.
- Read the frontend auth/error behavior without modifying the frontend repository.
- Confirmed the backend working tree had no changes before creating this report.
- Did not inspect credential values, connect to the real demo database, run tests, call live APIs, verify live CI, or change any data.
- No application implementation has started; schema approval remains pending.

## Output preference

The owner requested Markdown files for outputs. Future substantive reports and deliverables in this conversation will include an `.md` artifact and a link to it.
