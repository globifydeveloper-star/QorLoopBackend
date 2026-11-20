# Onboarding API and read-only demo checks

`GET /api/onboarding` requires a fully authenticated session and `settings.view`. It returns two things:

- the **ADR 015 wizard** (`steps`, `percent`, `nextStepId`, `complete`, `marketplaces`), unchanged: Owner/Admin get the full list, other roles the empty result below. It is kept until the frontend has moved to the checklist (owner decision D17), then removed in one commit.
- the **guided checklist and the essentials gate** (`checklist`, `essentials`, added 20 November 2026, [ADR 020](decisions/020-onboarding-checklist.md)), for every role.

`GET /api/onboarding/summary` (`recon.view`) is the setup summary. No request body or tenant ID is used. There are no skip/dismiss endpoints. See [ADR 015](decisions/015-onboarding.md) and [ADR 020](decisions/020-onboarding-checklist.md) for evidence semantics.

## Checklist and essentials

```ts
type ChecklistId = 'store_details' | 'erp_upload' | 'marketplace_uploads' | 'price_source' | 'first_comparison'   // essentials, in order
  | 'thresholds' | 'authenticator_app' | 'invite_team';                                                            // optional
type PendingUpload = { id: string; status: string; updatedAt: string } | null;   // newest upload of that source when not applied
type ChecklistResponse = {
  checklist: Array<{
    id: ChecklistId;
    required: boolean;
    status: 'done' | 'next' | 'todo' | 'waiting' | 'failed'   // essentials; waiting/failed: first_comparison only
      | 'defaults' | 'customised';                           // thresholds
    doneAt: string | null;
    canAct: boolean;                                         // the caller's role may do the step; false for first_comparison
    detail: {
      enabledMarketplaces?: MarketplaceId[];                  // store_details
      pendingUpload?: PendingUpload;                         // erp_upload
      items?: Array<{ marketplaceId: MarketplaceId; status: 'done' | 'pending' | 'todo'; doneAt: string | null; pendingUpload: PendingUpload }>; // marketplace_uploads, enabled only
      priceSource?: 'erp_markup' | 'adopt' | null; marketplaceId?: string | null; canAdoptFrom?: MarketplaceId[];                         // price_source
      reason?: string | null;                                // first_comparison
      priceTolerance?: number; stockThreshold?: number; staleHours?: number;                                                            // thresholds
    };
  }>;
  essentials: { complete: boolean; percent: 0 | 20 | 40 | 60 | 80 | 100; missing: Array<{ id: ChecklistId; message: string }> };
};
```

| Item | Done when | Who may act |
|---|---|---|
| store_details | an explicit switch row is on (`PUT /api/settings/marketplaces`); a store without any switch row: a marketplace with an applied file | Owner, Admin |
| erp_upload | an ERP upload is applied | Owner, Admin, Catalogue Manager |
| marketplace_uploads | every enabled marketplace has an applied file (switch unused ones off) | Owner, Admin, Catalogue Manager |
| price_source | `pricing_settings.price_source` is set (`PUT /api/pricing/price-source`, or a whole-catalogue adoption by an Owner/Admin) | Owner, Admin |
| first_comparison | a computed comparison with matched data exists. `waiting`: ERP and a marketplace file applied, not computed yet. `failed`: a `recon.failed` event newer than the last computation | nobody (the system) |
| thresholds | optional; `defaults` or `customised` | Owner, Admin |
| authenticator_app | optional; the caller's own app (Owner only) | the user |
| invite_team | optional; an invitation sent by a user | Owner, Admin |

At most one item is `next`: the first essential that is `todo`. `essentials.complete` opens the Dashboard (the gate is in the UI, D2). Visibility: Owner all items; Admin all but `authenticator_app`; Catalogue Manager `erp_upload` and `marketplace_uploads`; Analyst none. Every role gets `essentials`.

Coming back halfway: everything is derived from stored data, so the response after a closed browser equals the one before. `pendingUpload` points at the upload to continue (mapping, review) or to replace (rejected, failed).

## Setup summary

`GET /api/onboarding/summary`, `recon.view`:

```ts
{ data: {
  reference: 'marketplace' | 'erp'; computedAt: string | null;
  products: { loaded: number; active: number; blocked: number };      // active = active and not blocked
  marketplaces: Array<{ marketplaceId; hasData; lastUploadAt; stale; compared; matched; notListed; missingFromErp; newProducts; priceMismatches; stockMismatches }>; // enabled only
  uploads: Array<{ source: 'erp' | MarketplaceId; uploadId: string | null; appliedAt: string | null; rowErrors: number }>;          // ERP + enabled
  problems: { priceMismatches; stockMismatches; notListed; missingFromErp; stockConflicts; uploadRowErrors };
} }
```

## ADR 015 wizard: committed response shape

```ts
type RequiredStepId = 'owner_mfa' | 'erp_upload' | 'marketplace_upload' | 'first_comparison';
type StepId = RequiredStepId | 'invite_team' | 'pricing_settings' | 'generated_file';
type MarketplaceId = 'talabat' | 'snoonu' | 'rafeeq' | 'keeta';
type Target = 'settings.security' | 'uploads.erp' | 'uploads.marketplace'
  | 'dashboard' | 'team.invite' | 'settings.pricing' | 'generated-files';
type OnboardingResponse = {
  data: {
    steps: Array<{
      id: StepId;
      title: string;
      description: string;          // plain English
      required: boolean;
      status: 'done' | 'next' | 'todo';
      doneAt: string | null;        // UTC ISO evidence timestamp; MFA always null
      action: { kind: 'navigate'; target: Target };
    }>;
    percent: 0 | 25 | 50 | 75 | 100;
    nextStepId: RequiredStepId | null;
    complete: boolean;              // all four required steps done for full wizard
    marketplaces: Array<{
      marketplaceId: MarketplaceId;
      applied: boolean;
      doneAt: string | null;        // matching applied upload timestamp
    }>;
  };
};
```

Action targets are stable frontend navigation keys, not HTTP endpoints or assumptions about routes in the separate frontend repository. The frontend maps them to its actual screens; `uploads.erp` preselects ERP, `uploads.marketplace` opens marketplace selection. Per-marketplace evidence tells that screen which sources already have an applied upload.

| Order | ID | Title | Required | Target |
|---|---|---|---|---|
| 1 | owner_mfa | Secure your account | true | settings.security |
| 2 | erp_upload | Upload your ERP file | true | uploads.erp |
| 3 | marketplace_upload | Upload at least one marketplace file | true | uploads.marketplace |
| 4 | first_comparison | Review the first comparison | true | dashboard |
| 5 | invite_team | Invite your team | false | team.invite |
| 6 | pricing_settings | Review pricing settings | false | settings.pricing |
| 7 | generated_file | Generate your first corrected file | false | generated-files |

All evidence absent: percent 0, nextStepId owner_mfa, complete false, first step next and every other step todo. All required evidence present: percent 100, nextStepId null, complete true, first four steps done; optional steps reflect their evidence independently. Optional steps never acquire next. There is no profile or category step. No click changes this response.

Other roles receive HTTP 200 with these wizard fields (plus `checklist` and `essentials`, above):

```json
{"data":{"steps":[],"percent":0,"nextStepId":null,"complete":false,"marketplaces":[],"checklist":[...],"essentials":{...}}}
```

Use list emptiness to hide the wizard for those roles. Use complete to hide it for Owner/Admin. MFA date being null does not mean enrollment is incomplete: use status.

Standard errors use `{ error: { code, message, details? }, requestId }`: missing/expired/cross-tenant session 401; partial MFA session 403; unknown hostname 404. `settings.view` is checked in the route guard and service. It is currently granted to all four supported roles, with full-list visibility restricted separately.

## Exact PowerShell checks on the demo tenant

Prerequisite: restart the demo API with this code through its existing development workflow. No migration or seed is needed. Use an existing demo Owner/Admin account with MFA enrollment already completed. Enter email, password and, when requested, the six-digit authenticator code into the local prompts, following the bulk-price check's login flow. Password and authenticator-code prompts are hidden; do not paste credentials into chat or commands/history.

```powershell
Set-Location 'D:\Qorloop-backend'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\dev\onboarding-check.ps1'
```

The script logs in through `POST /api/auth/login`, verifies MFA through `POST /api/auth/mfa/verify` when required, and keeps the rotated cookie in a local `WebRequestSession`. After authentication, it makes only this GET request:

```powershell
$qorloopResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
    -Uri 'http://qorloop-demo.localhost:4000/api/onboarding' `
    -WebSession $qorloopSession -Headers @{ Accept = 'application/json' }
```

For a WebSession already authenticated in the current terminal, use that request directly with its session variable, then inspect only the onboarding response:

```powershell
Set-Location 'D:\Qorloop-backend'
$qorloopProgress = ($qorloopResponse.Content | ConvertFrom-Json).data
$qorloopProgress | ConvertTo-Json -Depth 8
```

Expected first line from the script:

```text
percent=100; complete=True; nextStepId=null
```

Expected required statuses: owner_mfa done, erp_upload done, marketplace_upload done, first_comparison done. Talabat and Snoonu must each show applied true with UTC ISO doneAt values. Rafeeq/Keeta reflect actual data; no values are fabricated. Optional invite_team, pricing_settings and generated_file rows show actual done/todo states, including which work remains. Their values cannot be promised without reading the live tenant.

Expected final line:

```text
PASS: all four required steps done; Talabat and Snoonu applied. Optional rows show real remaining work.
```

A failed expectation raises an error without changing demo business data. A 401 means rerun the login; a 403 means finish MFA; a 404 may mean the API has not been restarted with this code. The script does not print authentication responses, credentials, cookies or tokens. Authentication creates its normal session/audit records; after login the script is GET-only, including no logout POST. It does not upload, change pricing, apply files, generate files or recompute anything. The usual server-side session-activity touch still applies. These are expected demo results, not a claim of live verification.
