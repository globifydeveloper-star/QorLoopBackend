# Reset store data: Step 0 inspection and proposal

Date: 11 November 2026. Branch: `feature/reset-store-data`, based on `main` (36b3280). It does not depend on `feature/catalogue-marketplace-columns`.
No code, no schema change, no migration. Nothing was run against any database, Redis or object store.

**Owner decisions (11 November 2026): approved as proposed.**

| # | Decision |
| --- | --- |
| A1 | (b): delete business audit events, keep the security, team and settings events, write one `store.data_reset` event |
| A2 | delete categories, category mappings and category price rules |
| A3 | keep store-wide marketplace price rules, delete per-product ones |
| A4 | keep `tenant_marketplaces` |
| A5 | delete `generated_files` rows |
| D6 | 25% with an MFA-enrolled Owner |
| D7 | refuse while other database sessions are open, and list them |
| D8 | refuse if Redis is unreachable unless `--skip-redis` |
| D9 | `-Label` on `db-backup.ps1` |
| D10 | no CI commit on this branch; the owner merges `ci/run-on-branches` into `main` |

Two additions:

- **Completeness test.** A test fails if any table with a `tenant_id` is not in exactly one of KEEP, DELETE or ASK.
- **`marketplace_value_overrides`.** This table comes from `feature/marketplace-export-values`, planned migration `202611100001_marketplace_value_overrides`; the branch so far holds only the proposed SQL. It **goes on the DELETE list when that branch is merged**. Its proposed foreign keys to products and users are RESTRICT, so it must be deleted before `products`. The completeness test fails until it is classified.

Sources: [schema.prisma](../../packages/db/prisma/schema.prisma) and all 8 migrations in [migrations/](../../packages/db/prisma/migrations), plus the code that reads and writes each table.

## 1. Every table, its foreign keys and ON DELETE rules

The database has 33 tables plus `_prisma_migrations`. Prisma and the migrations agree: no table, trigger or function exists outside Prisma.

- 30 tables carry `tenant_id`.
- 3 are global: `tenants`, `marketplaces` and `output_templates`.
- `input_templates.tenant_id` is nullable: NULL means a built-in layout (none are seeded).

Every foreign key is `ON UPDATE CASCADE`. **ON DELETE is RESTRICT everywhere** except the four marked below. No table has a trigger. The `tenant_isolation` RLS policies exist but are not enabled (ADR 008).

| Table | Foreign keys (ON DELETE) | References without a foreign key |
| --- | --- | --- |
| `tenants` | (none) | (none) |
| `users` | tenant (R) | (none) |
| `memberships` | tenant (R); (tenant, user) → users (R) | (none) |
| `invitations` | tenant (R) | `invited_by` |
| `sessions` | tenant (R); (tenant, user) → users (R) | (none) |
| `password_resets` | tenant (R); (tenant, user) → users (R) | (none) |
| `recovery_codes` | tenant (R); (tenant, user) → users (R) | (none) |
| `stores` | tenant (R) | (none) |
| `tenant_settings` | tenant (R) | (none) |
| `audit_events` | tenant (R) | `actor_id`, `entity_id` |
| `email_outbox` | tenant (R) | (dedupe key names the invitation or reset) |
| `tenant_marketplaces` | tenant (R); marketplace → marketplaces (R) | (none) |
| `categories` | tenant (R); (tenant, parent) → categories (R, self) | (none) |
| `category_mappings` | tenant (R); (tenant, category) → categories (R) | `marketplace_id` |
| `products` | tenant (R); (tenant, category) → categories (R) | `subcategory_id`, `image_key` |
| `listings` | tenant (R); (tenant, product) → products (R) | `upload_id` |
| `pricing_settings` | tenant (R) | (none) |
| `category_price_rules` | tenant (R) | **`category_id`, `subcategory_id`** |
| `product_price_rules` | tenant (R); (tenant, product) → products (R) | (none) |
| `product_offers` | tenant (R); (tenant, product) → products (R) | (none) |
| `marketplace_price_rules` | tenant (R) | **`product_id`** |
| `input_templates` | tenant (**SET NULL**) | (none) |
| `uploads` | tenant (R); (tenant, uploaded_by) → users (R) | `template_id` |
| `upload_rows` | tenant (R); (tenant, upload) → uploads (**CASCADE**) | `match_product_id` |
| `upload_errors` | tenant (R); (tenant, upload) → uploads (**CASCADE**) | (none) |
| `erp_upload_changes` | tenant (R); (tenant, upload) → uploads (**CASCADE**); (tenant, product) → products (R) | (none) |
| `catalogue_stock_edits` | tenant (R); (tenant, product) → products (R); (tenant, set_by) → users (R) | `conflict_upload_id` |
| `recon_rows` | tenant (R); (tenant, product) → products (R) | (none) |
| `recon_summaries` | tenant (R) | (none) |
| `generated_files` | tenant (R); (tenant, generated_by) → users (R) | `storage_key` |
| `notifications` | tenant (R); (tenant, user) → users (R) | (none) |
| `marketplaces` (global) | (none) | (none) |
| `output_templates` (global) | (none) | (none) |

R = RESTRICT.

Two points follow from this table:

- **No KEEP table references a DELETE table**, so the reset never meets a RESTRICT from a row it keeps. The references run the other way: `uploads`, `generated_files`, `catalogue_stock_edits` and `notifications` point at `users`.
- **`category_price_rules` and `marketplace_price_rules` have no foreign key to what they describe.** If their category or product were deleted, they would stay behind silently. They must be handled explicitly (see A2 and A3).

## 2. Proposed groups

### KEEP: the tenant row, 11 tenant tables and the global tables

| Table | Why |
| --- | --- |
| `tenants`, `stores` | the tenant and its store |
| `users`, `memberships`, `invitations` | users, roles, invitations |
| `sessions`, `password_resets` | sign-ins stay valid |
| `recovery_codes` (and `users.mfa_*`) | MFA data |
| `tenant_settings` | tenant settings |
| `pricing_settings` | pricing settings |
| `email_outbox` | holds only invitation and password-reset mails (the only two `queueMail` callers); deleting it would lose an unsent invitation |
| `input_templates` (the tenant's rows) | the saved file mapping layouts |
| `marketplaces`, `output_templates`, built-in `input_templates`, `_prisma_migrations` | global; never touched |

### DELETE: 13 tables

`erp_upload_changes`, `upload_errors`, `upload_rows`, `uploads`, `catalogue_stock_edits`, `recon_rows`, `recon_summaries`, `listings`, `product_offers`, `product_price_rules`, `generated_files` (see A5), `notifications` and `products`.

`notifications` has no writer in the current code, so it is expected to be empty. It is deleted anyway because its rows would describe deleted data.

### ASK: your decision, with my recommendation

| # | Table(s) | Options | Recommendation |
| --- | --- | --- | --- |
| A1 | `audit_events` | **(a)** delete all of the tenant's events: Activity becomes empty and the run prints its summary instead of writing an event. **(b)** delete the business events and keep the security, team and settings events: `auth.*`, `invitation.*`, `team.*`, `store.*`, `settings.changed`, `pricing.settings_changed` and `template.updated`. Every other action is deleted, including unknown ones, so nothing business-related can slip through. Then write one `store.data_reset` event. **(c)** keep everything. | **(b).** The kept events describe rows that still exist. Business events would point at deleted products and uploads, and `bulk-price-revert.ps1` reads `pricing.bulk_applied`. The new event needs one line in `packages/core/src/activity.ts` (action → `team_security` group, plus its label) so Activity shows it. That is a code change, not a schema change. The dry run prints the counts per action. |
| A2 | `categories`, `category_mappings`, `category_price_rules` | delete all three, or keep all three | **Delete all three together.** They are owner-made catalogue data. The category rules cannot be kept without their categories (no foreign key). Keeping categories while deleting the rules would silently change prices after the next ERP upload. |
| A3 | `marketplace_price_rules` | tenant-level rules (`product_id IS NULL`, the only kind the app writes): keep or delete. Product-level rows: always delete (the app never writes them; they would dangle). | **Keep the tenant-level rules.** They are part of the Pricing settings screen, and onboarding treats them as pricing-settings evidence. |
| A4 | `tenant_marketplaces` | keep or delete | **Keep.** It is a per-tenant on/off switch (configuration, not data). Only the tests write it today. |
| A5 | `generated_files` (rows) | keep or delete | **Delete.** The rows point at objects the storage step removes, and at deleted recon data. The onboarding "generated file" step resets with them. |

**Effect on the Templates screen (no decision needed).** The kept layouts stay listed. The read-only `outgoing` description of each marketplace becomes `not_ready` until a marketplace file is applied again, because it is derived from the latest applied upload. When you edit a layout, a new header is taken by name, because no upload is on record (ADR 016).

## 3. Onboarding after the reset: "returns to zero" is not literally true

Progress is derived from the data, and the four required steps count 25% each.

| Step | After the reset |
| --- | --- |
| `owner_mfa` (required) | **stays done**: users and MFA data are kept |
| `erp_upload`, `marketplace_upload`, `first_comparison` (required) | not done |
| `generated_file` (optional) | not done (A5) |
| `invite_team` (optional) | stays done if a teammate was ever invited (invitations are kept) |
| `pricing_settings` (optional) | stays done if pricing settings differ from the defaults, or a tenant-level marketplace rule exists (both kept) |

So with an MFA-enrolled Owner, the result is `percent = 25`, `nextStepId = 'erp_upload'`, `complete = false`. It is 0% only without an enrolled Owner.

**Decision D6:** the test should assert exactly this. All data-driven steps are not done, and the percent is 25 with an enrolled Owner.

## 4. Deletion order and TRUNCATE versus DELETE

**No TRUNCATE anywhere. Every statement is `DELETE FROM <table> WHERE tenant_id = $1`.** TRUNCATE is unsafe here for three reasons:

- It ignores `WHERE`, so it empties every tenant's rows.
- `CASCADE` extends to every referencing table. For example, `TRUNCATE products CASCADE` also empties `listings`, `recon_rows`, the price rules, offers, stock edits and ERP changes of all tenants.
- It takes an ACCESS EXCLUSIVE lock.

The tenant id comes from the slug lookup and is passed as a bound parameter, never interpolated.

All of it runs in **one transaction**, in this order (children before parents):

| # | Step |
| --- | --- |
| 0 | `SET LOCAL lock_timeout = '5s'`. Then `SELECT … FROM tenants WHERE id = $1 FOR NO KEY UPDATE`, the same tenant row lock every `Database.run` takes: it waits out, then blocks, every app write for this tenant. Then `pg_try_advisory_xact_lock(hashtextextended('recon:' \|\| id, 0))`, the recon job's lock: if it is taken, the run refuses. Then count every DELETE and KEEP table for this tenant, and every table's rows of **other** tenants. |
| 1 | `erp_upload_changes` |
| 2 | `upload_errors` |
| 3 | `upload_rows` |
| 4 | `catalogue_stock_edits` |
| 5 | `recon_rows` |
| 6 | `recon_summaries` |
| 7 | `listings` |
| 8 | `product_offers` |
| 9 | `product_price_rules` |
| 10 | `marketplace_price_rules` `AND product_id IS NOT NULL` (A3) |
| 11 | `generated_files` (A5) |
| 12 | `notifications` |
| 13 | `uploads` |
| 14 | `products` |
| 15 | `category_price_rules` (A2) |
| 16 | `category_mappings` (A2) |
| 17 | `categories` (A2). One statement: the self-reference is checked at the end of the statement, after child and parent are both gone. The PGlite test covers a parent with a subcategory; if it ever fails, delete leaves first in a loop. |
| 18 | `audit_events` per A1 |
| 19 | Verify **before COMMIT**: every DELETE table has 0 rows for this tenant, every KEEP table has its starting count, and every table's rows of other tenants are unchanged. Any difference → ROLLBACK and exit non-zero. |
| 20 | Insert `store.data_reset` (A1 b) with the per-table counts and no actor (`operations`, like `store.provisioned`). COMMIT. |

Steps 1 to 3 are explicit, although the CASCADE from `uploads` would remove them anyway. Explicit deletes give exact counts and do not depend on the cascade.

**After COMMIT, outside the transaction:** `ANALYZE (SKIP_LOCKED)` on the emptied tables, then the Redis cleanup (section 6).

**Size.** `upload_rows` keeps up to 50,000 rows per upload, for every upload ever made, so it can be the largest table. The dry run shows the counts first. A large reset may take minutes, so the transaction gets a generous `statement_timeout` rather than the app's 20 s.

## 5. Files in object storage: a separate, explicit second step

Keys are built only in [storage.ts](../../packages/shared/src/storage.ts):

- `tenants/<tenantId>/uploads/<uploadId>/original<ext>`
- `tenants/<tenantId>/generated/<fileId><ext>`

`products.image_key` exists, but no code writes it.

**The app never deletes an object.** No retention sweep exists. The only delete is a failed generation removing its own object, and `expires_at` is not enforced on storage. After the database reset, the objects can no longer be downloaded, because downloads are signed only through database rows. They still hold the tenant's ERP prices and costs, though, and they still occupy the bucket.

Proposal: `scripts/dev/reset-store-storage.mjs`, separate from the database script:

- **Credentials:** reads `S3_*` from `.env` and never prints them.
- **Scope:** lists only `tenants/<tenantId>/uploads/` and `tenants/<tenantId>/generated/` with ListObjectsV2. The tenant id is a validated UUID and the prefix ends in `/`, so it cannot match another tenant. Anything else under `tenants/<tenantId>/` is reported as "not touched".
- **Order:** refuses while the tenant still has rows in `uploads` or `generated_files`. The database reset must come first; otherwise a failed database reset would leave rows pointing at deleted files.
- **Dry run (default):** prints the tenant, the object count, the total bytes and the keys. Keys contain only UUIDs and extensions. The first 50 are printed, and the full list goes to `D:\Qorloop-test\backups\storage-keys-<slug>-<timestamp>.txt`.
- **Real run:** needs `--confirm <slug>` **and** `--expect-count <n>` from the dry run. If the listing differs, it refuses. It uses DeleteObjects in batches of 1,000 and reports the deleted and failed counts.
- **Not reversible:** the database backup does not contain the files. If the bucket has versioning enabled, deletes only add delete markers and the script says so. The local MinIO bucket is unversioned by default.

## 6. Queued Redis jobs (BullMQ)

| Queue | Tenant jobs | If left in Redis and the worker starts again |
| --- | --- | --- |
| `upload-processing` | id `process-<tenantId>-<uploadId>-<rev>` | skipped: the upload no longer exists |
| `upload-apply` | id `apply-<tenantId>-<uploadId>-<rev>` | skipped |
| `recon` | data `tenantId`, deduplication id `recon-<tenantId>` | recomputes over empty data and rewrites zero summaries (`has_data` false); harmless |
| `generated-files` | id `generate-<tenantId>-…` | fails as blocked and **writes a `file.generation_failed` audit event after the reset** |
| `email-outbox` | none (one global scheduler) | untouched |

Completed jobs (kept 24 h) and failed jobs (kept 7 days) also hold tenant and upload ids.

Proposal: the database script handles the tenant's jobs.

- **Dry run:** prints the tenant's job counts per queue and state.
- **Before the transaction:** if any tenant job is `active`, the worker is running, so the script refuses.
- **After COMMIT:** removes the tenant's jobs from the four queues in every non-active state, matched on `data.tenantId`, and clears `recon-<tenantId>` deduplication.
- **Redis unreachable:** refuses, unless `--skip-redis` is given, in which case it prints that the jobs were not checked.

## 7. Running-process, backup and credential checks (Step 1 design)

**Is the API or the worker running?** Every check must pass, otherwise the script refuses:

- **API:** a TCP connect to `127.0.0.1:<PORT from .env, default 4000>` must fail.
- **Worker:** it has no port. `Queue.getWorkers()` (Redis CLIENT LIST) must show 0 workers on all five queues.
- **Other database sessions:** `pg_stat_activity` must show no other client sessions on this database. The worker's pool can be idle with 0 connections, so this check alone is not enough. If it fails, the script prints the count and the `application_name` values only, so you can close pgAdmin, psql or Prisma Studio.
- **Inside the transaction:** the tenant row lock and the recon advisory lock (section 4, step 0) are the final guard.

**Backup.** Newest `*.dump` in `D:\Qorloop-test\backups` with a LastWriteTime under 30 minutes old and a size above 0. The script only stats the file and never opens it. `db-backup.ps1` currently names files `qorloop-before-bulk-<ts>.dump`.

- **Decision D9:** add a `-Label` parameter (default `before-bulk`) so you can run `db-backup.ps1 -Label before-reset`.
- The backup covers the whole database, so restoring it would restore every tenant.

**Credentials.** `DATABASE_URL` is read with dotenv and split on the LAST `@`, the same logic as `database-url.ps1` and `splitUrl` in `change-db-password.mjs`.

- That file runs its main code on import, so the logic goes into a new `scripts/dev/database-url.mjs`, and `change-db-password.mjs` is not touched.
- Only fixed messages and error codes are printed (the `describe()` pattern): never the URL, a password, or a driver message.

**Confirmation.** The default run is a dry run. It prints the tenant name and id, the counts per table (DELETE and KEEP), the audit counts per action, the Redis counts, and exits.

A real run needs `--tenant <slug> --confirm <slug>`, with the slug typed twice. It then:

1. checks the backup, the API port, Redis workers and database sessions,
2. runs the one transaction,
3. runs ANALYZE,
4. cleans up Redis,
5. prints the summary.

## 8. Code layout (Step 1)

| File | Role |
| --- | --- |
| `scripts/dev/store-reset-plan.mjs` | Plain JS: the table lists, the SQL, and the count/delete/verify functions over a `query(text, params)` function. The PGlite test imports this same file, so the tested SQL is the shipped SQL. Jest should load `.mjs` natively under `--experimental-vm-modules` (to be verified in Step 1); a small `.d.mts` gives the test its types. |
| `scripts/dev/reset-store-data.mjs` | CLI: arguments, checks, transaction, ANALYZE, Redis |
| `scripts/dev/reset-store-storage.mjs` | CLI: storage dry run and delete |
| `scripts/dev/database-url.mjs` | Shared URL reading |

Only existing dependencies are used: `pg`, `dotenv`, `bullmq`, `ioredis` and `@aws-sdk/client-s3`. With A1 (b), the only app-code change is the `store.data_reset` entry in `activity.ts`.

Tests (Step 3) go in `apps/api/src/__tests__/store-reset.integration.test.ts` on the PGlite harness, with the teardown drain kept.

**Not covered by PGlite:** the port, Redis and backup checks are unit-tested with fakes only. Real Redis, real S3 and real PostgreSQL locking are not exercised in CI.

## 9. CI caveat

On this branch, `.github/workflows/ci.yml` runs only on pushes to `main` and on pull requests to `main`. **Pushing `feature/reset-store-data` alone does not start GitHub Actions.**

The trigger change exists only on the unmerged branch `ci/run-on-branches` (219263b). **Decision D10:** one of:

- (a) open a draft PR to `main`;
- (b) cherry-pick 219263b onto this branch;
- (c) no CI, with local runs behind the memory gate only.

## 10. Decisions needed before Step 1

| # | Decision | Recommendation |
| --- | --- | --- |
| A1 | Audit events: (a) delete all, (b) business events only plus a `store.data_reset` event, (c) keep all | (b) |
| A2 | Categories, category mappings, category price rules | delete all three |
| A3 | Tenant-level marketplace price rules | keep (product-level rows deleted) |
| A4 | `tenant_marketplaces` | keep |
| A5 | `generated_files` rows | delete |
| D6 | Onboarding assertion: data-driven steps not done, 25% with an MFA-enrolled Owner | accept |
| D7 | Refuse while other sessions are connected to the database | yes |
| D8 | Redis: refuse on an active tenant job; remove the tenant's jobs after COMMIT; `--skip-redis` only explicitly | yes |
| D9 | `db-backup.ps1 -Label` parameter | yes |
| D10 | How CI runs for this branch | (b) cherry-pick the trigger, or (a) a draft PR |
