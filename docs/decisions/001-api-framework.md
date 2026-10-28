# Architecture Decision Record (ADR) 001: API Framework Selection

- **Status:** Approved
- **Date:** 2026-10-26
- **Context:** Qorloop Phase 1 API Service
- **Options Evaluated:** NestJS vs. Fastify 5

## Context & Requirements
The Qorloop backend must handle:
1. Fast, high-throughput parsing and streaming of 25 MB Excel/CSV spreadsheets (up to 50k rows) in under 3 minutes.
2. Low memory footprint per tenant instance for single-tenant provisioning.
3. Strongly-typed request/response validation with automatic OpenAPI 3.0 (Swagger) generation.
4. Minimal startup overhead and clean modular plugin architecture.

## Decision
We select **Fastify 5** with TypeScript and `fastify-type-provider-zod`.

## Rationale
- **Performance & Overhead:** Fastify is significantly lighter and faster than NestJS, consuming less baseline RAM per customer container instance.
- **Zod Native Integration:** Using `fastify-type-provider-zod`, route schemas provide compile-time TypeScript type inference, runtime request validation, and automatic OpenAPI documentation generation without redundant DTO decorators.
- **Multipart Upload Performance:** `@fastify/multipart` offers direct streaming to disk/storage without buffering whole 25 MB files in Node.js heap memory.
- **NestJS Drawbacks:** NestJS brings heavy class-validator reflection overhead, excessive boilerplate, and higher memory consumption without meaningful benefits for our modular architecture.

## Consequences
- Endpoints will be structured as Fastify plugins with clear route grouping under `/api`.
- Request contracts will use Zod schemas as the single source of truth for runtime validation and static TypeScript types.
