# QorLoop Backend

Standalone Fastify API server and PostgreSQL background worker for **QorLoop** (Phase 1).

## Tech Stack
- **Framework:** Fastify 5 + TypeScript + fastify-type-provider-zod
- **Database:** PostgreSQL 16
- **ORM:** Drizzle ORM + Drizzle Kit
- **Queue / Jobs:** pg-boss
- **Docs:** OpenAPI 3.0 / Swagger UI (`/docs`)
- **Container Infrastructure:** Docker Compose (PostgreSQL 16 & Mailpit)

## Project Structure
```
d:/Qorloop-backend/
??? src/
?   ??? config/       # Environment & tenant context resolution
?   ??? core/         # Business logic: pricing, money (fils), GTIN barcodes, roles & permissions
?   ??? db/           # Drizzle schema (10 domains), connection client, seed & migration scripts
?   ??? jobs/         # pg-boss job queues (upload processing, recon refresh, file generation)
?   ??? plugins/      # Fastify plugins (tenant context decorator, Swagger UI)
?   ??? routes/       # HTTP endpoints (/health, /api/me, catalogue, pricing, uploads)
?   ??? storage/      # Local filesystem storage behind StorageProvider interface
?   ??? app.ts        # Fastify app builder
?   ??? server.ts     # Server entrypoint
??? docker-compose.yml
??? drizzle.config.ts
??? package.json
??? tsconfig.json
```

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Start PostgreSQL & Mailpit
```bash
npm run docker:up
```
- PostgreSQL runs on `localhost:5432`
- Mailpit Web UI runs on `http://localhost:8025`

### 3. Migrate and Seed Database
```bash
npm run db:migrate
npm run db:seed
```

### 4. Start Development Server
```bash
npm run dev
```
- API runs on `http://localhost:4000`
- OpenAPI Swagger docs: `http://localhost:4000/docs`
- Health check: `http://localhost:4000/health`


## Upload API (Task 6)

All routes live under `/api/uploads`, require a session (cookie + `X-CSRF-Token` on mutations) and are
permission-checked server-side. Interactive docs: `/docs`; machine-readable: `/docs/openapi.json`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/api/uploads` | `uploads.upload` | Create the record, get a signed PUT URL (`.xlsx` `.xls` `.csv`, max 25 MB) |
| POST | `/api/uploads/:id/complete` | `uploads.upload` | Confirm the file arrived; enqueue processing (idempotent) |
| GET | `/api/uploads`, `/api/uploads/:id` | `uploads.view` | History; status, step, progress (poll every 2 s) |
| POST | `/api/uploads/:id/mapping` | `uploads.map` | Confirm / save a column mapping |
| GET | `/api/uploads/:id/review?tab=` | `uploads.view` | The proposed change by tab, paginated |
| GET | `/api/uploads/:id/errors` | `uploads.view` | Row errors |
| POST | `/api/uploads/:id/discard` | `uploads.discard` | Discard and delete the stored original |

Run locally: `npm run docker:up`, `npm run db:migrate`, then `npm run dev` and `npm run dev:worker`.

## Testing

Needs Node 24 (see `engines`). Integration tests use an embedded PostgreSQL by default; point them at a real one
for full coverage (the 50,000-row test and the `pg_trgm` migration only run there):

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/qorloop_test \
TEST_REDIS_URL=redis://localhost:6379 npm test
```
