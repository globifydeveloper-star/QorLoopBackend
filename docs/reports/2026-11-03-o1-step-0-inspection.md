# O1 onboarding: Step 0 inspection

Date: 2026-11-03. Inspection only; implementation is paused for the storage decision below.

## Provisioning and first sign-in

- `infra/provision-store.ts` implements `npm run provision:store -- --name ... --slug ... --owner-email ... [--hostname ...]`. It runs existing migrations, then calls `AuthService.provision`. It is an internal command, not an HTTP endpoint. It does not provision infrastructure. It was not executed during this inspection.
- `Database.initialize` creates an active Tenant, one Store with the supplied name, and TenantSettings. Initialization is idempotent for matching configuration and rejects conflicting configuration.
- `AuthService.provision` creates the first Owner invitation with `invitedBy = null`, queues encrypted invitation email, and writes `invitation.created` and `store.provisioned`. A repeated matching request returns the existing first invitation; a different initial Owner email is rejected.
- The invitation lasts 48 hours. Acceptance through `POST /api/auth/invitations/accept` creates the user/membership and issues a partial session with `state: mfa_setup_required`. Owners must enroll through `/api/auth/mfa/setup` and `/api/auth/mfa/verify`; verification rotates the session. Later password sign-ins require an MFA challenge. Protected business endpoints reject partial sessions.
- A provisioned tenant initially has no users until invitation acceptance, no products, listings, uploads, tenant marketplace switches, reconciliation rows/summaries, generated files or pricing settings row. It has the Owner invitation, email outbox entry and audit events. Four global marketplace definitions are seeded by an existing migration; those are not tenant-enabled marketplaces.
- TenantSettings defaults: price tolerance 0, stock threshold 0, stale hours 12, MFA policy for all members false (Owners still always require MFA), Analyst export true. Pricing defaults are supplied by the application when no row exists: same as ERP, exact rounding, per-marketplace pricing false, comparison reference marketplace. Settings expose Asia/Qatar and QAR as read-only.
- `packages/db/src/seed.ts` provisions Doha Fresh Markets and an Owner invitation only; it does not load demo inventory. The documented local demo API is `http://qorloop-demo.localhost:4000`. No live demo records were inspected or changed.

## Existing facts and their limits

| Wizard fact | Existing evidence | Completion/timestamp limits |
|---|---|---|
| Store profile filled/reviewed | Tenant.name and Store.name; `settings.changed` with `details.field = profile.name` | Provisioning already fills the only profile field. Nonempty name cannot prove an Owner reviewed it. A name-change audit proves an edit; unchanged saves leave no event. Tenant.updatedAt is not a review timestamp. |
| Owner MFA enrolled | Active Owner memberships joined to tenant-scoped User.mfaSecret presence; `auth.mfa_enrolled` audit | Return only a boolean and an available enrollment timestamp, never the secret. Several Owners are supported; the policy for which Owner(s) must be enrolled must be documented. |
| Team member invited | Invitations with a non-null inviter, excluding the initial operations invitation; current memberships can corroborate accepted invitations | Initial Owner invitation must not count. Define treatment of revoked/expired invitations explicitly; invitation.createdAt is available. |
| ERP upload applied | Upload with source erp, status applied, appliedAt non-null | Uploading, processing, reviewing or failed files do not count. Existing tenant/source/status index supports existence probes. |
| Marketplace upload applied | Same Upload condition per talabat/snoonu/rafeeq/keeta | At least one satisfies the single wizard step; expose per-marketplace progress separately. Existing recon logic treats an applied upload as enabling a marketplace when no explicit switch exists; an explicit disabled switch takes precedence for recon. |
| First comparison available | ReconSummary.hasData, computedAt and actual nonempty comparison data | Empty recomputations must not count. Summary timestamps describe retained computations, not necessarily the first ever. These prove data exists, not that someone viewed Dashboard. |
| Pricing settings reviewed | Persisted PricingSettings and pricing settings/rule change audit events | Reads and unchanged saves write no review evidence. A changed pricing setting proves configuration work. Defaults, row existence alone and unrelated updatedAt values do not prove review. |
| First generated file | GeneratedFile.generatedAt, marketplaceId, kind, productCount; file.generated audit | Count successful persisted generation, not queue submission or preview. Define corrected-file eligibility using stock/price kinds with actual output; generation of new-products files alone should not silently satisfy corrected-file intent. |

All progress queries must be tenant-scoped, select only needed scalar fields and use bounded existence probes. Recon summaries are small (marketplace/reference pairs); do not load product or recon-row tables. Audit history has tenant/time and tenant/entity/time indexes, but no tenant/action index: filtering all historical events by action is not automatically cheap. A migration-free implementation must avoid an unbounded action-history scan, for example by using an indexed tenant entity for newly recorded save evidence, while returning null for unavailable historical doneAt values. Do not invent first-completion timestamps.

## Help & onboarding frontend

`apps/web/README.md` explicitly says the frontend repository is not included. Only its workspace placeholder exists. There is no Help & onboarding implementation to inspect here, so whether that external page is demo content is unverified. The registered controllers in `apps/api/src/app.ts` contain no onboarding endpoint. Search found no existing wizard, skip, dismissal or completion implementation/storage in the active workspaces.

## Storage decision (required before implementation)

- Completion can be derived from real step conditions; no completed column is necessary.
- There is no existing dedicated onboarding skip/dismiss state. The generic AuditEvent table could technically hold new event types, but making retained audit history the operational source of dismissal/skip state would be a new design with retention and lookup implications. It is not assumed to be existing onboarding storage.
- The smallest explicit storage option is one nullable JSONB column on Tenant, `onboarding_state`, with a validated shape containing `dismissedAt` and a map of optional-step IDs to skipped-at timestamps. Keep completion derived; record separate audit events transactionally. Do not store credentials or duplicate operational completion facts there. No schema file or migration has been written.
- Profile/pricing review also needs an explicit evidence definition: a validated settings save can record save evidence in existing audit storage without a schema change, including when the values are retained. Merely opening a page or clicking a generic complete button must not mark a step done. Existing historical edits can only establish the facts they actually prove.
- Alternative: approve a schema-free scope with derived progress, no skip/dismiss endpoints, optional steps excluded from percent, and conservative review evidence from validated settings saves/actual historical changes. No skipped status would be returned in that scope.

## Proposed implementation after the decision

1. Step 1 logical commit: pure core calculation; tenant-scoped repository probes; registered `GET /api/onboarding` using existing `settings.view`. Owners/Admins receive the full eight-step wizard; Catalogue Managers/Analysts receive an empty list, documented percent and null nextStepId. No category step. Existing response envelope is `{ data: ... }`. Exact endpoint contracts will be exported from implemented code, not treated as delivered by this inspection.
2. Ordered steps: profile, Owner MFA, ERP applied, any marketplace applied, comparison data, pricing saved/reviewed, team invitation (optional), corrected file (optional until eligible mismatches exist). First actionable unfinished step is next; other unfinished steps are todo. Only real conditions produce done. Optional skip/dismiss writes require the approved storage design and existing mutation/CSRF protections.
3. Step 2 logical commit only if approved: storage migration plus skip/dismiss endpoints and audit events; otherwise omit them. Audit-only operational state requires an explicit design decision rather than an implicit workaround.
4. Step 3 logical commit: pure unit tests, embedded PGlite integration coverage, ADR 015, open-gaps update and exact credential-safe PowerShell demo checks. Keep harness teardown unchanged: app close, recon.drain, fixture close.
5. Before every test run check `Available MBytes >= 1500`; run packages and apps separately, then full npm test, typecheck and lint. Stop at the first memory crash. Do not push.

## Test expectation that cannot literally hold under current auth

An authenticated Owner cannot query a protected business endpoint before enrolling MFA; `createOwner` in the harness already enrolls MFA. Therefore an actual first full Owner response cannot show all steps unfinished. Preserve the MFA gate: test all-empty facts in the pure calculator, assert partial Owner sessions receive 403, and assert MFA is done on the first fully authenticated Owner response. A pre-MFA wizard endpoint would be a deliberate exception to the existing auth invariant and is not silently introduced.

## Verification and delivery status

Inspection used source reads and searches only. No tests, migrations, provisioning commands, live demo authentication or demo writes ran. No implementation endpoints or final response shapes exist yet. Step 0 is documented for a local documentation-only commit; implementation awaits the storage/scope decision required by the task.
