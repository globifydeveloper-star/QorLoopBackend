import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Database, PrismaClient } from '../../../../packages/db/src/database.js';

export async function testDatabase() {
  const initial = await readFile('packages/db/prisma/migrations/202610280001_foundation/migration.sql', 'utf8');
  const checks = await readFile('packages/db/prisma/migrations/202610280002_security_constraints/migration.sql', 'utf8');
  const external = process.env.TEST_DATABASE_URL;
  let stop: () => Promise<void>;
  let adapter: PrismaPg;
  if (external) {
    // Never reset an existing database. Each test run owns a fresh random schema.
    const schema = 'qorloop_test_' + randomUUID().replaceAll('-', '');
    const pool = new Pool({ connectionString: external, max: 1, options: '-c search_path=' + schema });
    await pool.query('CREATE SCHEMA "' + schema + '"');
    await pool.query(initial + '\n' + checks);
    adapter = new PrismaPg(pool, { schema });
    stop = async () => {
      if (!/^qorloop_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test cleanup');
      await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
      await pool.end();
    };
  } else {
    const embedded = await PGlite.create({ initialMemory: 64 * 1024 * 1024 });
    await embedded.exec(initial + '\n' + checks);
    const socket = new PGLiteSocketServer({ db: embedded, host: '127.0.0.1', port: 0, maxConnections: 1 });
    await socket.start();
    adapter = new PrismaPg({ connectionString: 'postgresql://postgres:postgres@' + socket.getServerConn() + '/postgres', max: 1 });
    stop = async () => { await socket.stop(); await embedded.close(); };
  }
  const prisma = new PrismaClient({ adapter });
  const database = new Database('postgresql://test:test@localhost/test', prisma);
  await database.connect();
  return { database, prisma, close: async () => { await database.close(); await stop(); } };
}

