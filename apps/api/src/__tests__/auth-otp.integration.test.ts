// Plan Part 5 (ADR 021): one-time code limits, step-up windows, the sessions screen and account changes, through the API.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { buildApp } from '../app.js';
import { digest, unseal } from '../../../../packages/shared/src/security.js';
import { createHarness, password, sessionToken, testServices, type Harness, type Session, type Store } from './harness.js';

let h: Harness;
let n = 0;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); });

const ownerEmail = (s: Store) => 'owner@' + s.hostname.replace(/\.localhost$/, '') + '.test';
const challengeOf = (r: { cookies: { name: string; value: string }[] }) => ({ cookie: 'qorloop.challenge=' + r.cookies.find(c => c.name === 'qorloop.challenge')!.value, csrf: '' });
async function startLogin(s: Store, email = ownerEmail(s)) {
  const r = await h.request('POST', '/api/auth/login', s, undefined, { email, password });
  expect(r.statusCode).toBe(200);
  return { response: r, challenge: challengeOf(r) };
}
const setSession = (session: Session, data: { stepUpAt?: Date | null; lastSeenAt?: Date }) =>
  h.fixture.prisma.session.update({ where: { tokenHash: digest(sessionToken(session)) }, data });
const store = () => h.createOwner('otp-' + (++n));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe('emailed one-time codes', () => {
  it('limits resends: 60 s apart, three per sign-in; a new code replaces the old one', async () => {
    const s = await store();
    const { response, challenge } = await startLogin(s);
    expect(response.json().data.resendAvailableAt).toEqual(expect.any(String));
    const first = await h.codeFor(s, ownerEmail(s));
    const early = await h.request('POST', '/api/auth/otp/resend', s, challenge);
    expect(early.statusCode).toBe(429);
    expect(early.json().error).toMatchObject({ code: 'OTP_SEND_LIMIT', meta: { retryAfterSeconds: expect.any(Number) } });
    const row = await h.fixture.prisma.loginChallenge.findFirstOrThrow({ where: { tenantId: s.id, purpose: 'login' }, orderBy: { createdAt: 'desc' } });
    await h.fixture.prisma.loginChallenge.update({ where: { id: row.id }, data: { lastSentAt: minutesAgo(2) } });
    expect((await h.request('POST', '/api/auth/otp/resend', s, challenge)).statusCode).toBe(200);
    const second = await h.codeFor(s, ownerEmail(s));
    await h.fixture.prisma.loginChallenge.update({ where: { id: row.id }, data: { lastSentAt: minutesAgo(2) } });
    const third = await h.request('POST', '/api/auth/otp/resend', s, challenge);
    expect(third.statusCode).toBe(200);
    expect(third.json().data.resendAvailableAt).toBeNull();
    await h.fixture.prisma.loginChallenge.update({ where: { id: row.id }, data: { lastSentAt: minutesAgo(2) } });
    expect((await h.request('POST', '/api/auth/otp/resend', s, challenge)).json().error.code).toBe('OTP_SEND_LIMIT');
    const latest = await h.codeFor(s, ownerEmail(s));
    for (const stale of [first, second].filter(c => c !== latest)) {
      expect((await h.request('POST', '/api/auth/otp/verify', s, challenge, { code: stale })).json().error.code).toBe('OTP_INVALID');
    }
    expect((await h.request('POST', '/api/auth/otp/verify', s, challenge, { code: latest })).statusCode).toBe(200);
    // Every code mail is first in line and is never delivered after its code expired.
    const mails = await h.fixture.prisma.emailOutbox.findMany({ where: { tenantId: s.id, dedupeKey: { startsWith: 'otp:' } } });
    expect(mails).toHaveLength(3);
    expect(mails.every(m => m.priority === 1 && m.discardAfter && m.discardAfter.getTime() - m.createdAt.getTime() <= 600_000 + 1000)).toBe(true);
    expect(h.mailTrigger.nudges).toBeGreaterThanOrEqual(3);
  });
  it('limits code emails per user (5 an hour) and per store (30 an hour)', async () => {
    const s = await store();
    const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id } });
    const seed = (userId: string, sends: number) => h.fixture.prisma.loginChallenge.create({ data: { tenantId: s.id, userId, purpose: 'login', method: 'email',
      challengeHash: digest('seed' + Math.random()), sends, lastSentAt: minutesAgo(5), expiresAt: minutesAgo(1), consumedAt: minutesAgo(1) } });
    await seed(owner.id, 5);
    const limited = await h.request('POST', '/api/auth/login', s, undefined, { email: ownerEmail(s), password });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: 'OTP_SEND_LIMIT', meta: { retryAfterSeconds: 3600 } });
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'auth.otp_send_limited' } })).toBe(1);

    const member = await h.member(s, 'analyst');
    const memberUser = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id, name: 'analyst' } });
    expect(member).toBeDefined();
    expect((await h.request('POST', '/api/auth/login', s, undefined, { email: memberUser.email, password })).statusCode).toBe(200);
    await seed(owner.id, 25);
    expect((await h.request('POST', '/api/auth/login', s, undefined, { email: memberUser.email, password })).json().error.code).toBe('OTP_SEND_LIMIT');
  });
  it('expires a code after 10 minutes and locks the sign-in after five wrong codes', async () => {
    const s = await store();
    let { challenge } = await startLogin(s);
    const row = await h.fixture.prisma.loginChallenge.findFirstOrThrow({ where: { tenantId: s.id, purpose: 'login' }, orderBy: { createdAt: 'desc' } });
    await h.fixture.prisma.loginChallenge.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await h.request('POST', '/api/auth/otp/verify', s, challenge, { code: await h.codeFor(s, ownerEmail(s)) })).json().error.code).toBe('CHALLENGE_EXPIRED');

    ({ challenge } = await startLogin(s));
    const code = await h.codeFor(s, ownerEmail(s)), wrong = code === '111111' ? '222222' : '111111';
    const lefts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await h.request('POST', '/api/auth/otp/verify', s, challenge, { code: wrong });
      expect(r.statusCode).toBe(401);
      lefts.push(r.json().error.meta.attemptsLeft);
      if (i === 4) expect(r.json().error.code).toBe('OTP_LOCKED');
    }
    expect(lefts).toEqual([4, 3, 2, 1, 0]);
    expect((await h.request('POST', '/api/auth/otp/verify', s, challenge, { code })).json().error.code).toBe('CHALLENGE_EXPIRED');
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'auth.otp_locked' } })).toBe(1);
  });
  it('never writes a code to the logs, the audit log, a response or the stored mail', async () => {
    const s = await store();
    const lines: string[] = [], services = testServices();
    const api = await buildApp(h.config, { database: h.fixture.database, ...services, rateLimitMax: 100000, logStream: { write: line => { lines.push(line); } } });
    try {
      const headers = { host: s.hostname + ':4000', origin: 'http://' + s.hostname + ':3000' };
      const login = await api.server.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email: ownerEmail(s), password } });
      const code = await h.codeFor(s, ownerEmail(s));
      const cookie = 'qorloop.challenge=' + login.cookies.find(c => c.name === 'qorloop.challenge')!.value;
      const wrong = await api.server.inject({ method: 'POST', url: '/api/auth/otp/verify', headers: { ...headers, cookie }, payload: { code: code === '999999' ? '999998' : '999999' } });
      const ok = await api.server.inject({ method: 'POST', url: '/api/auth/otp/verify', headers: { ...headers, cookie }, payload: { code } });
      expect(ok.statusCode).toBe(200);
      for (const text of [lines.join('\n'), login.body, wrong.body, ok.body, JSON.stringify(await h.fixture.prisma.auditEvent.findMany({ where: { tenantId: s.id } })),
        JSON.stringify(await h.fixture.prisma.loginChallenge.findMany({ where: { tenantId: s.id } })), JSON.stringify(await h.fixture.prisma.emailOutbox.findMany({ where: { tenantId: s.id } }))]) {
        expect(text).not.toContain(code);
      }
      expect(lines.join('\n')).not.toContain(ownerEmail(s));
    } finally { await api.app.close(); await services.recon.drain(); }
  });
});

describe('step-up: a fresh code before sensitive actions', () => {
  it('asks for a code, accepts the emailed one and opens both windows', async () => {
    const s = await store();
    await setSession(s.owner, { stepUpAt: null });
    const invite = () => h.request('POST', '/api/team/invitations', s, s.owner, { email: 'stepped' + Math.random() + '@example.test', role: 'analyst' });
    expect((await invite()).json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', meta: { window: 'security' } });
    const start = await h.request('POST', '/api/auth/step-up/start', s, s.owner);
    expect(start.json().data).toMatchObject({ method: 'email', maskedEmail: expect.stringContaining('***@') });
    const code = await h.codeFor(s, ownerEmail(s));
    expect((await h.request('POST', '/api/auth/step-up/verify', s, s.owner, { code: code === '123123' ? '321321' : '123123' })).json().error.code).toBe('OTP_INVALID');
    const verified = await h.request('POST', '/api/auth/step-up/verify', s, s.owner, { code });
    expect(verified.statusCode).toBe(200);
    const { securityValidUntil, workValidUntil } = verified.json().data;
    expect(Date.parse(securityValidUntil) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(securityValidUntil) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(Date.parse(workValidUntil) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect((await invite()).statusCode).toBe(200);
    expect((await h.request('POST', '/api/auth/step-up/verify', s, s.owner, { code })).json().error.code).toBe('CHALLENGE_EXPIRED');
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'auth.step_up_verified' } })).toBe(1);
  });
  it('keeps security actions to 10 minutes and daily work to 30 minutes', async () => {
    const s = await store();
    const pricing = () => h.request('PUT', '/api/pricing/settings', s, s.owner, { rounding: '0.25' });
    const security = () => h.request('POST', '/api/account/sessions/revoke-all', s, s.owner, { includeCurrent: false });
    await setSession(s.owner, { stepUpAt: minutesAgo(9.9) });
    expect((await security()).statusCode).toBe(200);
    await setSession(s.owner, { stepUpAt: minutesAgo(12) });
    expect((await security()).json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', meta: { window: 'security' } });
    expect((await pricing()).statusCode).toBe(200);
    await setSession(s.owner, { stepUpAt: minutesAgo(29.9) });
    expect((await pricing()).statusCode).toBe(200);
    await setSession(s.owner, { stepUpAt: minutesAgo(31) });
    expect((await pricing()).json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', meta: { window: 'work' } });
    // General settings: profile and thresholds need none, security fields the 10-minute window, pricing the 30-minute one.
    const revision = async () => (await h.request('GET', '/api/settings', s, s.owner)).json().data.revision;
    expect((await h.request('PUT', '/api/settings', s, s.owner, { expectedRevision: await revision(), thresholds: { staleHours: 24 } })).statusCode).toBe(200);
    expect((await h.request('PUT', '/api/settings', s, s.owner, { expectedRevision: await revision(), security: { analystCanExport: false } })).json().error.code).toBe('STEP_UP_REQUIRED');
  });
  it('counts a sign-in that just checked a code as a step-up, but not a password-only sign-in on a trusted device', async () => {
    const s = await store();
    const invite = (who: Session) => h.request('POST', '/api/team/invitations', s, who, { email: 'fresh' + Math.random() + '@example.test', role: 'analyst' });
    const withCode = await h.login(s, ownerEmail(s));
    expect((await invite(withCode)).statusCode).toBe(200);
    const trusted = await h.login(s, ownerEmail(s), s.owner.device);
    expect((await invite(trusted)).json().error.code).toBe('STEP_UP_REQUIRED');
  });
  it('consumes a single-use step-up: the second sensitive request needs a new code', async () => {
    const s = await store();
    await h.stepUp(s.owner);
    expect((await h.request('POST', '/api/account/email', s, s.owner, { newEmail: 'first@example.test' })).statusCode).toBe(200);
    expect((await h.request('POST', '/api/account/email', s, s.owner, { newEmail: 'second@example.test' })).json().error.code).toBe('STEP_UP_REQUIRED');
  });
});

describe('account: sessions screen, password and email', () => {
  it('lists my devices, signs out one, or all others', async () => {
    const s = await store();
    const other = await h.login(s, ownerEmail(s));
    const third = await h.login(s, ownerEmail(s));
    const list = (await h.request('GET', '/api/account/sessions', s, s.owner)).json().data.items as { id: string; current: boolean; trustedDevice: boolean; deviceLabel: string }[];
    expect(list).toHaveLength(3);
    expect(list.filter(i => i.current)).toHaveLength(1);
    expect(list.every(i => i.trustedDevice)).toBe(true);
    const otherId = (await h.fixture.prisma.session.findUniqueOrThrow({ where: { tokenHash: digest(sessionToken(other)) } })).id;
    expect((await h.request('DELETE', '/api/account/sessions/' + otherId, s, s.owner)).statusCode).toBe(200);
    expect((await h.request('GET', '/api/auth/me', s, other)).statusCode).toBe(401);
    expect((await h.request('DELETE', '/api/account/sessions/' + otherId, s, s.owner)).statusCode).toBe(404);
    // Revoke all others (security step-up): the third device is out, this one stays.
    await h.stepUp(s.owner);
    expect((await h.request('POST', '/api/account/sessions/revoke-all', s, s.owner, {})).json().data).toEqual({ success: true, signedOut: 1 });
    expect((await h.request('GET', '/api/auth/me', s, third)).statusCode).toBe(401);
    expect((await h.request('GET', '/api/auth/me', s, s.owner)).statusCode).toBe(200);
    const all = await h.request('POST', '/api/account/sessions/revoke-all', s, s.owner, { includeCurrent: true });
    expect(all.cookies.filter(c => c.value === '').map(c => c.name).sort()).toEqual(['qorloop', 'qorloop.csrf', 'qorloop.device']);
    expect((await h.request('GET', '/api/auth/me', s, s.owner)).statusCode).toBe(401);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: { in: ['auth.session_revoked', 'auth.sessions_revoked_all'] } } })).toBe(3);
  });
  it('lets an Owner sign out the whole store (single-use step-up); others may not', async () => {
    const s = await store(), elsewhere = await store();
    const admin = await h.member(s, 'admin');
    expect((await h.request('POST', '/api/team/sessions/revoke-all', s, admin)).statusCode).toBe(403);
    const r = await h.request('POST', '/api/team/sessions/revoke-all', s, s.owner);
    expect(r.statusCode).toBe(200);
    expect(r.json().data.signedOut).toBe(2);
    for (const who of [admin, s.owner]) expect((await h.request('GET', '/api/auth/me', s, who)).statusCode).toBe(401);
    expect(await h.fixture.prisma.trustedDevice.count({ where: { tenantId: s.id } })).toBe(0);
    expect((await h.request('GET', '/api/auth/me', elsewhere, elsewhere.owner)).statusCode).toBe(200);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'auth.store_sessions_revoked' } })).toBe(1);
  });
  it('changes the password with the current one; other devices are signed out', async () => {
    const s = await store();
    const other = await h.login(s, ownerEmail(s));
    const change = (body: Record<string, unknown>) => h.request('POST', '/api/account/password', s, s.owner, body);
    expect((await change({ currentPassword: 'not the password', newPassword: 'An entirely new password!' })).json().error.details[0].path).toBe('currentPassword');
    expect((await change({ currentPassword: password, newPassword: password })).statusCode).toBe(400);
    expect((await change({ currentPassword: password, newPassword: 'An entirely new password!' })).json().data).toEqual({ success: true, signedOut: 1 });
    expect((await h.request('GET', '/api/auth/me', s, other)).statusCode).toBe(401);
    expect((await h.request('GET', '/api/auth/me', s, s.owner)).statusCode).toBe(200);
    expect((await h.request('POST', '/api/auth/login', s, undefined, { email: ownerEmail(s), password })).statusCode).toBe(401);
  });
  it('changes the sign-in address only when the link mailed to the new address is opened', async () => {
    const s = await store();
    const r = await h.request('POST', '/api/account/email', s, s.owner, { newEmail: 'moved@example.test' });
    expect(r.json().data.pendingEmail).toBe('m***@e***.test');
    expect((await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id } })).email).toBe(ownerEmail(s));
    const challenge = await h.fixture.prisma.loginChallenge.findFirstOrThrow({ where: { tenantId: s.id, purpose: 'email_change' } });
    const mail = await h.fixture.prisma.emailOutbox.findFirstOrThrow({ where: { tenantId: s.id, dedupeKey: 'email-change:' + challenge.id } });
    const message = await unseal<{ to: string; text: string }>(mail.sealedMessage, h.config.AUTH_SECRET);
    expect(message.to).toBe('moved@example.test');
    const link = /#token=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
    expect(await h.fixture.prisma.emailOutbox.count({ where: { tenantId: s.id, dedupeKey: 'email-change-notice:' + challenge.id } })).toBe(1);
    expect((await h.request('POST', '/api/auth/email/confirm', s, undefined, { token: link })).statusCode).toBe(200);
    expect((await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id } })).email).toBe('moved@example.test');
    expect((await h.request('GET', '/api/auth/me', s, s.owner)).statusCode).toBe(401);
    expect((await h.request('POST', '/api/auth/email/confirm', s, undefined, { token: link })).statusCode).toBe(400);
    const back = await h.login(s, 'moved@example.test');
    expect((await h.request('GET', '/api/auth/me', s, back)).json().data.user.email).toBe('moved@example.test');
  });
  it('removes the authenticator app only after a fresh code, and never while the store requires one', async () => {
    const s = await store();
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id } });
    expect((await h.request('DELETE', '/api/account/authenticator', s, s.owner)).statusCode).toBe(404);
    await h.fixture.prisma.user.update({ where: { id: user.id }, data: { mfaSecret: 'sealed-app-secret' } });
    await h.fixture.prisma.tenantSettings.update({ where: { tenantId: s.id }, data: { mfaRequiredForAll: true } });
    expect((await h.request('DELETE', '/api/account/authenticator', s, s.owner)).statusCode).toBe(409);
    await h.fixture.prisma.tenantSettings.update({ where: { tenantId: s.id }, data: { mfaRequiredForAll: false } });
    await setSession(s.owner, { stepUpAt: minutesAgo(11) });
    expect((await h.request('DELETE', '/api/account/authenticator', s, s.owner)).json().error.code).toBe('STEP_UP_REQUIRED');
    await h.stepUp(s.owner);
    expect((await h.request('POST', '/api/account/authenticator/recovery-codes', s, s.owner)).json().data.recoveryCodes).toHaveLength(10);
    expect((await h.request('DELETE', '/api/account/authenticator', s, s.owner)).statusCode).toBe(200);
    expect((await h.fixture.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mfaSecret).toBeNull();
    expect(await h.fixture.prisma.recoveryCode.count({ where: { userId: user.id } })).toBe(0);
  });
  it('writes last use at most every 5 minutes', async () => {
    const s = await store();
    const recent = minutesAgo(2), old = minutesAgo(6);
    await setSession(s.owner, { lastSeenAt: recent });
    await h.request('GET', '/api/auth/me', s, s.owner);
    const row = () => h.fixture.prisma.session.findUniqueOrThrow({ where: { tokenHash: digest(sessionToken(s.owner)) } });
    expect((await row()).lastSeenAt).toEqual(recent);
    await setSession(s.owner, { lastSeenAt: old });
    await h.request('GET', '/api/auth/me', s, s.owner);
    expect((await row()).lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
