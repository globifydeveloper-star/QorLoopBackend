# Architecture Decision Record (ADR) 006: Email Provider Selection

- **Status:** Approved
- **Date:** 2026-10-26
- **Context:** Transactional Email Infrastructure (Invitations, Password Resets, 2FA Recovery)
- **Options Evaluated:** Postmark vs. Resend vs. AWS SES (with Mailpit for local/staging)

## Context & Requirements
1. High deliverability for invitation emails (Owner onboarding, team invites) and password reset tokens.
2. Fast setup with clear API client and webhook support.
3. Zero-risk offline local development without burning production email quotas or leaking client emails.

## Decision
We select **Resend** (or Postmark) for production/staging, with **Mailpit** for local development.

## Rationale
- **Mailpit for Local Dev:** Bundled in `docker-compose.yml`, capturing all outgoing SMTP on port `1025` with an instant web inspection UI on port `8025`. No real emails are sent during automated testing.
- **Resend for Production/Staging:** Modern REST API with typed TypeScript SDK, high inbox placement, simple DNS DKIM/SPF verification on `qorloop.globify.ae` or designated sending domain, and excellent observability.

## Configuration
- `SMTP_HOST`: `localhost` (dev) or provider SMTP/API (staging)
- `SMTP_PORT`: `1025` (dev Mailpit)
- From Address: `noreply@qorloop.globify.ae`
