import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Database, PrismaClient } from '../../../../packages/db/src/database.js';

export async function testDatabase() {
  const external = process.env.TEST_DATABASE_URL;
  // Apply every migration in order. The embedded database has no contrib extensions, so it skips *_extensions.
  const dirs = (await readdir('packages/db/prisma/migrations', { withFileTypes: true }))
    .filter(d => d.isDirectory() && (external || !d.name.endsWith('_extensions'))).map(d => d.name).sort();
  const sql = (await Promise.all(dirs.map(d => readFile('packages/db/prisma/migrations/' + d + '/migration.sql', 'utf8')))).join('\n');
  let stop: () => Promise<void>;
  let adapter: PrismaPg;
  if (external) {
    // Never reset an existing database. Each test run owns a fresh random schema.
    const schema = 'qorloop_test_' + randomUUID().replaceAll('-', '');
    // public stays on the path so an extension already installed there (pg_trgm) resolves; new tables go to the first schema.
    // UTC like Database's own pool: adapter-pg reads and writes timestamptz without an offset.
    const pool = new Pool({ connectionString: external, max: 1, options: '-c search_path=' + schema + ',public -c timezone=UTC' });
    await pool.query('CREATE SCHEMA "' + schema + '"');
    await pool.query(sql);
    adapter = new PrismaPg(pool, { schema });
    stop = async () => {
      if (!/^qorloop_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test cleanup');
      await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
      await pool.end();
    };
  } else {
    // pglite.wasm imports at least 2048 pages (128 MiB); the default initialMemory is exactly that minimum.
    const embedded = await PGlite.create();
    await embedded.exec(sql);
    // pg destroys a client after a query error and reconnects at once; the second slot covers that overlap
    // (otherwise the new connection is refused). The pg pool below still holds at most one connection.
    const socket = new PGLiteSocketServer({ db: embedded, host: '127.0.0.1', port: 0, maxConnections: 2 });
    await socket.start();
    adapter = new PrismaPg({ connectionString: 'postgresql://postgres:postgres@' + socket.getServerConn() + '/postgres', max: 1 });
    stop = async () => { await socket.stop(); await embedded.close(); };
  }
  const prisma = new PrismaClient({ adapter });
  const database = new Database('postgresql://test:test@localhost/test', prisma);
  await database.connect();
  return { database, prisma, close: async () => { await database.close(); await stop(); } };
}

