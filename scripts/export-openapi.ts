import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../packages/shared/src/config.js';
import { buildApp } from '../apps/api/src/app.js';

const config = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/qorloop_spec',
  AUTH_SECRET: 'documentation-only-secret-with-no-runtime-use',
});
const { app, spec } = await buildApp(config, { connect: false, logger: false });
await writeFile('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
await app.close();
console.log('Wrote docs/openapi.json');

