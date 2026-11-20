/**
 * Operations CLI. Never registered as an HTTP endpoint, and never prints a token or link: invitations travel only by email.
 *
 *   npm run provision:store -- --name "Doha Fresh" --slug dohafresh --owner-email owner@example.test [--hostname h] [--marketplaces talabat,snoonu]
 *   npm run provision:store -- resend-owner-invitation --slug dohafresh
 *
 * The first form migrates the database and creates the store idempotently. The second resends the Owner invitation of a
 * store that has no active Owner yet (for example after the 48-hour link expired).
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { Database } from '../packages/db/src/database.js';
import { loadConfig } from '../packages/shared/src/config.js';
import { email } from '../packages/shared/src/contracts.js';
import { MARKETPLACES } from '../packages/core/src/constants.js';
import { AuthService } from '../apps/api/src/auth/auth.service.js';

const { values, positionals } = parseArgs({
  options: {
    name: { type: 'string' }, slug: { type: 'string' }, 'owner-email': { type: 'string' }, hostname: { type: 'string' }, marketplaces: { type: 'string' },
  },
  strict: true, allowPositionals: true,
});
const command = positionals[0] ?? 'create';
if (!['create', 'resend-owner-invitation'].includes(command) || positionals.length > 1) throw new Error('Usage: provision:store [create | resend-owner-invitation] --slug ...');
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/);
const config = loadConfig(process.env, { requireTenantPin: false });
const db = new Database(config.DATABASE_URL);
try {
  if (command === 'resend-owner-invitation') {
    const tenant = await db.tenantBySlug(slug.parse(values.slug));
    if (!tenant || tenant.status !== 'active') throw new Error('No active store with this slug');
    const result = await new AuthService(db, config).resendOwnerInvitation(tenant.id);
    console.log(JSON.stringify({ tenantId: tenant.id, invitationId: result.invitationId, expiresAt: result.expiresAt, created: result.created, emailDelivery: 'queued' }, null, 2));
  } else {
    const input = z.object({
      name: z.string().trim().min(1).max(120), slug, ownerEmail: email,
      hostname: z.string().regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/).optional(),
      marketplaces: z.array(z.enum(MARKETPLACES)).min(1).optional(),
    }).parse({
      name: values.name, slug: values.slug, ownerEmail: values['owner-email'], hostname: values.hostname,
      marketplaces: values.marketplaces === undefined ? undefined : [...new Set(values.marketplaces.split(',').map(m => m.trim().toLowerCase()).filter(Boolean))],
    });
    const hostname = input.hostname ?? input.slug + (config.NODE_ENV === 'production' ? '.' + config.BASE_DOMAIN : '.localhost');
    // This internal command initializes an already isolated stack. Infrastructure deployment is tracked separately.
    const migrated = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });
    if (migrated.status !== 0) throw new Error('Database migration failed');
    const result = await new AuthService(db, config).provision({ ...input, hostname });
    // A production stack is pinned to its one store; outside production TENANT_ID is ignored (security.guard tenantPin).
    const warning = config.NODE_ENV === 'production' && config.TENANT_ID && config.TENANT_ID !== result.tenantId
      ? 'TENANT_ID of this instance pins a different store; this store will not be served here' : undefined;
    console.log(JSON.stringify({ ...result, hostname, emailDelivery: result.created ? 'queued' : 'not sent (store existed; use resend-owner-invitation)', infrastructure: 'must already exist', ...(warning ? { warning } : {}) }, null, 2));
  }
} finally { await db.close(); }
