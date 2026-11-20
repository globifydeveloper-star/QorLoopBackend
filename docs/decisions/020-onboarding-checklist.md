# ADR 020: Guided onboarding checklist, marketplace switches and price source

Date: 20 November 2026. Status: built (plan steps 1–12 of [the onboarding redesign plan](../plans/onboarding-redesign-backend.md)); owner decisions D1–D12, D15–D17 approved, D13/D14 changed (step-up windows, later steps). Extends [ADR 015](015-onboarding.md); the ADR 015 wizard fields stay until the frontend has moved over (D17).

## Context

A new store went from provisioning to "ready" through a read-only wizard with four required steps. Several things were missing:

- a way to choose the marketplaces a store uses;
- a record of how prices are set;
- a way to resend an expired Owner invitation;
- a way to reach a second local store without editing `TENANT_ID`.

## Decisions

**Store resolution (step 1).** `TENANT_ID` pins only a production instance (`tenantPin`, [security.guard.ts](../../apps/api/src/http/security.guard.ts)). Outside production every active store resolves by its exact Host. `.env.example` no longer sets a tenant id.

**Provisioning CLI (steps 2–3).** `provision:store` keeps its idempotent create, with an optional `--marketplaces a,b`: it writes explicit switches for all four, only while the store has none. `provision:store resend-owner-invitation --slug s` serves a store without an active Owner. It rotates the newest open Owner invitation (expired or not), or invites the initial Owner email again when every Owner invitation was revoked. No CLI prints a token or link. The plan's "create the pricing_settings row at provisioning" was dropped: tests insert that row themselves, and every pricing write upserts.

**Marketplace switches (steps 6–7).** `PUT /api/settings/marketplaces` (`marketplaces.edit`: Owner, Admin) writes explicit switches for all four, at least one on. `GET` now lists all four with `enabled` and `explicit`. A switched-off marketplace keeps its data and takes no new files: `POST /api/uploads` answers 400. That refusal applies only where an explicit switch row is off, so stores from before the switch existed keep implicit enabling (D4). Changes are audited as `settings.changed` with `field: 'marketplaces'`. That keeps them in Activity's Team & security group and in the store reset's kept events.

**Price source (steps 5, 8–9).** Migration `202611200001_price_source` adds `pricing_settings.price_source` (`erp_markup` | `adopt`), `price_source_marketplace_id` and `price_source_confirmed_at`. A `CASE` check keeps them consistent. An `OR` of comparisons would pass when `price_source` is NULL; the test caught that.

- **Backfill (D6).** Stores with matched comparison data are confirmed: `adopt` from their newest `pricing.prices_adopted` event, otherwise `erp_markup`.
- **`PUT /api/pricing/price-source`.** `pricing.edit` and role Owner or Admin (D7).
  - `erp_markup` writes the default rule (percent, amount or same) and rounding through the existing audited writer.
  - `adopt` applies exactly the previewed whole-catalogue adoption. `POST /api/pricing/adopt/preview` now returns `previewToken`, a hash of the store, the input and every planned rule; any change in between gives 409 and nothing is written. The source must be enabled and have an applied file.
  - Both record the choice in the same transaction and audit `pricing.price_source_set`.
- **`GET /api/pricing/price-source`.** `pricing.view`.
- **Adoption on the Pricing screen (D5).** An Owner or Admin adopting the whole catalogue with `POST /api/pricing/adopt/apply` also records `adopt` when no choice exists.

The price source is a separate endpoint and is not part of the general settings view, so the settings revision behaves as before. A price-source write still bumps `pricing_settings.updated_at`, which changes that revision.

**Checklist and essentials (step 10).** `GET /api/onboarding` adds `checklist` and `essentials`; see [onboarding-api.md](../onboarding-api.md).

- The five essentials are: store details (an explicit switch on), the ERP file, a file for every enabled marketplace (D3), the price source, and the first comparison (a system step: `waiting` or `failed`, never `next`).
- Everything is derived from stored data except the price-source choice. The newest unfinished upload per source is returned, so an owner coming back continues where they left off.
- Every role gets `essentials`; the Dashboard gate is in the UI (D2).
- The applied-upload and invitation probes are now ordered (earliest), so `doneAt` is stable (B6).
- The `recon.failed` probe runs only while no comparison exists and only after the last computation, which keeps the audit read short.

**Setup summary (step 11).** `GET /api/onboarding/summary` (`recon.view`) returns:

- products loaded, active and blocked;
- per enabled marketplace: compared, matched, not listed, missing from ERP, new, and price and stock mismatches;
- the newest applied files with their stored row errors;
- problem totals, including open stock conflicts.

It is read once when opened, never on the checklist poll.

## Consequences and open items

- **A changed contract.** `GET /api/settings/marketplaces` lists disabled marketplaces too; the frontend must read `enabled`.
- **Switching from `adopt` to `erp_markup` keeps the adopted product rules.** They outrank the default rule. Removing them is a separate bulk action, not part of this change.
- **The store reset (ADR 018) keeps `pricing_settings`**, so `price_source` survives a reset while the adopted product rules are deleted. Owner question: should the reset script clear `price_source*` so the store chooses again? Recommendation: yes; it is one `UPDATE` in the reset plan.
- **Step-up (fresh OTP) on the price source and other daily actions** comes with the authentication steps (plan steps 13–25, waiting for the frontend contract): the 30-minute work window.
