import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { generate } from 'otplib';
import type { HTTPMethods } from 'fastify';
import { buildApp } from '../app.js';
import { AuthService } from '../auth/auth.service.js';
import { loadConfig } from '../../../../packages/shared/src/config.js';
import { digest, unseal } from '../../../../packages/shared/src/security.js';
import { testDatabase } from './database.js';

const password = 'Correct horse battery staple!';
type Session = { cookie: string; csrf: string; recoveryCodes?: string[] };
type Store = { id: string; hostname: string; owner: Session };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let api: Awaited<ReturnType<typeof buildApp>>;
let a: Store, b: Store;
let counter = 0;
const onboarding: { blocked: number; state: string; rotated: boolean; httpOnly: boolean }[] = [];
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters', APP_ORIGIN: 'http://dohafresh.localhost:3000' });

function request(method: HTTPMethods, url: string, store: Pick<Store, 'hostname'>, session?: Session, payload?: Record<string, unknown>, extra?: Record<string, string>, remoteAddress = '127.0.0.1') {
  return api.server.inject({
    method, url, remoteAddress,
    headers: { host: store.hostname + ':4000', origin: 'http://' + store.hostname + ':3000', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...extra },
    ...(payload ? { payload } : {}),
  });
}
function sessionFrom(response: Awaited<ReturnType<typeof request>>): Session {
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find(c => c.name === 'qorloop');
  expect(cookie).toBeDefined();
  return { cookie: 'qorloop=' + cookie!.value, csrf: response.json().data.csrfToken, recoveryCodes: response.json().data.recoveryCodes };
}
async function tokenFor(id: string, kind = 'invitation') {
  const message = await fixture.prisma.emailOutbox.findFirstOrThrow({ where: { dedupeKey: { startsWith: kind + ':' + id } }, orderBy: { createdAt: 'desc' } });
  const plaintext = await unseal<{text: string}>(message.sealedMessage, config.AUTH_SECRET);
  const token = plaintext.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  expect(token).toHaveLength(43);
  return token!;
}
async function createOwner(slug: string) {
  const auth = new AuthService(fixture.database, config);
  const result = await auth.provision({ name: slug, slug, hostname: slug + '.localhost', ownerEmail: 'owner@example.test' });
  const store = { id: result.tenantId, hostname: slug + '.localhost', owner: {} as Session };
  const accepted = await request('POST', '/api/auth/invitations/accept', store, undefined, { token: await tokenFor(result.invitationId), name: 'Owner', password });
  const pending = sessionFrom(accepted);
  const blocked = await request('GET', '/api/auth/me', store, pending);
  const setup = await request('POST', '/api/auth/mfa/setup', store, pending, { password });
  expect(setup.statusCode).toBe(200);
  const secret = new URL(setup.json().data.totpUri).searchParams.get('secret')!;
  const verified = await request('POST', '/api/auth/mfa/verify', store, pending, { code: await generate({ secret }) });
  store.owner = sessionFrom(verified);
  onboarding.push({ blocked: blocked.statusCode, state: accepted.json().data.state, rotated: pending.cookie !== store.owner.cookie, httpOnly: Boolean(accepted.cookies.find(c => c.name === 'qorloop')?.httpOnly) });
  return store;
}
async function invite(store: Store, role: string, email = 'user' + (++counter) + '@example.test') {
  const response = await request('POST', '/api/team/invitations', store, store.owner, { role, email });
  expect(response.statusCode).toBe(200);
  return { id: response.json().data.id as string, email };
}
async function acceptMember(store: Store, role: string) {
  const invited = await invite(store, role);
  const token = await tokenFor(invited.id);
  const response = await request('POST', '/api/auth/invitations/accept', store, undefined, { token, name: 'Team member', password });
  return { ...invited, session: sessionFrom(response), token };
}

beforeAll(async () => {
  fixture = await testDatabase();
  api = await buildApp(config, { database: fixture.database, logger: false });
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
  it('enforces configured instance pins as well as host resolution', async () => {
    const pinned = await buildApp({ ...config, TENANT_ID: a.id }, { database: fixture.database, logger: false });
    const response = await pinned.server.inject({ url: '/api/auth/me', headers: { host: b.hostname } });
    expect(response.statusCode).toBe(404);
    await pinned.app.close();
  });
  it('uses tenant foreign keys to reject a cross-tenant membership', async () => {
    const user = await fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id } });
    await expect(fixture.prisma.membership.create({ data: { tenantId: b.id, userId: user.id, role: 'analyst' } })).rejects.toThrow();
  });
  it('publishes contracts without a signup path', async () => {
    expect(api.spec.paths['/api/auth/mfa/verify']).toBeDefined();
    expect(api.spec.paths['/api/team/members/{id}/role']).toBeDefined();
    expect(Object.keys(api.spec.paths).some(path => /signup|sign-up|provision/.test(path))).toBe(false);
    expect((await api.server.inject('/docs/openapi.json')).statusCode).toBe(200);
  });
});

describe('Invitation-only accounts and MFA', () => {
  it('restricts Owners until MFA, rotates the cookie, and stores only protected credentials', async () => {
    for (const flow of onboarding) expect(flow).toEqual({ blocked: 403, state: 'mfa_setup_required', rotated: true, httpOnly: true });
    const users = await fixture.prisma.user.findMany();
    for (const user of users) {
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.mfaSecret).toMatch(/^Fe26/);
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);
      expect(user.pendingMfaSecret).toBeNull();
    }
    const me = await request('GET', '/api/auth/me', a, a.owner);
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toMatch(/passwordHash|mfaSecret|tokenHash/);
    expect(a.owner.recoveryCodes).toHaveLength(10);
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
  it('requires MFA on every Owner login and consumes recovery codes only once', async () => {
    const login = await request('POST', '/api/auth/login', a, undefined, { email: 'owner@example.test', password });
    expect(login.json().data.state).toBe('mfa_required');
    const pending = sessionFrom(login);
    expect((await request('GET', '/api/team/members', a, pending)).statusCode).toBe(403);
    expect((await request('POST', '/api/auth/mfa/recovery', b, pending, { code: a.owner.recoveryCodes![0] })).statusCode).toBe(401);
    const recovered = await request('POST', '/api/auth/mfa/recovery', a, pending, { code: a.owner.recoveryCodes![0] });
    const full = sessionFrom(recovered);
    expect((await request('GET', '/api/auth/me', a, full)).statusCode).toBe(200);
    expect((await request('GET', '/api/auth/me', a, pending)).statusCode).toBe(401);
    const another = sessionFrom(await request('POST', '/api/auth/login', a, undefined, { email: 'owner@example.test', password }));
    expect((await request('POST', '/api/auth/mfa/recovery', a, another, { code: a.owner.recoveryCodes![0] })).statusCode).toBe(401);
    expect((await request('POST', '/api/auth/mfa/recovery', a, another, { code: a.owner.recoveryCodes![1] })).statusCode).toBe(200);
  });
  it('rejects invalid and replayed TOTP steps, including simultaneous challenge sessions', async () => {
    const login1 = sessionFrom(await request('POST', '/api/auth/login', a, undefined, { email: 'owner@example.test', password }));
    const login2 = sessionFrom(await request('POST', '/api/auth/login', a, undefined, { email: 'owner@example.test', password }));
    expect((await request('POST', '/api/auth/mfa/verify', a, login1, { code: 'abcdef' })).statusCode).toBe(400);
    const user = await fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id } });
    const secret = await unseal<string>(user.mfaSecret!, config.AUTH_SECRET);
    await fixture.prisma.user.update({ where: { id: user.id }, data: { lastTotpStep: Math.floor(Date.now() / 30_000) - 1 } });
    const code = await generate({ secret });
    expect((await request('POST', '/api/auth/mfa/verify', a, login1, { code })).statusCode).toBe(200);
    expect((await request('POST', '/api/auth/mfa/verify', a, login2, { code })).statusCode).toBe(401);
  });
  it('honors configurable MFA requirements for non-Owners', async () => {
    const member = await acceptMember(b, 'analyst');
    await fixture.prisma.tenantSettings.update({ where: { tenantId: b.id }, data: { mfaRequiredForAll: true } });
    expect((await request('GET', '/api/auth/me', b, member.session)).statusCode).toBe(403);
    const login = await request('POST', '/api/auth/login', b, undefined, { email: member.email, password });
    expect(login.json().data.state).toBe('mfa_setup_required');
    await fixture.prisma.tenantSettings.update({ where: { tenantId: b.id }, data: { mfaRequiredForAll: false } });
  });
});

describe('Team authorization and lifecycle', () => {
  it('keeps Analysts and Catalogue Managers out of team mutations', async () => {
    for (const role of ['analyst', 'catalogue_manager']) {
      const member = await acceptMember(a, role);
      expect((await request('GET', '/api/team/members', a, member.session)).statusCode).toBe(200);
      expect((await request('GET', '/api/team/invitations', a, member.session)).statusCode).toBe(403);
      expect((await request('POST', '/api/team/invitations', a, member.session, { email: 'denied@example.test', role: 'admin' })).statusCode).toBe(403);
    }
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
    expect((await request('POST', '/api/team/invitations/' + invited.id + '/resend', b, b.owner)).statusCode).toBe(404);
    expect((await request('DELETE', '/api/team/invitations/' + invited.id, b, b.owner)).statusCode).toBe(404);
    expect((await request('POST', '/api/team/invitations/' + invited.id + '/resend', a, a.owner)).statusCode).toBe(200);
    const latest = await tokenFor(invited.id);
    expect(latest).not.toBe(oldToken);
    expect((await request('POST', '/api/auth/invitations/accept', a, undefined, { token: oldToken, name: 'Old', password })).statusCode).toBe(400);
    expect((await request('DELETE', '/api/team/invitations/' + invited.id, a, a.owner)).statusCode).toBe(200);
    expect((await request('POST', '/api/auth/invitations/accept', a, undefined, { token: latest, name: 'Revoked', password })).statusCode).toBe(400);
  });
  it('revokes sessions after role changes and deactivation and writes audit events', async () => {
    const member = await acceptMember(a, 'analyst');
    const membership = await fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, user: { email: member.email } } });
    expect((await request('PATCH', '/api/team/members/' + membership.id + '/role', a, a.owner, { role: 'catalogue_manager' })).statusCode).toBe(200);
    expect((await request('GET', '/api/auth/me', a, member.session)).statusCode).toBe(401);
    const current = sessionFrom(await request('POST', '/api/auth/login', a, undefined, { email: member.email, password }));
    expect((await request('DELETE', '/api/team/members/' + membership.id, a, a.owner)).statusCode).toBe(200);
    expect((await request('GET', '/api/auth/me', a, current)).statusCode).toBe(401);
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
    expect((await request('GET', '/api/auth/me', a, a.owner, undefined, { origin: 'http://' + b.hostname + ':3000' })).statusCode).toBe(403);
    expect((await request('OPTIONS', '/api/auth/login', a)).statusCode).toBe(204);
  });
  it('enforces idle expiry, absolute expiry and logout invalidation', async () => {
    const member = await acceptMember(a, 'analyst');
    const token = member.session.cookie.split('=')[1]!;
    await fixture.prisma.session.update({ where: { tokenHash: digest(token) }, data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
    expect((await request('GET', '/api/auth/me', a, member.session)).statusCode).toBe(401);
    const current = sessionFrom(await request('POST', '/api/auth/login', a, undefined, { email: member.email, password }));
    await fixture.prisma.session.update({ where: { tokenHash: digest(current.cookie.split('=')[1]!) }, data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 3_600_000) } });
    expect((await request('GET', '/api/auth/me', a, current)).statusCode).toBe(401);
    const logout = sessionFrom(await request('POST', '/api/auth/login', a, undefined, { email: member.email, password }));
    expect((await request('POST', '/api/auth/logout', a, logout)).statusCode).toBe(200);
    expect((await request('GET', '/api/auth/me', a, logout)).statusCode).toBe(401);
  });
  it('uses generic forgot responses and tenant-bound, expiring, single-use reset tokens', async () => {
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
    expect((await request('POST', '/api/auth/login', b, undefined, { email: member.email, password })).statusCode).toBe(401);
    expect((await request('POST', '/api/auth/login', b, undefined, { email: member.email, password: payload.password })).statusCode).toBe(200);
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

