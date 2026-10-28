# Foundation and authentication milestone

Date: 2026-10-28

## Repository inspection

The repository starts with a Fastify 5 server, Drizzle table definitions, pg-boss
queue declarations, pricing/barcode/money/permission helpers and unit tests.
There is no frontend in this checkout. There are no applied SQL migration files,
authentication handlers or provisioning implementation. The previous migrate
script does not apply a schema, the seed does not create password credentials,
and `/api/me` returns an unauthenticated mock Owner.

The new work prompt explicitly requests NestJS, Prisma, Redis/BullMQ and a
monorepo. It supersedes ADRs 001, 002 and 004 for the new runtime. The existing
domain helpers and reference schemas will be preserved. Existing installations
must not apply a fresh initial migration over populated Drizzle tables: data
conversion and baselining require a separate reviewed migration.

## Scope

Implement the foundation and invitation-only authentication milestone, including
tenant-scoped persistence, internal tenant initialization, team authorization,
OpenAPI contracts and security-focused integration tests. Inventory parsing,
marketplace exports and production infrastructure provisioning remain later
milestones. No sample marketplace files are present in this checkout.

## Authentication compatibility assessment

The Better Auth documentation describes its NestJS integration as community
maintained and Fastify support as beta. A compatibility installation of Better
Auth 1.7.14 failed with npm ERESOLVE: its optional SvelteKit peer selected Vite 8,
conflicting with the existing Vitest/Vite 7 tree. This is a dependency/integration
assessment, not a claim that Better Auth cannot support this application.

For this milestone use maintained libraries for cryptographic operations:
`@node-rs/argon2` (Argon2id passwords), `otplib` (TOTP), `@hapi/iron`
(authenticated encryption of MFA secrets). Node's built-in CSPRNG and SHA-256
provide opaque tokens and token digests. Tenant-scoped application services own
invitation, reset and session lifecycles; no general-purpose public auth router
or signup endpoint is mounted. Reconsider Better Auth with a tested tenant-aware
adapter before changing these contracts. This supersedes ADR 003 for the new
runtime.

Sources checked:
- https://better-auth.com/docs/integrations/nestjs
- https://better-auth.com/docs/concepts/database
- https://better-auth.com/docs/plugins/2fa
- https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7
- https://otplib.yeojz.dev/guide/advanced-usage

## Security invariants

- Resolve tenants from an exact configured hostname; never use a body/header
  tenant ID or forwarded host to choose authorization context.
- Scope every customer query to that tenant; use composite foreign keys to
  prevent cross-tenant references even if application code has a defect.
- Store only digests of random invitation, reset, session and recovery tokens.
- MFA enrollment and MFA challenges grant no access to protected business APIs.
- Rotate session tokens when authentication assurance increases.
- Prevent Owner removal/demotion races by serializing membership changes.
- Include audit writes in the transaction that changes state.
- Require an allowlisted Origin on all state-changing browser requests and a
  session-bound CSRF token on authenticated mutations.
- Do not log credentials, authorization/cookie headers or request bodies.

## Environment observations

Node 24.18.0 is available. No PostgreSQL listener is running on localhost:5432.
Docker CLI is installed but its daemon is not running. Python/Poppler are not
available through PATH. Production infrastructure, DNS/TLS, object storage and
email-provider delivery cannot be claimed as verified from this environment.
