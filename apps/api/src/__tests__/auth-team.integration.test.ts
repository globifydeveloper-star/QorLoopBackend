import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { generate } from 'otplib';
import type { HTTPMethods } from 'fastify';
import { buildApp } from '../app.js';
import { AuthService } from '../auth/auth.service.js';
import { loadConfig } from '../../../../packages/shared/src/config.js';
import { digest, unseal } from '../../../../packages/shared/src/security.js';
import { testDatabase } from './database.js';
import { sessionFrom, sessionToken, testServices, type Session } from './harness.js';
import { SecurityGuard, tenantPin } from '../http/security.guard.js';

const password = 'Correct horse battery staple!';
type Store = { id: string; hostname: string; owner: Session };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let api: Awaited<ReturnType<typeof buildApp>>;
let a: Store, b: Store;
let counter = 0;
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters', APP_ORIGIN: 'http://dohafresh.localhost:3000' });

function request(method: HTTPMethods, url: string, store: Pick<Store, 'hostname'>, session?: Session, payload?: Record<string, unknown>, extra?: Record<string, string>, remoteAddress = '127.0.0.1') {
  return api.server.inject({
    method, url, remoteAddress,
    headers: { host: store.hostname + ':4000', origin: 'http://' + store.hostname + ':3000', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...extra },
    ...(payload ? { payload } : {}),
  });
}
async function tokenFor(id: string, kind = 'invitation') {
  const message = await fixture.prisma.emailOutbox.findFirstOrThrow({ where: { dedupeKey: { startsWith: kind + ':' + id } }, orderBy: { createdAt: 'desc' } });
  const plaintext = await unseal<{text: string}>(message.sealedMessage, config.AUTH_SECRET);
  const token = plaintext.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  expect(token).toHaveLength(43);
  return token!;
}
async function codeFor(store: Pick<Store, 'id'>, email: string) {
  for (const row of await fixture.prisma.emailOutbox.findMany({ where: { tenantId: store.id, dedupeKey: { startsWith: 'otp:' } }, orderBy: { createdAt: 'desc' } })) {
    const message = await unseal<{ to: string; text: string }>(row.sealedMessage, config.AUTH_SECRET);
    if (message.to === email) return /Your code is (\d{6})/.exec(message.text)![1]!;
  }
  throw new Error('no code');
}
/** Marks the session as freshly confirmed (a step-up), as the harness does; the real flow is in auth-otp tests. */
const stepUp = async (session: Session) => { await fixture.prisma.session.update({ where: { tokenHash: digest(sessionToken(session)) }, data: { stepUpAt: new Date() } }); return session; };
const challengeCookie = (response: { cookies: { name: string; value: string }[] }) => response.cookies.find(c => c.name === 'qorloop.challenge');
/** Password, then (new device) the emailed code. */
async function signIn(store: Store, email: string, options: { device?: string; secret?: string; sharedDevice?: boolean } = {}) {
  const first = await request('POST', '/api/auth/login', store, options.device ? { cookie: 'qorloop.device=' + options.device, csrf: '' } : undefined,
    { email, password: options.secret ?? password, ...(options.sharedDevice ? { sharedDevice: true } : {}) });
  expect(first.statusCode).toBe(200);
  if (first.json().data.state === 'authenticated') return sessionFrom(first, options.device);
  const challenge = { cookie: 'qorloop.challenge=' + challengeCookie(first)!.value + (options.device ? '; qorloop.device=' + options.device : ''), csrf: '' };
  return sessionFrom(await request('POST', '/api/auth/otp/verify', store, challenge, { code: await codeFor(store, email) }), options.device);
}
async function createOwner(slug: string) {
  const result = await new AuthService(fixture.database, config).provision({ name: slug, slug, hostname: slug + '.localhost', ownerEmail: 'owner@example.test' });
  const store = { id: result.tenantId, hostname: slug + '.localhost', owner: {} as Session };
  store.owner = await stepUp(sessionFrom(await request('POST', '/api/auth/invitations/accept', store, undefined, { token: await tokenFor(result.invitationId), name: 'Owner', password })));
  return store;
}
async function invite(store: Store, role: string, email = 'user' + (++counter) + '@example.test') {
  const response = await request('POST', '/api/team/invitations', store, await stepUp(store.owner), { role, email });
  expect(response.statusCode).toBe(200);
  return { id: response.json().data.id as string, email };
}
async function acceptMember(store: Store, role: string) {
  const invited = await invite(store, role);
  const token = await tokenFor(invited.id);
  const response = await request('POST', '/api/auth/invitations/accept', store, undefined, { token, name: 'Team member', password });
  return { ...invited, session: await stepUp(sessionFrom(response)), token };
}

beforeAll(async () => {
  fixture = await testDatabase();
  api = await buildApp(config, { database: fixture.database, logger: false, ...testServices() });
  a = await createOwner('dohafresh');
  b = await createOwner('otherstore');
}, 120000);
afterAll(async () => { if (api) await api.app.close(); if (fixture) await fixture.close(); });

describe('Foundation and tenant routing', () => {
  it('runs real readiness checks and returns 503 when the database is unavailable', async () => {
    expect((await api.server.inject('/health')).statusCode).toBe(200);
    expect((await api.server.inject('/health/ready')).statusCode).toBe(200);
    const ping = jest.spyOn(fixture.database, 'ping').mockRejectedValueOnce(new Error('contains-private-database-details'));
    const failed = await api.server.inject('/health/ready');
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('private-database');
    expect(failed.json().requestId).toMatch(/^[a-f0-9-]{36}$/);
    ping.mockRestore();
  });
  it('has no signup or public provisioning route, and protects the old mock profile path', async () => {
    for (const path of ['/api/auth/signup', '/api/auth/sign-up/email', '/api/provision']) expect((await request('POST', path, a, undefined, {})).statusCode).toBe(404);
    expect((await request('GET', '/api/me', a)).statusCode).toBe(401);
  });
  it('resolves exact hosts, ignores forwarded tenant headers, and binds cookies to a tenant', async () => {
    expect((await request('GET', '/api/auth/me', b, a.owner)).statusCode).toBe(401);
    expect((await request('GET', '/api/team/members', b, a.owner)).statusCode).toBe(401);
    expect((await request('GET', '/api/auth/me', { hostname: 'evil' + a.hostname }, a.owner)).statusCode).toBe(404);
    const me = await request('GET', '/api/auth/me?tenant_id=' + b.id, a, a.owner, undefined, { 'x-tenant-id': b.id, 'x-forwarded-host': b.hostname });
    expect(me.json().data.tenant.id).toBe(a.id);
    const sameEmail = await fixture.prisma.user.findMany({ where: { email: 'owner@example.test' } });
    expect(sameEmail).toHaveLength(2);
  });
  it('ignores TENANT_ID outside production, so every local store resolves by its host', async () => {
    const pinned = await buildApp({ ...config, TENANT_ID: a.id }, { database: fixture.database, logger: false, ...testServices() });
    for (const store of [a, b]) {
      const response = await pinned.server.inject({ url: '/api/auth/session', headers: { host: store.hostname + ':4000' } });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }
    expect((await pinned.server.inject({ url: '/api/auth/session', headers: { host: 'unknown.localhost:4000' } })).statusCode).toBe(404);
    await pinned.app.close();
  });
  it('enforces the configured instance pin in production', async () => {
    const calls: [string, string | undefined][] = [];
    const db = { resolve: async (host: string, pin?: string) => { calls.push([host, pin]); return pin === a.id && host === a.hostname ? { id: a.id } : null; } };
    const guard = new SecurityGuard({ getAllAndOverride: () => ({ public: true }) } as never, db as never, {} as never, { ...config, NODE_ENV: 'production', TENANT_ID: a.id });
    const execution = (host: string) => ({ getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => ({ headers: { host } }) }) }) as never;
    await expect(guard.canActivate(execution(a.hostname + ':443'))).resolves.toBe(true);
    await expect(guard.canActivate(execution(b.hostname + ':443'))).rejects.toThrow('Store not found');
    expect(calls).toEqual([[a.hostname, a.id], [b.hostname, a.id]]);
    expect(tenantPin({ NODE_ENV: 'production', TENANT_ID: a.id })).toBe(a.id);
    expect(tenantPin({ NODE_ENV: 'development', TENANT_ID: a.id })).toBeUndefined();
    expect(tenantPin({ NODE_ENV: 'test', TENANT_ID: a.id })).toBeUndefined();
  });
  it('uses tenant foreign keys to reject a cross-tenant membership', async () => {
    const user = await fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id, email: 'owner@example.test' } });
    await expect(fixture.prisma.membership.create({ data: { tenantId: b.id, userId: user.id, role: 'analyst' } })).rejects.toThrow();
  });
  it('publishes the new sign-in contracts without a signup path or the removed MFA routes', async () => {
    for (const path of ['/api/auth/otp/verify', '/api/auth/otp/resend', '/api/auth/step-up/verify', '/api/account/sessions', '/api/team/members/{id}/role']) expect(api.spec.paths[path]).toBeDefined();
    for (const path of ['/api/auth/mfa/setup', '/api/auth/mfa/verify', '/api/auth/mfa/recovery']) expect(api.spec.paths[path]).toBeUndefined();
    expect(Object.keys(api.spec.paths).some(path => /signup|sign-up|provision/.test(path))).toBe(false);
    expect((await api.server.inject('/docs/openapi.json')).statusCode).toBe(200);
  });
});

describe('Invitation-only accounts, devices and second factors', () => {
  it('activates on a trusted device and stores only protected credentials', async () => {
    const users = await fixture.prisma.user.findMany();
    for (const user of users) {
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.mfaSecret).toBeNull();
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    }
    const me = await request('GET', '/api/auth/me', a, a.owner);
    expect(me.statusCode).toBe(200);
    expect(me.json().data).toMatchObject({ mfaEnabled: false });
    expect(me.body).not.toMatch(/passwordHash|mfaSecret|tokenHash/);
    const session = await fixture.prisma.session.findUniqueOrThrow({ where: { tokenHash: digest(sessionToken(a.owner)) }, include: { device: true } });
    expect(session.device!.tokenHash).toBe(digest(a.owner.device!));
    expect(session.device!.tokenHash).not.toBe(a.owner.device);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeGreaterThan(19.9 * 86_400_000);
    expect(session.device!.expiresAt.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
  });
  it('rejects invitation replay, expiry, foreign-tenant tokens and client tenant IDs', async () => {
    const member = await acceptMember(a, 'analyst');
    const payload = { token: member.token, name: 'Replay', password };
    expect((await request('POST', '/api/auth/invitations/accept', a, undefined, payload)).statusCode).toBe(400);
    const pending = await invite(a, 'analyst');
    const token = await tokenFor(pending.id);
    expect((await request('POST', '/api/auth/invitations/accept', b, undefined, { ...payload, token })).statusCode).toBe(400);
    expect((await request('POST', '/api/auth/invitations/accept', a, undefined, { ...payload, token, tenantId: b.id })).statusCode).toBe(400);
    await fixture.prisma.invitation.update({ where: { id: pending.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request('POST', '/api/auth/invitations/accept', a, undefined, { ...payload, token })).statusCode).toBe(400);
  });
  it('issues only one invitation when operations initialization is retried', async () => {
    const auth = new AuthService(fixture.database, config);
    const input = { name: 'Retry store', slug: 'retry-store', hostname: 'retry-store.localhost', ownerEmail: 'retry@example.test' };
    const first = await auth.provision(input);
    const second = await auth.provision(input);
    expect(second).toEqual({ ...first, created: false });
    expect(await fixture.prisma.invitation.count({ where: { tenantId: first.tenantId } })).toBe(1);
    expect(await fixture.prisma.emailOutbox.count({ where: { tenantId: first.tenantId } })).toBe(1);
    await expect(auth.provision({ ...input, ownerEmail: 'different@example.test' })).rejects.toThrow('differs');
  });
  it('signs in with the password only on a trusted device, and asks a new device for the emailed code', async () => {
    const trusted = await request('POST', '/api/auth/login', a, { cookie: 'qorloop.device=' + a.owner.device, csrf: '' }, { email: 'owner@example.test', password });
    expect(trusted.json().data.state).toBe('authenticated');
    expect(trusted.cookies.find(c => c.name === 'qorloop.device')).toBeUndefined();

    const fresh = await request('POST', '/api/auth/login', a, undefined, { email: 'owner@example.test', password });
    expect(fresh.json().data).toMatchObject({ state: 'otp_required', maskedEmail: 'o***@e***.test' });
    expect(fresh.json().data.csrfToken).toBeUndefined();
    const cookie = challengeCookie(fresh)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    const challenge = { cookie: 'qorloop.challenge=' + cookie.value, csrf: '' };
    expect((await request('GET', '/api/auth/me', a, challenge)).statusCode).toBe(401);
    const code = await codeFor(a, 'owner@example.test');
    const wrong = await request('POST', '/api/auth/otp/verify', a, challenge, { code: code === '000000' ? '000001' : '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toMatchObject({ code: 'OTP_INVALID', meta: { attemptsLeft: 4 } });
    expect(wrong.body).not.toContain(code);
    expect((await request('POST', '/api/auth/otp/verify', b, challenge, { code })).statusCode).toBe(401);
    const verified = await request('POST', '/api/auth/otp/verify', a, challenge, { code });
    const session = sessionFrom(verified);
    expect(session.device).toBeDefined();
    expect(session.device).not.toBe(a.owner.device);
    expect((await request('GET', '/api/auth/me', a, session)).statusCode).toBe(200);
    expect((await request('POST', '/api/auth/otp/verify', a, challenge, { code })).json().error.code).toBe('CHALLENGE_EXPIRED');
    const actions = (await fixture.prisma.auditEvent.findMany({ where: { tenantId: a.id, action: { startsWith: 'auth.' } } })).map(e => e.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.otp_sent', 'auth.otp_failed', 'auth.otp_verified', 'auth.new_device', 'auth.login_succeeded']));
    expect(JSON.stringify(await fixture.prisma.auditEvent.findMany({ where: { tenantId: a.id } }))).not.toContain(code);
  });
  it('gives a shared computer no device trust and a 12-hour session', async () => {
    const first = await request('POST', '/api/auth/login', a, { cookie: 'qorloop.device=' + a.owner.device, csrf: '' }, { email: 'owner@example.test', password, sharedDevice: true });
    expect(first.json().data.state).toBe('otp_required');
    const verified = await request('POST', '/api/auth/otp/verify', a, { cookie: 'qorloop.challenge=' + challengeCookie(first)!.value, csrf: '' }, { code: await codeFor(a, 'owner@example.test') });
    expect(verified.cookies.find(c => c.name === 'qorloop.device')).toBeUndefined();
    const shared = sessionFrom(verified);
    const row = await fixture.prisma.session.findUniqueOrThrow({ where: { tokenHash: digest(sessionToken(shared)) } });
    expect(row.deviceId).toBeNull();
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(12 * 3_600_000 + 1000);
    expect((await request('GET', '/api/auth/me', a, shared)).statusCode).toBe(200);
  });
  it('refuses a session cookie without its own device cookie', async () => {
    const bare = { cookie: 'qorloop=' + sessionToken(a.owner), csrf: a.owner.csrf };
    expect((await request('GET', '/api/auth/me', a, bare)).json().error.code).toBe('SESSION_EXPIRED');
    const member = await acceptMember(a, 'analyst');
    const swapped = { cookie: 'qorloop=' + sessionToken(a.owner) + '; qorloop.device=' + member.session.device, csrf: a.owner.csrf };
    expect((await request('GET', '/api/auth/me', a, swapped)).statusCode).toBe(401);
    expect((await request('GET', '/api/auth/me', a, a.owner)).statusCode).toBe(200);
  });
  it('uses the authenticator app instead of the email code once enrolled, and consumes recovery codes once', async () => {
    const member = await acceptMember(b, 'admin');
    const setup = await request('POST', '/api/account/authenticator/setup', b, member.session, { password });
    expect(setup.statusCode).toBe(200);
    const secret = new URL(setup.json().data.totpUri).searchParams.get('secret')!;
    const enrolled = await request('POST', '/api/account/authenticator/verify', b, member.session, { code: await generate({ secret }) });
    expect(enrolled.statusCode).toBe(200);
    const recoveryCodes = enrolled.json().data.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);
    const user = await fixture.prisma.user.findFirstOrThrow({ where: { tenantId: b.id, email: member.email } });
    expect(user.mfaSecret).toMatch(/^Fe26/);

    const mailsBefore = await fixture.prisma.emailOutbox.count({ where: { tenantId: b.id, dedupeKey: { startsWith: 'otp:' } } });
    const first = await request('POST', '/api/auth/login', b, undefined, { email: member.email, password });
    expect(first.json().data).toMatchObject({ state: 'totp_required', maskedEmail: null, resendAvailableAt: null });
    expect(await fixture.prisma.emailOutbox.count({ where: { tenantId: b.id, dedupeKey: { startsWith: 'otp:' } } })).toBe(mailsBefore);
    const challenge = { cookie: 'qorloop.challenge=' + challengeCookie(first)!.value, csrf: '' };
    expect((await request('POST', '/api/auth/otp/resend', b, challenge)).json().error.code).toBe('CHALLENGE_EXPIRED');
    await fixture.prisma.user.update({ where: { id: user.id }, data: { lastTotpStep: Math.floor(Date.now() / 30_000) - 2 } });
    const viaApp = await request('POST', '/api/auth/otp/verify', b, challenge, { code: await generate({ secret }) });
    expect(viaApp.statusCode).toBe(200);

    const second = await request('POST', '/api/auth/login', b, undefined, { email: member.email, password });
    const recovery = { cookie: 'qorloop.challenge=' + challengeCookie(second)!.value, csrf: '' };
    expect((await request('POST', '/api/auth/otp/recovery', b, recovery, { code: recoveryCodes[0] })).statusCode).toBe(200);
    const third = await request('POST', '/api/auth/login', b, undefined, { email: member.email, password });
    const again = { cookie: 'qorloop.challenge=' + challengeCookie(third)!.value, csrf: '' };
    expect((await request('POST', '/api/auth/otp/recovery', b, again, { code: recoveryCodes[0] })).json().error.code).toBe('OTP_INVALID');
    expect((await request('POST', '/api/auth/otp/recovery', b, again, { code: recoveryCodes[1] })).statusCode).toBe(200);
  });
  it('honors a store rule requiring an authenticator app', async () => {
    const member = await acceptMember(b, 'analyst');
    await fixture.prisma.tenantSettings.update({ where: { tenantId: b.id }, data: { mfaRequiredForAll: true } });
    try {
      const blocked = await request('GET', '/api/auth/me', b, member.session);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('AUTHENTICATOR_SETUP_REQUIRED');
      expect((await request('POST', '/api/account/authenticator/setup', b, member.session, { password })).statusCode).toBe(200);
      const signIn = await request('POST', '/api/auth/login', b, { cookie: 'qorloop.device=' + member.session.device, csrf: '' }, { email: member.email, password });
      expect(signIn.json().data.state).toBe('authenticator_setup_required');
    } finally { await fixture.prisma.tenantSettings.update({ where: { tenantId: b.id }, data: { mfaRequiredForAll: false } }); }
  });
});

describe('Team authorization and lifecycle', () => {
  it('keeps Analysts and Catalogue Managers out of team mutations', async () => {
    for (const role of ['analyst', 'catalogue_manager']) {
      const member = await acceptMember(a, role);
      expect((await request('GET', '/api/team/members', a, member.session)).statusCode).toBe(200);
      expect((await request('GET', '/api/team/invitations', a, member.session)).statusCode).toBe(403);
      expect((await request('POST', '/api/team/invitations', a, member.session, { email: 'denied@example.test', role: 'admin' })).statusCode).toBe(403);
      const target = await fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, role: 'owner' } });
      expect((await request('PATCH', '/api/team/members/' + target.id + '/role', a, member.session, { role: 'analyst' })).statusCode).toBe(403);
      expect((await request('DELETE', '/api/team/members/' + target.id, a, member.session)).statusCode).toBe(403);
    }
  });
  it('asks for a fresh code (security window) before invitations, role changes and removal', async () => {
    const member = await acceptMember(a, 'analyst');
    const membership = await fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, user: { email: member.email } } });
    await fixture.prisma.session.update({ where: { tokenHash: digest(sessionToken(a.owner)) }, data: { stepUpAt: new Date(Date.now() - 11 * 60_000) } });
    for (const [method, url, body] of [['POST', '/api/team/invitations', { email: 'later@example.test', role: 'analyst' }], ['PATCH', `/api/team/members/${membership.id}/role`, { role: 'admin' }],
      ['DELETE', `/api/team/members/${membership.id}`, undefined]] as const) {
      const r = await request(method, url, a, a.owner, body);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', meta: { window: 'security' } });
    }
    expect((await fixture.prisma.membership.findUniqueOrThrow({ where: { id: membership.id } })).role).toBe('analyst');
    // Revoking an invitation only lowers risk: no step-up.
    const pending = await fixture.prisma.invitation.create({ data: { tenantId: a.id, email: 'norevoke@example.test', pendingEmail: 'norevoke@example.test', role: 'analyst', tokenHash: digest('x' + Date.now()), expiresAt: new Date(Date.now() + 3_600_000) } });
    expect((await request('DELETE', '/api/team/invitations/' + pending.id, a, a.owner)).statusCode).toBe(200);
    await stepUp(a.owner);
  });
  it('prevents Admins from inviting, promoting, demoting or removing Owners', async () => {
    const admin = await acceptMember(a, 'admin');
    const owner = await fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, role: 'owner' } });
    const own = await fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, user: { email: admin.email } } });
    expect((await request('POST', '/api/team/invitations', a, admin.session, { email: 'newowner@example.test', role: 'owner' })).statusCode).toBe(403);
    expect((await request('PATCH', '/api/team/members/' + own.id + '/role', a, admin.session, { role: 'owner' })).statusCode).toBe(403);
    expect((await request('PATCH', '/api/team/members/' + owner.id + '/role', a, admin.session, { role: 'admin' })).statusCode).toBe(403);
    expect((await request('DELETE', '/api/team/members/' + owner.id, a, admin.session)).statusCode).toBe(403);
  });
  it('retains the only active Owner and hides foreign member identifiers', async () => {
    const owner = await fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, role: 'owner' } });
    const foreign = await fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: b.id } });
    expect((await request('DELETE', '/api/team/members/' + owner.id, a, a.owner)).statusCode).toBe(409);
    expect((await request('PATCH', '/api/team/members/' + owner.id + '/role', a, a.owner, { role: 'admin' })).statusCode).toBe(409);
    expect((await request('DELETE', '/api/team/members/' + foreign.id, a, a.owner)).statusCode).toBe(404);
    expect((await request('PATCH', '/api/team/members/' + foreign.id + '/role', a, a.owner, { role: 'admin' })).statusCode).toBe(404);
  });
  it('rotates resend tokens, rejects duplicates, scopes invitation IDs and supports revocation', async () => {
    const invited = await invite(a, 'analyst');
    const oldToken = await tokenFor(invited.id);
    expect((await request('POST', '/api/team/invitations', a, a.owner, { email: invited.email, role: 'analyst' })).statusCode).toBe(409);
    expect((await request('POST', '/api/team/invitations/' + invited.id + '/resend', b, await stepUp(b.owner))).statusCode).toBe(404);
    expect((await request('DELETE', '/api/team/invitations/' + invited.id, b, b.owner)).statusCode).toBe(404);
    expect((await request('POST', '/api/team/invitations/' + invited.id + '/resend', a, a.owner)).statusCode).toBe(200);
    const latest = await tokenFor(invited.id);
    expect(latest).not.toBe(oldToken);
    expect((await request('POST', '/api/auth/invitations/accept', a, undefined, { token: oldToken, name: 'Old', password })).statusCode).toBe(400);
    expect((await request('DELETE', '/api/team/invitations/' + invited.id, a, a.owner)).statusCode).toBe(200);
    expect((await request('POST', '/api/auth/invitations/accept', a, undefined, { token: latest, name: 'Revoked', password })).statusCode).toBe(400);
  });
  it('signs a member out on every device after a role change or removal and writes audit events', async () => {
    const member = await acceptMember(a, 'analyst');
    const membership = await fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, user: { email: member.email } } });
    expect((await request('PATCH', '/api/team/members/' + membership.id + '/role', a, await stepUp(a.owner), { role: 'catalogue_manager' })).statusCode).toBe(200);
    expect((await request('GET', '/api/auth/me', a, member.session)).statusCode).toBe(401);
    // The device lost its trust too: signing in again needs the emailed code.
    const again = await request('POST', '/api/auth/login', a, { cookie: 'qorloop.device=' + member.session.device, csrf: '' }, { email: member.email, password });
    expect(again.json().data.state).toBe('otp_required');
    const current = await signIn(a, member.email);
    expect((await request('DELETE', '/api/team/members/' + membership.id, a, a.owner)).statusCode).toBe(200);
    expect((await request('GET', '/api/auth/me', a, current)).statusCode).toBe(401);
    expect(await fixture.prisma.trustedDevice.count({ where: { tenantId: a.id, userId: membership.userId } })).toBe(0);
    expect((await request('POST', '/api/auth/login', a, undefined, { email: member.email, password })).statusCode).toBe(401);
    const events = await fixture.prisma.auditEvent.findMany({ where: { tenantId: a.id, entityId: membership.id } });
    expect(events.map(e => e.action)).toEqual(expect.arrayContaining(['team.role_changed', 'team.member_deactivated']));
    expect(events.every(e => Boolean(e.requestId))).toBe(true);
  });
});

describe('Session, CSRF, password reset and throttling', () => {
  it('requires a matching Origin and session-bound CSRF token', async () => {
    expect((await request('POST', '/api/team/invitations', a, a.owner, { email: 'csrf@example.test', role: 'analyst' }, { 'x-csrf-token': '' })).statusCode).toBe(403);
    expect((await request('POST', '/api/auth/logout', a, a.owner, undefined, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await request('POST', '/api/auth/login', a, undefined, { email: 'owner@example.test', password }, { origin: '' })).statusCode).toBe(403);
    expect((await request('POST', '/api/auth/otp/verify', a, undefined, { code: '123456' }, { origin: '' })).statusCode).toBe(403);
    expect((await request('GET', '/api/auth/me', a, a.owner, undefined, { origin: 'http://' + b.hostname + ':3000' })).statusCode).toBe(403);
    expect((await request('OPTIONS', '/api/auth/login', a)).statusCode).toBe(204);
  });
  it('enforces 7 days idle and the 20-day hard limit; logout keeps the device trusted', async () => {
    const member = await acceptMember(a, 'analyst');
    await fixture.prisma.session.update({ where: { tokenHash: digest(sessionToken(member.session)) }, data: { lastSeenAt: new Date(Date.now() - 7 * 86_400_000 - 60_000) } });
    expect((await request('GET', '/api/auth/me', a, member.session)).json().error.code).toBe('SESSION_EXPIRED');
    const current = await signIn(a, member.email, { device: member.session.device });
    // Active every day still ends at the hard limit, 20 days from sign-in.
    await fixture.prisma.session.update({ where: { tokenHash: digest(sessionToken(current)) }, data: { createdAt: new Date(Date.now() - 20 * 86_400_000), lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1000) } });
    expect((await request('GET', '/api/auth/me', a, current)).json().error.code).toBe('SESSION_EXPIRED');
    const logout = await signIn(a, member.email, { device: member.session.device });
    expect((await request('POST', '/api/auth/logout', a, logout)).statusCode).toBe(200);
    expect((await request('GET', '/api/auth/me', a, logout)).statusCode).toBe(401);
    const back = await request('POST', '/api/auth/login', a, { cookie: 'qorloop.device=' + member.session.device, csrf: '' }, { email: member.email, password });
    expect(back.json().data.state).toBe('authenticated');
  });
  it('uses generic forgot responses and tenant-bound, expiring, single-use reset tokens; a reset signs out every device', async () => {
    const member = await acceptMember(b, 'analyst');
    const known = await request('POST', '/api/auth/password/forgot', b, undefined, { email: member.email });
    const unknown = await request('POST', '/api/auth/password/forgot', b, undefined, { email: 'absent@example.test' });
    expect(known.json()).toEqual(unknown.json());
    const user = await fixture.prisma.user.findFirstOrThrow({ where: { tenantId: b.id, email: member.email } });
    const reset = await fixture.prisma.passwordReset.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    const token = await tokenFor(reset.id, 'reset');
    const payload = { token, password: 'A new strong password for testing!' };
    expect((await request('POST', '/api/auth/password/reset', a, undefined, payload)).statusCode).toBe(400);
    expect((await request('POST', '/api/auth/password/reset', b, undefined, payload)).statusCode).toBe(200);
    expect((await request('POST', '/api/auth/password/reset', b, undefined, payload)).statusCode).toBe(400);
    expect((await request('GET', '/api/auth/me', b, member.session)).statusCode).toBe(401);
    expect(await fixture.prisma.trustedDevice.count({ where: { tenantId: b.id, userId: user.id } })).toBe(0);
    expect((await request('POST', '/api/auth/login', b, undefined, { email: member.email, password })).statusCode).toBe(401);
    expect((await request('GET', '/api/auth/me', b, await signIn(b, member.email, { secret: payload.password }))).statusCode).toBe(200);
    await request('POST', '/api/auth/password/forgot', b, undefined, { email: member.email });
    const expired = await fixture.prisma.passwordReset.findFirstOrThrow({ where: { userId: user.id, usedAt: null } });
    await fixture.prisma.passwordReset.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request('POST', '/api/auth/password/reset', b, undefined, { ...payload, token: await tokenFor(expired.id, 'reset') })).statusCode).toBe(400);
  });
  it('rate-limits sensitive auth requests and returns a request ID', async () => {
    let response = await request('POST', '/api/auth/login', a, undefined, { email: 'absent@example.test', password }, undefined, '127.0.0.99');
    for (let i = 0; i < 20; i++) response = await request('POST', '/api/auth/login', a, undefined, { email: 'absent@example.test', password }, undefined, '127.0.0.99');
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('RATE_LIMITED');
    expect(response.headers['retry-after']).toBeDefined();
    expect(response.json().requestId).toBeDefined();
  });
});
