# ADR 018: Reset one store's business data (developer script)

Date: 11 November 2026. Status: built; owner-approved Step 0, with no schema change or migration. Step 0 inspection and the owner's decisions: [2026-11-11-reset-store-data-step-0.md](../reports/2026-11-11-reset-store-data-step-0.md).

The scripts were **never run against the owner's database**. You run them.

## Context

You need to start a store again from an empty catalogue, without re-provisioning it. Users, MFA, settings and saved layouts must stay. The database may hold several stores, and the others must never be touched.

## Decision

Two scripts, both dry runs by default. Each prints only fixed messages and error codes: never a URL, a password, the S3 keys or a driver message.

| Script | Does |
| --- | --- |
| [scripts/dev/reset-store-data.mjs](../../scripts/dev/reset-store-data.mjs) | the database, plus the store's queued BullMQ jobs |
| [scripts/dev/reset-store-storage.mjs](../../scripts/dev/reset-store-storage.mjs) | the store's files in object storage: a separate step, with its own dry run and confirmation |

[scripts/dev/store-reset-plan.mjs](../../scripts/dev/store-reset-plan.mjs) holds the table lists, the SQL, the verification and the checks. The PGlite tests run exactly that SQL. [scripts/dev/database-url.mjs](../../scripts/dev/database-url.mjs) reads `.env` with dotenv and splits `DATABASE_URL` on the **last** `@`, as `database-url.ps1` does.

### What is kept and what is deleted

| | Tables |
| --- | --- |
| **Kept** | `tenants`, `stores`, `users` (with MFA), `memberships`, `invitations`, `sessions`, `password_resets`, `recovery_codes`, `tenant_settings`, `pricing_settings`, `email_outbox` (invitation and reset mails only), `input_templates` (saved layouts), `tenant_marketplaces`; the global tables `marketplaces` and `output_templates`, and built-in layouts |
| **Deleted** | `erp_upload_changes`, `upload_errors`, `upload_rows`, `catalogue_stock_edits`, `recon_rows`, `recon_summaries`, `listings`, `product_offers`, `product_price_rules`, `generated_files`, `notifications`, `uploads`, `products`, `category_price_rules`, `category_mappings`, `categories` |
| **Partly deleted** | `marketplace_price_rules`: per-product rows deleted, store-wide rules (`product_id IS NULL`) kept. `audit_events`: business events deleted; kept are `auth.*`, `invitation.*`, `team.*`, `store.*`, `settings.changed`, `pricing.settings_changed` and `template.updated`. Every other action is deleted, including unknown ones. |

**Completeness.** Every table with a `tenant_id` must be in exactly one of KEEP, DELETE or ASK; ASK is empty now. A test checks this against the migrated schema, and a real run also checks it against the live database and refuses on a mismatch.

**`marketplace_value_overrides`.** When `feature/marketplace-export-values` is merged (migration `202611100001_marketplace_value_overrides`), add `{ table: 'marketplace_value_overrides' }` to `DELETE_STEPS` **before `products`**: its product and user foreign keys are RESTRICT. Also add a row for it to the test's `seedStore`. Until then, the completeness test and the seed test fail, and a real run refuses.

### How the reset runs

- **No TRUNCATE.** Every statement is `DELETE ... WHERE tenant_id = $1`, with the id bound as a parameter. TRUNCATE would ignore `WHERE` and empty every store's rows (and, with CASCADE, every referencing table as well).
- **Order:** children before parents. A test derives it from `pg_constraint` and also proves that no kept table references a deleted one.
- **One transaction:**
  1. `lock_timeout 5s` and the tenant row lock `FOR NO KEY UPDATE`, the same lock `Database.run` takes, so every app write for the store waits.
  2. The recon job's advisory lock; if it is taken, the run refuses.
  3. Counts per table, the deletes, then counts again.
  4. **Before COMMIT**, a check that every DELETE table is empty for this store, every kept row count is unchanged, and every other store's row count and the global tables are unchanged. Any difference rolls everything back.
  5. One `store.data_reset` audit event (actor null, request id `operations`), with the deleted and kept counts. Activity lists it under team and security.
- **After COMMIT:** `ANALYZE (SKIP_LOCKED)` on the 18 tables that had rows deleted. Then the store's BullMQ jobs in every non-active state are removed from `upload-processing`, `upload-apply`, `recon` and `generated-files`, and the `recon-<id>` deduplication key is cleared. `email-outbox` is untouched.

### What a real run requires

A real run needs `--tenant <slug> --confirm <slug>` (the same slug twice) and refuses unless all of these hold:

- **Backup:** a `*.dump` under 30 minutes old in `D:\Qorloop-test\backups`, checked by timestamp and size only (the file is never opened). `db-backup.ps1` has a new `-Label` option for naming it.
- **API:** nothing listens on the API port (`PORT` from `.env`, default 4000), checked on 127.0.0.1 and ::1.
- **Database:** no other client session is connected to the database. The refusal lists each one's pid, application name, address and state.
- **Worker:** no BullMQ worker is connected (Redis `CLIENT LIST`), and no job of this store is active. If Redis is unreachable, the run refuses unless `--skip-redis` is given.
- **Plan:** the database matches the plan (completeness above).

The dry run prints the same checks as `[ok]`, `[refuse]` or `[skip]`, together with every count.

### Storage step

- **Scope:** lists only `tenants/<id>/uploads/` and `tenants/<id>/generated/`. Anything else under `tenants/<id>/` is reported as untouched, and another store's keys cannot match.
- **Dry run:** prints the count, the bytes and the first 50 keys, and writes the full list to `D:\Qorloop-test\backups\storage-keys-<slug>-<timestamp>.txt`.
- **Real run:** needs `--confirm <slug> --expect-count <n>` and refuses while the store still has upload or generated-file rows, or when the listing differs from `n`. It deletes in batches of 1,000, falls back to single deletes when multi-object delete is not implemented, then lists again and reports what is left.
- **Versioning:** if the bucket has versioning enabled, the script says so; deletes then only add delete markers.

### After the reset

| | Result |
| --- | --- |
| Onboarding | 25% with an MFA-enrolled Owner, next step `erp_upload`. The ERP, marketplace, comparison and generated-file steps are not done. Team invitation and pricing settings keep their state (both are kept data). |
| Templates screen | Layouts stay. `outgoing` is `not_ready` until a marketplace file is applied again. |
| Sessions | Stay valid; reload open browser tabs. |

## Commands for the owner (PowerShell, from `D:\Qorloop-backend`)

```powershell
$slug = 'qorloop-demo'   # the store's slug; the dry run prints its name and id, and a wrong slug is refused

# 1. Dry run: changes nothing. Read the counts and the checks.
node scripts/dev/reset-store-data.mjs --tenant $slug

# 2. Stop the API and the worker (Ctrl+C in their terminals); close pgAdmin, psql and Prisma Studio.
#    No output from the next line means nothing listens on port 4000 any more:
Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue

# 3. Back up the whole database (the real run must start within 30 minutes of this).
powershell -ExecutionPolicy Bypass -File scripts\dev\db-backup.ps1 -Label before-reset

# 4. Dry run again: every check should now be [ok].
node scripts/dev/reset-store-data.mjs --tenant $slug

# 5. Real run (one transaction; prints the deleted counts and the audit event id).
node scripts/dev/reset-store-data.mjs --tenant $slug --confirm $slug

# 6. Storage dry run: review the key list file it names.
node scripts/dev/reset-store-storage.mjs --tenant $slug

# 7. Storage real run, with the count from step 6. Not reversible: the backup does not contain these files.
node scripts/dev/reset-store-storage.mjs --tenant $slug --confirm $slug --expect-count <n>

# 8. Start the API and the worker again (npm run dev, npm run dev:worker); onboarding shows 25%.
```

Options:

- `--env-path <file>` for another `.env`. Not `--env-file`: Node 24 takes that flag for itself even after the script name.
- `--backup-dir <dir>` and `--api-port <n>` (reset script).
- `--keys-dir <dir>` (storage script).
- `--skip-redis` (reset script), only when Redis is deliberately not running.

Exit codes: 0 done, 2 refused (nothing changed), 1 failed.

**Undoing a committed reset.** Restore the `.dump` from step 3 (pgAdmin Restore, or `pg_restore --clean`). That restores **every** store to the backup time. Do not run step 7 until the database reset is confirmed.

## Not included

- No HTTP endpoint and no app UI: this is a developer operations script.
- No schema change, no migration, no new dependency.
- Files are not deleted by the database script.
- No retention cleanup job (G7).
- The kept `email_outbox` mails still go out when the worker starts.

## Verification

| Kind | What |
| --- | --- |
| PGlite integration tests ([store-reset.integration.test.ts](../../apps/api/src/__tests__/store-reset.integration.test.ts)) | Two stores with rows in all 30 tables that have a `tenant_id`; completeness; foreign-key order; a dry run changes no row anywhere; a mid-way failure and a failed verification roll back everything; an unplanned tenant table makes the run refuse; a real run leaves exactly the KEEP rows (row-for-row digests), writes one event and gives 25% onboarding; the second store and the global tables are identical row for row; ANALYZE; a second run deletes nothing. |
| Unit tests (fakes) | Arguments; the backup age rules; the API port probe; every refusal message (including the listed sessions); BullMQ counting and removal (only this store's, never active jobs; deduplication cleared); queue names and the recon lock key match the app; storage prefixes, batches, pagination and refusals; BEGIN/COMMIT/ROLLBACK; the last-`@` URL split; error descriptions that never repeat a message. |
| Activity | `store.data_reset` is presented under `team_security` without its details (`activity.test.ts`). |
| **Not covered** | Real Redis, a real S3/MinIO bucket and real PostgreSQL concurrency are not exercised: PGlite has one session, so the lock waits and the recon-lock refusal are not tested. |
