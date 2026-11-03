import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createHarness, password, testServices, type Harness, type Store } from './harness.js';
import { digest } from '../../../../packages/shared/src/security.js';
import { buildApp } from '../app.js';
import { AuthService } from '../auth/auth.service.js';

let h: Harness, a: Store;
beforeAll(async () => { h = await createHarness(); a = await h.createOwner('session-status'); });
afterAll(async () => { await h.close(); });
const status = () => h.request('GET', '/api/auth/session', a, a.owner);
const currentSession = () => h.fixture.prisma.session.findUniqueOrThrow({ where: { tokenHash: digest(a.owner.cookie.slice('qorloop='.length)) } });

describe('session status without extending idle expiry', () => {
  it('reports a healthy session and leaves lastSeenAt unchanged across repeated polls', async () => {
    const s = await currentSession(), at = new Date(Date.now() - 120000);
    await h.fixture.prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: at } });
    for (let i = 0; i < 2; i++) {
      const r = await status(); expect(r.statusCode).toBe(200);
      expect(r.json().data).toMatchObject({ state: 'authenticated', nextAction: 'none', expiresAt: s.expiresAt.toISOString(),
        idleExpiresAt: new Date(at.getTime() + h.config.SESSION_IDLE_MINUTES * 60000).toISOString() });
      expect(r.body).not.toMatch(/csrf|hash|token|secret/i);
    }
    expect((await currentSession()).lastSeenAt).toEqual(at);
  });
  it('distinguishes no cookie, invalid cookie, idle expiry and absolute expiry', async () => {
    for (const who of [undefined, { cookie: 'qorloop=invalid', csrf: 'invalid' }]) {
      const r = await h.request('GET', '/api/auth/session', a, who); expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHENTICATED');
    }
    const s = await currentSession();
    try {
      await h.fixture.prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(Date.now() - 31 * 60000) } });
      expect((await status()).json().error.code).toBe('SESSION_EXPIRED');
      await h.fixture.prisma.session.update({ where: { id: s.id }, data: { createdAt: new Date(Date.now() - 3600000), lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1000) } });
      const r = await status(); expect(r.statusCode).toBe(401); expect(r.json().error.code).toBe('SESSION_EXPIRED');
    } finally { await h.fixture.prisma.session.update({ where: { id: s.id }, data: { createdAt: s.createdAt, lastSeenAt: new Date(), expiresAt: s.expiresAt } }); }
  });
  it('reports restricted challenge and enrollment states and precise business-endpoint 403 codes', async () => {
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id, name: 'Owner' } });
    const login = async () => h.sessionFrom(await h.request('POST', '/api/auth/login', a, undefined, { email: user.email, password }));
    const challenge = await login();
    let r = await h.request('GET', '/api/auth/session', a, challenge);
    expect(r.json().data).toMatchObject({ state: 'mfa_required', nextAction: 'verify_mfa' });
    expect(Date.parse(r.json().data.expiresAt) - Date.now()).toBeLessThanOrEqual(600000);
    expect((await h.request('GET', '/api/auth/me', a, challenge)).json().error.code).toBe('MFA_REQUIRED');
    try {
      await h.fixture.prisma.user.update({ where: { id: user.id }, data: { mfaSecret: null } });
      const enrollment = await login(); r = await h.request('GET', '/api/auth/session', a, enrollment);
      expect(r.json().data).toMatchObject({ state: 'mfa_setup_required', nextAction: 'setup_mfa' });
      expect((await h.request('GET', '/api/auth/me', a, enrollment)).json().error.code).toBe('MFA_SETUP_REQUIRED');
    } finally { await h.fixture.prisma.user.update({ where: { id: user.id }, data: { mfaSecret: user.mfaSecret } }); }
  });
  it('does not accept a session issued to a different tenant', async () => {
    const b = await h.createOwner('session-other');
    expect((await h.request('GET', '/api/auth/session', b, a.owner)).json().error.code).toBe('UNAUTHENTICATED');
  });
});

describe('standard errors and dependency readiness', () => {
  const checkError = (r: { statusCode: number; headers: Record<string, unknown>; json: () => { error: { code: string; message: string }; requestId: string }; body: string }, expected: number, code?: string) => {
    expect(r.statusCode).toBe(expected); expect(r.json().requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(r.headers['x-request-id']).toBe(r.json().requestId);
    expect(r.json().error.code).toEqual(code ?? expect.any(String));
    expect(r.json().error.message).toEqual(expect.any(String));
    expect(r.body).not.toMatch(/private-canary|stack|passwordHash|mfaSecret/);
  };
  it('normalizes missing-session, CSRF, validation and unknown-route errors', async () => {
    checkError(await h.request('GET', '/api/settings', a), 401, 'UNAUTHENTICATED');
    checkError(await h.request('PUT', '/api/settings', a, { ...a.owner, csrf: 'wrong' }, {}), 403, 'CSRF_REQUIRED');
    checkError(await h.request('PUT', '/api/settings', a, a.owner, {}), 400, 'VALIDATION_ERROR');
    checkError(await h.request('GET', '/api/not-a-route', a, a.owner), 404, 'NOT_FOUND');
  });
  it('normalizes parser, body-limit and content-type errors', async () => {
    const headers = { host: a.hostname + ':4000', origin: 'http://' + a.hostname + ':3000', cookie: a.owner.cookie, 'x-csrf-token': a.owner.csrf };
    checkError(await h.api.server.inject({ method: 'PUT', url: '/api/settings', headers: { ...headers, 'content-type': 'application/json' }, payload: '{' }), 400);
    checkError(await h.api.server.inject({ method: 'PUT', url: '/api/settings', headers, payload: { padding: 'x'.repeat(40000) } }), 413, 'PAYLOAD_TOO_LARGE');
    checkError(await h.api.server.inject({ method: 'PUT', url: '/api/settings', headers: { ...headers, 'content-type': 'application/x-unknown' }, payload: 'private-canary' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });
  it('logs the same requestId as an unexpected 500 without logging raw exceptions or query text', async () => {
    const lines: string[] = [], services = testServices();
    const api = await buildApp(h.config, { database: h.fixture.database, ...services, logStream: { write: line => { lines.push(line); } } });
    const mock = jest.spyOn(AuthService.prototype, 'me').mockRejectedValueOnce(new Error('private-canary'));
    try {
      const r = await api.server.inject({ url: '/api/auth/me?ignored=private-canary', headers: { host: a.hostname, cookie: a.owner.cookie } });
      checkError(r, 500, 'INTERNAL_ERROR'); expect(r.json().error.message).toBe('Internal server error');
      expect(lines.some(line => line.includes('"requestId":"' + r.json().requestId + '"'))).toBe(true);
      expect(lines.join('\n')).not.toContain('private-canary');
    } finally { mock.mockRestore(); await api.app.close(); await services.recon.drain(); }
  });
  it('returns 200 degraded for Redis/storage and 503 only for the database, with safe per-component states', async () => {
    const services = testServices(); let redisFails = false;
    const api = await buildApp(h.config, { database: h.fixture.database, logger: false, ...services,
      redisHealth: async () => { if (redisFails) throw new Error('private-canary'); } });
    try {
      let r = await api.server.inject('/health/ready');
      expect(r.json().data).toEqual({ status: 'ok', components: { database: 'ok', redis: 'ok', storage: 'ok' } });
      redisFails = true;
      const storage = jest.spyOn(services.storage, 'check').mockRejectedValue(new Error('private-canary'));
      try {
        r = await api.server.inject('/health/ready'); expect(r.statusCode).toBe(200);
        expect(r.json().data).toEqual({ status: 'degraded', components: { database: 'ok', redis: 'degraded', storage: 'degraded' } });
        const database = jest.spyOn(h.fixture.database, 'ping').mockRejectedValueOnce(new Error('private-canary'));
        try {
          r = await api.server.inject('/health/ready'); checkError(r, 503, 'UNAVAILABLE');
          expect(r.json().error.details).toEqual([{ path: 'database', message: 'unavailable' }, { path: 'redis', message: 'degraded' }, { path: 'storage', message: 'degraded' }]);
        } finally { database.mockRestore(); }
      } finally { storage.mockRestore(); }
    } finally { await api.app.close(); await services.recon.drain(); }
  });
  it('normalizes early rate-limit failures with a body and header requestId', async () => {
    const services = testServices();
    const api = await buildApp(h.config, { database: h.fixture.database, logger: false, ...services, rateLimitMax: 1 });
    try {
      expect((await api.server.inject('/health')).statusCode).toBe(200);
      checkError(await api.server.inject('/health'), 429, 'RATE_LIMITED');
    } finally { await api.app.close(); await services.recon.drain(); }
  });
});
