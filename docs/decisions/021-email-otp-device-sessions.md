# ADR 021: Email one-time codes, device-bound sessions and step-up

Date: 20 November 2026. Status: built on `feature/auth-redesign` (plan steps 13–25 of [the redesign plan](../plans/onboarding-redesign-backend.md), Part 5). **Not merged**: the frontend must move to this contract first. Supersedes the session and MFA parts of [ADR 003](003-auth.md) and [ADR 007](007-foundation-auth-milestone.md).

## Owner decisions this implements

1. The one-time code is sent by email.
2. Sessions last at most 20 days from sign-in and end after 7 days without use.
3. Sessions are bound to the device. A new device or browser needs a code.
4. A fresh code is needed before sensitive actions, even inside a valid session. The security window is 10 minutes and the daily-work window is 30 minutes; owner-email change and store-wide sign-out are single use (D13/D14 as changed).
5. The authenticator app stays as an optional, stronger factor, next to the email code. Users who add it use it instead of the email code (confirmed by the owner).

Approved plan decisions: D9 (everyone is signed out once at deploy), D10 (90-day device trust), D11 (a user-agent label only, no IP), D12 (shared computer), D15 (code mail first and nudged), D16 (support recovery CLI).

## Sign-in

| Step | Endpoint | What happens |
| --- | --- | --- |
| Activation | `POST /api/auth/invitations/accept` | Proves the mailbox: the browser becomes a trusted device (cookie `qorloop.device`, `__Host-qorloop.device` in production, 90 days) and a session starts. |
| Password | `POST /api/auth/login {email, password, sharedDevice?}` | Generic 401 as before. On this user's trusted device: a session at once. Otherwise a 10-minute challenge cookie, plus an emailed six-digit code, or `totp_required` when the user has the app (the email code is **not** offered instead, so a mailbox cannot bypass the app). 429 `OTP_SEND_LIMIT` when no code may be sent. |
| Code | `POST /api/auth/otp/verify {code}` | Single use, five attempts (`OTP_INVALID` with `meta.attemptsLeft`, then `OTP_LOCKED`), 10 minutes (`CHALLENGE_EXPIRED`). Success: a session, this browser trusted (unless shared), and the session counts as freshly stepped up. |
| Recovery | `POST /api/auth/otp/recovery {code}` | App users only: one recovery code, consumed. |
| Resend | `POST /api/auth/otp/resend` | A new code that replaces the old one. 60 s apart, three per sign-in, five per hour per user, 30 per hour per store. |

**Codes.** Six random digits are stored as an HMAC-SHA256 keyed from `AUTH_SECRET` and bound to the challenge (a plain digest of six digits could be reversed from a database copy). The code is never logged, never in an audit event or a response, and in the outbox only inside the sealed body (cleared on delivery). The limits are constants in `packages/shared/src/otp.ts`, so no environment variable can weaken them.

**Sessions.** A session is bound to its device. A session cookie without the matching device cookie is refused (401 `SESSION_EXPIRED`).
- **Limits:** the hard limit is 20 days from sign-in, never extended (`SESSION_MAX_DAYS`, at most 20); the idle limit is 7 days (`SESSION_IDLE_DAYS`, at most 7). These replace `SESSION_HOURS` and `SESSION_IDLE_MINUTES`.
- **Last use** is written at most every 5 minutes.
- **Shared computer:** no device trust and 12 hours.
- **Logout** ends the session but keeps the device trusted, so the next sign-in on that device needs only the password.
- **Removed:** the 10-minute restricted MFA sessions and `/api/auth/mfa/*`.

**Authenticator app (optional).** Endpoints under `/api/account`:
- `authenticator/setup` (password) and `authenticator/verify` enrol the app and return ten recovery codes once; other devices are signed out.
- `DELETE authenticator` removes it (security step-up). It is refused while the store requires an app.
- `authenticator/recovery-codes` replaces the recovery codes.

`mfaRequiredForAll` now means "require an authenticator app for everyone": users without one get 403 `AUTHENTICATOR_SETUP_REQUIRED`. An Owner can turn it on only after setting up their own app, so they cannot lock themselves out.

## Step-up

`POST /api/auth/step-up/start` sends a code (or asks for the app); `POST /api/auth/step-up/verify {code} | {recoveryCode}` returns `{securityValidUntil, workValidUntil}`. Routes declare `Access({ stepUp })`, and without a fresh step-up they answer 403 `STEP_UP_REQUIRED` with `meta.window`.

| Window | Routes |
| --- | --- |
| security, 10 min | `POST /api/team/invitations`, `.../:id/resend`, `PATCH /api/team/members/:id/role`, `DELETE /api/team/members/:id`, `POST /api/account/password`, `POST /api/account/sessions/revoke-all`, `DELETE /api/account/authenticator`, `POST /api/account/authenticator/recovery-codes`, `PUT /api/settings` with `security` |
| single use | `POST /api/account/email`, `POST /api/team/sessions/revoke-all` (Owner) |
| work, 30 min | `POST /api/pricing/bulk/apply`, `/api/pricing/offers/bulk/apply`, `/api/pricing/offers/bulk-remove/apply`, `/api/marketplace-values/bulk/apply`, `/api/pricing/adopt/apply`, `PUT /api/pricing/price-source`, `PUT /api/pricing/settings`, `PUT /api/settings` with `pricing`, `GET /api/generated-files/:id/download` |

Revoking an invitation or signing out one device needs no step-up, because those actions only lower risk. A sign-in completed with a code counts as a step-up; a password-only sign-in on a trusted device does not. "Reset store data" is a CLI script (ADR 018), so it has no route to guard.

## Sessions screen and account

- `GET /api/account/sessions`: my devices, with label, trusted or shared, last use and expiry.
- `DELETE /api/account/sessions/:id`: signs out one device; a trusted device also loses its trust.
- `POST /api/account/sessions/revoke-all {includeCurrent}`: signs out all my other devices.
- `POST /api/team/sessions/revoke-all`: the Owner signs out every session and device of the store.
- `POST /api/account/password {currentPassword, newPassword}`: other devices are signed out.
- `POST /api/account/email {newEmail}`: a 24-hour link goes to the new address and a notice to the old one. `POST /api/auth/email/confirm {token}` changes the address and signs the user out everywhere.

Password reset, role change and member removal also sign the user out on every device.

## Activity

These events appear in Team & security, with the code, addresses and tokens never shown: `auth.login_succeeded`, `auth.new_device`, `auth.otp_sent`, `auth.otp_failed`, `auth.otp_locked`, `auth.otp_send_limited`, `auth.otp_verified`, `auth.step_up_verified`, `auth.session_revoked`, `auth.sessions_revoked_all`, `auth.store_sessions_revoked`, `auth.password_changed`, `auth.email_change_requested`, `auth.email_changed`, `auth.mfa_disabled`, `auth.recovery_codes_regenerated`, `support.owner_email_changed`, `mail.undeliverable`. The store reset keeps `auth.*` and `support.*`.

## Mail

- Code mail has priority 1 and is delivered first.
- The API nudges the worker after queuing it (`BullMailTrigger`); the 10-second poll stays as a fallback.
- A failed send of a code is retried after 20 s, other mail after 5 minutes.
- A code is never delivered after it expired: the mail is marked failed and its body cleared.
- After ten failed attempts a mail is marked failed, with audit `mail.undeliverable`.
- The Message-ID uses the `MAIL_FROM` domain, and `MAIL_FROM_NAME` sets the sender name.
- `SMTP_SECURE` overrides the implicit-TLS default (port 465); other ports require STARTTLS in production.
- The worker checks the connection and login at start.
- **Production refuses to start** with a local `SMTP_HOST` or without `SMTP_USER` and `SMTP_PASSWORD`.

What this does not cover: SPF, DKIM and DMARC are DNS work at the mail provider (ADR 006: Resend or Postmark), and the readiness endpoint still reports no mail state.

## Recovery and support

- **The owner has the app:** recovery codes.
- **The mailbox works but the password is lost:** the reset email.
- **Another Owner exists:** that Owner handles it through Team.
- **No other Owner:** `npm run provision:store -- recover-owner --slug s --current-email old --new-email new --confirmed-identity`. Run it only after support has confirmed the person's identity outside Qorloop. It signs the Owner out everywhere, moves the account, removes the app and mails a 24-hour password link to the new address and a notice to the old one.

No command prints a code, a token or a link, and there is no master code. `scripts/e2e-support.ts` reads codes only in development against a local mail catcher.

## Development and tests

- **Local codes:** with the worker running, codes arrive in Mailpit (http://localhost:8025). `tsx scripts/e2e-support.ts token --kind otp --slug s --email e` prints the newest one.
- **Tests:** they read codes from the sealed outbox as the worker would (harness `codeFor`, `login`). Suites about other features mark sessions as freshly stepped up in the database (harness `stepUp`). Nothing in production code has a test bypass.
- **Dev scripts:** the `scripts/dev/*.ps1` checks ask for the emailed or app code; each run is a new device.

## Threat model (short; the full table is in the plan, 5.10)

| Threat | What the design does | What remains risky |
| --- | --- | --- |
| Stolen session cookie | Refused without its device cookie. | Malware copying the whole cookie jar. |
| Stolen laptop | At most 20 days, 7 idle. The owner signs the device out remotely. Sensitive actions need a fresh code. | An open mailbox on the same laptop. |
| Compromised mailbox | The password is still needed. App users are unaffected. | Mailbox plus a reused password, for users without the app. |
| Brute force | Five attempts per code, limited sends and the IP rate limit. | — |
| Interception | TLS to the mail service in production; codes expire in 10 minutes and are single use. | Mail hops outside our control. |
| Shared computers | The shared-computer option. | Users forgetting to choose it. |

## Consequences

- **Breaking for the frontend:** login now returns two shapes, the `mfa_*` states and `/api/auth/mfa/*` are gone, and the cookie names and step-up handling are new. **Merge only together with the matching frontend.**
- **Deploy signs everyone out once** (the migration deletes all sessions). Owners who already use the app keep it and are asked for it on new devices.
- **Production `.env` needs** `SMTP_USER` and `SMTP_PASSWORD` and a real `SMTP_HOST`, or the API and worker refuse to start.
