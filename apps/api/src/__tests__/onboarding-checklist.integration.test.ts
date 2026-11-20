// Plan step 10 (docs/plans/onboarding-redesign-backend.md): GET /api/onboarding checklist and essentials, derived from
// real data, as an owner sees them while setting a store up and when coming back halfway.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';

type Item = { id: string; status: string; canAct: boolean; doneAt: string | null; detail: Record<string, unknown> };
type Body = { checklist: Item[]; essentials: { complete: boolean; percent: number; missing: { id: string; message: string }[] } };
let h: Harness, s: Store, manager: Session, analyst: Session;
const get = async (store: Store, who: Session = store.owner) => {
  const r = await h.request('GET', '/api/onboarding', store, who);
  expect(r.statusCode).toBe(200);
  return r.json().data as Body;
};
const item = (body: Body, id: string) => body.checklist.find(i => i.id === id)!;
let n = 0;
async function upload(store: Store, source: string, status: string, appliedAt: Date | null = null) {
  const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id } });
  return h.fixture.prisma.upload.create({ data: { tenantId: store.id, source, fileName: source + '.xlsx', size: 1, storageKey: `oc-${store.id}-${++n}`, uploadedById: user.id, status, appliedAt } });
}

beforeAll(async () => {
  h = await createHarness();
  s = await h.createOwner('oc-a');
  manager = await h.member(s, 'catalogue_manager');
  analyst = await h.member(s, 'analyst');
});
afterAll(async () => { await h.close(); });

describe('onboarding checklist through the API', () => {
  it('walks a new store through the essentials, resuming each step from stored data', async () => {
    let p = await get(s);
    expect(p.essentials).toMatchObject({ complete: false, percent: 0 });
    expect(item(p, 'store_details').status).toBe('next');
    expect(item(p, 'authenticator_app').status).toBe('done');

    const revision = (await h.request('GET', '/api/settings', s, s.owner)).json().data.revision;
    expect((await h.request('PUT', '/api/settings/marketplaces', s, s.owner, { expectedRevision: revision, enabled: ['talabat', 'snoonu'] })).statusCode).toBe(200);
    p = await get(s);
    expect(item(p, 'store_details')).toMatchObject({ status: 'done', detail: { enabledMarketplaces: ['talabat', 'snoonu'] } });
    expect(item(p, 'erp_upload').status).toBe('next');

    // An ERP file left waiting for its column mapping is shown to continue, not to start again.
    const erp = await upload(s, 'erp', 'needs_mapping');
    p = await get(s);
    expect(item(p, 'erp_upload').detail.pendingUpload).toMatchObject({ id: erp.id, status: 'needs_mapping' });
    expect(p.essentials.missing[0]).toEqual({ id: 'erp_upload', message: 'Your ERP file is waiting for column mapping' });
    const appliedAt = new Date(Date.now() - 60_000);
    await h.fixture.prisma.upload.update({ where: { id: erp.id }, data: { status: 'applied', appliedAt } });
    p = await get(s);
    expect(item(p, 'erp_upload')).toMatchObject({ status: 'done', doneAt: appliedAt.toISOString(), detail: { pendingUpload: null } });

    await upload(s, 'talabat', 'applied', new Date());
    const rejected = await upload(s, 'snoonu', 'rejected');
    p = await get(s);
    expect(item(p, 'marketplace_uploads').detail.items).toEqual([
      expect.objectContaining({ marketplaceId: 'talabat', status: 'done' }),
      expect.objectContaining({ marketplaceId: 'snoonu', status: 'pending', pendingUpload: expect.objectContaining({ id: rejected.id, status: 'rejected' }) }),
    ]);
    expect(item(p, 'first_comparison').status).toBe('waiting');
    expect(item(p, 'price_source')).toMatchObject({ status: 'todo', detail: { canAdoptFrom: ['talabat'] } });
    expect(item(p, 'marketplace_uploads').status).toBe('next');

    await upload(s, 'snoonu', 'applied', new Date());
    await h.fixture.prisma.reconSummary.create({ data: { tenantId: s.id, marketplaceId: 'talabat', hasData: true, listed: 2, computedAt: new Date() } });
    p = await get(s);
    expect(p.essentials).toEqual({ complete: false, percent: 80, missing: [{ id: 'price_source', message: 'Choose how your prices are set' }] });

    expect((await h.request('PUT', '/api/pricing/price-source', s, s.owner, { source: 'erp_markup', rule: { mode: 'percent', value: 10 } })).statusCode).toBe(200);
    p = await get(s);
    expect(p.essentials).toEqual({ complete: true, percent: 100, missing: [] });
    expect(p.checklist.filter(i => i.status === 'next')).toEqual([]);
  });
  it('shows the essentials to every role and the upload steps to Catalogue Managers only', async () => {
    const asManager = await get(s, manager);
    expect(asManager.checklist.map(i => i.id)).toEqual(['erp_upload', 'marketplace_uploads']);
    expect(asManager.essentials.complete).toBe(true);
    const asAnalyst = await get(s, analyst);
    expect(asAnalyst.checklist).toEqual([]);
    expect(asAnalyst.essentials.complete).toBe(true);
  });
  it('reports a failed first comparison with a safe reason, and isolates stores', async () => {
    const f = await h.createOwner('oc-failed');
    await upload(f, 'erp', 'applied', new Date());
    await upload(f, 'keeta', 'applied', new Date());
    expect(item(await get(f), 'first_comparison').status).toBe('waiting');
    await h.fixture.prisma.auditEvent.create({ data: { tenantId: f.id, action: 'recon.failed', details: { reason: 'upload.applied', error: 'secret detail' } } });
    const p = await get(f);
    expect(item(p, 'first_comparison')).toMatchObject({ status: 'failed', canAct: false });
    expect(JSON.stringify(p)).not.toContain('secret detail');
    // A later successful computation without matched data clears the failure (the older event is ignored).
    await h.fixture.prisma.reconSummary.create({ data: { tenantId: f.id, marketplaceId: 'keeta', hasData: true, listed: 0, computedAt: new Date(Date.now() + 1000) } });
    expect(item(await get(f), 'first_comparison').status).toBe('waiting');
    // The first store's events and data never show here.
    expect(item(await get(f), 'store_details').detail.enabledMarketplaces).toEqual(['keeta']);
    expect((await h.request('GET', '/api/onboarding', f, s.owner)).statusCode).toBe(401);
  });
});

describe('GET /api/onboarding/summary (plan step 11)', () => {
  it('counts products, matches per enabled marketplace and the problems found', async () => {
    const t = await h.createOwner('oc-summary');
    const revision = (await h.request('GET', '/api/settings', t, t.owner)).json().data.revision;
    expect((await h.request('PUT', '/api/settings/marketplaces', t, t.owner, { expectedRevision: revision, enabled: ['talabat', 'rafeeq'] })).statusCode).toBe(200);
    for (const [i, status, blocked] of [[1, 'active', false], [2, 'active', false], [3, 'new', false], [4, 'active', true]] as const) {
      const barcode = String(6_286_000_000_000 + i);
      await h.fixture.prisma.product.create({ data: { tenantId: t.id, nameEn: 'P' + i, barcode, normalizedBarcode: barcode, erpPrice: 1, erpStock: 1, status,
        ...(blocked ? { blockedAt: new Date(), blockedReason: 'old' } : {}) } });
    }
    const erpOld = await upload(t, 'erp', 'applied', new Date(Date.now() - 86_400_000));
    const erp = await upload(t, 'erp', 'applied', new Date());
    await upload(t, 'snoonu', 'applied', new Date()); // switched off: not part of the summary
    await h.fixture.prisma.uploadError.createMany({ data: [
      { tenantId: t.id, uploadId: erp.id, row: 2, reason: 'Missing barcode' }, { tenantId: t.id, uploadId: erp.id, row: 3, reason: 'Missing price' },
      { tenantId: t.id, uploadId: erpOld.id, row: 9, reason: 'Older file, not counted' },
    ] });
    const computedAt = new Date();
    await h.fixture.prisma.reconSummary.createMany({ data: [
      { tenantId: t.id, marketplaceId: 'talabat', hasData: true, total: 3, listed: 2, notListed: 1, missingFromErp: 1, price: 1, stock: 2, newCount: 1, computedAt },
      { tenantId: t.id, marketplaceId: 'snoonu', hasData: true, total: 3, listed: 3, price: 5, computedAt },
      { tenantId: t.id, marketplaceId: 'talabat', reference: 'erp', hasData: true, total: 3, listed: 2, price: 99, computedAt },
    ] });

    const r = await h.request('GET', '/api/onboarding/summary', t, await h.member(t, 'analyst'));
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d).toMatchObject({ reference: 'marketplace', products: { loaded: 4, active: 2, blocked: 1 } });
    expect(d.computedAt).toBe(computedAt.toISOString());
    expect(d.marketplaces).toEqual([
      expect.objectContaining({ marketplaceId: 'talabat', hasData: true, compared: 3, matched: 2, notListed: 1, missingFromErp: 1, newProducts: 1, priceMismatches: 1, stockMismatches: 2 }),
      expect.objectContaining({ marketplaceId: 'rafeeq', hasData: false, compared: 0, matched: 0, lastUploadAt: null }),
    ]);
    expect(d.uploads.map((u: { source: string }) => u.source)).toEqual(['erp', 'talabat', 'rafeeq']);
    expect(d.uploads[0]).toMatchObject({ uploadId: erp.id, rowErrors: 2 });
    expect(d.problems).toEqual({ priceMismatches: 1, stockMismatches: 2, notListed: 1, missingFromErp: 1, stockConflicts: 0, uploadRowErrors: 2 });
    expect(r.body).not.toMatch(/Missing barcode|storageKey|fileName/);

    expect((await h.request('GET', '/api/onboarding/summary', t)).statusCode).toBe(401);
    expect((await h.request('GET', '/api/onboarding/summary', t, s.owner)).statusCode).toBe(401);
    const other = (await h.request('GET', '/api/onboarding/summary', s, s.owner)).json().data;
    expect(other.products.loaded).toBe(0);
  });
});
