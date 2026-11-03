# Onboarding API and read-only demo checks

`GET /api/onboarding` is the only onboarding endpoint. It requires a fully authenticated session and `settings.view`. Owner/Admin receive the full list; other roles receive the exact empty result below. No request body or tenant ID is used. There are no skip/dismiss endpoints. See [ADR 015](decisions/015-onboarding.md) for evidence semantics.

## Committed response shape

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

Other roles receive HTTP 200:

```json
{"data":{"steps":[],"percent":0,"nextStepId":null,"complete":false,"marketplaces":[]}}
```

Use list emptiness to hide the wizard for those roles. Use complete to hide it for Owner/Admin. MFA date being null does not mean enrollment is incomplete: use status.

Standard errors use `{ error: { code, message, details? }, requestId }`: missing/expired/cross-tenant session 401; partial MFA session 403; unknown hostname 404. `settings.view` is checked in the route guard and service. It is currently granted to all four supported roles, with full-list visibility restricted separately.

## Exact PowerShell checks on the demo tenant

Prerequisite: restart the demo API with this code through its existing development workflow. No migration or seed is needed. Sign in as an existing demo Owner/Admin in the app and complete its normal MFA challenge. Keep the cookie value private; do not paste it into chat or commands/history. In browser DevTools, locate the existing `qorloop` cookie for `qorloop-demo.localhost` and enter only its value at the hidden local prompt.

```powershell
Set-Location 'D:\Qorloop-backend'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\dev\onboarding-check.ps1'
```

The script creates a local `WebRequestSession` containing that existing cookie and makes only this request:

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

A failed expectation raises an error without changing demo business data. A 401 means obtain a current authenticated cookie; a 403 means finish MFA; a 404 may mean the API has not been restarted with this code. The script does not print authentication responses, credentials, cookies or tokens, does not log in/out, and does not upload, change pricing, apply files, generate files or recompute anything. The usual server-side session-activity touch still applies. These are expected demo results, not a claim of live verification.
