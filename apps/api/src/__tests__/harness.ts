import { expect } from '@jest/globals';
import type { HTTPMethods } from 'fastify';
import { buildApp } from '../app.js';
import { AuthService } from '../auth/auth.service.js';
import { loadConfig } from '../../../../packages/shared/src/config.js';
import { digest, unseal } from '../../../../packages/shared/src/security.js';
import { MemoryStorage } from '../../../../packages/shared/src/storage.js';
import { InlineUploadQueue } from '../../../../packages/shared/src/queue.js';
import { InlineReconQueue } from '../../../../packages/shared/src/recon.js';
import { InlineGeneratedFilesQueue } from '../../../../packages/shared/src/generated-files.js';
import { InlineMailTrigger } from '../../../../packages/shared/src/mail.js';
import { InlineStoreCleanupQueue } from '../../../../packages/shared/src/store-cleanup.js';
import { testDatabase } from './database.js';

export const password = 'Correct horse battery staple!';
/** cookie: the session cookie and, on a trusted device, the device cookie, ready for a Cookie header. */
export type Session = { cookie: string; csrf: string; device?: string };
export type Store = { id: string; hostname: string; owner: Session };
type Response = { statusCode: number; cookies: { name: string; value: string }[]; json: () => { data: Record<string, unknown> } };

/** In-memory doubles for every external service buildApp would otherwise reach (Redis via BullMQ, S3, the recon job). */
export function testServices() {
  return { storage: new MemoryStorage(), queue: new InlineUploadQueue(), recon: new InlineReconQueue(), generatedFiles: new InlineGeneratedFilesQueue(), mailTrigger: new InlineMailTrigger(), storeCleanup: new InlineStoreCleanupQueue(), redisHealth: async () => undefined };
}
/** Session (and device) cookies from a session response; `device` keeps a device cookie the response did not renew. */
export function sessionFrom(response: Response, device?: string): Session {
  expect(response.statusCode).toBe(200);
  const session = response.cookies.find(c => c.name === 'qorloop');
  expect(session).toBeDefined();
  const deviceToken = response.cookies.find(c => c.name === 'qorloop.device')?.value ?? device;
  return { cookie: 'qorloop=' + session!.value + (deviceToken ? '; qorloop.device=' + deviceToken : ''), csrf: response.json().data.csrfToken as string, ...(deviceToken ? { device: deviceToken } : {}) };
}
export const sessionToken = (session: Session) => /qorloop=([^;]+)/.exec(session.cookie)![1]!;

export async function createHarness() {
  const fixture = await testDatabase();
  const { storage, queue, recon, generatedFiles, mailTrigger, storeCleanup } = testServices();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters', APP_ORIGIN: 'http://dohafresh.localhost:3000' });
  const api = await buildApp(config, { database: fixture.database, logger: false, storage, queue, recon, generatedFiles, mailTrigger, storeCleanup, rateLimitMax: 100000 });
  let counter = 0;

  function request(method: HTTPMethods, url: string, store: Pick<Store, 'hostname'>, session?: Session, payload?: Record<string, unknown>) {
    return api.server.inject({
      method, url, remoteAddress: '127.0.0.1',
      headers: { host: store.hostname + ':4000', origin: 'http://' + store.hostname + ':3000', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) },
      ...(payload ? { payload } : {}),
    });
  }
  async function tokenFor(id: string) {
    const message = await fixture.prisma.emailOutbox.findFirstOrThrow({ where: { dedupeKey: { startsWith: 'invitation:' + id } }, orderBy: { createdAt: 'desc' } });
    const plaintext = await unseal<{ text: string }>(message.sealedMessage, config.AUTH_SECRET);
    return plaintext.text.match(/#token=([A-Za-z0-9_-]+)/)![1]!;
  }
  /** The newest emailed one-time code for this address, read from the sealed outbox as the email worker would. */
  async function codeFor(store: Pick<Store, 'id'>, email: string) {
    const rows = await fixture.prisma.emailOutbox.findMany({ where: { tenantId: store.id, dedupeKey: { startsWith: 'otp:' } }, orderBy: { createdAt: 'desc' }, take: 20 });
    for (const row of rows) {
      const message = await unseal<{ to: string; text: string }>(row.sealedMessage, config.AUTH_SECRET);
      if (message.to === email) return /Your code is (\d{6})/.exec(message.text)![1]!;
    }
    throw new Error('No code mail for this address');
  }
  /**
   * Test shortcut: marks the session as freshly confirmed (step-up) in the database, so suites about other features
   * need no code mail and stay inside the hourly send limits. The real step-up flow is covered in auth-otp tests.
   */
  async function stepUp(session: Session) {
    await fixture.prisma.session.update({ where: { tokenHash: digest(sessionToken(session)) }, data: { stepUpAt: new Date() } });
    return session;
  }
  /** Signs in with the password; on an unknown device completes the emailed code. `device`: this browser's device cookie. */
  async function login(store: Pick<Store, 'id' | 'hostname'>, email: string, device?: string) {
    const first = await request('POST', '/api/auth/login', store, device ? { cookie: 'qorloop.device=' + device, csrf: '' } : undefined, { email, password });
    expect(first.statusCode).toBe(200);
    if (first.json().data.state !== 'otp_required') return sessionFrom(first, device);
    const challenge = first.cookies.find(c => c.name === 'qorloop.challenge')!.value;
    const verified = await request('POST', '/api/auth/otp/verify', store, { cookie: 'qorloop.challenge=' + challenge + (device ? '; qorloop.device=' + device : ''), csrf: '' }, { code: await codeFor(store, email) });
    return sessionFrom(verified, device);
  }
  async function createOwner(slug: string): Promise<Store> {
    const result = await new AuthService(fixture.database, config).provision({ name: slug, slug, hostname: slug + '.localhost', ownerEmail: 'owner@' + slug + '.test' });
    const store: Store = { id: result.tenantId, hostname: slug + '.localhost', owner: {} as Session };
    store.owner = await stepUp(sessionFrom(await request('POST', '/api/auth/invitations/accept', store, undefined, { token: await tokenFor(result.invitationId), name: 'Owner', password })));
    return store;
  }
  /** Invite + accept a member (the browser becomes a trusted device), with a fresh step-up. */
  async function member(store: Store, role: string): Promise<Session> {
    await stepUp(store.owner);
    const invited = await request('POST', '/api/team/invitations', store, store.owner, { role, email: `user${++counter}@${store.hostname}.test` });
    expect(invited.statusCode).toBe(200);
    const accepted = await request('POST', '/api/auth/invitations/accept', store, undefined, { token: await tokenFor(invited.json().data.id), name: role, password });
    return stepUp(sessionFrom(accepted));
  }
  return {
    fixture, api, config, storage, queue, recon, generatedFiles, mailTrigger, storeCleanup, request, sessionFrom, createOwner, member, codeFor, stepUp, login, tokenFor,
    // App first (no request can queue another recompute), then every queued/in-flight recompute, then the database:
    // a recompute still running after teardown fails on the closed database and touches modules Jest has torn down.
    close: async () => { await api.app.close(); await recon.drain(); await fixture.close(); },
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
