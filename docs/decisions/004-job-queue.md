# Architecture Decision Record (ADR) 004: Job Queue & Background Processing

- **Status:** Approved
- **Date:** 2026-10-26
- **Context:** Asynchronous Job Execution (Upload Processing, Recon Refresh, File Generation)
- **Options Evaluated:** pg-boss vs. BullMQ (Redis)

## Context & Requirements
1. Long-running, compute-intensive background jobs:
   - Spreadsheet parsing & row staging (`process-upload`)
   - Bulk database application (`apply-upload`)
   - 50k product discrepancy calculation (`recon-refresh`)
   - Marketplace export file generation (`generate-file`)
2. Per-customer single-tenant provisioning (each customer has its own database and containers).
3. Low infrastructure footprint, transactional reliability, and job archiving.

## Decision
We select **pg-boss** running directly on PostgreSQL 16.

## Rationale
- **Zero Additional Infrastructure:** BullMQ requires a separate Redis instance. For our single-tenant deployment model where each customer gets an isolated stack, spinning up a Redis container per customer increases RAM usage and maintenance overhead.
- **Transactional Integrity:** pg-boss uses PostgreSQL tables with `SKIP LOCKED` row locking. Jobs can be enqueued inside database transactions.
- **Automatic Archival & Retries:** Built-in job completion archiving, failure backoff, and retry mechanisms.

## Consequences
- Background queues are declared in `src/jobs/boss.ts`.
- Worker consumers run in background worker processes attached to the PostgreSQL database.
