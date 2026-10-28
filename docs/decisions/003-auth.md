# Architecture Decision Record (ADR) 003: Authentication & Security Library

- **Status:** Approved
- **Date:** 2026-10-26
- **Context:** User Authentication, Sessions & Two-Factor Authentication
- **Options Evaluated:** Better Auth vs. NextAuth / Custom JWT / Lucia

## Context & Requirements
1. Multi-tenant session isolation without exposing tenant switching in the UI.
2. Mandatory TOTP (RFC 6238) two-step verification with recovery/backup codes for Owners (A3).
3. Email invitation flow where invitation acceptance verifies user email (A1).
4. Secure password reset, session timeouts, and session invalidation (A2).
5. Clean Drizzle ORM PostgreSQL integration.

## Decision
We select **Better Auth** (with custom Drizzle adapter & Argon2/scrypt password hashing).

## Rationale
- **Native Two-Factor (2FA/TOTP):** Better Auth provides built-in 2FA plugins with standard authenticator app QR code generation and hashed backup recovery codes out-of-the-box.
- **Tenant-Aware Organization/Session Model:** Better Auth's session model easily binds `tenant_id` to the session context.
- **Drizzle Schema Alignment:** The existing `users`, `sessions`, `accounts`, `verifications`, and `two_factors` tables are directly compatible with Better Auth's standard specification.
- **Clean API Separation:** Unlike NextAuth (Auth.js) which is tightly coupled to Next.js handlers, Better Auth is framework-agnostic and plugs directly into Fastify.

## Consequences
- Auth endpoints reside under `/api/auth/*`.
- Fastify middleware populates `request.user` and checks roles/permissions on every protected endpoint.
