/**
 * Test support for browser end-to-end tests (see the frontend repo's e2e/). NEVER used by the running app and
 * never exposed over HTTP: it talks to the database directly, the way the provisioning CLI does.
 *
 *   tsx scripts/e2e-support.ts provision --slug dohafresh --owner-email owner@example.test
 *   tsx scripts/e2e-support.ts token --slug dohafresh --email someone@example.test [--kind invitation|reset]
 *
 * Prints the single-use token from the newest matching message in the email outbox. In a real deployment
 * that token only ever travels by email.
 */
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { Database, PrismaClient } from '../packages/db/src/database.js';
import { loadConfig } from '../packages/shared/src/config.js';
import { unseal } from '../packages/shared/src/security.js';
import { AuthService } from '../apps/api/src/auth/auth.service.js';

const config = loadConfig(process.env, { requireTenantPin: false });
if (config.NODE_ENV === 'production') throw new Error('e2e-support must never run in production');

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { slug: { type: 'string' }, 'owner-email': { type: 'string' }, email: { type: 'string' }, kind: { type: 'string', default: 'invitation' } }, strict: true });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL, options: '-c timezone=UTC' }) });
const database = new Database(config.DATABASE_URL, prisma);

async function tokenFor(slug: string, email: string, kind: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug } });
  const rows = await prisma.emailOutbox.findMany({ where: { tenantId: tenant.id, dedupeKey: { startsWith: kind + ':' } }, orderBy: { createdAt: 'desc' }, take: 50 });
  for (const row of rows) {
    const message = await unseal<{ to: string; text: string }>(row.sealedMessage, config.AUTH_SECRET).catch(() => null);
    if (message?.to === email.toLowerCase()) return message.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  }
  return null;
}

try {
  if (command === 'provision') {
    const slug = values.slug!, ownerEmail = values['owner-email']!.toLowerCase();
    const result = await new AuthService(database, config).provision({ name: slug, slug, hostname: slug + '.localhost', ownerEmail });
    console.log(JSON.stringify({ ...result, hostname: slug + '.localhost', inviteToken: await tokenFor(slug, ownerEmail, 'invitation') }));
  } else if (command === 'token') {
    console.log(JSON.stringify({ token: await tokenFor(values.slug!, values.email!, values.kind!) }));
  } else {
    throw new Error('Usage: provision | token');
  }
} finally {
  await database.close();
}
