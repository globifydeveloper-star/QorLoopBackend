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
    expect((await put({ security: { mfaRequiredForAll: true } })).statusCode).toBe(200);
    expect((await get(a, analyst)).statusCode).toBe(403);
    expect((await put({ security: { mfaRequiredForAll: false } })).statusCode).toBe(200);
  });
  it('requires the correct tenant session, Origin and CSRF', async () => {
    expect((await h.request('GET', '/api/settings', a)).statusCode).toBe(401);
    expect((await get(b, a.owner)).statusCode).toBe(401);
    expect((await put({ profile: { name: 'x' } }, { ...a.owner, csrf: 'wrong' })).statusCode).toBe(403);
    const noOrigin = await h.api.server.inject({ method: 'PUT', url: '/api/settings', headers: { host: a.hostname + ':4000', cookie: a.owner.cookie }, payload: {} });
    expect(noOrigin.statusCode).toBe(403);
  });
  it('lists enabled marketplaces using applied uploads and explicit switches', async () => {
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: a.id, source: 'snoonu', fileName: 'sample.xlsx', size: 1, storageKey: 'test-settings', uploadedById: user.id,
      status: 'applied', appliedAt: new Date(Date.now() - 7200000) } });
    await h.fixture.prisma.tenantMarketplace.createMany({ data: [
      { tenantId: a.id, marketplaceId: 'talabat', enabled: true }, { tenantId: a.id, marketplaceId: 'keeta', enabled: false },
    ] });
    const r = await h.request('GET', '/api/settings/marketplaces', a, analyst);
    expect(r.statusCode).toBe(200);
    expect(r.json().data.items.map((x: { marketplaceId: string }) => x.marketplaceId)).toEqual(['talabat', 'snoonu']);
    expect(r.json().data.items[0]).toMatchObject({ enabled: true, hasData: false, lastUploadAt: null, ageHours: null });
    expect(r.json().data.items[1].ageHours).toBeGreaterThanOrEqual(2);
    expect((await h.request('GET', '/api/settings/marketplaces', b, b.owner)).json().data.items).toEqual([]);
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
