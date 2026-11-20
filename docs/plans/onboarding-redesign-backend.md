# Store creation, onboarding and authentication redesign: backend plan

Date: 20 November 2026. Status: **approved** (see "Decisions for the owner"). Steps 1–12 are approved for implementation on `feature/onboarding-redesign`; steps 13–25 wait for the owner to confirm the frontend contract. Branch `plan/onboarding-redesign`.

Scope: this is the **backend** repository (API, database, worker, seed and scripts). The frontend parts (screens, state, API calls, frontend tests, and what `VITE_REAL_ONBOARDING` switches) belong to the frontend session and are **not covered here**. Where the backend depends on a frontend fact, it is marked *(frontend to confirm)*.

Marking: **[verified]** means read in the code at the reference given. **[guess]** means inferred and not proven by the code.

---

## Part 1: Audit of what exists today

### 1.1 How the store is found from the request

1. `SecurityGuard.canActivate` ([security.guard.ts:41](../../apps/api/src/http/security.guard.ts)) calls `Database.resolve(hostname(req.headers.host), config.TENANT_ID)`. **[verified]**
2. `hostname()` ([security.guard.ts:18-21](../../apps/api/src/http/security.guard.ts)) lowercases the `Host` header and strips the port. Hosts that are not plain `[a-z0-9.-]` resolve to `''`, which gives 404. **[verified]**
3. `Database.resolve` ([database.ts:53-58](../../packages/db/src/database.ts)) looks up `tenants` where `hostname = host AND status = 'active'`, plus `id = TENANT_ID` **when TENANT_ID is set**. If nothing matches, the response is 404 `Store not found`. **[verified]**
4. `trustProxy: false` ([app.ts:120](../../apps/api/src/app.ts)): only the raw `Host` header is used. `X-Forwarded-Host` is ignored. **[verified]**
5. The trusted-Origin check ([app.ts:150-172](../../apps/api/src/app.ts)) takes `APP_ORIGIN` and `CORS_ORIGIN`, **replaces their hostname with the request host** (`originsForHost`, [security.guard.ts:22-28](../../apps/api/src/http/security.guard.ts)) and requires an exact match for every mutation. Any `<store>.localhost:3000` therefore passes, as long as the port and scheme match `APP_ORIGIN` or `CORS_ORIGIN`. **[verified]**
6. `TENANT_ID` is optional in the schema ([config.ts:12](../../packages/shared/src/config.ts)), but `loadConfig` refuses to start in production without it ([config.ts:46](../../packages/shared/src/config.ts)). The CLI scripts opt out with `requireTenantPin: false`. **[verified]**
7. Session and CSRF cookies are host-only (no `Domain`), named `__Host-qorloop` in production and `qorloop` otherwise ([security.guard.ts:14](../../apps/api/src/http/security.guard.ts), [auth.controller.ts:25-33](../../apps/api/src/auth/auth.controller.ts)). Each store host has its own cookie jar. **[verified]**

**What must be true for a new store to work:**

| Condition | Where |
| --- | --- |
| A `tenants` row with `status='active'` and `hostname` equal to the browser's API host, without the port | `tenants` |
| `TENANT_ID` either unset, or equal to that tenant's id. **This alone blocks a second store locally.** | `.env` |
| The API is reached with that `Host` (for example `newstore.localhost:4000`). `*.localhost` resolves to loopback in Chromium, Firefox and curl. **[guess for every OS/browser]** | DNS / browser |
| The frontend is served from the same host on the port of `APP_ORIGIN`/`CORS_ORIGIN`, and the dev server accepts that host *(frontend to confirm: Vite `allowedHosts` and the API base URL)* | frontend |
| The worker is running, because invitation mail, upload processing and recon all depend on it | `npm run dev:worker` |
| The Owner invitation has not expired (48 h, [auth.service.ts:150](../../apps/api/src/auth/auth.service.ts)) | `invitations` |

### 1.2 Steps from "a store exists" to "ready to use"

| # | Step | Endpoint / script | Requires | Writes | On failure | Leave and come back |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | **Create store (operator)** | `npm run provision:store -- --name --slug --owner-email [--hostname]` ([infra/provision-store.ts](../../infra/provision-store.ts)); dev seed `npm run db:seed` ([seed.ts](../../packages/db/src/seed.ts)); e2e `scripts/e2e-support.ts provision` | DATABASE_URL, AUTH_SECRET. Runs `prisma migrate deploy` first ([provision-store.ts:21](../../infra/provision-store.ts)) | `tenants`, `stores`, `tenant_settings` (defaults) ([database.ts:110-122](../../packages/db/src/database.ts)); `invitations` (owner, `invited_by` null); `email_outbox`; audit `invitation.created`, `store.provisioned` | Migration failure stops the run. A different name or host for the same slug throws a generic Error. An existing different owner email gives 409 | Idempotent per slug: a rerun returns the **first** owner invitation (`created:false`) and sends nothing |
| 1 | **Invitation e-mail** | worker outbox poller ([worker main.ts:27-43](../../apps/worker/src/main.ts)) | worker, SMTP | `email_outbox.delivered_at`; the sealed body is cleared after delivery | Retried after a 5-minute lease, up to 10 attempts, then silently abandoned | n/a |
| 2 | **Activation** | `POST /api/auth/invitations/accept` `{token,name,password}` (public) | a valid, unexpired invitation token (48 h) | `users` (`email_verified_at`), `memberships`, `invitations.accepted_at`, `sessions` (restricted 10 min for an owner), audit `invitation.accepted` | 400 `Invitation expired or invalid`; 409 if already a member | The token is single use. After acceptance the owner logs in with the password |
| 3 | **Login** | `POST /api/auth/login` | email and password | `sessions`: `full` (SESSION_HOURS, default 12 h) or `enrollment`/`challenge` (10 min); audit | 401 generic; rate limit 20/min per host, IP and path ([app.ts:146](../../apps/api/src/app.ts)) | A new login is needed after the idle time (30 min) or the hard expiry |
| 4 | **MFA setup (owner forced)** | `POST /api/auth/mfa/setup` `{password}` then `POST /api/auth/mfa/verify` `{code}` | restricted session, password | `users.pending_mfa_secret` (10 min), then `mfa_secret`, `recovery_codes` (10); deletes all the user's sessions; issues a `full` session | Wrong code: 401 and audit `auth.mfa_failed`. An expired pending secret means setup must be started again | Not resumable: a pending secret older than 10 minutes means starting again |
| 5 | **Onboarding wizard (read only)** | `GET /api/onboarding` (`settings.view`; owner and admin get steps, others get an empty list) ([onboarding.service.ts](../../apps/api/src/onboarding/onboarding.service.ts), [core onboarding.ts](../../packages/core/src/onboarding.ts), [db onboarding.ts](../../packages/db/src/onboarding.ts)) | a full session | nothing (derived, ADR 015) | n/a | Fully derived from data, so it resumes by itself |
| 6 | **Store details / thresholds** | `GET/PUT /api/settings` (`settings.edit`, `expectedRevision`) | revision | `tenants.name`, `stores.name`, `tenant_settings.{price_tolerance,stock_threshold,stale_hours,mfa_required_for_all,analyst_can_export}`, `pricing_settings`; audit `settings.changed`; recon queued for tolerance/threshold/pricing | 409 on a stale revision | Saved immediately |
| 7 | **Marketplaces used** | `GET /api/settings/marketplaces` (read only) | n/a | **nothing: no write endpoint exists** | n/a | n/a |
| 8 | **ERP upload (map columns once)** | `POST /api/uploads` → PUT to the signed URL → `POST /:id/complete` → (if `needs_mapping`) `POST /:id/mapping` → `GET /:id/review` → `POST /:id/apply` | `uploads.*` permissions; S3; worker | `uploads` (state machine `uploading→processing→needs_mapping→processing→needs_review→applying→applied`, plus `rejected/failed/discarded`), `upload_rows/errors`, `input_templates` (saved layout, versioned), `products`, `erp_upload_changes`; recon queued | Rejected or failed with `error_message`; a failed apply returns to `needs_review` ([worker main.ts:61-67](../../apps/worker/src/main.ts)); a stuck-upload sweep runs every 5 min | **Resumable**: an upload in `needs_mapping`/`needs_review` waits in the DB. An upload left in `uploading` after the signed URL expired (600 s) can only be discarded |
| 9 | **Marketplace upload(s)** | same endpoints, `source` = talabat/snoonu/rafeeq/keeta | as above | `listings`; an applied upload **implicitly enables** the marketplace when there is no `tenant_marketplaces` row ([recon/compute.ts:22-35](../../packages/core/src/recon/compute.ts)) | as above | as above |
| 10 | **First comparison** | worker recon → `GET /api/recon/summary` | worker | `recon_rows`, `recon_summaries` | A failed run keeps the previous results; the onboarding step stays `next` with no reason given | derived |
| 11 | **Price source** | `PUT /api/settings` (pricing: default rule = "ERP plus markup") or `POST /api/pricing/adopt/preview` + `/apply` ("use current marketplace prices") | `pricing.edit`; a marketplace file applied | `pricing_settings`, or `product_price_rules` per product; audit `pricing.prices_adopted`; recon | Validation 400 | No record of *which* strategy was chosen |
| 12 | **Invite team** | `POST /api/team/invitations`, resend, revoke; `PATCH /members/:id/role`; `DELETE /members/:id` | `team.*` | `invitations`, `email_outbox`, `memberships`; sessions deleted on a role change or removal | 409 on a duplicate pending invitation | Pending invitations are listed |

### 1.3 Demo and mock paths in the backend

- No demo or mock branch exists in the API code. **[verified by reading the services used above; I did not grep every file]** Previously demo-only screens (templates, onboarding) are now backed by real endpoints (ADR 015, ADR 016).
- The dev seed creates `dohafresh` / `dohafresh.localhost` with `owner@example.test` ([seed.ts:10](../../packages/db/src/seed.ts)). The dev scripts all target **`qorloop-demo.localhost`** ([scripts/dev/*.ps1](../../scripts/dev/), [start-qorloop.ps1:72](../../scripts/dev/start-qorloop.ps1)). The default `APP_ORIGIN` is `dohafresh.localhost:3000` ([config.ts:13](../../packages/shared/src/config.ts)). Three different "default stores" exist.
- `scripts/e2e-support.ts` prints invitation and reset tokens from the outbox. It is guarded by `NODE_ENV !== 'production'` ([e2e-support.ts:19](../../scripts/e2e-support.ts)).
- The local backend `.env` contains `VITE_REAL_UPLOADS` and `VITE_REAL_CATALOGUE` keys. They are frontend flags in a backend file: harmless, but confusing. **[verified key names only; values not read]** `VITE_REAL_ONBOARDING` is a frontend flag (out of scope).

### 1.4 Bugs, gaps and confusing behaviour

| ID | Severity | Finding | Reference |
| --- | --- | --- | --- |
| B1 | **High (dev)** | `.env.example` sets `TENANT_ID=00000000-0000-0000-0000-000000000001`, but provisioning creates the tenant with `randomUUID()`. A fresh setup following the example answers **404 Store not found** for the seeded store until TENANT_ID is edited. With TENANT_ID set (it is set in the local `.env`), **every second store is unreachable**. | [.env.example](../../.env.example), [database.ts:119](../../packages/db/src/database.ts), [database.ts:55](../../packages/db/src/database.ts) |
| B2 | **High** | If the owner invitation expires (48 h) before activation, **nothing can resend it**. `provision` returns the stale first invitation (`created:false`) ([auth.service.ts:159-163](../../apps/api/src/auth/auth.service.ts)), and `POST /api/team/invitations/:id/resend` needs a signed-in `team.invite` user, and no one exists yet. The only way out today is a database edit. | [auth.service.ts:156-169](../../apps/api/src/auth/auth.service.ts) |
| B3 | Medium | No endpoint writes `tenant_marketplaces`. The permission `marketplaces.edit` is defined but used by no route. `GET /api/settings/marketplaces` hard-codes `enabled: true` and omits disabled marketplaces, so the UI cannot show a switch. Tests insert rows directly with Prisma. | [roles.ts:41](../../packages/core/src/roles.ts), [settings.service.ts:67-77](../../apps/api/src/settings/settings.service.ts), [settings.controller.ts:36-43](../../apps/api/src/settings/settings.controller.ts) |
| B4 | Medium | An implicit enable: uploading a file for any marketplace without a switch row turns it on for recon, Review and bulk offers. The onboarding text names all four marketplaces. A store that uses only Talabat gets Snoonu reconciled as soon as someone uploads a Snoonu file by mistake. | [recon/compute.ts:22-35](../../packages/core/src/recon/compute.ts), [core onboarding.ts:44](../../packages/core/src/onboarding.ts) |
| B5 | Medium | The onboarding `pricing_settings` step is done only when the settings **differ from the defaults**. An owner who deliberately chooses "ERP price, no markup" (the defaults) can never complete it. No record exists of the chosen price source. | [db onboarding.ts:24-29](../../packages/db/src/onboarding.ts), ADR 015 |
| B6 | Low | The `findFirst` probes have no `orderBy`, so `doneAt` is an arbitrary matching row, not the earliest. ADR 015 accepts this, but it makes `doneAt` jump between calls after a reset or extra uploads. **[guess about jumping: depends on the plan PostgreSQL picks]** | [db onboarding.ts:16-30](../../packages/db/src/onboarding.ts) |
| B7 | Low | `first_comparison` waits on the recon worker. If the worker is down or a recompute failed (`recon.failed` audit), the step stays `next` with no explanation. | [core onboarding.ts:45](../../packages/core/src/onboarding.ts) |
| B8 | Medium | Outbox delivery: a 10 s poll, and a failed send waits 5 minutes (the lease) before retrying. After 10 attempts a mail is abandoned silently, with no event and no visible status. This is acceptable for invitations and **unacceptable for one-time codes** (Part 5). | [database.ts:223-228](../../packages/db/src/database.ts), [worker main.ts:28-43](../../apps/worker/src/main.ts) |
| B9 | Low | The Message-ID domain is hard-coded to `@qorloop.globify.ae` regardless of `MAIL_FROM`. | [worker main.ts:35](../../apps/worker/src/main.ts) |
| B10 | Low | `accept()` for a returning (previously removed) user overwrites the password but ignores the submitted `name`. | [auth.service.ts:72-75](../../apps/api/src/auth/auth.service.ts) |
| B11 | Low | `checkSession` writes `sessions.last_seen_at` on **every** authenticated request (one UPDATE per call). With a 7-day idle window this can be throttled. | [auth.service.ts:55](../../apps/api/src/auth/auth.service.ts) |
| B12 | Low | No password-change endpoint for a signed-in user; only forgot/reset. | [auth.controller.ts](../../apps/api/src/auth/auth.controller.ts) |
| B13 | Doc drift | ADR 003 says Better Auth + Drizzle; the code is custom auth on Prisma with otplib/argon2. ADR 005 names `infra/provision.sh`, which does not exist (only `provision-store.ts`; open gap G8). | [docs/decisions/003-auth.md](../decisions/003-auth.md), [005](../decisions/005-hosting-provisioning.md) |
| B14 | Low | The `provision-store` hostname default for dev is `<slug>.localhost`, but `.env.example` has `CORS_ORIGIN=http://localhost:3000` and no `APP_ORIGIN`. It works only because `originsForHost` rewrites the hostname. This is not documented. | [provision-store.ts:18](../../infra/provision-store.ts) |
| B15 | Info | "Reset store data" is a developer CLI script, not an API action (ADR 018). Part 5's "fresh OTP before reset store data" has no endpoint to attach to today. | [scripts/dev/reset-store-data.mjs](../../scripts/dev/reset-store-data.mjs) |
| B16 | Info | Adoption writes one product rule per product, and a product rule applies to **every** marketplace (open gap G13). When Talabat and Snoonu prices differ, adopting from one creates mismatches on the other; they are only reported as `conflicts`. Products added by later ERP files have no adopted rule and fall back to the default rule. **[the second point is inferred from the rule order in ADR 010/013]** | ADR 010, [open-gaps.md G13](../open-gaps.md) |

---

## Part 2: Proposed design

### 2.1 Review of the proposed flow, with changes

| Proposed | Change and reason |
| --- | --- |
| 1. The operator creates the store by CLI | Keep. Add `--marketplaces talabat,snoonu` (optional, preselects step a) and a **`resend-owner-invitation`** subcommand (fixes B2). Never print tokens or links. |
| 2. Activate and set up two-step verification | **Conflicts with Part 5 decision 5** (the authenticator becomes optional). New meaning: two-step = password + **email OTP**, which is always on. Activation itself proves the mailbox. The authenticator app becomes an *optional, recommended* checklist item for owners. See decision D1. |
| 3a. Store details and marketplaces | Keep. Add the missing write endpoint. Unselected marketplaces are written as explicit `enabled=false` rows, which stops implicit enabling (B4). |
| 3b. ERP upload | Keep. Show a pending upload (`needs_mapping`/`needs_review`) as "continue", not "start". |
| 3c. Marketplace files | "Each **enabled** marketplace" needs one applied file. To skip one, the owner disables it in 3a. |
| 3d. Price source | Keep, **after** 3c (adoption needs listings). Store the choice explicitly (B5). |
| 3e. Thresholds | Optional, with visible defaults. No progress state needed. |
| 3f. Invite team | Optional. Each invitation needs a fresh OTP (Part 5). |
| — (new) **3g. First comparison** | A system step, not a user step: "Preparing your comparison", showing the recon status and the failure reason. It is required before the Dashboard opens, because a Dashboard with no recon rows is empty. |
| 4. Dashboard gated on a–d | Gate on a–d **plus 3g**. The gate is in the **UI**. The API keeps serving recon to anyone with `recon.view`, which avoids breaking existing stores and tests. The API returns `essentials.missing[]`. |
| 5. Final summary | Keep. A new read-only endpoint. Also reachable later from Settings. |

### 2.2 Step definitions

All progress is **derived** unless noted. "Settings later" names the existing or new place where the value can be changed after onboarding.

| Step | Required | Defaults | Validation | Saved where | Changed later in | Resume |
| --- | --- | --- | --- | --- | --- | --- |
| **0 Create store** (CLI) | yes | host = `<slug>.localhost` (dev) or `<slug>.<BASE_DOMAIN>` (prod) | slug `^[a-z][a-z0-9-]{1,61}[a-z0-9]$`, name 1–120, email, host regex (existing, [provision-store.ts:13-16](../../infra/provision-store.ts)); new: host unique, warn when `TENANT_ID` in the env differs | `tenants`, `stores`, `tenant_settings`, `pricing_settings` (**new: create the row up front**), optional `tenant_marketplaces`, `invitations`, `email_outbox` | CLI only | Idempotent rerun; `resend-owner-invitation` |
| **1 Activate** | yes | — | password 12–128, name 1–100 (existing) | `users`, `memberships`, `invitations.accepted_at`; **trusts this device** (Part 5: the email link counts as the first factor of possession) | Profile: name; password change (new, B12) | The invitation link works until used or expired; the operator resends |
| **2 Secure account** | email OTP: automatic. Authenticator app: **optional**, recommended for owners | — | TOTP as today | `users.mfa_secret` (existing) | Settings → Security | Pending TOTP setup expires after 10 min: start again |
| **a Store details and marketplaces** | yes | name from the CLI; marketplaces from `--marketplaces` or none | ≥1 marketplace enabled; ids in `MARKETPLACES`; name 1–120 | `tenants.name`/`stores.name` (existing `PUT /api/settings`); `tenant_marketplaces` rows for **all four** ids (new `PUT /api/settings/marketplaces`) | Settings → Store / Marketplaces | Done when ≥1 explicit `tenant_marketplaces` row has `enabled=true` |
| **b ERP file** | yes | saved layout reused automatically on the next file | existing upload validation | `uploads`, `input_templates`, `products` | Uploads; Templates | Done when an ERP upload is `applied`. In progress: the newest non-terminal ERP upload is returned as `pendingUpload` |
| **c Marketplace files** | yes, one per enabled marketplace | — | source must be **enabled** (new check in `POST /api/uploads` once any switch row exists; legacy stores without rows keep today's behaviour) | `uploads`, `listings`, `input_templates` | Uploads; Settings → Marketplaces to disable one | Per marketplace: done / pending upload / todo |
| **d Price source** | yes | none preselected | `erp_markup`: percent −90..1000, rounding in `ROUNDING_OPTIONS`. `adopt`: `sourceMarketplaceId` enabled and with an applied file; mode fixed/percent | `erp_markup`: `pricing_settings.default_rule_*`, `rounding`. `adopt`: product rules via the existing adoption. Both: **new** `pricing_settings.price_source`, `price_source_confirmed_at`, `price_source_marketplace_id` | Settings → Pricing ("Price source"). Re-running adoption with `onlyWithoutRule=true` covers new products | Done when `price_source_confirmed_at IS NOT NULL` |
| **e Thresholds** | optional | stock threshold 0, price tolerance 0.000 QAR, stale hours 12 (existing defaults, [constants.ts](../../packages/core/src/constants.ts)) | existing (`settingsThresholds`, [contracts.ts:173-177](../../packages/shared/src/contracts.ts)) | `tenant_settings` | Settings → Thresholds | Always shows the current values; status `defaults` or `customised` |
| **f Invite team** | optional | role `analyst` preselected **[UI suggestion]** | existing; step-up OTP (Part 5) | `invitations`, `email_outbox` | Team | Pending invitations are listed |
| **g First comparison** | yes (system) | — | — | `recon_summaries` (existing) | — | `waiting` (job queued or running), `failed` (latest `recon.failed` event newer than the latest summary), `done` |
| **Summary** | — | — | — | read only | Settings → "Setup summary" | — |

### 2.3 API contracts (backend)

#### `GET /api/onboarding` (changed, additive)

The existing fields `steps`, `percent`, `nextStepId`, `complete` and `marketplaces` stay **unchanged** for the current frontend. New fields:

```jsonc
{
  "checklist": [
    { "id": "store_details", "required": true, "status": "done|next|todo|waiting|failed", "doneAt": null,
      "canAct": true,                       // the caller's role may do this step
      "detail": { "enabledMarketplaces": ["talabat"] } },
    { "id": "erp_upload", "required": true, "status": "next", "doneAt": null, "canAct": true,
      "detail": { "pendingUpload": { "id": "uuid", "status": "needs_mapping", "updatedAt": "..." } } },
    { "id": "marketplace_uploads", "required": true, "status": "todo", "canAct": true,
      "detail": { "items": [ { "marketplaceId": "talabat", "status": "todo", "pendingUpload": null } ] } },
    { "id": "price_source", "required": true, "status": "todo", "canAct": true,
      "detail": { "priceSource": null } },                     // "erp_markup" | "adopt" | null
    { "id": "first_comparison", "required": true, "status": "todo", "detail": { "reason": null } },
    { "id": "thresholds", "required": false, "status": "defaults|customised" },
    { "id": "authenticator_app", "required": false, "status": "done|todo" },   // owner only
    { "id": "invite_team", "required": false, "status": "done|todo" }
  ],
  "essentials": { "complete": false, "percent": 20,
    "missing": [ { "id": "erp_upload", "message": "Upload and apply your ERP file" } ] }
}
```

- `percent` = done required items ÷ 5 × 100, rounded down.
- Visibility: owner and admin get everything. Catalogue managers get `checklist` filtered to b and c with `canAct: true`, plus `essentials`. Analysts get `essentials` only (so the UI can say "your store is being set up"). This replaces the empty response for those roles in the new fields only.
- The same fixed-size probes as today, plus: one `tenant_marketplaces` read, one newest non-terminal upload per source (index `uploads(tenant_id, source, status)` exists), one `pricing_settings` read, and one `recon.failed` audit probe (`audit_events_tenant_time_id_idx`, `LIMIT 1`, newest).

#### `PUT /api/settings/marketplaces` (new)

- Permission `marketplaces.edit` (owner, admin; already defined). Trusted Origin and CSRF as usual.
- Body: `{ "enabled": ["talabat","snoonu"], "expectedRevision": "<settings revision>" }`, strict Zod, `min(1)`.
- Effect: upsert all four `tenant_marketplaces` rows (`enabled` true/false), `settings.touch()`, audit `marketplaces.changed {from,to}`, recon enqueued after commit when the set changed.
- Errors: 400 `VALIDATION` (empty set), 409 stale revision.
- `GET /api/settings/marketplaces` changes: return **all four** with the real `enabled` value (the schema enum `[true]` is widened to boolean). **This is a contract change; the frontend must read `enabled`.**

#### `PUT /api/pricing/price-source` (new)

- Permission `pricing.edit` **and** role owner or admin (D7; others get 403). Step-up in the 30-minute work window once Part 5 lands (store-wide price change).
- Body (strict, discriminated):
  - `{ "source": "erp_markup", "rule": { "mode": "percent", "value": 15 }, "rounding": "0.25" }`, or
  - `{ "source": "adopt", "sourceMarketplaceId": "talabat", "mode": "fixed", "onlyWithoutRule": true, "previewToken": "<from adopt/preview>" }`
- `erp_markup`: writes `pricing_settings.default_rule_mode/value/rounding` through the existing `PricingService.writeSettings`, sets `price_source*`, and enqueues recon.
- `adopt`: runs the existing adoption apply in the same transaction (60 s limit), then sets `price_source*`. The `previewToken` (a hash of the preview's input and counts) ensures the user saw the preview. **[new; the existing adopt/apply has no token]**
- Response: `{ priceSource, confirmedAt, adopted?: {...existing apply result} }`.
- The existing `/api/pricing/adopt/*` and `PUT /api/settings` stay unchanged. They **do not** set `price_source`, except that the plan proposes `adopt/apply` also sets it when it is still null (decision D5).

#### `GET /api/onboarding/summary` (new)

- Permission `recon.view`.
- Response: `{ products: { loaded, active, blocked }, marketplaces: [ { marketplaceId, enabled, lastUploadAt, listed, matched, notListed, missingFromErp, priceMismatches, stockMismatches } ], problems: { uploadErrorsLatest, stockConflicts, adoptionConflicts: null|n } }`.
- Sources: product counts (`count(*)` by tenant, using the existing product indexes; **[guess: acceptable at 50,000 rows, measure]**), `recon_summaries` (existing counts), `uploads.summary` of the newest applied upload per source, and `CatalogueStockRepository.conflictCount()`.

#### CLI changes ([infra/provision-store.ts](../../infra/provision-store.ts))

- `npm run provision:store -- --name ... --slug ... --owner-email ... [--hostname ...] [--marketplaces talabat,snoonu]`
- `npm run provision:store -- resend-owner-invitation --slug ...`: allowed only while the store has **no active owner**. It rotates the token of the newest pending owner invitation (or creates one if all expired or were revoked), queues the email, and writes audit `invitation.resent` with requestId `operations`. Output: `{tenantId, invitationId, expiresAt}`. Never prints the token.
- The output adds `warning` when `TENANT_ID` is set and differs from the new tenant (dev).

### 2.4 Draft migration (text only, not created)

```sql
-- 2026112xxxxx_onboarding_price_source
ALTER TABLE "pricing_settings"
  ADD COLUMN "price_source" TEXT NULL,                        -- 'erp_markup' | 'adopt'
  ADD COLUMN "price_source_marketplace_id" TEXT NULL REFERENCES "marketplaces"("id"),
  ADD COLUMN "price_source_confirmed_at" TIMESTAMPTZ NULL,
  ADD CONSTRAINT "pricing_settings_price_source_check"
    CHECK ("price_source" IS NULL OR "price_source" IN ('erp_markup','adopt')),
  ADD CONSTRAINT "pricing_settings_price_source_mp_check"
    CHECK (("price_source" = 'adopt') = ("price_source_marketplace_id" IS NOT NULL) OR "price_source" IS NULL);

-- Backfill for existing stores (decision D6): treat stores that already work as confirmed.
UPDATE "pricing_settings" ps SET "price_source" = 'erp_markup', "price_source_confirmed_at" = ps."updated_at"
WHERE EXISTS (SELECT 1 FROM "recon_summaries" r WHERE r."tenant_id" = ps."tenant_id" AND r."has_data" AND r."listed" > 0);
-- (adopt-derived backfill: stores with a pricing.prices_adopted audit event get 'adopt'; one-time scan in the migration only)
```

No table for onboarding progress. `tenant_marketplaces` already exists. `pricing_settings` rows must exist for every tenant: provisioning creates one (new), and the migration inserts the missing rows with `INSERT ... SELECT id FROM tenants WHERE NOT EXISTS (...)`.

---

## Part 3: Answers to the specific questions

**Where should onboarding progress be stored?** Derive it, as ADR 015 does today. Every step has real evidence (switch rows, applied uploads, recon summaries, invitations, MFA) **except the price-source choice**, which is a decision with no data trace when the defaults are chosen. Store only that choice, as three columns on `pricing_settings`, because it is a pricing fact that Settings shows later anyway, not an onboarding flag. No `onboarding_state` table, no tenant JSON, and no skip or dismiss state.

**Does "Adopt current marketplace prices" fit step d?** Mostly. It is the right engine (exact verification, skips, conflicts, one transaction, one recompute). Missing:
1. There is no record that the store *chose* adoption (fixed by `price_source`).
2. The source marketplace must be chosen. With two marketplaces whose prices differ, adoption from one shows mismatches on the other (G13; the conflicts are only counted).
3. Products added later get the default rule, not an adopted one. The Dashboard/Review needs a "N products have no adopted price, adopt now" hint that re-runs with `onlyWithoutRule=true`.
4. Apply has no binding to the preview the user saw (`previewToken`).
5. Products with offers are skipped (`has_offer`/`offer_active`), which is correct but must be explained in the step.
6. It needs step c done first; the wizard must disable "adopt" until a marketplace file is applied.

**How are marketplaces enabled per store, and what happens with only one?** Today: an explicit `tenant_marketplaces.enabled` row wins; without a row, a marketplace counts as enabled once it has an applied upload ([recon/compute.ts:22-35](../../packages/core/src/recon/compute.ts)). There is no write API (B3). With one marketplace, recon, summary, Review and bulk offers all iterate over `enabledMarketplaceIds()` ([pricing.data.ts:81-84](../../apps/api/src/pricing/pricing.data.ts)), so the Dashboard shows one marketplace and Review offers one. "Copy from marketplace" requires another enabled marketplace and returns 400 (`… is not enabled`, [marketplace-values.service.ts:266](../../apps/api/src/marketplace-values/marketplace-values.service.ts)), so the UI must hide it when only one is enabled *(frontend to confirm)*. The single-marketplace path is tested ([recon.integration.test.ts:337](../../apps/api/src/__tests__/recon.integration.test.ts) disables one).

**What must change so a second store works locally without editing code?**
1. Apply `TENANT_ID` **only in production**: `db.resolve(host, config.NODE_ENV === 'production' ? config.TENANT_ID : undefined)`. Alternatively, ignore it in dev with a startup warning. Remove `TENANT_ID` from `.env.example` and add a comment.
2. Add `APP_ORIGIN=http://localhost:3000` to `.env.example` and document that the hostname is replaced by the request host (B14).
3. Align one dev default store name: the seed, the `APP_ORIGIN` default and the dev scripts' `qorloop-demo`. Give the scripts a `-Store` parameter.
4. Run `provision:store --slug second ...` and open `second.localhost:3000`. The invitation arrives in Mailpit.
5. Frontend: the API base must follow `window.location.hostname` and Vite must allow `*.localhost` *(frontend to confirm)*.

**What does an owner see on returning after closing the browser halfway?** With the Part 5 sessions, the browser keeps the session for 7 days idle (20 days maximum), so they land straight back. If the session expired, they sign in with the password only: the device is trusted, so no OTP. On sign-in, the frontend calls `GET /api/onboarding`, and `essentials.missing[0]` plus `checklist[*].detail.pendingUpload` show the exact resume point ("Your ERP file is waiting for column mapping, continue"). Uploads in `uploading` with an expired URL show "upload again", with discard. An adoption interrupted mid-request either committed or did not (one transaction); the step reads `price_source_confirmed_at`.

**Roles during onboarding**

| Step | Owner | Admin | Catalogue manager | Analyst | Permission (existing unless noted) |
| --- | --- | --- | --- | --- | --- |
| a name | ✓ | ✓ | — | — | `settings.edit` |
| a marketplaces | ✓ | ✓ | — | — | `marketplaces.edit` (now used) |
| b, c uploads | ✓ | ✓ | ✓ | — | `uploads.upload/map/apply` |
| d price source | ✓ | ✓ | — (D7: owner and admin only) | — | `pricing.edit` + an owner/admin role check in the endpoint + step-up (30-minute work window) |
| e thresholds | ✓ | ✓ | — | — | `settings.edit` |
| f invite | ✓ (any role) | ✓ (not owner) | — | — | `team.invite` + step-up |
| authenticator app | ✓ | ✓ | ✓ | ✓ | own account |
| summary | ✓ | ✓ | ✓ | ✓ | `recon.view` |

**Test data and tests per step**

| Step | Test data | Tests |
| --- | --- | --- |
| 0 CLI | two slugs, the same slug with a different host, an expired owner invitation | core: input validation. Integration (PGlite): idempotent rerun; `resend-owner-invitation` refused once an owner is active; it rotates the token, the old token fails, and the outbox holds one new mail; `--marketplaces` writes four rows |
| dev resolution | two tenants, TENANT_ID set to one | integration: in `NODE_ENV=test`/development both resolve; production config still pins (unit test with `buildApp` using `NODE_ENV=production`, which needs Redis, so test `resolve` arguments instead) |
| a | — | integration: PUT marketplaces (empty set 400, stale revision 409, audit, recon enqueued only on change, analyst 403, catalogue manager 403); GET returns disabled ones |
| b, c | existing fixtures in `packages/core/src/__tests__/fixtures/marketplace-files.ts` | integration: a pending upload appears in `detail.pendingUpload`; an upload to a disabled source is refused once switch rows exist; legacy stores without rows are unaffected |
| d | 3 products: listed, unlisted, with offer | integration: erp_markup sets the columns and recomputes; adopt binds `previewToken` (a mismatch gives 409); no step-up gives 403 `STEP_UP_REQUIRED` (once steps 13–25 land); a catalogue manager and an analyst get 403 (D7) |
| e | — | existing settings tests plus the `defaults/customised` status |
| g | recon failure via the inline queue throwing | integration: `waiting` → `failed` with reason → `done` |
| summary | 2 marketplaces, mismatches, a stock conflict | integration: counts equal the `recon_summaries` numbers; tenant isolation |
| roles | four role fixtures (harness `member(role)` exists) | integration: the visibility matrix above |

---

## Part 5: Authentication redesign

Decisions already made by the owner (not reopened): (1) the OTP is sent by email; (2) sessions have a 20-day hard limit and a 7-day idle timeout; (3) sessions are bound to a device, and a new device needs an OTP; (4) a fresh OTP before sensitive actions; (5) the authenticator app is an optional stronger factor for owners.

### 5.1 Email OTP login on a new device

```
POST /api/auth/login {email,password}
 ├─ invalid → 401 generic (unchanged), audit auth.login_failed
 ├─ device cookie valid for this user → full session (no OTP), audit auth.login_succeeded {newDevice:false}
 └─ otherwise → create login challenge, send OTP (or ask for TOTP if enrolled)
      200 { state: "otp_required" | "totp_required", challengeExpiresAt, resendAvailableAt, maskedEmail: "o***@e***.test" }
      Set-Cookie qorloop.challenge (httpOnly, strict, 10 min) – opaque challenge token
POST /api/auth/otp/verify {code}            (challenge cookie, trusted Origin; no CSRF: no session yet)
 ├─ ok → full session + device cookie, audit auth.otp_verified, auth.new_device
 └─ wrong → 401 { code: "OTP_INVALID", attemptsLeft } ; at 0 → challenge dead, 401 OTP_LOCKED
POST /api/auth/otp/resend                   (challenge cookie) → 200 { resendAvailableAt } or 429 OTP_SEND_LIMIT
```

| Rule | Value (recommended) |
| --- | --- |
| Code | 6 digits, `crypto.randomInt(0, 1_000_000)`, zero-padded |
| Expiry | **10 minutes** from send. A resend issues a **new** code and invalidates the previous one |
| Single use | `consumed_at` set in the same transaction as the session is created, under the tenant row lock (`Database.run`) |
| Attempts | **5 per challenge**, then the challenge is dead (a new login is needed) |
| Sends | 1 initial + **2 resends** per challenge, **60 s** between sends; **5 sends per user per hour**; **30 per store per hour**; plus the existing IP rate limit (20/min on auth POSTs) |
| Storage | `code_hash = HMAC-SHA256(key = HKDF(AUTH_SECRET, "otp"), challengeId ‖ code)`. A plain SHA-256 of a 6-digit code is reversible from a database dump in milliseconds |
| Never logged | The code exists only in memory, in the HMAC, and in the **sealed** outbox body (already encrypted with Iron, [auth.service.ts:131-133](../../apps/api/src/auth/auth.service.ts)). The dedupe key is `otp:<challengeId>:<sendNo>`, never the code. Audit details never contain the code. Errors are generic. The Pino request serializer already logs only method, path and host ([app.ts:125](../../apps/api/src/app.ts)) |
| Same answer for unknown emails | Wrong password and unknown user both return 401 before any challenge, so no OTP is ever sent to an unverified address |
| TOTP users | If `mfa_secret` is set, the challenge asks for **TOTP** (stronger). Email OTP is **not** offered as a fallback (no downgrade); recovery codes still work |

### 5.2 Device sessions

- **Device cookie** `__Host-qorloop.device` (prod) or `qorloop.device` (dev): httpOnly, Secure (prod), `SameSite=Strict`, path `/`, `Max-Age` = device trust period (D10, recommended **90 days**). The value is a 32-byte opaque token; the DB stores `sha256(token)` in `trusted_devices.token_hash`. One device row per (user, browser).
- **Session record**: the existing `sessions` table plus `device_id`, `absolute_expires_at` (= created + 20 d), `step_up_at`, `revoked_at`, `revoke_reason`, `user_agent` (truncated to 200 characters), `ip_prefix` (decision D11).
- **Enforcement** in `checkSession` ([auth.service.ts:40-57](../../apps/api/src/auth/auth.service.ts)):
  1. The session exists and is not revoked.
  2. `now < absolute_expires_at` (20 days, never extended).
  3. `now < last_seen_at + 7 days`.
  4. The request's device cookie hashes to `session.device.token_hash`, and the device is not revoked. **A session cookie without its device cookie is refused.**
  5. The membership is active (existing).
  6. CSRF on mutations (existing).
- **Renewal**: `last_seen_at` is updated at most once per **5 minutes** (fixes B11). The session never extends past the 20-day limit. After 20 days the user signs in again with the password on the trusted device: no OTP while device trust lasts.
- **End**: logout sets `revoked_at` (keep the row for the sessions screen, with a nightly purge of rows older than 30 days **[new worker job]**). Expiry is passive. Cookies are cleared on logout.

### 5.3 Sensitive actions (fresh OTP)

Owner decision (D13/D14 as changed): **two windows**, both measured from the last successful step-up of that one session (`sessions.step_up_at`):

- **Security window: 10 minutes.** Team invite, resend and remove, role change, owner email, password, security settings, revoke all.
- **Work window: 30 minutes.** Bulk price changes, adoption, price source, generated-file downloads. One step-up covers a normal work session.
- **Single use** (the step-up is consumed by the action, inside the 10-minute window): owner-email change and store-wide revoke.

A step-up made for either kind opens both windows. A security action 12 minutes after a step-up asks again; a download at the same moment does not.

| Action | Endpoint(s) | Window | Notes |
| --- | --- | --- | --- |
| Role change | `PATCH /api/team/members/:id/role` | security 10 min | |
| Invite user, resend invitation | `POST /api/team/invitations`, `POST /api/team/invitations/:id/resend` | security 10 min | Revoking an invitation does **not** need it (it lowers risk) |
| Remove user | `DELETE /api/team/members/:id` | security 10 min | |
| Change owner email | **new** `POST /api/account/email` (verify the new address by link) | security, **single use** | |
| Password change (new, B12) | `POST /api/account/password` | security 10 min | current password + step-up |
| Security settings | `PUT /api/settings` with `security.*`; new disable-authenticator and regenerate-recovery-codes endpoints | security 10 min | |
| Revoke all my sessions | `POST /api/account/sessions/revoke-all` | security 10 min | Revoking **one** device does not need it |
| Revoke all store sessions (owner) | `POST /api/team/sessions/revoke-all` | security, **single use** | |
| Bulk price changes | `POST /api/pricing/bulk/apply`, `/api/pricing/offers/bulk/apply`, `/api/pricing/offers/bulk-remove/apply`, `/api/marketplace-values/bulk/apply`, pricing part of `PUT /api/settings` and `PUT /api/pricing/settings` (a store-wide rule is a bulk change) | work 30 min | previews do not need it |
| Adoption | `POST /api/pricing/adopt/apply` | work 30 min | |
| Price source | `PUT /api/pricing/price-source` | work 30 min | |
| Generated file downloads | `GET /api/generated-files/:id/download` | work 30 min | every role (D14). Returns 403 `STEP_UP_REQUIRED`; the UI steps up and retries |
| Reset store data | none today (CLI script, B15) | security, single use | Any future API must use `stepUp` |

Mechanism: add `stepUp?: 'security' | 'work' | 'single'` to the `Access` policy ([security.guard.ts:10](../../apps/api/src/http/security.guard.ts)). The guard checks `session.step_up_at > now − 10 min` for `security` and `single`, and `> now − 30 min` for `work`. For `single`, the action sets `step_up_at = null` in its own transaction. The 403 body carries `{ code: "STEP_UP_REQUIRED", window: "security" | "work" }`. The `verify` response returns `{ securityValidUntil, workValidUntil }`. Step-up endpoints: `POST /api/auth/step-up/start` → `{ method: "email"|"totp", resendAvailableAt }`, and `POST /api/auth/step-up/verify {code}` → `{ validUntil }`. Both are CSRF-protected and use the same limits as login OTPs, with `purpose='step_up'`. `verify` returns `{ securityValidUntil, workValidUntil }`.

### 5.4 Sessions screen (API)

| Endpoint | Who | Effect |
| --- | --- | --- |
| `GET /api/account/sessions` | self | `[{id, current, deviceLabel (parsed UA), createdAt, lastSeenAt, expiresAt, idleExpiresAt}]` |
| `DELETE /api/account/sessions/:id` | self | revoke one session and its device trust; audit `auth.session_revoked` |
| `POST /api/account/sessions/revoke-all` | self, step-up | all except the current one (option `includeCurrent`); audit `auth.sessions_revoked_all` |
| `POST /api/team/sessions/revoke-all` | owner, step-up single use | every session and device in the store, including the caller's; audit `auth.store_sessions_revoked` |
| automatic | — | password reset or change → revoke all of that user's sessions and devices (today `deleteUserSessions`, [auth.service.ts:197](../../apps/api/src/auth/auth.service.ts)); member removal and role change (already delete sessions, [team.service.ts:42,54](../../apps/api/src/team/team.service.ts)) also revoke devices |

### 5.5 Activity events

New actions (added to the labels in [packages/core/src/activity.ts](../../packages/core/src/activity.ts) and kept by the store reset's `auth.*` rule, ADR 018): `auth.login_succeeded {newDevice}`, `auth.new_device`, `auth.otp_sent {purpose, sendNo}`, `auth.otp_failed {purpose, attemptsLeft}`, `auth.otp_locked`, `auth.otp_send_limited`, `auth.otp_verified {purpose}`, `auth.step_up_verified`, `auth.session_revoked`, `auth.sessions_revoked_all`, `auth.store_sessions_revoked`, `auth.device_revoked`, `support.owner_email_changed`. The details never include the code, the email address or tokens. The entity is the session or challenge id.

### 5.6 Failure handling and recovery

- **Email delayed**: OTP mail gets **priority** in the outbox. On commit, the API enqueues a BullMQ `deliver-now` job (the 10 s poll stays as a fallback). Retry after **20 s** instead of the 5-minute lease (B8). `discard_after = code expiry`: a stale code is never sent late. The UI shows "Code sent at hh:mm" and a resend countdown.
- **Email down**: the sends hit their limits, and the response says "We could not confirm delivery. Try again later, or ask an owner." Owners with TOTP are unaffected. Readiness (`/health/ready`) gains a degraded `mail` component from the worker's last successful send **[new]**.
- **Owner recovery**:
  1. The owner has TOTP or recovery codes: sign in with those.
  2. The mailbox works but the password is lost: the existing forgot/reset flow.
  3. The mailbox is lost or compromised: another owner (if any) changes it through Team.
  4. There is no other owner: the **operator CLI** `npm run provision:store -- recover-owner --slug --new-email`. It requires out-of-band identity verification (documented procedure, a human step). It revokes all of that owner's sessions and devices, sets the new email, queues an *activation-style* link (password set) to the **new** address and a notice to the old address, and writes audit `support.owner_email_changed {operator:true}`.
- **What support must never do**: print or know a code or link. Every CLI only queues mail. `e2e-support.ts` stays dev-only (it already refuses production). Add a refusal when `SMTP_HOST` is not local, so it cannot read a real outbox in staging. There are no master codes, no "skip OTP" flag and no impersonation.

### 5.7 Interaction with existing mechanisms

| Existing | Decision |
| --- | --- |
| Restricted sessions (10 min, assurance `enrollment`/`challenge`, [auth.service.ts:29-34](../../apps/api/src/auth/auth.service.ts)) | **Replaced** by `login_challenges` + challenge cookie (10 min). The `sessions` table then holds only real sessions, which keeps the sessions screen clean. TOTP enrollment moves to a signed-in, step-up-protected endpoint |
| `SESSION_HOURS` (default 12, max 168) | **Replaced** by `SESSION_MAX_DAYS` (default 20, max 20) |
| `SESSION_IDLE_MINUTES` (default 30) | **Replaced** by `SESSION_IDLE_DAYS` (default 7, max 7). Both are lowerable for tests or staging, never raisable above the owner's limits |
| New settings | `DEVICE_TRUST_DAYS` (90), with OTP constants in code (TTL 10 min, 5 attempts, send limits, step-up 10 min): no env override, so production cannot be weakened |
| CSRF (per session, `x-csrf-token`) | **Kept**. OTP verify/resend before a session exists is protected by the challenge cookie, SameSite=Strict and the trusted-Origin check |
| Trusted-origin check ([app.ts:150-172](../../apps/api/src/app.ts)) | **Kept**, unchanged; it applies to all new endpoints |
| `mfaRequiredForAll` | **Kept** with a new meaning: "require an authenticator app for everyone". The owner's TOTP is no longer forced (decision 5) |
| `GET /api/auth/session` states | `authenticated` plus a new `step_up_valid_until`. `mfa_*` states are removed (breaking change for the frontend, coordinated) |

### 5.8 Migration of existing owners with the authenticator

- `users.mfa_secret` is kept. Those users get a **TOTP challenge** on a new device instead of email OTP (the stronger factor stays active). Step-up also uses TOTP for them.
- On deploy every existing session is invalidated: they have no `device_id`, and the old `sessions` table semantics change. Everyone signs in once, passes their second factor, and the browser becomes trusted. Announce this beforehand.
- Owners who never enrolled (currently stuck at `mfa_setup_required`) no longer need to: email OTP applies.
- Disabling the authenticator: allowed for a user with step-up (TOTP), unless `mfaRequiredForAll` is set. Audit `auth.mfa_disabled`.

### 5.9 Local development and tests

- **Dev**: start Mailpit (`docker:up`, or the Mailpit binary in `start-qorloop.ps1`) and the worker. The OTP email appears at `http://localhost:8025`. `scripts/e2e-support.ts token --kind otp --slug ... --email ...` reads the newest OTP from the sealed outbox, the same way it reads invitations ([e2e-support.ts:26-34](../../scripts/e2e-support.ts)).
- **Tests**: the harness already unseals outbox mail with the test `AUTH_SECRET` ([harness.ts:44](../../apps/api/src/__tests__/harness.ts)). Add `otpFor(store, email)` and `loginWithOtp(store, email)`. Inject a clock (`now()` provider) for the expiry, idle and 20-day tests. **No test-only bypass, fixed code or env flag** exists in production code paths.

### 5.10 Threat model

| Threat | What the design does | What remains risky |
| --- | --- | --- |
| Stolen laptop (browser profile intact) | The session lasts at most 20 days and 7 idle. The owner revokes the device from another device, or revokes all store sessions. Sensitive actions need a fresh OTP, which goes to email the thief may also have open on the laptop | A logged-in mail client on the same laptop defeats the step-up. The OS disk lock is the user's responsibility. Recommend TOTP on a phone for owners |
| Stolen session cookie alone (XSS-free leak: logs, proxy) | Refused without the matching device cookie. Both are httpOnly and `__Host-` | Malware that copies the whole cookie jar gets both. No IP or UA pinning (it breaks mobile users) |
| Compromised mailbox | Email OTP alone is not enough: the password is still required. Owners with TOTP are not affected. New-device and OTP events are visible in Activity | Mailbox plus a reused password = full account takeover for users without TOTP. Password reset by email also goes to that mailbox. This is the main residual risk; mitigate with a TOTP recommendation and a forced TOTP option (`mfaRequiredForAll`) |
| OTP brute force | 5 attempts per code, 3 codes per challenge, 5 sends per hour per user, an IP rate limit and the password first. An online guess succeeds with probability ≈ 15/10⁶ per hour per account | Distributed guessing over many accounts. The store-level send limit and the alert on `auth.otp_locked` bursts help **[the alert is new and needs monitoring]** |
| Email interception in transit | TLS is required for SMTP in production (`requireTLS`, [worker main.ts:24](../../apps/worker/src/main.ts)). The code expires after 10 min and is single use | Recipient-side MTA hops are not under our control (opportunistic TLS). MTA-STS on the sending domain is recommended |
| Shared computers | The sign-in page offers "This is a shared computer" → no device trust (session cookie only, 12-hour cap, no device cookie, so an OTP is needed every time) **[proposal, decision D12]** | Users who forget to tick it. Logout clears both cookies |
| Database dump | OTP HMAC with a server key, tokens hashed, MFA secret sealed (existing) | `AUTH_SECRET` compromise breaks all of these together (existing risk) |

### 5.11 Production email requirements

What the backend supports today **[verified, [worker main.ts:22-26](../../apps/worker/src/main.ts), [config.ts:17-21](../../packages/shared/src/config.ts)]**:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` (auth only when `SMTP_USER` is set), `MAIL_FROM`.
- TLS: implicit TLS when the port is 465; `requireTLS` (STARTTLS mandatory) in production on other ports. Nodemailer verifies certificates by default.

Missing:
1. Production validation: refuse `SMTP_HOST=localhost`, refuse a missing `SMTP_USER`/`SMTP_PASSWORD`, and refuse a `MAIL_FROM` default domain unless it was set explicitly.
2. An explicit `SMTP_SECURE` override (some providers use 2465 or 587 differently).
3. `transport.verify()` at worker start and a mail readiness signal.
4. A Message-ID domain derived from `MAIL_FROM` (B9).
5. `MAIL_FROM_NAME`.
6. Priority and expiry for OTP mail (B8).
7. A visible dead-letter status (an audit `mail.undeliverable` without the address).
8. `.env.example` lacks `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` and `APP_ORIGIN`.

DNS and provider work, outside the code: a provider with SMTP credentials (ADR 006: Resend or Postmark), SPF include, DKIM keys, and a DMARC policy (`p=quarantine`, then `reject`) on the sending domain, with bounce handling at the provider.

### 5.12 Draft migration (text only)

```sql
-- 2026112yyyyy_device_sessions_email_otp
CREATE TABLE "trusted_devices" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL REFERENCES "tenants"("id"),
  "user_id" UUID NOT NULL, "token_hash" TEXT NOT NULL UNIQUE,
  "label" TEXT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ NULL, "revoke_reason" TEXT NULL,
  FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","id"));
CREATE INDEX "trusted_devices_tenant_user_idx" ON "trusted_devices"("tenant_id","user_id");

CREATE TABLE "login_challenges" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL REFERENCES "tenants"("id"),
  "user_id" UUID NOT NULL, "purpose" TEXT NOT NULL CHECK ("purpose" IN ('login','step_up')),
  "method" TEXT NOT NULL CHECK ("method" IN ('email','totp')),
  "challenge_hash" TEXT NOT NULL UNIQUE,          -- sha256 of the challenge cookie (login) / session id (step_up)
  "session_id" UUID NULL,                         -- step_up only
  "code_hash" TEXT NULL,                          -- HMAC; null for totp
  "attempts" INT NOT NULL DEFAULT 0, "sends" INT NOT NULL DEFAULT 0,
  "last_sent_at" TIMESTAMPTZ NULL, "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","id"));
CREATE INDEX "login_challenges_tenant_user_created_idx" ON "login_challenges"("tenant_id","user_id","created_at" DESC);

ALTER TABLE "sessions"
  ADD COLUMN "device_id" UUID NULL REFERENCES "trusted_devices"("id"),   -- null = shared-computer session
  ADD COLUMN "absolute_expires_at" TIMESTAMPTZ NULL,
  ADD COLUMN "step_up_at" TIMESTAMPTZ NULL,
  ADD COLUMN "revoked_at" TIMESTAMPTZ NULL, ADD COLUMN "revoke_reason" TEXT NULL,
  ADD COLUMN "user_agent" VARCHAR(200) NULL;
-- Existing sessions are invalidated on deploy (decision D9):
DELETE FROM "sessions";
-- 'assurance' becomes always 'full'; drop it in a later migration once the code no longer reads it.

ALTER TABLE "email_outbox"
  ADD COLUMN "priority" SMALLINT NOT NULL DEFAULT 0,       -- 1 = OTP
  ADD COLUMN "discard_after" TIMESTAMPTZ NULL,
  ADD COLUMN "failed_at" TIMESTAMPTZ NULL;
CREATE INDEX "email_outbox_due_idx" ON "email_outbox"("priority" DESC, "available_at") WHERE "delivered_at" IS NULL;
```

The new tables need ADR 018's KEEP list updated (`trusted_devices` and `login_challenges` kept on reset), or the reset completeness test fails, which is intended. The RLS `tenant_isolation` policy is added like the other tables (inert, G27).

### 5.13 Tests per rule

| Rule | Test (integration on PGlite unless noted) |
| --- | --- |
| OTP format, HMAC, constant-time compare | core unit |
| 10-minute expiry | clock +10 min → 401 `OTP_EXPIRED` |
| Single use | verify twice → the second gives 401; concurrent double verify → exactly one session (two parallel requests, tenant lock) |
| 5 attempts | the 6th try, even with the right code → `OTP_LOCKED` |
| Send limits | 3rd resend → 429; the 60 s cooldown; the 6th send in an hour across challenges → 429; store limit |
| Code never leaked | capture the Pino stream (the harness `logStream` option exists, [app.ts:88](../../apps/api/src/app.ts)) and assert the code is absent from the logs, audit `details` and every response body |
| Unknown email | no outbox row, same 401 |
| Trusted device skips OTP; a new device needs it | two cookie jars |
| Session without device cookie | 401 |
| 20-day hard limit despite activity | clock jumps of 6 days, touching each time → refused at day 20 |
| 7-day idle | clock +7 d → `SESSION_EXPIRED` |
| Touch throttle | two requests within 5 min → one UPDATE (spy on the repository) |
| Step-up | every endpoint in 5.3 returns 403 `STEP_UP_REQUIRED` without it. Security endpoints succeed at 9 min 59 s and fail at 10 min + 1 s; work endpoints succeed at 29 min 59 s and fail at 30 min + 1 s; a security action at minute 12 is refused while a download at minute 12 succeeds; single-use endpoints fail on a second call. A table-driven test iterates the route list taken from the controller metadata so that no new sensitive route is missed |
| Sessions screen | list, revoke one, revoke all except current, owner store-wide revoke; an analyst cannot call the store-wide revoke |
| Revocation on password reset, member removal and role change | the old cookies return 401 |
| TOTP users | get `totp_required`, not email; email OTP refused for them |
| Outbox priority and discard | an expired OTP mail is never sent (worker unit with a fake transport) |
| Production config | `loadConfig` rejects localhost SMTP and a missing SMTP credential when `NODE_ENV=production` |
| Reset completeness | the existing ADR 018 test passes with the new tables in KEEP |

---

## Decisions for the owner

**Owner's answers (20 November 2026):** D1–D12, D15, D16 and D17 approved as recommended. D7: owner and admin only (role table fixed). D13/D14 changed: a 10-minute security window and a 30-minute work window, as described in 5.3; owner-email change and store-wide revoke stay single use. Steps 1–12 approved to start; steps 13–25 wait for the frontend contract.

| # | Decision | Recommendation | Reason |
| --- | --- | --- | --- |
| D1 | What "two-step verification" means in onboarding step 2 now that the authenticator is optional | Email OTP counts. The authenticator app is an optional checklist item, recommended for owners | Follows Part 5 decision 5 and removes the current forced-enrollment wall |
| D2 | Gate the Dashboard in the API too, or only in the UI? | UI only. The API returns `essentials` | An API gate would break existing stores and many tests, and gains no security |
| D3 | Must every enabled marketplace have a file, or at least one? | Every enabled one; disable those not used | Keeps Review and Dashboard honest. The proposed flow says "each" |
| D4 | Block uploads to a disabled marketplace? | Yes, once the store has switch rows; legacy stores keep implicit enabling | Prevents B4 without breaking old stores |
| D5 | Should the old `adopt/apply` also set `price_source` when it is null? | Yes | Stores that adopt from the Pricing screen should not be asked again |
| D6 | Backfill for existing stores | Mark the price source as confirmed (`erp_markup`, or `adopt` if a `pricing.prices_adopted` event exists) when the store already has matched recon data | Existing owners should not see an onboarding wall after deploy |
| D7 | May a catalogue manager choose the price source? | **Decided:** no, owner and admin only (a role check inside the endpoint) | A store-wide decision; catalogue managers can still adjust prices afterwards |
| D8 | TENANT_ID in dev | Ignore it outside production | Makes multi-store local work with no code edits; production keeps the pin |
| D9 | Invalidate all sessions on the auth deploy | Yes, announced | Old sessions have no device binding |
| D10 | Device trust period | 90 days absolute, renewed by each OTP | Balances "no OTP at every 20-day re-login" against bounded trust |
| D11 | Store an IP prefix on sessions for the sessions screen | Store only the user agent label, no IP | Less personal data; the label is enough to recognise a device |
| D12 | "Shared computer" option | Yes: no device trust and a 12 h cap | Covers the shared-PC threat cheaply |
| D13 | Step-up window | **Decided (changed):** 10 min for security actions, 30 min for daily work actions; single use for owner-email change and store-wide revoke | Security actions stay short; daily work isn't interrupted every 10 minutes |
| D14 | Should generated-file downloads need step-up for analysts too? | **Decided (changed):** yes, every role, in the 30-minute work window | The files contain the full price list; the longer window keeps daily downloads usable |
| D15 | Outbox speed for OTP | Immediate BullMQ trigger + 20 s retry + discard after expiry | Needed for usable OTP (B8) |
| D16 | Owner recovery without a second owner | The operator CLI `recover-owner` after out-of-band identity checks | The only path without a backdoor code |
| D17 | Keep the existing `steps` field of `GET /api/onboarding` | Keep until the frontend switches to `checklist`, then remove in one commit | Avoids a lock-step deploy |

---

## Implementation status (branch `feature/onboarding-redesign`)

Steps 1–12 are built and tested. Steps 13–25 wait for the owner to confirm the frontend contract. Changes from the plan:

- **Step 3:** creating the `pricing_settings` row at provisioning was dropped. Existing tests insert that row themselves after provisioning, and every pricing write already upserts. The migration therefore does not insert missing rows either, except for backfilled stores.
- **Steps 2–3 and 8–9** were each committed together, because they share one service and one endpoint.
- **Marketplace changes** are audited as `settings.changed` with `field: 'marketplaces'`, not `marketplaces.changed`. This keeps them in Activity's Team & security group and in the store reset's kept events.
- **The price-source CHECK** uses `CASE`. The drafted `OR` form passes when `price_source` is NULL; the test caught it.
- **The price source** has its own `GET /api/pricing/price-source` and is not part of the settings view, so the settings revision behaves as before.
- **Owner question raised by the build:** should the store reset (ADR 018) clear `price_source*`, now that it keeps the choice while deleting the adopted rules? Recommendation: yes. See [ADR 020](../decisions/020-onboarding-checklist.md).

## Implementation steps (dependency order, one commit each)

**A. Foundations (no behaviour change for production)**
1. `fix(dev): TENANT_ID applies only in production` + `.env.example` (remove TENANT_ID, add APP_ORIGIN and SMTP keys). Tests: two tenants resolve in test mode; a unit test that `resolve` receives the pin in production.
2. `fix(provision): resend-owner-invitation subcommand` (B2). Tests: refused with an active owner; the token rotates; one outbox row.
3. `feat(provision): --marketplaces option; create pricing_settings row`. Tests: four switch rows; idempotent rerun.
4. `chore(dev): one default dev store; -Store parameter in scripts/dev/*.ps1`. Test: manual run of `onboarding-check.ps1` against two stores.

**B. Onboarding**
5. `feat(db): migration pricing_settings.price_source*` + backfill (D6) + missing rows. Tests: migration applies on PGlite; backfill cases.
6. `feat(api): PUT /api/settings/marketplaces; GET returns disabled` (B3). Tests from Part 3 (a).
7. `feat(api): refuse uploads to a disabled marketplace when switches exist` (D4). Tests: legacy store unaffected.
8. `feat(api): PUT /api/pricing/price-source (erp_markup)`. Tests: columns, recompute, permissions (D7).
9. `feat(api): price-source adopt with previewToken; adopt/apply sets price_source when null` (D5). Tests: token mismatch 409, conflicts returned.
10. `feat(onboarding): checklist + essentials + pendingUpload + first_comparison status`, additive (D17); ordered probes (B6). Tests: core pure function for every combination; integration for role visibility, resume, and failed recon.
11. `feat(api): GET /api/onboarding/summary`. Tests: counts equal the summaries; isolation.
12. `docs: ADR 020 onboarding v2; onboarding-api.md; OpenAPI`.

**C. Authentication** (after the frontend agrees on the contract; each commit keeps the old login working until step 17)
13. `feat(db): migration trusted_devices, login_challenges, sessions columns, outbox priority` (no `DELETE FROM sessions` yet) + ADR 018 KEEP list. Tests: the reset completeness test.
14. `feat(core): OTP generation, HMAC, limits as pure functions`. Unit tests.
15. `feat(worker): outbox priority, immediate trigger, discard_after, 20 s OTP retry, Message-ID from MAIL_FROM, transport.verify` (B8, B9). Tests: worker unit tests with a fake transport.
16. `feat(config): production SMTP validation; SESSION_MAX_DAYS/IDLE_DAYS/DEVICE_TRUST_DAYS`. Tests: `config.test.ts`.
17. `feat(auth): login challenge + email OTP + device cookie; TOTP challenge for enrolled users; replace restricted sessions` + migration step `DELETE FROM sessions` (D9). Tests: 5.13 login rows.
18. `feat(auth): device-bound checkSession, 20 d/7 d limits, touch throttle` (B11). Tests: 5.13 session rows.
19. `feat(auth): step-up endpoints + Access.stepUp ('security' 10 min | 'work' 30 min | 'single'); apply to the 5.3 routes`. Tests: the table-driven route test with both windows.
20. `feat(account): sessions list/revoke/revoke-all; owner store-wide revoke; revoke devices on reset, removal and role change`. Tests.
21. `feat(account): password change; owner email change with verification` (B12). Tests.
22. `feat(auth): authenticator optional; mfaRequiredForAll new meaning; disable TOTP`. Tests: migration of enrolled owners.
23. `feat(activity): labels for the new auth events`. Tests: `activity.test.ts`.
24. `feat(provision): recover-owner subcommand; e2e-support refuses non-local SMTP; token --kind otp`. Tests.
25. `docs: ADR 021 email OTP and device sessions; supersede the ADR 003 text; update open-gaps`.

---

## Risks and what could break existing stores

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Making TENANT_ID dev-only | A developer machine pointing at a shared database could reach other stores **[guess: no shared DBs today]** | Production is unchanged; startup log lists the resolvable hosts in dev |
| Explicit marketplace switches | A store whose owner saves step a without a marketplace that has data hides that marketplace in recon, Review and generated files | Data is kept, re-enabling restores it; the confirmation dialog shows "this marketplace has N listings" |
| Upload refusal for disabled marketplaces | Breaks a workflow of uploading before enabling | Only once switch rows exist; clear 400 message |
| `GET /api/settings/marketplaces` now returns disabled items | A frontend that assumes all are enabled shows extra marketplaces | Coordinate; the field already exists |
| Backfill D6 is wrong for a store | It skips or forces step d wrongly | Owner-visible in Settings; can be reconfirmed |
| Auth deploy logs everyone out (D9) | Support load | Announce; deploy off-hours |
| Email outage = no new-device logins | Users locked out of new browsers | Trusted devices keep working; TOTP owners unaffected; mail readiness alert |
| Step-up on downloads and bulk pricing | Slower daily work; scripts in `scripts/dev/*.ps1` (bulk-price-check etc.) stop working without OTP | Update the scripts to read the OTP from Mailpit or the outbox in dev; the 30-minute work window covers a normal work session |
| Removing the `mfa_*` session states | The frontend state machine breaks | Ship behind the coordinated contract (commit 17), with the frontend in the same release |
| New tables not in the ADR 018 lists | The reset script refuses to run | Intended guard; commit 13 updates the lists |
| Restricted-session removal touches every login test | Large test churn in `auth-team`, `session-errors` and the harness | Change the harness helpers first (commit 17) so other suites change only via the helpers |
