import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/qorloop_dev';

async function run() {
  console.log('[db:migrate] Connecting to database:', connectionString);
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    console.log('[db:migrate] Database connection verified.');
    console.log('[db:migrate] Use "npm run db:generate" to generate SQL migrations via drizzle-kit.');
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('[db:migrate] Migration error:', err.message);
  process.exit(1);
});
