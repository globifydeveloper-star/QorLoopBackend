# BACKEND contracts: settings, activity/history, session status and readiness

Implementation date: 3 November 2026. See ADR 014 for decisions and historical limits. Validation and commit evidence are recorded separately in `docs/reports/2026-11-03-s1-s2-s3-implementation.md`.

Use `http://qorloop-demo.localhost:4000` for the demo API and `http://qorloop-demo.localhost:3000` for its Origin. HOST resolves the tenant. Do not send a tenant ID. Mutations require trusted Origin and `X-CSRF-Token` with the session cookie. Do not paste passwords, authenticator codes, cookies or tokens into chat.

## S1: settings

`GET /api/settings`: 200, requires `settings.view`.

`PUT /api/settings`: 200, requires `settings.edit` (Owner/Admin), Origin and CSRF. Returns the same shape. MFA-policy changes are Owner only.

```ts
type Rule = { mode: "same" }
  | { mode: "percent" | "amount" | "fixed"; value: number };
type Rounding = "exact" | "0.05" | "0.25" | "0.50";
type MarketplaceId = "talabat" | "snoonu" | "rafeeq" | "keeta";
type MarketplaceRule = Rule & { marketplaceId: MarketplaceId; rounding: Rounding };

type SettingsResponse = {
  data: {
    profile: { name: string };
    timeZone: "Asia/Qatar";              // read-only
    currency: "QAR";                    // read-only
    thresholds: {
      priceTolerance: number;           // QAR, 0..100000, <=3 decimal places
      stockThreshold: number;           // integer 0..2147483647
      staleHours: number;               // integer 1..8760; existing default 12
    };
    security: { mfaRequiredForAll: boolean; analystCanExport: boolean };
    pricing: {
      defaultRule: Rule;
      rounding: Rounding;
      perMarketplaceEnabled: boolean;
      compareReferenceDefault: "marketplace" | "erp";
      marketplaceRules: MarketplaceRule[];
      order: string[];
      updatedAt: string | null;         // UTC ISO
    };
    revision: string;                   // opaque 64-character lowercase hex
  };
};

type UpdateSettings = {
  expectedRevision: string;             // REQUIRED: last GET/PUT revision
  profile?: { name: string };           // trimmed 1..100 characters
  thresholds?: {
    priceTolerance?: number;
    stockThreshold?: number;
    staleHours?: number;
  };
  security?: {
    mfaRequiredForAll?: boolean;         // Owner only, even if value is unchanged
    analystCanExport?: boolean;
  };
  pricing?: {
    defaultRule?: Rule;
    rounding?: Rounding;
    perMarketplaceEnabled?: boolean;
    compareReferenceDefault?: "marketplace" | "erp";
    marketplaceRules?: MarketplaceRule[];
  };
};
```

At least one change object is required; thresholds/security/pricing objects must not be empty. All objects reject unknown fields. There is no currency/time-zone setter or unstored profile field. A stale revision returns 409 `CONFLICT`; reload, show the current settings and ask the user to retry. A no-op leaves the revision unchanged and writes no audit event.

Pricing validation preserves the existing engine contracts: percent -90..1000; amount -100000..100000; fixed >0 and <1000000000; values at most three decimal places. `same` has no value property. When supplied, `marketplaceRules` is the complete set: omitted marketplaces lose their rule. Maximum four, with no duplicate marketplace IDs.

The existing `GET/PUT /api/pricing/settings` remain supported with their existing `pricing.view/edit` permissions and payloads. They do not require the new general settings revision. A change through those endpoints invalidates a previously read general settings revision.

### Enabled marketplaces

`GET /api/settings/marketplaces`: 200, requires `settings.view`.

```ts
{
  data: {
    items: Array<{                        // all four, canonical order (changed 20 Nov 2026: disabled ones are listed too)
      marketplaceId: MarketplaceId;
      enabled: boolean;                   // the effective switch
      explicit: boolean;                  // the store has a switch row for it
      hasData: boolean;
      lastUploadAt: string | null;       // latest APPLIED marketplace upload, UTC ISO
      ageHours: number | null;          // fractional, nonnegative
    }>;
    revision: string;                     // the general settings revision
  };
}
```

Explicit switches win; without a switch row an applied upload enables the marketplace (stores from before the switch existed). An explicitly enabled marketplace with no upload has `hasData: false` and null timestamp/age.

`PUT /api/settings/marketplaces`: requires `marketplaces.edit` (Owner, Admin), CSRF and a trusted Origin. Body `{ expectedRevision, enabled: MarketplaceId[] }` (at least one, each once; strict). Writes explicit switches for all four marketplaces (the listed ones on). Returns the GET shape with the new revision. 400 on validation, 409 on a stale revision. Data of a switched-off marketplace is kept and returns when it is switched on again. One `settings.changed` event (`field: 'marketplaces'`, old and new lists) and a recon recompute (`settings.marketplaces`) only when the effective set changed. Afterwards `POST /api/uploads` refuses a file for a switched-off marketplace (400, `details[0].path = 'source'`).

## S2: activity and product history

- `GET /api/activity`: requires `activity.view`.
- `GET /api/products/:id/history`: requires `activity.view` and `products.view`. A missing/other-tenant product returns 404.

Query parameters:

| Parameter | Accepted value |
| --- | --- |
| `productId` | UUID. On history, if supplied it must equal the path ID. |
| `eventType` | `price`, `stock_uploads`, `catalogue`, `team_security` |
| `actorId` | User UUID or literal `system` |
| `from` | Inclusive ISO timestamp with offset |
| `to` | Inclusive ISO timestamp with offset; must be on/after `from` |
| `limit` | Integer 1..200; default 50 |
| `cursor` | Opaque `nextCursor` from the preceding page |

Unknown parameters are rejected with 400. Continue with the same filters when following a cursor. Ordering is newest first, then descending ID for ties. Cursors preserve microseconds; do not construct or edit them in the frontend.

```ts
type SafeValue = string | number | boolean | null
  | { [field: string]: string | number | boolean | null };
type ActivityItem = {
  id: string;
  time: string;                         // UTC ISO; may have 6 fractional digits
  actor: {
    id: string | null;
    name: string;                       // "system" or "Former team member" when applicable
    email: string | null;
  };
  type: string;                         // stored known action, or "unknown"
  group: "price" | "stock_uploads" | "catalogue" | "team_security";
  summary: string;                      // safe server-built English
  beforeAfter: Array<{ field: string; before: SafeValue; after: SafeValue }>;
  scope: "product" | "tenant";
  productId: string | null;
  uploadId: string | null;
};
type ActivityResponse = {
  data: {
    items: ActivityItem[];
    nextCursor: string | null;
  };
};
type ProductHistoryResponse = {
  data: ActivityResponse["data"] & { coverageNotice: string };
};
```

Product history includes direct product events, matching bulk operation payloads, and clearly labelled tenant-wide upload summaries. `GET /api/activity?productId=...` returns only events linked to that product; it does not mix in tenant-wide uploads. In history, upload aggregates have `scope: "tenant"` and `productId: null` and must be presented as store-wide context. They do not prove that product changed.

Display `coverageNotice`. Earlier marketplace price/availability differences and some historical new rule adoptions were not recorded per product. No per-product upload expansion or historical backfill is added. No audit retention policy exists yet.

The API never returns raw `details`. Bulk history includes only the selected product's compact rule/price differences. Cost before/after values require `pricing.edit`. Missing before/after information stays absent; the frontend must not manufacture it.

## S3: session status

*(Changed 20 November 2026 by [ADR 021](decisions/021-email-otp-device-sessions.md): email codes, device-bound sessions and step-up. The restricted MFA sessions and the `mfa_*` states are gone.)*

`GET /api/auth/session` is tenant-bound. A valid session cookie (with its device cookie) is inspected without updating `lastSeenAt` or extending expiry.

```ts
{
  data: {
    state: "authenticated" | "authenticator_setup_required";
    expiresAt: string;                  // the hard limit: 20 days from sign-in (12 hours on a shared computer)
    idleExpiresAt: string;              // earlier of 7 days idle and the hard limit
    nextAction: "none" | "setup_authenticator";
    securityValidUntil: string | null;  // step-up: security actions allowed until (10 minutes)
    workValidUntil: string | null;      // step-up: daily work actions allowed until (30 minutes)
  };
}
```

| HTTP/code or state | Frontend action |
| --- | --- |
| 200 `authenticated` | Continue; use `/api/auth/me` for profile/permissions. |
| 200 `authenticator_setup_required` | The store requires an authenticator app the user has not set up: show `POST /api/account/authenticator/setup` and `/verify`. |
| 401 `UNAUTHENTICATED` | Show sign-in. Cookie is missing, invalid/revoked, or membership is inactive. |
| 401 `SESSION_EXPIRED` | Show sign-in. The session passed 7 days idle or its 20-day limit, or its device cookie is missing or no longer trusted. |
| 403 `AUTHENTICATOR_SETUP_REQUIRED` on a protected API | Show authenticator setup. |
| 403 `STEP_UP_REQUIRED` (`meta.window`: `security` or `work`) | Ask for a fresh code (`POST /api/auth/step-up/start`, then `/verify`) and retry the action. |
| 403 `CSRF_REQUIRED` | Refresh session/CSRF state; do not blindly replay a mutation. |
| 403 `FORBIDDEN` | Permission or Origin failure. |
| 500 `INTERNAL_ERROR` | Show a server-error state and Request ID; preserve the distinction from sign-out. |

Sign-in: `POST /api/auth/login` answers either a session (this user's trusted device) or `{ state: "otp_required" | "totp_required", challengeExpiresAt, resendAvailableAt, maskedEmail }` with a 10-minute challenge cookie. Then `POST /api/auth/otp/verify { code }` (or `/otp/recovery { code }` with a recovery code for authenticator users). Codes: 401 `OTP_INVALID` (`meta.attemptsLeft`), `OTP_LOCKED` (after five wrong codes), `CHALLENGE_EXPIRED` (enter the password again); 429 `OTP_SEND_LIMIT` (`meta.retryAfterSeconds`). `POST /api/auth/otp/resend` sends a new code. These forms return expected 401s and must not trigger a global session-expired flow. See ADR 021 for the account endpoints.

## Error envelope and Request ID

```ts
{
  error: {
    code: string;
    message: string;
    details?: Array<{ path?: string; message: string }>;
  };
  requestId: string;
}
```

Response header `X-Request-ID` matches the error-body ID and structured server logs. It is exposed to trusted browser origins. Unexpected 500s contain only `Internal server error`, with no raw exception or stack. Native 413 errors use `PAYLOAD_TOO_LARGE`; 415 uses `UNSUPPORTED_MEDIA_TYPE`; 429 uses `RATE_LIMITED`; 503 uses `UNAVAILABLE`.

## Readiness

`GET /health/ready` is public and does not need tenant/authentication. Only database unavailability returns 503. Redis or storage failures remain 200 degraded.

200:

```ts
{
  data: {
    status: "ok" | "degraded";
    components: {
      database: "ok";
      redis: "ok" | "degraded";
      storage: "ok" | "degraded";
    };
  };
}
```

503:

```json
{
  "error": {
    "code": "UNAVAILABLE",
    "message": "Service unavailable",
    "details": [
      { "path": "database", "message": "unavailable" },
      { "path": "redis", "message": "ok" },
      { "path": "storage", "message": "degraded" }
    ]
  },
  "requestId": "<generated UUID>"
}
```

The example component values depend on actual checks. No hostnames, credentials or raw error text are returned. Readiness does not establish worker liveness.

## Demo checks: exact PowerShell commands

The owner first takes a database backup and applies the approved indexes-only migration. Exact migration file:

`packages/db/prisma/migrations/202611030001_activity_indexes/migration.sql`

```powershell
Set-Location 'D:\Qorloop-backend'
npm.cmd run db:migrate
```

Expected: the approved activity-index migration is applied successfully. The assistant does not run this command on the demo database.

Restart the API with the new code in its existing development window. Ensure the worker is running. Then, in a separate PowerShell window:

```powershell
Set-Location 'D:\Qorloop-backend'
curl.exe --silent --show-error 'http://qorloop-demo.localhost:4000/health/ready'
```

Expected: a `data` object with separate database/Redis/storage statuses. Redis/storage issues may produce 200 degraded. Database failure produces 503 with a standard error and safe component details.

Read-only authenticated checks:

```powershell
Set-Location 'D:\Qorloop-backend'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\dev\settings-activity-check.ps1'
```

Enter email, password and authenticator code only into that local terminal. Password/code prompts are hidden. The script does not print cookies, CSRF tokens or authentication responses. It uses `-WebSession`, not a manually constructed Cookie header.

Expected: `Session: authenticated; next action: none`, settings with fixed Asia/Qatar and QAR, enabled marketplaces with upload ages, latest activity, price activity, and one product's history including `coverageNotice`. It logs its separate check session out afterwards.

To inspect a specific product, substitute its UUID:

```powershell
Set-Location 'D:\Qorloop-backend'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\dev\settings-activity-check.ps1' -ProductId '<product UUID>'
```

Optional reversible settings check:

```powershell
Set-Location 'D:\Qorloop-backend'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\dev\settings-activity-check.ps1' -ReversibleEdit
```

Expected: `Reversible edit verified: staleHours N -> N+1` (or 8760 -> 8759), then `Restored staleHours: N`. Only stale hours changes, and the `finally` block restores it with the returned revision. A concurrent edit causes a conflict rather than overwriting someone else's settings; the script then reports that the original value needs attention. Two settings audit events remain as the truthful record of the edit/revert.

These checks do not upload files, change prices, apply stock updates or create price rules. They have not been run against the demo tenant until the implementation report explicitly records that verification.
