# Reconciliation worker (R1)

Date: 2026-10-31

## Context

Business rules 5.3 (ERP availability) and 5.4 (status per product x marketplace) must be stored as recon rows and
per-marketplace summaries that the dashboard (R2) and the reports (R3) both read, for both comparison references
(the resolved Marketplace price, and the ERP price). The rows and summaries must follow every change that can move a
price or availability, at 50,000 products x 4 marketplaces.

## Decisions

- **Rules are pure functions** in `packages/core/src/recon/` (`reconcile`, `erpAvailable`, `computeReconRows`,
  `diffReconRows`). Prices are compared in integer fils. The Marketplace price comes from the P1 pricing engine,
  per marketplace, so a per-marketplace rule is honoured.
- **Migration 202610310001_recon_reference.** `recon_rows.status` is the status against the MARKETPLACE reference;
  `status_vs_erp` the status against the ERP reference. `recon_summaries` holds one row per tenant x marketplace x
  reference with stock, price, total (= stock + price), listed, notListed, noData, missingFromErp, newCount,
  lastUploadAt, stale and computedAt.
- **Which marketplaces.** A `tenant_marketplaces` row decides (enabled or not). Without a row, a marketplace with an
  applied upload counts as enabled (no code creates these rows yet, and the existing demo tenant has none). An enabled
  marketplace without an applied upload gets `no_data` rows, not zeros. Unmatched listings get no row.
- **One run per tenant, coalesced.** Queue `recon`, job `recompute-recon`, BullMQ deduplication id `recon-{tenantId}`
  with `keepLastIfActive` and a 2 s delay: a burst of triggers runs once, and triggers during a run give exactly one
  follow-up run (a fixed job id would drop that follow-up and keep stale results). Triggers, all after commit:
  upload apply, every pricing change, product status, category and activation changes, `POST /api/recon/recompute`.
- **One transaction, without the tenant row lock.** `Database.runSnapshot` runs the whole recompute in one
  REPEATABLE READ transaction serialized per tenant by an advisory lock. The tenant row lock (ADR 007) serializes
  auth-sensitive writes; the recompute only writes recon tables, so holding that lock for a 200,000-row write would
  only make requests and applies wait. Readers see the previous results until the run commits.
- **Write only the difference.** The stored rows are read as one packed string of signatures (`reconSignature`, built
  identically in SQL and in core), diffed in memory, and only new, changed and no-longer-qualifying rows are written
  (`INSERT/UPDATE/DELETE ... FROM unnest(...)`, one bind parameter per column, 10,000 rows per statement). An unchanged
  run writes nothing; `last_updated` is the time a row's result last changed.
- **Summaries are counted by the database from the stored rows** in the same transaction, so a summary can never
  disagree with the rows. `stale` is stored, and re-judged on read from the stored `last_upload_at` and the current
  `staleHours`, so it turns true without a run.
- **Failure** rolls the transaction back (previous results stay), records `recon.failed` with the apply worker's safe
  summary (phase, error type, codes, message cut before any quoted value) and rethrows for BullMQ to retry.

## Measurements (50,000 products x 4 marketplaces, local PostgreSQL 18 on a laptop)

| Run | Rows written | Time |
|---|---|---|
| First run | 200,000 inserted | 44-57 s |
| Nothing changed | 0 | 6-7 s |
| 1% of products and listings changed | ~700 updated | 6-8 s |
| Default rule changed (every price moves) | 73,500 updated | 18-19 s |

A request that takes the tenant row lock during the first run waits 12-31 ms. Summary endpoint ~30 ms, rows endpoint
150-300 ms. The long runs are bound by this server's index maintenance: a plain `INSERT ... SELECT` of 200,000
recon rows takes 17.8 s in psql, and a price-only `UPDATE` of all of them 11.5 s.

## Consequences

- A store's first recompute and a default-rule change are the slow cases. They hold no lock other requests need.
  Possible follow-up migration: `fillfactor` below 100 on `recon_rows` (HOT updates for price-only changes) and
  dropping one of the two status indexes, after the R2/R3 query shapes are known.
- An enqueue that fails after a committed change (Redis down) is logged, not retried; the next trigger or a manual
  recompute repairs it.
