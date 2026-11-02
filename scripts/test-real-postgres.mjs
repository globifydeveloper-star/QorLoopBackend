import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';

// Never print connection options or raw driver errors: local credentials can contain reserved URL characters.
const name = 'qorloop_test_' + randomUUID().replaceAll('-', '');
let admin;
let created = false;
let phase = 'configuration';
let childProcess;
const interrupt = () => { process.exitCode = 130; childProcess?.kill('SIGTERM'); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  const source = process.env.TEST_POSTGRES_ADMIN_URL || process.env.DATABASE_URL;
  if (!source) throw new Error('Database configuration is required');
  const url = new URL(source);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database configuration');
  url.pathname = '/postgres';
  admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  phase = 'connect';
  await admin.connect();
  phase = 'create throwaway database';
  if (!/^qorloop_test_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe test database name');
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = '/' + name;
  const requested = process.argv.slice(2);
  const paths = requested.length ? requested : ['apps/'];
  if (paths.some(p => p.startsWith('-'))) throw new Error('Pass test paths, not Jest options');
  phase = 'tests';
  console.log('Running tests on an isolated throwaway PostgreSQL database.');
  const child = spawn(process.execPath, ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--runInBand', ...paths], {
    stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url.href },
  });
  childProcess = child;
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (result.signal || result.code === 134 || result.code === 3221225477) console.error('Test process crashed. Stop further test batches and check memory.');
  process.exitCode = result.code ?? 1;
} catch {
  console.error(`Real PostgreSQL runner failed during ${phase}. Connection details were suppressed.`);
  process.exitCode = 1;
} finally {
  if (created && admin) {
    try {
      if (!/^qorloop_test_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe cleanup');
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      console.log('Throwaway PostgreSQL database dropped.');
    } catch { console.error('Throwaway database cleanup failed; check PostgreSQL before another run.'); process.exitCode = 1; }
  }
  await admin?.end().catch(() => undefined);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
