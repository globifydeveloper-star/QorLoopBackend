import { expect } from '@jest/globals';
import { generate } from 'otplib';
import type { HTTPMethods } from 'fastify';
import { buildApp } from '../app.js';
import { AuthService } from '../auth/auth.service.js';
import { loadConfig } from '../../../../packages/shared/src/config.js';
import { unseal } from '../../../../packages/shared/src/security.js';
import { MemoryStorage } from '../../../../packages/shared/src/storage.js';
import { InlineUploadQueue } from '../../../../packages/shared/src/queue.js';
import { testDatabase } from './database.js';

export const password = 'Correct horse battery staple!';
export type Session = { cookie: string; csrf: string };
export type Store = { id: string; hostname: string; owner: Session };

export async function createHarness() {
  const fixture = await testDatabase();
  const storage = new MemoryStorage();
  const queue = new InlineUploadQueue();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters', APP_ORIGIN: 'http://dohafresh.localhost:3000' });
  const api = await buildApp(config, { database: fixture.database, logger: false, storage, queue, rateLimitMax: 100000 });
  let counter = 0;

  function request(method: HTTPMethods, url: string, store: Pick<Store, 'hostname'>, session?: Session, payload?: Record<string, unknown>) {
    return api.server.inject({
      method, url, remoteAddress: '127.0.0.1',
      headers: { host: store.hostname + ':4000', origin: 'http://' + store.hostname + ':3000', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) },
      ...(payload ? { payload } : {}),
    });
  }
  function sessionFrom(response: Awaited<ReturnType<typeof request>>): Session {
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find(c => c.name === 'qorloop');
    return { cookie: 'qorloop=' + cookie!.value, csrf: response.json().data.csrfToken };
  }
  async function tokenFor(id: string) {
    const message = await fixture.prisma.emailOutbox.findFirstOrThrow({ where: { dedupeKey: { startsWith: 'invitation:' + id } }, orderBy: { createdAt: 'desc' } });
    const plaintext = await unseal<{ text: string }>(message.sealedMessage, config.AUTH_SECRET);
    return plaintext.text.match(/#token=([A-Za-z0-9_-]+)/)![1]!;
  }
  async function createOwner(slug: string): Promise<Store> {
    const result = await new AuthService(fixture.database, config).provision({ name: slug, slug, hostname: slug + '.localhost', ownerEmail: 'owner@' + slug + '.test' });
    const store: Store = { id: result.tenantId, hostname: slug + '.localhost', owner: {} as Session };
    const pending = sessionFrom(await request('POST', '/api/auth/invitations/accept', store, undefined, { token: await tokenFor(result.invitationId), name: 'Owner', password }));
    const setup = await request('POST', '/api/auth/mfa/setup', store, pending, { password });
    const secret = new URL(setup.json().data.totpUri).searchParams.get('secret')!;
    store.owner = sessionFrom(await request('POST', '/api/auth/mfa/verify', store, pending, { code: await generate({ secret }) }));
    return store;
  }
  /** Invite + accept a member. Non-Owner roles need no MFA unless the tenant policy says so. */
  async function member(store: Store, role: string): Promise<Session> {
    const invited = await request('POST', '/api/team/invitations', store, store.owner, { role, email: `user${++counter}@${store.hostname}.test` });
    expect(invited.statusCode).toBe(200);
    const accepted = await request('POST', '/api/auth/invitations/accept', store, undefined, { token: await tokenFor(invited.json().data.id), name: role, password });
    return sessionFrom(accepted);
  }
  return {
    fixture, api, config, storage, queue, request, sessionFrom, createOwner, member,
    close: async () => { await api.app.close(); await fixture.close(); },
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
