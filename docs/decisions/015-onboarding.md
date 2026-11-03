# ADR 015: Derived onboarding progress without storage changes

Date: 3 November 2026. Status: approved schema-free scope.

The owner's decision supersedes the eight-step proposal in the Step 0 inspection. Add only `GET /api/onboarding`. No migration, `Tenant.onboarding_state`, skip/dismiss endpoints, new permissions, category step, profile-review step or new settings/pricing audit writes.

## Authentication and visibility

The endpoint requires an existing fully authenticated session and `settings.view`. Tenant resolution remains the exact request hostname with the configured tenant pin. Owners and Admins receive the full wizard. Catalogue Managers and Analysts receive `{ steps: [], percent: 0, nextStepId: null, complete: false, marketplaces: [] }`. The empty role response makes no assertion about tenant completion; the frontend hides the wizard when the list is empty.

Owners must enroll MFA before accessing business APIs. A partial Owner session receives 403 `MFA_SETUP_REQUIRED` or `MFA_REQUIRED`. A first fully authenticated Owner therefore already has security done. Integration tests use an Admin observer fixture to inspect a new tenant before Owner enrollment and then exercise the real Owner enrollment endpoints; the MFA guard is preserved.

## Completion and ordering

Only these four required steps count, at 25 percent each:

1. `owner_mfa`: at least one active Owner membership belongs to a user with enrolled MFA. The Admin's own MFA does not satisfy this condition. Multiple Owners are supported; this is not an assertion that every Owner has enrolled.
2. `erp_upload`: an ERP Upload has status applied and a non-null applied timestamp.
3. `marketplace_upload`: at least one Talabat, Snoonu, Rafeeq or Keeta Upload has status applied and a non-null applied timestamp. The response also lists applied evidence for every marketplace in canonical order. This is upload evidence, not the current marketplace-switch value; an explicit disabled switch still wins for reconciliation elsewhere.
4. `first_comparison`: a retained ReconSummary has `hasData = true`, `listed > 0` and non-null `computedAt`. This proves a computed comparison with matched marketplace data exists. A page view, empty recomputation, unmatched upload or queued job alone does not satisfy it. It does not prove a human opened Dashboard.

The first unfinished required step has status next, other unfinished steps todo, and evidence-backed steps done even when earlier steps are unfinished. There is at most one next step. When all four are done, `percent = 100`, `complete = true`, `nextStepId = null`, regardless of optional progress. The frontend may hide the wizard automatically at that point. There is no persisted completed flag. Evidence can disappear or change, so completion is not irrevocable.

Three optional steps follow, contribute nothing to percent and never become next:

- `invite_team`: an invitation with non-null `invitedBy` exists. The operations-created initial Owner invitation has a null inviter and is excluded. An invitation still proves it was sent after acceptance, expiry or revocation; this step does not promise a current pending invite or active teammate.
- `pricing_settings`: the current global PricingSettings differs from application defaults (rule same/value 0, exact rounding, marketplace comparison reference, per-marketplace disabled), or a tenant-level marketplace price rule exists (the default has none). Product-specific and category rules do not count. A read, unchanged default save or default-valued settings row does not count. Restoring all settings/rules to defaults returns this step to todo; no historical audit scan or new audit write is introduced.
- `generated_file`: a successful GeneratedFile record exists, regardless of kind/scope/expiry. This follows the owner's approved existing-successful-file condition. Preview, enqueue and failed generation do not create this evidence. Generation remains optional even before mismatches exist, and optional completion never gates hiding the wizard.

No status skipped is returned because there is no skip storage or operation.

## Queries, timestamps and safety

`OnboardingRepository.facts` uses fixed-size `findFirst`/existence-style probes, with tenant scope on every query and on the Owner/user relation. Upload probes use the existing tenant/source/status index and return at most one timestamp per source. Memberships use the existing tenant/role/active index. Other probes read tenant-indexed settings, rules, invitations, summaries and files. Summary cardinality is marketplace/reference pairs. No products, listings, recon rows or audit-history scans/counts are used; only scalar evidence is selected. The MFA query selects the matching membership ID and never selects the MFA ciphertext.

Non-null `doneAt` values are UTC ISO timestamps from an existing matching record: appliedAt, computedAt, invitation.createdAt, pricing/rule.updatedAt, generatedAt. They identify retained evidence, not necessarily the first-ever completion event. Existence probes do not sort large histories to manufacture first timestamps. The combined marketplace step uses the earliest of the returned per-marketplace witness timestamps, not a guarantee about the first upload ever. MFA doneAt is null even when done because no dedicated enrollment timestamp exists; do not guess from User.updatedAt. Unfinished steps always have null doneAt.

The normal authentication layer touches session activity as for other business GET endpoints. Onboarding itself does not write business data, audit events or review markers. Response fields are allowlisted; no names/emails, tokens, hashes, secrets, raw settings, storage keys or upload contents are returned. Full response and frontend action keys are documented in [onboarding-api.md](../onboarding-api.md) and exported in OpenAPI from the actual controller.

## Verification

Pure core tests cover empty facts, every combination of required evidence, out-of-order completion, independent optional progress and marketplace ordering. Embedded PGlite integration tests cover fresh progress, real MFA and upload transitions, comparison computation, pricing changes/default restoration, invitation history, successful file generation, role visibility, tenant/session isolation, timestamp serialization and secret-free response fields. Harness teardown remains app close, inline recon drain, fixture close.

Before each test command, require Windows `Memory/Available MBytes >= 1500`. Run packages and apps separately, then full npm test. Stop at the first memory crash. Record actual validation results separately; this ADR does not imply every planned check ran.
