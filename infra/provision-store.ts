import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { Database } from '../packages/db/src/database.js';
import { loadConfig } from '../packages/shared/src/config.js';
import { email } from '../packages/shared/src/contracts.js';
import { AuthService } from '../apps/api/src/auth/auth.service.js';

const { values } = parseArgs({
  options: { name: { type: 'string' }, slug: { type: 'string' }, 'owner-email': { type: 'string' }, hostname: { type: 'string' } },
  strict: true,
});
const input = z.object({
  name: z.string().trim().min(1).max(120), slug: z.string().regex(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/),
  ownerEmail: email, hostname: z.string().regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/).optional(),
}).parse({ name: values.name, slug: values.slug, ownerEmail: values['owner-email'], hostname: values.hostname });
const config = loadConfig(process.env, { requireTenantPin: false });
const hostname = input.hostname ?? input.slug + (config.NODE_ENV === 'production' ? '.' + config.BASE_DOMAIN : '.localhost');
// This internal command initializes an already isolated stack. It is never
// registered as an HTTP endpoint. Infrastructure deployment is tracked separately.
const migrated = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });
if (migrated.status !== 0) throw new Error('Database migration failed');
const db = new Database(config.DATABASE_URL);
try {
  const result = await new AuthService(db, config).provision({ ...input, hostname });
  console.log(JSON.stringify({ ...result, hostname, emailDelivery: 'queued', infrastructure: 'must already exist' }, null, 2));
} finally { await db.close(); }

