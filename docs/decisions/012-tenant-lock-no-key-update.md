# Tenant row lock FOR NO KEY UPDATE, and statistics after bulk writes (G12)

Date: 2026-11-02

## Context

`Database.run` opens every tenant-scoped write (every authenticated request, since `checkSession` touches the session,
and the bulk jobs that must stay one transaction: upload apply, price adoption) with
`SELECT id FROM tenants WHERE id = $1 AND status = 'active' FOR UPDATE`. That lock is what serialises invitation
consumption, TOTP and recovery-code replay, role changes and removals against the last-Owner check, and upload status
transitions, across API replicas and the worker (ADR 007).

Every `INSERT` into a table with a foreign key to `tenants` (and every update of such a key column) runs PostgreSQL's
referential check, `SELECT 1 FROM ONLY tenants WHERE id = $1 FOR KEY SHARE`, and keeps that lock until commit. The recon
recompute (`Database.runSnapshot`, ADR 009) deliberately takes no tenant lock, but its first run inserts 200,000
`recon_rows` in one transaction of 45-60 s. `FOR UPDATE` is the only row lock that conflicts with `FOR KEY SHARE`, so
once the recompute's first insert ran, every request on that store waited for the whole recompute: G12, caught only by
`recon.performance` on real PostgreSQL (the embedded database is one backend, nothing overlaps there).

## Decision

`Database.run` locks the tenant row `FOR NO KEY UPDATE`. Nothing else in the lock changes (same row, same `status`
filter, same transaction and timeouts).

Row-lock conflicts in PostgreSQL (`x` = conflicts):

| Requested \ held | FOR KEY SHARE | FOR SHARE | FOR NO KEY UPDATE | FOR UPDATE |
|---|---|---|---|---|
| FOR KEY SHARE (foreign-key check) | | | | x |
| FOR SHARE | | | x | x |
| **FOR NO KEY UPDATE (Database.run)** | | x | **x** | x |
| FOR UPDATE | x | x | x | x |

An `UPDATE` of the row that changes no key column takes `FOR NO KEY UPDATE`; a `DELETE`, or an `UPDATE` of a column in a
unique index (`id`, `slug`, `hostname`), takes `FOR UPDATE`.

### Why it is sufficient

- **Every guarantee rests on one property: two `Database.run` transactions on the same tenant never overlap.**
  `FOR NO KEY UPDATE` conflicts with itself, so that property is unchanged, for every caller of `Database.run`
  (API requests on any replica, apply, price adoption, generated-file commit, mail claim). Each protected operation is
  a read-check-write inside one `Database.run`: the second transaction acquires the lock only after the first commits,
  and under READ COMMITTED its next statements see that commit. So:
  - an invitation token is consumed once (the second acceptance reads `acceptedAt` set),
  - a TOTP step is used once (the second verification reads the new `lastTotpStep`) and a recovery code once (also a
    conditional `UPDATE ... WHERE used_at IS NULL`),
  - a role change or removal reads the Owner count and the actor's membership after the other change committed, so the
    last active Owner cannot be removed by two Owners at once (the loser's session is gone: 401),
  - an upload is applied once (the second worker finds it no longer `applying` and skips).
- **What it still conflicts with:** another `Database.run` (`FOR NO KEY UPDATE`), `FOR SHARE`, `FOR UPDATE`, any `UPDATE`
  of the tenant row (suspending a store waits for running requests, and the next `Database.run` re-checks
  `status = 'active'` on the updated row) and any `DELETE` of it.
- **What it no longer conflicts with:** `FOR KEY SHARE`, that is, other transactions inserting rows that reference the
  tenant. The only writers outside `Database.run` are the recompute (recon tables only, serialised per tenant by its own
  advisory lock) and nothing else (`readSnapshot` is read-only). No guarantee depended on making those inserts wait.
  Rows that request transactions insert under the lock (sessions, audit events, invitations) still take the lock first.

### Apply and recompute can now overlap

Before, a recompute that had started inserting held up an apply's tenant lock until it committed (and vice versa an
apply held up the recompute's first insert). Now they overlap. That is safe:

- The recompute reads one REPEATABLE READ snapshot; an apply that commits during it is picked up by the follow-up run
  the apply enqueues after commit (`keepLastIfActive`, ADR 009).
- No deadlock: `recon_rows` references only `tenants` and `products`. The recompute's `FOR KEY SHARE` locks on product
  rows conflict only with a delete or a key change of a product; apply never deletes products (it flags
  `in_latest_erp_file`) and updates them by barcode without changing `id` or `normalized_barcode`. Listings, which
  apply deletes, are not referenced by recon rows.

## Statistics after bulk writes

`Database.analyze(tables)` runs `ANALYZE (SKIP_LOCKED) ...` on an allow-list (`products`, `listings`, `recon_rows`) after
the commit, outside every transaction: an ERP apply analyses `products`, a marketplace apply `listings` (before the recon
is enqueued), and a recompute that wrote rows `recon_rows` (an unchanged run skips it). `SKIP_LOCKED` returns at once if
autovacuum is on the table; a failure is logged and never fails the job; `analyzeMs` is in the jobs' log lines.
Statistics are per table (all tenants), which is why the call is on `Database` and takes no tenant ID.

- PostgreSQL allows `ANALYZE` only to the table owner (or a role with `MAINTAIN`, PostgreSQL 17+); otherwise it skips the
  table with a WARNING, not an error. The production role must own the tables (it does when it runs the migrations).
- Measured cost and effect: see the measurements below. With G1's set-based preview query the preview is not measurably
  faster with fresh statistics at 25,000 rows; the ANALYZE is kept as a cheap safeguard because the earlier per-row
  query shape took 230 s on missing statistics right after a bulk load.

## Tests

`apps/api/src/__tests__/tenant-lock.integration.test.ts` (real PostgreSQL only). The races hold the tenant lock from a
separate connection, start the competing calls on a Database with a pool of 6, and release the lock only once all of
them wait on it in `pg_stat_activity`, so they leave the lock together.

| Case | FOR NO KEY UPDATE | old FOR UPDATE | FOR SHARE (no mutual exclusion) |
|---|---|---|---|
| Database.run vs Database.run serialised | pass | pass | **fail** |
| FK inserts (products, listings, recon_rows, audit_events) pass a held Database.run lock | pass | **fail** | pass |
| Database.run does not wait for uncommitted FK inserts | pass | **fail** | pass |
| Conflict table above (NO KEY UPDATE, UPDATE, SHARE, row UPDATE, DELETE blocked; KEY SHARE not) | pass | **fail** (KEY SHARE blocked) | **fail** |
| One invitation accepted twice at once: one 200, one 400, one user/membership/event | pass | pass | **fail** |
| One TOTP code on two challenge sessions at once: one 200, one 401 | pass | pass | pass |
| One recovery code on two challenge sessions at once: one 200, one 401 | pass | pass | pass |
| Last two Owners: demote vs remove at once leaves one Owner (200 + 401) | pass | pass | **fail** |
| Last two Owners: remove each other at once leaves one Owner (200 + 401) | pass | pass | **fail** |
| Two workers apply one upload at once: applied + skipped, products once, one event | pass | pass | **fail** |

The two columns on the right were run once by temporarily editing the lock clause, to show which tests detect which
mistake. The TOTP and recovery cases also pass without mutual exclusion in that run, so they guard the outcome but do
not by themselves prove the lock (recovery codes are protected by their conditional UPDATE as well).

`recon.performance` now takes the probe lock through a real `Database.run` on a second pool (the old probe issued its
own `FOR UPDATE`, which would still conflict with the inserts whatever `Database.run` does) at 3, 6 and 12 s into the
first full recompute, and requires each probe to land while the recompute runs and at least two after its inserts began.

## Measurements (local PostgreSQL 18, laptop, 2026-11-02)

recon.performance, 50,000 products x 4 marketplaces:

| | |
|---|---|
| First run (200,000 inserted) | 44.1 s; inserts from 2.5 s to 43.4 s |
| Request through Database.run at 3.5 / 6.6 / 12.0 s into it | 210 / 5 / 7 ms (budget 1 s) |
| Unchanged / 1% changed / default rule changed | 6.3 s / 5.5 s (664 updated) / 19.0 s (73,500 updated) |

Preview right after the real pipeline (`generated-files-after-apply.performance`, 25,000-row ERP and Talabat files, no
manual ANALYZE): ANALYZE took 267 ms (products), 504 ms (listings) and 185 ms (recon_rows); the first preview took
2.5 s with them and 2.6 s with the ANALYZE disabled (one comparison run). The time is reading the original file. The
test requires `last_analyze` to be set on all three tables and a preview under 8 s.
