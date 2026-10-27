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
