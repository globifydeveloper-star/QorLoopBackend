import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { generate as totp } from 'otplib';
import { createHarness, password, testServices, type Harness, type Session, type Store } from '../harness.js';
import { buildApp } from '../../app.js';
import { AuthService } from '../../auth/auth.service.js';
import { processUpload } from '../../../../worker/src/process-upload.js';
import { applyUpload } from '../../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../../worker/src/recompute-recon.js';
import { generateFile } from '../../../../worker/src/generate-file.js';
import { priceFromRule } from '../../../../../packages/core/src/pricing.js';
import { DATASETS, ERP_MAPPING, ISOLATION_MARKER, TALABAT_MAPPING, SNOONU_MAPPING, erpFile, talabatFile, snoonuFile, type Dataset } from './datasets.js';
import { pipeline, type DatasetRun } from './pipeline.js';
import * as ref from './reference.js';

/**
 * Step 5: behaviour beyond accuracy. Results go to .cache/verification/behaviour.json for the report.
 * Embedded PGlite is ONE backend: "concurrent" requests here interleave at await points but their transactions run one
 * after another. Real parallel transactions are covered only by tenant-lock.integration.test.ts on real PostgreSQL.
 */
let h: Harness;
let p: ReturnType<typeof pipeline>;
let A: DatasetRun, B: DatasetRun;
let admin: Session, analyst: Session;
const results: Record<string, unknown> = {};
const presence = DATASETS.find(d => d.name === 'presence')!;
const twin = DATASETS.find(d => d.name === 'presence-twin')!;
const small: Dataset = { ...DATASETS.find(d => d.name === 'formats')!, name: 'behaviour', slug: 'vbehave' };

beforeAll(async () => {
  h = await createHarness();
  p = pipeline(h);
  h.queue.handler = job => processUpload(p.deps(), job).then(() => undefined);
  h.queue.applyHandler = job => applyUpload({ ...p.deps(), recon: h.recon }, job).then(() => undefined);
  h.recon.handler = job => recomputeRecon(p.deps(), job);
  h.generatedFiles.handler = job => generateFile(p.deps(), job);
  A = await p.run(presence);
  B = await p.run(twin);
  for (const run of [A, B]) await p.generate(run.store, run.manager, 'talabat', 'stock_price', 'all');
  admin = await h.member(A.store, 'admin');
  analyst = await h.member(A.store, 'analyst');
}, 300_000);

afterAll(async () => {
  mkdirSync('.cache/verification', { recursive: true });
  writeFileSync('.cache/verification/behaviour.json', JSON.stringify(results, null, 1));
  await h?.recon.drain();
  await h?.close();
});

const snapshot = async (tenantId: string) => {
  const prisma = h.fixture.prisma;
  const [products, listings, recon, audit, changes] = await Promise.all([
    prisma.product.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    prisma.listing.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    prisma.reconRow.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    prisma.auditEvent.count({ where: { tenantId } }),
    prisma.erpUploadChange.count({ where: { tenantId } }),
  ]);
  return JSON.parse(JSON.stringify({ products, listings, recon, audit, changes }));
};

// ─────────────────────────────── idempotency ───────────────────────────────
describe('idempotency', () => {
  it('applying the same upload twice changes nothing the second time', async () => {
    const before = await snapshot(A.store.id);
    const again = await h.request('POST', `/api/uploads/${A.erp1.id}/apply`, A.store, A.manager);
    await h.recon.drain();
    const after = await snapshot(A.store.id);
    results.applyTwice = { status: again.statusCode, message: again.json().error?.message ?? null, unchanged: JSON.stringify(before) === JSON.stringify(after) };
    expect(after).toEqual(before);
  });

  it('uploading and applying an identical ERP file again records no change and leaves products and recon as they were', async () => {
    const run = await p.run({ ...small, slug: 'videm' });
    await recomputeRecon(p.deps(), { tenantId: run.store.id, reason: 'manual' });
    const before = await snapshot(run.store.id);
    const u = await p.apply(run.store, run.manager, await p.upload(run.store, run.manager, 'erp', await erpFile(small.erp), ERP_MAPPING, 'same-again.xlsx'));
    await recomputeRecon(p.deps(), { tenantId: run.store.id, reason: 'manual' });
    const after = await snapshot(run.store.id);
    const changes = await h.fixture.prisma.erpUploadChange.count({ where: { tenantId: run.store.id, uploadId: u.id } });
    results.sameFileTwice = { status: u.status, changeRows: changes, productsUnchanged: JSON.stringify(before.products) === JSON.stringify(after.products), reconUnchanged: JSON.stringify(before.recon) === JSON.stringify(after.recon), auditAdded: after.audit - before.audit };
    expect(u.status).toBe('applied');
    expect(changes).toBe(0);
    expect(after.products).toEqual(before.products);
    expect(after.recon).toEqual(before.recon);
  });

  it('running the recompute twice gives identical rows, including last_updated', async () => {
    await recomputeRecon(p.deps(), { tenantId: A.store.id, reason: 'manual' });
    const first = (await snapshot(A.store.id)).recon;
    await recomputeRecon(p.deps(), { tenantId: A.store.id, reason: 'manual' });
    const second = (await snapshot(A.store.id)).recon;
    results.reconTwice = { rows: first.length, identical: JSON.stringify(first) === JSON.stringify(second) };
    expect(second).toEqual(first);
  });
});

// ─────────────────────────────── concurrency ───────────────────────────────
describe('concurrency (interleaved on one embedded backend)', () => {
  it('two marketplace uploads at once both apply, and recon covers both', async () => {
    const run = await p.run({ ...small, slug: 'vconc1', talabat: undefined, snoonu: undefined });
    const [t, s] = await Promise.all([
      p.upload(run.store, run.manager, 'talabat', await talabatFile(small.talabat!), TALABAT_MAPPING).then(u => p.apply(run.store, run.manager, u)),
      p.upload(run.store, run.manager, 'snoonu', await snoonuFile(small.snoonu!), SNOONU_MAPPING).then(u => p.apply(run.store, run.manager, u)),
    ]);
    await h.recon.drain();
    const recon = await p.readRecon(run.store.id);
    const mps = [...new Set(recon.map(r => r.marketplaceId))].sort();
    results.twoUploads = { talabat: t.status, snoonu: s.status, reconMarketplaces: mps };
    expect([t.status, s.status]).toEqual(['applied', 'applied']);
    expect(mps).toEqual(['snoonu', 'talabat']);
  });

  it('two ERP applies at once leave every product from ONE file (never a mix)', async () => {
    const run = await p.run({ ...small, slug: 'vconc2', talabat: undefined, snoonu: undefined });
    const fileX = small.erp.map(r => [r[0], r[1], r[2], '11.110', 7, r[5], r[6], r[7]] as typeof r);
    const fileY = small.erp.map(r => [r[0], r[1], r[2], '22.220', 9, r[5], r[6], r[7]] as typeof r);
    const x = await p.upload(run.store, run.manager, 'erp', await erpFile(fileX), ERP_MAPPING, 'x.xlsx');
    const y = await p.upload(run.store, run.manager, 'erp', await erpFile(fileY), ERP_MAPPING, 'y.xlsx');
    const statuses = await Promise.all([x, y].map(u => h.request('POST', `/api/uploads/${u.id}/apply`, run.store, run.manager).then(r => r.statusCode)));
    await h.recon.drain();
    const prices = [...new Set((await p.readProducts(run.store.id)).map(r => `${r.erpPrice}/${r.erpStock}`))];
    results.twoErpApplies = { statuses, distinctPriceStock: prices };
    expect(prices).toHaveLength(1);
    expect(['11.11/7', '22.22/9']).toContain(prices[0]);
  });

  it('a recompute during an upload apply converges: one more recompute changes nothing', async () => {
    const run = await p.run({ ...small, slug: 'vconc3', snoonu: undefined });
    const u = await p.upload(run.store, run.manager, 'snoonu', await snoonuFile(small.snoonu!), SNOONU_MAPPING);
    await Promise.all([recomputeRecon(p.deps(), { tenantId: run.store.id, reason: 'manual' }), p.apply(run.store, run.manager, u)]);
    await h.recon.drain();
    const settled = (await snapshot(run.store.id)).recon;
    await recomputeRecon(p.deps(), { tenantId: run.store.id, reason: 'manual' });
    const again = (await snapshot(run.store.id)).recon;
    results.reconDuringUpload = { rows: settled.length, convergedWithoutExtraRun: JSON.stringify(settled) === JSON.stringify(again) };
    expect(again).toEqual(settled);
    expect(settled.some((r: { marketplaceId: string }) => r.marketplaceId === 'snoonu')).toBe(true);
  });

  it('a burst of pricing changes is coalesced into at most two recompute runs (inline queue model)', async () => {
    const ids = A.products.filter(x => x.status === 'active' && !x.blockedAt).slice(0, 8).map(x => x.id);
    await h.recon.drain();
    const calls0 = h.recon.calls.length; const runs0 = h.recon.runs;
    const statuses = await Promise.all(ids.map((id, i) => h.request('PUT', `/api/products/${id}/price-rule`, A.store, A.manager, { mode: 'fixed', value: 4 + i / 100 }).then(r => r.statusCode)));
    await h.recon.drain();
    results.coalescing = { requests: ids.length, statuses, triggers: h.recon.calls.length - calls0, runs: h.recon.runs - runs0,
      note: 'InlineReconQueue models the BullMQ deduplication; the real BullMQ burst test needs TEST_REDIS_URL (queue-storage.test.ts)' };
    expect(statuses.every(s => s === 200)).toBe(true);
    expect(h.recon.runs - runs0).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────── permissions ───────────────────────────────
type Route = { method: string; path: string };
const PUBLIC = new Set(['POST /api/auth/invitations/accept', 'POST /api/auth/login', 'POST /api/auth/password/forgot', 'POST /api/auth/password/reset', 'GET /api/auth/session']);
function routes(): Route[] {
  return Object.entries(h.api.spec.paths as Record<string, Record<string, unknown>>).flatMap(([path, ops]) =>
    Object.keys(ops).filter(m => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(m => ({ method: m.toUpperCase(), path })));
}
/**
 * What the documents forbid (docs/open-gaps.md G1 prose, settings/products/marketplace-values/catalogue-stock/ADR 011 docs):
 * Analyst read-only (no state change); Catalogue Manager no team or settings edits; Admin everything but the security policy
 * (field level, tested separately); Owner everything; unauthenticated nothing but the public auth routes.
 */
function docsForbid(role: string, r: Route): string | null {
  const key = `${r.method} ${r.path}`;
  if (role === 'unauthenticated') return PUBLIC.has(key) || r.path.startsWith('/health') || r.path.startsWith('/ready') || r.path.startsWith('/docs') ? null : 'requires a session';
  if (role === 'analyst' && r.method !== 'GET') return 'Analyst is read-only (G1)';
  if (role === 'catalogue_manager' && r.method !== 'GET' && /^\/api\/(team\/|settings$|templates\/)/.test(r.path)) return 'Catalogue Manager: no team or settings edits (G1, ADR 016)';
  return null;
}
const fill = (path: string) => path.replace(/\{marketplaceId\}/g, 'talabat').replace(/\{source\}/g, 'erp').replace(/\{jobId\}/g, 'not-a-job').replace(/\{[^}]+\}/g, () => randomUUID());

describe('permissions: every endpoint x every role', () => {
  it('no endpoint is more permissive than the documents say', async () => {
    const sessions: Record<string, Session | undefined> = { unauthenticated: undefined, analyst, catalogue_manager: A.manager, admin, owner: A.store.owner };
    const all = routes().filter(r => !r.path.startsWith('/api/auth/') || PUBLIC.has(`${r.method} ${r.path}`) || r.path === '/api/auth/me');
    const matrix: Record<string, Record<string, number>> = {};
    const tooPermissive: string[] = [];
    for (const role of Object.keys(sessions)) for (const r of all) {
      if (r.path.startsWith('/api/auth/') && role !== 'unauthenticated') continue; // auth self-service is session-scoped, tested elsewhere
      const res = await h.request(r.method as 'GET', fill(r.path), A.store, sessions[role], r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      (matrix[`${r.method} ${r.path}`] ??= {})[role] = res.statusCode;
      const why = docsForbid(role, r);
      if (why && ![401, 403].includes(res.statusCode)) tooPermissive.push(`${role} ${r.method} ${r.path} -> ${res.statusCode} (${why})`);
    }
    await h.recon.drain();
    results.permissions = { endpoints: Object.keys(matrix).length, matrix, tooPermissive };
    expect(tooPermissive).toEqual([]);
  }, 300_000);

  it('the security policy is Owner-only, even for an Admin', async () => {
    const settings = (await h.request('GET', '/api/settings', A.store, A.store.owner)).json().data;
    const body = { expectedRevision: settings.revision, security: { mfaRequiredForAll: settings.security.mfaRequiredForAll } };
    const asAdmin = await h.request('PUT', '/api/settings', A.store, admin, body);
    results.securityPolicyOwnerOnly = { admin: asAdmin.statusCode };
    expect(asAdmin.statusCode).toBe(403);
  });

  // BUG-3: analystCanExport only gates 'reports.export', which no endpoint checks (packages/core/src/roles.ts:85).
  it.failing('BUG-3: analystCanExport = false stops the Analyst downloading a generated file (docs 01-product-overview: export only if the Owner allows it)', async () => {
    const file = await h.fixture.prisma.generatedFile.findFirstOrThrow({ where: { tenantId: A.store.id } });
    await h.fixture.prisma.tenantSettings.update({ where: { tenantId: A.store.id }, data: { analystCanExport: false } });
    const blocked = await h.request('GET', `/api/generated-files/${file.id}/download`, A.store, analyst);
    await h.fixture.prisma.tenantSettings.update({ where: { tenantId: A.store.id }, data: { analystCanExport: true } });
    const allowed = await h.request('GET', `/api/generated-files/${file.id}/download`, A.store, analyst);
    results.analystCanExport = { whenFalse: blocked.statusCode, whenTrue: allowed.statusCode };
    expect(blocked.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
  });
});

// ─────────────────────────────── tenant isolation ───────────────────────────────
describe('tenant isolation: every read endpoint and the by-id writes', () => {
  it('no list or read endpoint of tenant A returns tenant B data, and B ids answer 404 in A', async () => {
    const prisma = h.fixture.prisma;
    const tB = B.store.id;
    const bIds = {
      product: B.products.map(x => x.id), upload: (await prisma.upload.findMany({ where: { tenantId: tB } })).map(x => x.id),
      file: (await prisma.generatedFile.findMany({ where: { tenantId: tB } })).map(x => x.id), user: (await prisma.user.findMany({ where: { tenantId: tB } })).map(x => x.id),
      listing: (await prisma.listing.findMany({ where: { tenantId: tB } })).map(x => x.id),
    };
    const invitation = await h.request('POST', '/api/team/invitations', B.store, B.store.owner, { role: 'analyst', email: 'iso@vtwin.test' });
    const bInvitation = invitation.json().data.id as string;
    const bCategory = (await prisma.category.create({ data: { tenantId: tB, nameEn: `${ISOLATION_MARKER} category` } })).id;
    const needles = [tB, ISOLATION_MARKER, ...Object.values(bIds).flat(), bInvitation, bCategory];
    const bFor = (path: string, name: string) => {
      if (name === 'marketplaceId') return 'talabat';
      if (name === 'source') return 'erp';
      if (name === 'productId' || path.startsWith('/api/products/')) return bIds.product[0]!;
      if (path.startsWith('/api/uploads/')) return bIds.upload[0]!;
      if (path.startsWith('/api/generated-files/jobs')) return 'not-in-this-tenant';
      if (path.startsWith('/api/generated-files/')) return bIds.file[0]!;
      if (path.startsWith('/api/team/invitations')) return bInvitation;
      if (path.startsWith('/api/team/members')) return bIds.user[0]!;
      if (path.startsWith('/api/categories')) return bCategory;
      return randomUUID();
    };
    const out: { route: string; status: number; leak: boolean }[] = [];
    for (const r of routes().filter(x => x.method === 'GET' && x.path.startsWith('/api/'))) {
      const url = r.path.replace(/\{([^}]+)\}/g, (_, name: string) => bFor(r.path, name));
      let res = await h.request('GET', url, A.store, A.store.owner);
      if (res.statusCode === 400 && !url.includes('?')) res = await h.request('GET', url + '?marketplaceId=talabat', A.store, A.store.owner);
      const leak = needles.some(n => res.body.includes(n));
      out.push({ route: `GET ${r.path}`, status: res.statusCode, leak });
    }
    // By-id writes with valid bodies: must be 404 and leave B untouched.
    const bProduct = bIds.product[0]!;
    const before = await snapshot(tB);
    const writes: [string, string, Record<string, unknown> | undefined][] = [
      ['PATCH', `/api/products/${bProduct}`, { status: 'inactive' }],
      ['PUT', `/api/products/${bProduct}/price-rule`, { mode: 'fixed', value: 1 }],
      ['PUT', `/api/products/${bProduct}/offer`, { price: 1, validUntil: new Date(Date.now() + 86_400_000).toISOString() }],
      ['PUT', `/api/products/${bProduct}/stock`, { stock: 1, expected: { erpStock: 999, catalogueStock: 999 } }],
      ['PUT', `/api/marketplace-values/talabat/products/${bProduct}`, { values: { availability: { value: false } }, expected: null }],
      ['POST', `/api/uploads/${bIds.upload[0]}/apply`, undefined], ['POST', `/api/uploads/${bIds.upload[0]}/discard`, undefined],
      ['DELETE', `/api/team/invitations/${bInvitation}`, undefined], ['PATCH', `/api/team/members/${bIds.user[0]}/role`, { role: 'analyst' }],
      ['DELETE', `/api/team/members/${bIds.user[0]}`, undefined], ['PATCH', `/api/categories/${bCategory}`, { nameEn: 'x' }], ['DELETE', `/api/categories/${bCategory}`, undefined],
    ];
    const writeResults: { route: string; status: number }[] = [];
    for (const [method, url, body] of writes) writeResults.push({ route: `${method} ${url.replace(/[0-9a-f-]{36}/g, '<B id>')}`, status: (await h.request(method as 'GET', url, A.store, A.store.owner, body)).statusCode });
    await h.recon.drain();
    const after = await snapshot(tB);
    const bUntouched = JSON.stringify(before) === JSON.stringify(after) && (await prisma.category.count({ where: { id: bCategory } })) === 1;
    results.isolation = { reads: out, writes: writeResults, bUntouched };
    expect(out.filter(x => x.leak)).toEqual([]);
    expect(out.filter(x => /\{/.test(x.route) && x.status === 200)).toEqual([]);
    expect(writeResults.filter(x => x.status < 400)).toEqual([]);
    expect(bUntouched).toBe(true);
  }, 300_000);
});

// ─────────────────────────────── security ───────────────────────────────
describe('security', () => {
  const inject = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
    h.api.server.inject({ method: method as 'POST', url, remoteAddress: '127.0.0.1', headers: { host: A.store.hostname + ':4000', ...headers }, ...(payload ? { payload: payload as object } : {}) });
  const origin = () => 'http://' + A.store.hostname + ':3000';

  it('CSRF: a mutation without, or with a wrong, X-CSRF-Token is refused', async () => {
    const s = A.store.owner;
    const none = await inject('POST', '/api/recon/recompute', { origin: origin(), cookie: s.cookie });
    const wrong = await inject('POST', '/api/recon/recompute', { origin: origin(), cookie: s.cookie, 'x-csrf-token': 'x'.repeat(43) });
    const right = await inject('POST', '/api/recon/recompute', { origin: origin(), cookie: s.cookie, 'x-csrf-token': s.csrf });
    await h.recon.drain();
    results.csrf = { none: none.statusCode, wrong: wrong.statusCode, right: right.statusCode };
    expect([none.statusCode, wrong.statusCode]).toEqual([403, 403]);
    expect(right.statusCode).toBeLessThan(300);
  });

  it('Origin: a mutation from another origin, or with none, is refused; a GET from another origin too', async () => {
    const s = A.store.owner;
    const evil = await inject('POST', '/api/recon/recompute', { origin: 'http://evil.example', cookie: s.cookie, 'x-csrf-token': s.csrf });
    const missing = await inject('POST', '/api/recon/recompute', { cookie: s.cookie, 'x-csrf-token': s.csrf });
    const otherTenant = await inject('POST', '/api/recon/recompute', { origin: 'http://' + B.store.hostname + ':3000', cookie: s.cookie, 'x-csrf-token': s.csrf });
    const evilGet = await inject('GET', '/api/products', { origin: 'http://evil.example', cookie: s.cookie });
    results.origin = { evil: evil.statusCode, missing: missing.statusCode, otherTenantOrigin: otherTenant.statusCode, evilGet: evilGet.statusCode };
    expect([evil.statusCode, missing.statusCode, otherTenant.statusCode, evilGet.statusCode]).toEqual([403, 403, 403, 403]);
  });

  it('a session cookie of tenant B does not work on tenant A\'s host', async () => {
    const r = await h.request('GET', '/api/products', A.store, B.store.owner);
    results.crossTenantCookie = r.statusCode;
    expect(r.statusCode).toBe(401);
  });

  it('rate limits: the auth POST limit (20 a minute by default) answers 429 RATE_LIMITED', async () => {
    const app = await buildApp(h.config, { database: h.fixture.database, logger: false, ...testServices() });
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 25; i++) {
        const r = await app.server.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.9.9', headers: { host: A.store.hostname + ':4000', origin: origin() }, payload: { email: 'nobody@x.test', password: 'wrong password!!' } });
        statuses.push(r.statusCode);
        if (r.statusCode === 429) { expect(r.json().error.code).toBe('RATE_LIMITED'); break; }
      }
    } finally { await app.app.close(); }
    results.rateLimit = { requestsUntil429: statuses.length, statuses: [...new Set(statuses)] };
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.length).toBeLessThanOrEqual(21);
  });

  it('MFA: an Owner who has not finished MFA gets no business API, and a full session needs the TOTP step', async () => {
    const service = new AuthService(h.fixture.database, h.config);
    const result = await service.provision({ name: 'vmfa', slug: 'vmfa', hostname: 'vmfa.localhost', ownerEmail: 'owner@vmfa.test' });
    const store = { id: result.tenantId, hostname: 'vmfa.localhost' } as Store;
    const message = await h.fixture.prisma.emailOutbox.findFirstOrThrow({ where: { dedupeKey: { startsWith: 'invitation:' + result.invitationId } } });
    const { unseal } = await import('../../../../../packages/shared/src/security.js');
    const token = (await unseal<{ text: string }>(message.sealedMessage, h.config.AUTH_SECRET)).text.match(/#token=([A-Za-z0-9_-]+)/)![1]!;
    const pending = h.sessionFrom(await h.request('POST', '/api/auth/invitations/accept', store, undefined, { token, name: 'Owner', password }));
    const probes = await Promise.all(['/api/products', '/api/recon/summary', '/api/settings', '/api/uploads'].map(u => h.request('GET', u, store, pending).then(r => r.statusCode)));
    const setup = await h.request('POST', '/api/auth/mfa/setup', store, pending, { password });
    const secret = new URL(setup.json().data.totpUri).searchParams.get('secret')!;
    const wrongCode = await h.request('POST', '/api/auth/mfa/verify', store, pending, { code: '000000' });
    const full = h.sessionFrom(await h.request('POST', '/api/auth/mfa/verify', store, pending, { code: await totp({ secret }) }));
    const afterMfa = await h.request('GET', '/api/products', store, full);
    const oldPendingAfter = await h.request('GET', '/api/products', store, pending);
    results.mfa = { pendingProbes: probes, wrongCode: wrongCode.statusCode, afterMfa: afterMfa.statusCode, pendingSessionAfterMfa: oldPendingAfter.statusCode };
    expect(probes.every(s => s === 401 || s === 403)).toBe(true);
    expect(wrongCode.statusCode).toBe(401);
    expect(afterMfa.statusCode).toBe(200);
  });

  it('session expiry: an expired session and an idle session are refused', async () => {
    const user = await h.member(A.store, 'analyst');
    const ok = await h.request('GET', '/api/products', A.store, user);
    const row = await h.fixture.prisma.session.findFirstOrThrow({ where: { tenantId: A.store.id }, orderBy: { createdAt: 'desc' } });
    await h.fixture.prisma.session.update({ where: { id: row.id }, data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
    const idle = await h.request('GET', '/api/products', A.store, user);
    const user2 = await h.member(A.store, 'analyst');
    const row2 = await h.fixture.prisma.session.findFirstOrThrow({ where: { tenantId: A.store.id }, orderBy: { createdAt: 'desc' } });
    await h.fixture.prisma.session.update({ where: { id: row2.id }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000), expiresAt: new Date(Date.now() - 1000) } });
    const expired = await h.request('GET', '/api/products', A.store, user2);
    results.sessionExpiry = { fresh: ok.statusCode, idle31min: idle.statusCode, expired: expired.statusCode };
    expect(ok.statusCode).toBe(200);
    expect([idle.statusCode, expired.statusCode]).toEqual([401, 401]);
  });

  it('upload limits: size, file type and row count', async () => {
    const create = (body: Record<string, unknown>) => h.request('POST', '/api/uploads', A.store, A.manager, { source: 'erp', ...body }).then(r => r.statusCode);
    const res = {
      over25MB: await create({ fileName: 'big.xlsx', size: 25 * 1024 * 1024 + 1 }),
      exactly25MB: await create({ fileName: 'max.xlsx', size: 25 * 1024 * 1024 }),
      zeroBytes: await create({ fileName: 'empty.xlsx', size: 0 }),
      exe: await create({ fileName: 'tool.exe', size: 100 }), pdf: await create({ fileName: 'doc.pdf', size: 100 }), noExtension: await create({ fileName: 'file', size: 100 }),
      xlsm: await create({ fileName: 'macro.xlsm', size: 100 }), csv: await create({ fileName: 'ok.csv', size: 100 }), xls: await create({ fileName: 'ok.xls', size: 100 }),
    };
    // 50,001 data rows: over the 50,000 row limit (CSV keeps it small)
    const csv = Buffer.from(['Barcode,Item Name,Sale Price,Qty', ...Array.from({ length: 50_001 }, (_, i) => `${7_000_000_000_000 + i},Row ${i},1.00,1`)].join('\r\n'));
    const tooMany = await p.upload(A.store, A.manager, 'erp', csv, { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' }, 'rows.csv');
    results.uploadLimits = { ...res, rows50001: { status: tooMany.status, message: tooMany.errorMessage } };
    expect(res.over25MB).toBe(400); expect(res.zeroBytes).toBe(400);
    expect([res.exe, res.pdf, res.noExtension, res.xlsm]).toEqual([400, 400, 400, 400]);
    expect([res.exactly25MB, res.csv, res.xls]).toEqual([200, 200, 200]);
    expect(tooMany.status).toBe('rejected');
    expect(tooMany.errorMessage).toMatch(/50,000/);
  }, 300_000);

  it('malicious file names never reach a storage key', async () => {
    const names = ['../../../etc/passwd.xlsx', '..\\..\\windows\\win.ini.xlsx', '<img src=x onerror=alert(1)>.xlsx', 'a‮slx.csv', '%2e%2e%2fsecret.xlsx', 'x'.repeat(300) + '.xlsx', 'nul\u0000byte.xlsx', 'CON.xlsx'];
    const out: { name: string; status: number; key: string | null; storedName: string | null }[] = [];
    for (const name of names) {
      const r = await h.request('POST', '/api/uploads', A.store, A.manager, { source: 'erp', fileName: name, size: 100 });
      const id = r.statusCode === 200 ? r.json().data.id : null;
      const rec = id ? await h.fixture.prisma.upload.findUnique({ where: { id } }) : null;
      out.push({ name: JSON.stringify(name).slice(0, 40), status: r.statusCode, key: rec?.storageKey ?? null, storedName: rec ? JSON.stringify(rec.fileName).slice(0, 60) : null });
    }
    results.maliciousNames = out;
    for (const o of out) if (o.key) expect(o.key).toMatch(new RegExp(`^tenants/${A.store.id}/uploads/[0-9a-f-]{36}/original\\.(xlsx|xls|csv)$`));
  });

  it('formula injection: = + - @ cells are neutralised in generated files and in the error report', async () => {
    // generated files: the names dataset's =1+2, @SUM, +cmd and -2+3 cells (exact checks in the accuracy harness)
    const run = await p.run({ ...DATASETS.find(d => d.name === 'names')!, slug: 'vformula' });
    const file = await p.generate(run.store, run.manager, 'talabat', 'stock_price', 'all');
    const cells = file.rows.flat().filter((v): v is string => typeof v === 'string' && /^'?[=+\-@]/.test(v));
    // error report: an invalid price that looks like a formula
    const u = await p.upload(run.store, run.manager, 'erp', await erpFile([...DATASETS.find(d => d.name === 'names')!.erp, [ref.refBarcode('6281000099991'), 'Formula price', null, '=HYPERLINK("http://x","y")', 1, null, null, null]]), ERP_MAPPING, 'formula.xlsx');
    const report = await h.request('GET', `/api/uploads/${u.id}/errors.xlsx`, run.store, run.manager);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(report.rawPayload as unknown as ArrayBuffer);
    const reportCells: string[] = [];
    wb.eachSheet(ws => ws.eachRow(row => row.eachCell(c => { if (typeof c.value === 'string' && /^'?[=+\-@]/.test(c.value)) reportCells.push(c.value); if (c.formula) reportCells.push('FORMULA:' + c.formula); })));
    results.formulaInjection = { generatedCells: cells, errorReportCells: reportCells };
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.filter(c => !c.startsWith('\''))).toEqual([]);
    expect(reportCells.length).toBeGreaterThan(0);
    expect(reportCells.filter(c => !c.startsWith('\''))).toEqual([]);
  }, 120_000);
});

// ─────────────────────────────── data integrity ───────────────────────────────
describe('data integrity', () => {
  it('money columns are exact numeric(12,3); no floating-point column exists anywhere', async () => {
    const cols = await h.fixture.prisma.$queryRawUnsafe<{ table_name: string; column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null }[]>(
      'SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = current_schema()');
    const floats = cols.filter(c => ['real', 'double precision'].includes(c.data_type)).map(c => `${c.table_name}.${c.column_name}`);
    // money-like numeric columns; recon_summaries.price is a count of products, not money
    const money = cols.filter(c => ['numeric', 'integer', 'bigint', 'real', 'double precision'].includes(c.data_type) && /price|cost|tolerance|^value$/.test(c.column_name) && c.table_name !== 'recon_summaries');
    const notExact = money.filter(c => !(c.data_type === 'numeric' && Number(c.numeric_scale) === 3)).map(c => `${c.table_name}.${c.column_name} ${c.data_type}(${c.numeric_precision},${c.numeric_scale})`);
    results.moneyColumns = { checked: money.map(c => `${c.table_name}.${c.column_name} ${c.data_type}(${c.numeric_precision},${c.numeric_scale})`), floatColumns: floats, notNumeric12_3: notExact };
    expect(floats).toEqual([]);
    expect(notExact).toEqual([]);
  });

  it('price engine has no floating-point noise: 200,000 random cases agree with the BigInt reference at the product\'s 0.01 step', () => {
    // Seeded LCG so the cases are the same on every run.
    let seed = 20261119;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const roundings = ['exact', '0.05', '0.25', '0.50'] as const;
    const disagreements: string[] = [];
    Object.assign(ref.REF_CONFIG, ref.DOCUMENTED_CONFIG, { moneyStepFils: 10 }); // BUG-1: the product's 'exact' is 0.01
    try {
      for (let i = 0; i < 200_000; i++) {
        const erp = Math.floor(rnd() * 999_999) / 100 + 0.01; // 2-decimal ERP prices, as stored (BUG-1)
        const mode = rnd() < 0.6 ? 'percent' : 'amount';
        const value = mode === 'percent' ? Math.round((rnd() * 200 - 50) * 1000) / 1000 : Math.round((rnd() * 20 - 5) * 1000) / 1000;
        const rounding = roundings[Math.floor(rnd() * 4)]!;
        const product = Math.round(priceFromRule(erp, { mode, value }, rounding) * 1000);
        const erpFils = Math.round(erp * 100) * 10;
        let reference = ref.refApplyRule(erpFils, { mode, value: value.toFixed(3) }, rounding);
        reference = Math.max(0, reference);
        if (product !== reference && disagreements.length < 2000) disagreements.push(`${erp.toFixed(2)} ${mode} ${value} ${rounding}: product ${product} reference ${reference}`);
      }
    } finally { Object.assign(ref.REF_CONFIG, ref.DOCUMENTED_CONFIG); }
    results.floatNoise = { cases: 200_000, disagreements: disagreements.length, examples: disagreements.slice(0, 20) };
    expect(disagreements).toEqual([]);
  });

  it('every change through the API writes an audit event in the same tenant', async () => {
    const prisma = h.fixture.prisma;
    const t = A.store.id;
    const product = A.products.find(x => x.status === 'active' && !x.blockedAt && x.inLatestErpFile)!;
    const count = () => prisma.auditEvent.count({ where: { tenantId: t } });
    const latest = async (n: number) => (await prisma.auditEvent.findMany({ where: { tenantId: t }, orderBy: { createdAt: 'desc' }, take: n })).map(e => e.action);
    const settings = (await h.request('GET', '/api/settings', A.store, A.store.owner)).json().data;
    const stock = (await h.request('GET', `/api/products/${product.id}/stock`, A.store, A.manager)).json().data;
    const changes: [string, () => Promise<{ statusCode: number }>][] = [
      ['PATCH product status', () => h.request('PATCH', `/api/products/${product.id}`, A.store, A.manager, { nameAr: 'اسم للتدقيق' })],
      ['PUT price rule', () => h.request('PUT', `/api/products/${product.id}/price-rule`, A.store, A.manager, { mode: 'fixed', value: 3.5 })],
      ['PUT offer', () => h.request('PUT', `/api/products/${product.id}/offer`, A.store, A.manager, { price: 1.25, validUntil: new Date(Date.now() + 86_400_000).toISOString() })],
      ['DELETE offer', () => h.request('DELETE', `/api/products/${product.id}/offer`, A.store, A.manager)],
      ['PUT catalogue stock', () => h.request('PUT', `/api/products/${product.id}/stock`, A.store, A.manager, { stock: 3, expected: { erpStock: stock.erpStock, catalogueStock: stock.catalogueStock } })],
      ['PUT marketplace export value', () => h.request('PUT', `/api/marketplace-values/talabat/products/${product.id}`, A.store, A.manager, { values: { availability: { value: false } }, expected: null })],
      ['PUT settings thresholds', () => h.request('PUT', '/api/settings', A.store, A.store.owner, { expectedRevision: settings.revision, thresholds: { staleHours: settings.thresholds.staleHours + 1 } })],
      ['PUT pricing settings', () => h.request('PUT', '/api/pricing/settings', A.store, A.manager, { rounding: '0.05' })],
      ['POST team invitation', () => h.request('POST', '/api/team/invitations', A.store, A.store.owner, { role: 'analyst', email: 'audit@vpresence.test' })],
      ['POST generated file', async () => { const pre = (await h.request('POST', '/api/generated-files/preview', A.store, A.manager, { marketplaceId: 'talabat', kind: 'stock', scope: 'all', reference: 'erp' })).json().data; return h.request('POST', '/api/generated-files', A.store, A.manager, { marketplaceId: 'talabat', kind: 'stock', scope: 'all', reference: 'erp', exportToken: pre.exportToken }); }],
      ['POST upload apply', async () => { const u = await p.upload(A.store, A.manager, 'erp', await erpFile(presence.erp2!.map(r => [r[0], r[1], r[2], '3.500', r[4], r[5], r[6], r[7]] as typeof r)), ERP_MAPPING, 'audit.xlsx'); return h.request('POST', `/api/uploads/${u.id}/apply`, A.store, A.manager); }],
    ];
    const out: { change: string; status: number; events: number; actions: string[] }[] = [];
    for (const [name, run] of changes) {
      const before = await count();
      const r = await run();
      await h.recon.drain();
      const added = (await count()) - before;
      out.push({ change: name, status: r.statusCode, events: added, actions: added ? [...new Set(await latest(Math.min(added, 50)))] : [] });
    }
    results.audit = out;
    expect(out.filter(o => o.status >= 300)).toEqual([]);
    expect(out.filter(o => o.events === 0).map(o => o.change)).toEqual([]);
  }, 300_000);
});

// ─────────────────────────────── error handling ───────────────────────────────
describe('error handling: bad files give a clear error and write no data', () => {
  it('broken, empty, wrong-format, password-protected and macro files', async () => {
    const run = await p.run({ ...small, slug: 'vbadfiles', erp: [], talabat: undefined, snoonu: undefined });
    const good = await erpFile(small.erp);
    const headerOnly = await erpFile([]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(good); zip.file('xl/vbaProject.bin', Buffer.from('x'));
    const files: [string, Buffer, string][] = [
      ['truncated xlsx', good.subarray(0, Math.floor(good.length / 2)), 'broken.xlsx'],
      ['random bytes', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)), 'noise.xlsx'],
      ['header row only', headerOnly, 'header-only.xlsx'],
      ['PDF named .xlsx', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'), 'doc.xlsx'],
      ['PNG named .csv', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'image.csv'],
      ['password-protected (OLE EncryptedPackage)', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('EncryptedPackage', 'utf16le'), Buffer.alloc(512)]), 'locked.xlsx'],
      ['macro workbook named .xlsx', await zip.generateAsync({ type: 'nodebuffer' }), 'macro.xlsx'],
      ['garbage .xls', Buffer.from('not an excel 97 file at all'), 'legacy.xls'],
      ['empty CSV (one space)', Buffer.from(' '), 'blank.csv'],
    ];
    const out: { file: string; status: string; message: string | null; products: number; stagedRows: number }[] = [];
    for (const [name, data, fileName] of files) {
      const u = await p.upload(run.store, run.manager, 'erp', data, ERP_MAPPING, fileName);
      const products = await h.fixture.prisma.product.count({ where: { tenantId: run.store.id } });
      const stagedRows = u.id ? await h.fixture.prisma.uploadRow.count({ where: { uploadId: u.id } }) : 0;
      out.push({ file: name, status: u.status, message: u.errorMessage, products, stagedRows });
    }
    results.badFiles = out;
    for (const o of out) {
      expect([o.file, o.status]).toEqual([o.file, 'rejected']);
      expect(o.message).toBeTruthy();
      expect(o.message!).not.toMatch(/Error:|stack|at .*\.ts|prisma|undefined/i);
      expect([o.file, o.products, o.stagedRows]).toEqual([o.file, 0, 0]);
    }
  }, 300_000);
});
