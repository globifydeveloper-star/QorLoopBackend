# ADR 022: Reset store data from the app (Owner only)

Date: 21 November 2026. Status: built. Extends [ADR 018](018-reset-store-data.md), which offered the reset only as a
developer script and said "No HTTP endpoint and no app UI".

## Decision (owner)

- **Where:** every environment, production included.
- **Who:** the Owner only (new permission `store.reset`). Administrators and everyone else get 403.
- **Safeguards:** a fresh single-use code ("Confirm it's you", ADR 021) and the store's slug typed to confirm.
- **Files:** the worker deletes the store's uploaded and generated files after the reset.

## What it does

The same plan and SQL as the script: `scripts/dev/store-reset-plan.mjs` stays the one source. It is compiled into the
build (`allowJs`, only this file) and run through Prisma by `packages/db/src/store-reset.ts`. What is deleted and kept is
listed in ADR 018 and unchanged.

| | |
| --- | --- |
| `GET /api/store/reset` | Owner: per-kind counts of what would be deleted, and `blockedReason` while an upload is processed |
| `POST /api/store/reset` `{ confirmSlug }` | Owner, `stepUp: 'single'`: runs the reset; returns the deleted counts and `storageCleanup` |

**One transaction, the request's own.** `AuthService.authenticated` holds the tenant row lock. Inside the same
transaction, the request then:

1. checks the session, the permission and the step-up, and consumes the step-up;
2. checks the slug and refuses (409) while an upload is `uploaded`, `processing` or `applying`;
3. runs `resetTenantInTransaction`. That function refuses (409) while the recon holds its advisory lock, or when the
   schema does not match the plan. It verifies the counts before commit.

The transaction timeout is 10 minutes. Any refusal rolls everything back, including the spent code, so the Owner can
retry without a new code. The `store.data_reset` audit event records the Owner as actor, the request id and
`source: 'app'`.

**Differences from the script.** The script's pre-flight checks (a backup under 30 minutes old, the API stopped, no other
database session, no worker) cannot apply to a running app. The in-app reset relies on the tenant lock, the recon
lock and the in-flight upload check instead. **There is no automatic backup.** Undoing a reset means restoring a
database backup, which restores every store.

**After commit:** `ANALYZE` of the emptied tables (best effort). Then a `store-cleanup` job is queued with a 2-minute
delay, so a file generation that was already running can finish writing. The worker
(`apps/worker/src/clean-store-storage.ts`) lists `tenants/<id>/uploads/` and `tenants/<id>/generated/`. It deletes only
objects that meet both conditions:

- no `uploads.storage_key` or `generated_files.storage_key` row points at them;
- they were last modified before the reset.

A file uploaded or generated after the reset is never touched, and nothing outside those two prefixes is deleted. It
writes one `store.storage_cleaned` event, which later resets keep. If any file fails to delete, the job throws and the
queue retries it; a retry deletes only what is still there. Queued jobs are not removed, unlike the script: a waiting
recon runs on the empty store, which is harmless.

`ObjectStorage` gains `list(prefix)` and `deleteMany(keys)`. `deleteMany` sends batches of 1,000 and falls back to one
request per key where multi-object delete is not implemented.

## Frontend

Settings → "Reset store data" (shown with `store.reset`). It loads the counts only when opened, lists what is deleted and
kept, and blocks while an upload is processed. The reset button is enabled once the slug is typed. The API client
handles `STEP_UP_REQUIRED` with the existing dialog. On success every query is invalidated.

## Not included

- No undo and no soft delete.
- The store's `price_source` choice is kept, as in the script. Whether a reset should clear it is still the open
  question from the onboarding plan.
- Production readiness depends on the worker running; without it, files stay until it starts (the job waits in Redis).
