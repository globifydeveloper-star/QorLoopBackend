import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';

let h: Harness, a: Store, b: Store, admin: Session, manager: Session, analyst: Session;
const get = (store = a, who = store.owner) => h.request('GET', '/api/settings', store, who);
async function put(fields: Record<string, unknown>, who = a.owner) {
  const current = (await get()).json().data;
  return h.request('PUT', '/api/settings', a, who, { expectedRevision: current.revision, ...fields });
}
beforeAll(async () => {
  h = await createHarness(); a = await h.createOwner('settings-a'); b = await h.createOwner('settings-b');
  admin = await h.member(a, 'admin'); manager = await h.member(a, 'catalogue_manager'); analyst = await h.member(a, 'analyst');
});
afterAll(async () => { await h.close(); });

describe('tenant settings', () => {
  it('reads only stored settings with read-only Qatar defaults and a revision', async () => {
    const r = await get(); expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ profile: { name: 'settings-a' }, timeZone: 'Asia/Qatar', currency: 'QAR',
      thresholds: { priceTolerance: 0, stockThreshold: 0, staleHours: 12 }, pricing: { defaultRule: { mode: 'same' }, rounding: 'exact' } });
    expect(r.json().data.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(r.body).not.toMatch(/password|token|mfaSecret|hostname/);
  });
  it('updates profile, thresholds and pricing atomically, audits each change, and queues recon', async () => {
    const r = await put({ profile: { name: 'Updated store' }, thresholds: { priceTolerance: 0.05, stockThreshold: 2, staleHours: 24 },
      pricing: { defaultRule: { mode: 'percent', value: 5 }, rounding: '0.25' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ profile: { name: 'Updated store' }, thresholds: { priceTolerance: 0.05, stockThreshold: 2, staleHours: 24 },
      pricing: { defaultRule: { mode: 'percent', value: 5 }, rounding: '0.25' } });
    expect((await h.request('GET', '/api/auth/me', a, a.owner)).json().data.tenant.name).toBe('Updated store');
    expect((await h.fixture.prisma.store.findUniqueOrThrow({ where: { tenantId: a.id } })).name).toBe('Updated store');
    const events = await h.fixture.prisma.auditEvent.findMany({ where: { tenantId: a.id, action: { in: ['settings.changed', 'pricing.settings_changed'] } } });
    expect(events).toHaveLength(6);
    expect(events.every(e => e.actorId && e.requestId)).toBe(true);
    expect(events.map(e => e.details)).toContainEqual({ field: 'stockThreshold', old: 0, new: 2 });
    expect(h.recon.calls.at(-1)).toEqual({ tenantId: a.id, reason: 'settings.changed' });
    expect((await get(b)).json().data.thresholds.stockThreshold).toBe(0);
  });
  it('rejects stale revisions and detects changes through the existing pricing endpoint', async () => {
    const before = (await get()).json().data;
    const r = await h.request('PUT', '/api/pricing/settings', a, a.owner, { rounding: '0.50' }); expect(r.statusCode).toBe(200);
    const stale = await h.request('PUT', '/api/settings', a, a.owner, { expectedRevision: before.revision, profile: { name: 'Lost update' } });
    expect(stale.statusCode).toBe(409);
    expect((await get()).json().data.profile.name).toBe('Updated store');
  });
  it('has one winner when two edits use the same revision', async () => {
    const { revision } = (await get()).json().data;
    const results = await Promise.all([25, 26].map(staleHours => h.request('PUT', '/api/settings', a, a.owner, { expectedRevision: revision, thresholds: { staleHours } })));
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
  });
  it('does not audit or change the revision for a no-op', async () => {
    const before = (await get()).json().data, count = await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id } });
    const r = await put({ thresholds: { staleHours: before.thresholds.staleHours } });
    expect(r.json().data.revision).toBe(before.revision);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id } })).toBe(count);
  });
  it.each([
    { thresholds: { staleHours: 0 } }, { thresholds: { staleHours: 1.5 } }, { thresholds: { staleHours: 8761 } },
    { thresholds: { stockThreshold: -1 } }, { thresholds: { priceTolerance: 0.0001 } }, { thresholds: {} },
    { profile: { name: ' ' } }, { profile: { name: 'x', email: 'not-stored' } }, { timeZone: 'UTC' }, { currency: 'USD' },
    { pricing: { rounding: '1.00' } }, { security: { mfaRequiredForAll: 'true' } }, { tenantId: 'other' },
  ])('rejects invalid or unstored fields %j', async fields => { expect((await put(fields)).statusCode).toBe(400); });
  it('requires a revision and a change', async () => {
    expect((await h.request('PUT', '/api/settings', a, a.owner, { profile: { name: 'x' } })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
  });
  it('uses Owner/Admin for ordinary edits; only Owner can change MFA policy', async () => {
    for (const who of [manager, analyst]) {
      expect((await get(a, who)).statusCode).toBe(200);
      expect((await put({ thresholds: { staleHours: 48 } }, who)).statusCode).toBe(403);
    }
    expect((await put({ thresholds: { staleHours: 48 } }, admin)).statusCode).toBe(200);
    expect((await put({ security: { mfaRequiredForAll: true } }, admin)).statusCode).toBe(403);
    expect((await put({ security: { analystCanExport: false } }, admin)).statusCode).toBe(200);
    const me = await h.request('GET', '/api/auth/me', a, analyst);
    expect(me.json().data.permissions).not.toContain('reports.export');
    // The authenticator app is optional (ADR 021): an Owner without one cannot require it for everyone.
    expect((await put({ security: { mfaRequiredForAll: true } })).statusCode).toBe(409);
    const ownerId = (await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id, name: 'Owner' } })).id;
    await h.fixture.prisma.user.update({ where: { id: ownerId }, data: { mfaSecret: 'sealed-app-secret' } });
    expect((await put({ security: { mfaRequiredForAll: true } })).statusCode).toBe(200);
    const blocked = await get(a, analyst);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('AUTHENTICATOR_SETUP_REQUIRED');
    expect((await put({ security: { mfaRequiredForAll: false } })).statusCode).toBe(200);
    await h.fixture.prisma.user.update({ where: { id: ownerId }, data: { mfaSecret: null } });
  });
  it('requires the correct tenant session, Origin and CSRF', async () => {
    expect((await h.request('GET', '/api/settings', a)).statusCode).toBe(401);
    expect((await get(b, a.owner)).statusCode).toBe(401);
    expect((await put({ profile: { name: 'x' } }, { ...a.owner, csrf: 'wrong' })).statusCode).toBe(403);
    const noOrigin = await h.api.server.inject({ method: 'PUT', url: '/api/settings', headers: { host: a.hostname + ':4000', cookie: a.owner.cookie }, payload: {} });
    expect(noOrigin.statusCode).toBe(403);
  });
  it('lists every marketplace with its effective switch from applied uploads and explicit switches', async () => {
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: a.id, source: 'snoonu', fileName: 'sample.xlsx', size: 1, storageKey: 'test-settings', uploadedById: user.id,
      status: 'applied', appliedAt: new Date(Date.now() - 7200000) } });
    await h.fixture.prisma.tenantMarketplace.createMany({ data: [
      { tenantId: a.id, marketplaceId: 'talabat', enabled: true }, { tenantId: a.id, marketplaceId: 'keeta', enabled: false },
    ] });
    const r = await h.request('GET', '/api/settings/marketplaces', a, analyst);
    expect(r.statusCode).toBe(200);
    const items = r.json().data.items as { marketplaceId: string; enabled: boolean; explicit: boolean; ageHours: number | null }[];
    expect(items.map(x => [x.marketplaceId, x.enabled, x.explicit])).toEqual([['talabat', true, true], ['snoonu', true, false], ['rafeeq', false, false], ['keeta', false, true]]);
    expect(items[0]).toMatchObject({ hasData: false, lastUploadAt: null, ageHours: null });
    expect(items[1]!.ageHours).toBeGreaterThanOrEqual(2);
    expect(r.json().data.revision).toBe((await get()).json().data.revision);
    expect((await h.request('GET', '/api/settings/marketplaces', b, b.owner)).json().data.items.filter((x: { enabled: boolean }) => x.enabled)).toEqual([]);
  });
  it('changes the reconciliation results and stale warning through existing consumers', async () => {
    await h.recon.drain();
    const s = await h.createOwner('settings-consumers');
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id } });
    const upload = await h.fixture.prisma.upload.create({ data: { tenantId: s.id, source: 'snoonu', fileName: 'consumer.xlsx', size: 1,
      storageKey: 'settings-consumer', uploadedById: user.id, status: 'applied', appliedAt: new Date(Date.now() - 48 * 3600000) } });
    const product = await h.fixture.prisma.product.create({ data: { tenantId: s.id, barcode: '629999900003', normalizedBarcode: '629999900003',
      nameEn: 'Consumer', erpPrice: 10, erpStock: 1, status: 'active' } });
    await h.fixture.prisma.listing.create({ data: { tenantId: s.id, productId: product.id, marketplaceId: 'snoonu', marketplaceProductId: 'consumer',
      barcodes: [product.barcode], price: 10, available: true, uploadId: upload.id } });
    await recomputeRecon({ database: h.fixture.database }, { tenantId: s.id, reason: 'manual' });
    const before = (await h.request('GET', '/api/recon/summary', s, s.owner)).json().data.marketplaces[0];
    expect(before).toMatchObject({ stock: 0, price: 0, stale: true });
    h.recon.handler = job => recomputeRecon({ database: h.fixture.database }, job);
    try {
      const revision = (await get(s)).json().data.revision;
      const r = await h.request('PUT', '/api/settings', s, s.owner, { expectedRevision: revision, thresholds: { stockThreshold: 2, staleHours: 72 },
        pricing: { defaultRule: { mode: 'fixed', value: 11 } } });
      expect(r.statusCode).toBe(200); await h.recon.drain();
      const after = (await h.request('GET', '/api/recon/summary', s, s.owner)).json().data.marketplaces[0];
      expect(after).toMatchObject({ stock: 1, price: 1, stale: false });
    } finally { await h.recon.drain(); h.recon.handler = undefined; }
  });
});

describe('PUT /api/settings/marketplaces (plan step 6)', () => {
  let s: Store, sAdmin: Session, sManager: Session, sAnalyst: Session;
  const revision = async (store: Store) => (await h.request('GET', '/api/settings', store, store.owner)).json().data.revision as string;
  const setMarketplaces = async (store: Store, enabled: unknown, who = store.owner, expectedRevision?: string) =>
    h.request('PUT', '/api/settings/marketplaces', store, who, { expectedRevision: expectedRevision ?? await revision(store), enabled });
  const switches = async (store: Store) => (await h.fixture.prisma.tenantMarketplace.findMany({ where: { tenantId: store.id } }))
    .map(r => [r.marketplaceId, r.enabled]).sort();
  beforeAll(async () => {
    s = await h.createOwner('settings-mp');
    sAdmin = await h.member(s, 'admin'); sManager = await h.member(s, 'catalogue_manager'); sAnalyst = await h.member(s, 'analyst');
  });

  it('switches the chosen marketplaces on and all others off, audits once and recomputes', async () => {
    const before = await revision(s);
    const r = await setMarketplaces(s, ['snoonu', 'talabat']);
    expect(r.statusCode).toBe(200);
    expect(r.json().data.items.map((x: { marketplaceId: string; enabled: boolean; explicit: boolean }) => [x.marketplaceId, x.enabled, x.explicit]))
      .toEqual([['talabat', true, true], ['snoonu', true, true], ['rafeeq', false, true], ['keeta', false, true]]);
    expect(r.json().data.revision).not.toBe(before);
    expect(r.json().data.revision).toBe(await revision(s));
    expect(await switches(s)).toEqual([['keeta', false], ['rafeeq', false], ['snoonu', true], ['talabat', true]]);
    const events = await h.fixture.prisma.auditEvent.findMany({ where: { tenantId: s.id, action: 'settings.changed' } });
    expect(events.map(e => e.details)).toEqual([{ field: 'marketplaces', old: [], new: ['talabat', 'snoonu'] }]);
    expect(h.recon.calls.at(-1)).toEqual({ tenantId: s.id, reason: 'settings.marketplaces' });
    expect(await switches(b)).toEqual([]);
  });
  it('writes nothing when the same set is saved again', async () => {
    const calls = h.recon.calls.length, before = await revision(s);
    const r = await setMarketplaces(s, ['talabat', 'snoonu'], sAdmin);
    expect(r.statusCode).toBe(200);
    expect(r.json().data.revision).toBe(before);
    expect(h.recon.calls.length).toBe(calls);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'settings.changed' } })).toBe(1);
  });
  it('keeps the data of a switched-off marketplace', async () => {
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: s.id, source: 'snoonu', fileName: 'kept.xlsx', size: 1, storageKey: 'settings-mp-kept', uploadedById: user.id, status: 'applied', appliedAt: new Date() } });
    const r = await setMarketplaces(s, ['talabat']);
    expect(r.json().data.items.find((x: { marketplaceId: string }) => x.marketplaceId === 'snoonu')).toMatchObject({ enabled: false, hasData: true });
    expect(await h.fixture.prisma.upload.count({ where: { tenantId: s.id, source: 'snoonu' } })).toBe(1);
    expect((await h.fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: s.id, action: 'settings.changed' }, orderBy: { createdAt: 'desc' } })).details)
      .toEqual({ field: 'marketplaces', old: ['talabat', 'snoonu'], new: ['talabat'] });
  });
  it('makes implicit switches explicit without an event or a recompute when the effective set is unchanged', async () => {
    const legacy = await h.createOwner('settings-mp-legacy');
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: legacy.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: legacy.id, source: 'keeta', fileName: 'old.xlsx', size: 1, storageKey: 'settings-mp-legacy', uploadedById: user.id, status: 'applied', appliedAt: new Date() } });
    const calls = h.recon.calls.length;
    expect((await setMarketplaces(legacy, ['keeta'])).statusCode).toBe(200);
    expect(await switches(legacy)).toEqual([['keeta', true], ['rafeeq', false], ['snoonu', false], ['talabat', false]]);
    expect(h.recon.calls.length).toBe(calls);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: legacy.id, action: 'settings.changed' } })).toBe(0);
  });
  it('validates the body and the revision', async () => {
    for (const enabled of [[], ['talabat', 'talabat'], ['amazon'], 'talabat', ['talabat', 'snoonu', 'rafeeq', 'keeta', 'talabat']]) {
      expect((await setMarketplaces(s, enabled)).statusCode).toBe(400);
    }
    expect((await h.request('PUT', '/api/settings/marketplaces', s, s.owner, { enabled: ['talabat'] })).statusCode).toBe(400);
    expect((await h.request('PUT', '/api/settings/marketplaces', s, s.owner, { expectedRevision: await revision(s), enabled: ['talabat'], extra: 1 })).statusCode).toBe(400);
    expect((await setMarketplaces(s, ['rafeeq'], s.owner, 'a'.repeat(64))).statusCode).toBe(409);
    expect(await switches(s)).toContainEqual(['rafeeq', false]);
  });
  it('is Owner and Admin only, with CSRF', async () => {
    expect((await setMarketplaces(s, ['rafeeq'], sManager)).statusCode).toBe(403);
    expect((await setMarketplaces(s, ['rafeeq'], sAnalyst)).statusCode).toBe(403);
    expect((await setMarketplaces(s, ['rafeeq'], { ...s.owner, csrf: 'wrong' })).statusCode).toBe(403);
    expect(await switches(s)).toContainEqual(['rafeeq', false]);
    expect((await setMarketplaces(s, ['rafeeq', 'talabat'], sAdmin)).statusCode).toBe(200);
  });
});
