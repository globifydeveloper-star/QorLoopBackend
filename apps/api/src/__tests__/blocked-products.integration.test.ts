import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { processUpload } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';
import { InlineReconQueue } from '../../../../packages/shared/src/recon.js';
import { loadGenerationInputs } from '../../../../packages/shared/src/generated-files.js';

/**
 * Blocked products (migration 202611170001) through the real API, upload pipeline, apply and recon workers: block and
 * unblock, list filters and counts, and every check and change that must skip a blocked product.
 */
let h: Harness;
let recon: InlineReconQueue;
let a: Store, b: Store;
let manager: Session, analyst: Session, admin: Session;

async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const erpHeader = ['Barcode', 'Item Name', 'Sale Price', 'Qty'];
const erpFields = { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' };
const talabatHeader = ['sku', 'barcode 1', 'name', 'price', 'active'];
const talabatFields = { marketplaceProductId: 'sku', barcode1: 'barcode 1', name: 'name', price: 'price', available: 'active' };
const A = '6281000000011', B = '6281000000028', C = '6281000000035', D = '6281000000042', N = '6281000000066';

/** Upload, map, review and (optionally) apply; the inline queues run the real workers. Returns the upload id. */
async function uploadFile(store: Store, who: Session, source: string, rows: unknown[][], fields: Record<string, string>, apply = true) {
  const file = await xlsx(rows);
  const created = await h.request('POST', '/api/uploads', store, who, { source, fileName: `${source}.xlsx`, size: file.length, contains: 'full' });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  h.storage.put((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).storageKey, file);
  expect((await h.request('POST', `/api/uploads/${id}/complete`, store, who)).statusCode).toBe(200);
  const status = async () => (await h.request('GET', `/api/uploads/${id}`, store, who)).json().data.status;
  if (await status() === 'needs_mapping') expect((await h.request('POST', `/api/uploads/${id}/mapping`, store, who, { fields })).statusCode).toBe(200);
  expect(await status()).toBe('needs_review');
  if (apply) {
    expect((await h.request('POST', `/api/uploads/${id}/apply`, store, who)).statusCode).toBe(200);
    expect(await status()).toBe('applied');
    await recon.drain();
  }
  return id;
}
const erp = (rows: [string, string, number, number][]) => uploadFile(a, manager, 'erp', [erpHeader, ...rows], erpFields);
const productId = async (barcode: string, store = a) => (await h.fixture.prisma.product.findFirstOrThrow({ where: { tenantId: store.id, normalizedBarcode: barcode } })).id;
const get = async (url: string, who = manager, store = a) => {
  const r = await h.request('GET', url, store, who);
  expect([url, r.statusCode]).toEqual([url, 200]);
  return r.json().data;
};
const post = (url: string, body: Record<string, unknown>, who = manager, store = a) => h.request('POST', url, store, who, body);
async function ok(url: string, body: Record<string, unknown>, who = manager, store = a) {
  const r = await post(url, body, who, store);
  expect([url, r.statusCode, r.statusCode === 200 ? null : r.body]).toEqual([url, 200, null]);
  return r.json().data;
}
const reasonsSince = (n: number) => recon.calls.slice(n).map(c => c.reason);
const reconBarcodes = async () => ((await get('/api/recon/rows?marketplaceId=talabat&limit=50&reference=marketplace')).items as { barcode: string }[]).map(i => i.barcode).sort();
const talabatSummary = async () => ((await get('/api/recon/summary?reference=marketplace')).marketplaces as { marketplaceId: string; price: number; listed: number }[])
  .find(m => m.marketplaceId === 'talabat')!;
const listIds = async (query = '') => ((await get(`/api/products?limit=200${query}`)).items as { id: string }[]).map(i => i.id);
const END = new Date(Date.now() + 10 * 86_400_000).toISOString();

let idA: string, idB: string, idC: string, idN: string;
let priceBefore: number;

beforeAll(async () => {
  h = await createHarness();
  recon = h.recon as InlineReconQueue;
  h.queue.handler = job => processUpload({ database: h.fixture.database, storage: h.storage }, job).then(() => undefined);
  h.queue.applyHandler = job => applyUpload({ database: h.fixture.database, recon }, job).then(() => undefined);
  recon.handler = job => recomputeRecon({ database: h.fixture.database }, job);
  a = await h.createOwner('blocka');
  b = await h.createOwner('blockb');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
  admin = await h.member(a, 'admin');
  // first import: four active products; Talabat lists A, B in sync and C at 5 against an ERP price of 1 (a price mismatch)
  await erp([[A, 'Laban', 10, 5], [B, 'Juice', 4, 3], [C, 'Water', 1, 10], [D, 'Bread', 2, 3]]);
  await uploadFile(a, manager, 'talabat', [talabatHeader, ['T-A', A, 'Laban', 10, 'TRUE'], ['T-B', B, 'Juice', 4, 'TRUE'], ['T-C', C, 'Water', 5, 'TRUE']], talabatFields);
  [idA, idB, idC] = [await productId(A), await productId(B), await productId(C)];
  // N: a new product (not activated yet); C has an active offer
  idN = (await h.fixture.prisma.product.create({ data: { tenantId: a.id, nameEn: 'New thing', barcode: N, normalizedBarcode: N, erpPrice: 3, status: 'new' } })).id;
  await h.fixture.prisma.productOffer.create({ data: { tenantId: a.id, productId: idC, price: 0.75, validFrom: null, validUntil: new Date(END) } });
  await recon.enqueueRecon(a.id, 'manual');
  await recon.drain();
}, 180_000);
afterAll(async () => { await h.close(); });

describe('block and unblock: access and contract', () => {
  it('needs products.block (owner, admin, catalogue manager; not the analyst) and the CSRF token', async () => {
    const body = { productIds: [randomUUID()], reason: 'old' };
    for (const url of ['/api/products/block/preview', '/api/products/unblock']) {
      expect((await post(url, body, analyst)).statusCode).toBe(403);
      expect((await post(url, body, { ...manager, csrf: 'wrong' })).statusCode).toBe(403);
    }
    expect((await post('/api/products/block', { ...body, previewToken: 'a'.repeat(64) }, analyst)).statusCode).toBe(403);
    expect((await post('/api/products/block/preview', body, admin)).statusCode).toBe(200);
    expect((await post('/api/products/block/preview', body, a.owner)).statusCode).toBe(200);
    expect((await post('/api/products/block/preview', body)).statusCode).toBe(200);
  });

  it('refuses a malformed request (400)', async () => {
    const id = randomUUID();
    const bad: Record<string, unknown>[] = [
      {}, { reason: 'old' }, { productIds: [id] }, { productIds: [id], reason: 'retired' }, { productIds: [], reason: 'old' },
      { productIds: Array.from({ length: 501 }, () => randomUUID()), reason: 'old' }, { productIds: [id], filter: {}, reason: 'old' },
      { filter: { marketplaceStatus: 'mismatch' }, reason: 'old' }, { filter: { limit: 5 }, reason: 'old' },
    ];
    for (const body of bad) expect([JSON.stringify(body).slice(0, 60), (await post('/api/products/block/preview', body)).statusCode]).toEqual([JSON.stringify(body).slice(0, 60), 400]);
    expect((await post('/api/products/block', { productIds: [id], reason: 'old' })).statusCode).toBe(400); // no previewToken
    expect((await post('/api/products/unblock', { productIds: [id], filter: {} })).statusCode).toBe(400);
  });

  it('is documented in OpenAPI, with the blocked list filter and counts', () => {
    for (const p of ['/api/products/block/preview', '/api/products/block', '/api/products/unblock']) expect(h.api.spec.paths[p]?.post?.requestBody).toBeDefined();
    const list = h.api.spec.paths['/api/products']?.get as { parameters?: { name: string }[] } | undefined;
    expect(list?.parameters?.map(p => p.name)).toContain('blocked');
    expect(JSON.stringify(h.api.spec.paths['/api/products'])).toContain('isBlocked');
  });
});

describe('before blocking', () => {
  it('C is reconciled (a Talabat price mismatch), in the generated file and on the list', async () => {
    expect(await reconBarcodes()).toEqual([A, B, C, D, N].sort());
    priceBefore = (await talabatSummary()).price;
    expect(priceBefore).toBeGreaterThanOrEqual(1);
    const inputs = await h.fixture.database.readSnapshot(a.id, d => loadGenerationInputs(d, 'talabat', 'marketplace'));
    expect(inputs.rows.map(r => r.productId)).toContain(idC);
    expect((await get('/api/products')).counts).toEqual({ all: 5, active: 4, inactive: 0, new: 1, missing: 0, blocked: 0 });
  });
});

describe('POST /api/products/block/preview and /block', () => {
  let token: string;
  const body = () => ({ productIds: [idC, idN, randomUUID()], reason: 'seasonal' });

  it('previews the products to block, those already blocked and the active offers that will end; writes nothing', async () => {
    const d = await ok('/api/products/block/preview', body());
    expect(d).toMatchObject({ reason: 'seasonal', reasonLabel: 'Seasonal', selected: 2, toBlock: 2, alreadyBlocked: 0, notFound: 1, activeOffersToEnd: 1 });
    expect(d.offersNote).toMatch(/not bring them back/);
    expect(d.previewToken).toMatch(/^[a-f0-9]{64}$/);
    token = d.previewToken;
    expect(await h.fixture.prisma.product.count({ where: { tenantId: a.id, blockedAt: { not: null } } })).toBe(0);
  });

  it('refuses a token that does not match the selection (409)', async () => {
    const r = await post('/api/products/block', { ...body(), reason: 'old', previewToken: token });
    expect(r.statusCode).toBe(409);
    expect(await h.fixture.prisma.product.count({ where: { tenantId: a.id, blockedAt: { not: null } } })).toBe(0);
  });

  it('blocks: status kept, the active offer ended, recon rows removed, events written, a recompute queued', async () => {
    const before = recon.calls.length;
    const d = await ok('/api/products/block', { ...body(), previewToken: token });
    expect(d).toMatchObject({ blocked: 2, alreadyBlocked: 0, notFound: 1, offersEnded: 1, reason: 'seasonal' });
    expect(d.offersNote).toMatch(/not restored/);
    await recon.drain();
    expect(reasonsSince(before)).toContain('product.blocked');

    const c = await h.fixture.prisma.product.findUniqueOrThrow({ where: { id: idC } });
    expect(c).toMatchObject({ status: 'active', blockedReason: 'seasonal', blockedBy: expect.any(String) });
    expect(c.blockedAt).toBeInstanceOf(Date);
    expect((await h.fixture.prisma.product.findUniqueOrThrow({ where: { id: idN } })).status).toBe('new');
    const offer = await h.fixture.prisma.productOffer.findFirstOrThrow({ where: { productId: idC } });
    expect(offer.validUntil!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await h.fixture.prisma.reconRow.count({ where: { productId: { in: [idC, idN] } } })).toBe(0);

    const perProduct = await h.fixture.prisma.auditEvent.findMany({ where: { tenantId: a.id, action: 'product.blocked' } });
    expect(perProduct.map(e => e.entityId).sort()).toEqual([idC, idN].sort());
    expect((perProduct.find(e => e.entityId === idC)!.details as { offersEnded: unknown[] }).offersEnded).toHaveLength(1);
    const summary = await h.fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.id, action: 'products.blocked' } });
    expect(summary.details).toMatchObject({ mode: 'ids', reason: 'seasonal', blocked: 2, offersEnded: 1 });
    const activity = await get(`/api/activity?productId=${idC}`, a.owner);
    expect(JSON.stringify(activity)).toContain('Product blocked (seasonal)');
  });

  it('a second preview finds them already blocked; nothing more to do', async () => {
    const d = await ok('/api/products/block/preview', body());
    expect(d).toMatchObject({ toBlock: 0, alreadyBlocked: 2, activeOffersToEnd: 0 });
  });
});

describe('list filters and counts', () => {
  it('blocked=exclude (default) hides them from the list and the tabs; counts.blocked shows the Blocked tab number', async () => {
    const ids = await listIds();
    expect(ids).not.toContain(idC);
    expect(ids).not.toContain(idN);
    expect((await get('/api/products')).counts).toEqual({ all: 3, active: 3, inactive: 0, new: 0, missing: 0, blocked: 2 });
  });
  it('blocked=only is the Blocked tab, its items flagged; include shows both', async () => {
    const only = await get('/api/products?blocked=only');
    expect((only.items as { id: string }[]).map(i => i.id).sort()).toEqual([idC, idN].sort());
    expect(only.items[0]).toMatchObject({ isBlocked: true, blockedReason: 'seasonal', blockedAt: expect.any(String) });
    expect(only.counts).toEqual({ all: 2, active: 1, inactive: 0, new: 1, missing: 0, blocked: 2 });
    expect((await get('/api/products?blocked=only&tab=new')).items.map((i: { id: string }) => i.id)).toEqual([idN]);
    const all = await get('/api/products?blocked=include');
    expect(all.counts).toEqual({ all: 5, active: 4, inactive: 0, new: 1, missing: 0, blocked: 2 });
    expect((all.items as { id: string; isBlocked: boolean }[]).find(i => i.id === idA)!.isBlocked).toBe(false);
    expect((await get(`/api/products/${idC}`)).isBlocked).toBe(true);
  });
  it('"activate all new" skips a blocked new product; by id it is skipped with the reason', async () => {
    expect((await ok('/api/products/activate', { all: true })).activated).toBe(0);
    const byId = await ok('/api/products/activate', { ids: [idN] });
    expect(byId).toMatchObject({ activated: 0, skippedCount: 1, skipped: [{ id: idN, reason: expect.stringMatching(/blocked/) }] });
  });
});

describe('every check skips a blocked product', () => {
  it('recon rows and the Dashboard summary', async () => {
    expect(await reconBarcodes()).toEqual([A, B, D].sort());
    expect((await talabatSummary()).price).toBe(priceBefore - 1);
  });
  it('the Review lists and counts', async () => {
    const review = await get('/api/marketplace-values/review?marketplaceId=talabat&show=all');
    expect(JSON.stringify(review.items)).not.toContain(idC);
  });
  it('generated marketplace files', async () => {
    const inputs = await h.fixture.database.readSnapshot(a.id, d => loadGenerationInputs(d, 'talabat', 'marketplace'));
    expect(inputs.rows.map(r => r.productId)).not.toContain(idC);
    expect(inputs.rows.map(r => r.productId)).toContain(idA);
  });
  it('a marketplace row matched to it is returned with isBlocked, never compared', async () => {
    const d = await get('/api/products/marketplace-listings?marketplaceId=talabat&limit=50');
    const row = (d.items as { marketplaceProductId: string; isBlocked: boolean; availabilityAdjustment: unknown; product: { isBlocked: boolean } }[]).find(i => i.marketplaceProductId === 'T-C')!;
    expect(row).toMatchObject({ isBlocked: true, availabilityAdjustment: null, product: { id: idC, isBlocked: true } });
    expect((d.items as { marketplaceProductId: string; isBlocked: boolean }[]).find(i => i.marketplaceProductId === 'T-A')!.isBlocked).toBe(false);
  });
  it('bulk price: product_blocked, and the totals still add up', async () => {
    const d = await ok('/api/pricing/bulk/preview', { marketplaceId: 'talabat', selection: { productIds: [idC, idA] }, action: { type: 'match_erp' } });
    expect(d).toMatchObject({ selected: 2, blocked: 1, blockedReasons: [expect.objectContaining({ reason: 'product_blocked', count: 1 })] });
    expect(d.willChange + d.unchanged + d.blocked).toBe(d.selected);
    // a filter selection does not include the blocked product at all
    const byFilter = await ok('/api/pricing/bulk/preview', { marketplaceId: 'talabat', selection: { filter: { q: 'Water' } }, action: { type: 'match_erp' } });
    expect(byFilter.selected).toBe(0);
  });
  it('bulk offers (set and remove): product_blocked; a single offer or price rule edit is refused (409)', async () => {
    const set = await ok('/api/pricing/offers/bulk/preview', { items: [{ productId: idC, price: 0.5, validUntil: END }, { productId: idA, price: 9, validUntil: END }] });
    expect(set.rows.map((r: { reason: string | null }) => r.reason)).toEqual(['product_blocked', null]);
    expect(set.totals.items).toBe(set.totals.set + set.totals.unchanged + set.totals.rejected);
    const remove = await ok('/api/pricing/offers/bulk-remove/preview', { productIds: [idC] });
    expect(remove.totals).toMatchObject({ products: 1, remove: 0, skipped: 1, skippedReasons: [expect.objectContaining({ reason: 'product_blocked' })] });
    expect((await h.request('PUT', `/api/products/${idC}/offer`, a, manager, { price: 0.5, validUntil: END })).statusCode).toBe(409);
    expect((await h.request('PUT', `/api/products/${idC}/price-rule`, a, manager, { mode: 'fixed', value: 2 })).statusCode).toBe(409);
  });
  it('the active offers list', async () => {
    const d = await get('/api/pricing/active-offers');
    expect(JSON.stringify(d)).not.toContain(idC);
  });
});

describe('an ERP upload with a blocked product', () => {
  let upload: string;
  it('reviews it as no change: not new, not a price or stock change, not missing', async () => {
    // C: price 1 -> 3, stock 10 -> 7; N is not in the full file (it would be "missing")
    upload = await uploadFile(a, manager, 'erp', [erpHeader, [A, 'Laban', 10, 5], [B, 'Juice', 4, 3], [C, 'Water', 3, 7], [D, 'Bread', 2, 3]], erpFields, false);
    const u = await get(`/api/uploads/${upload}`);
    expect(u.summary).toMatchObject({ newProducts: 0, priceChanges: 0, stockChanges: 0, missingFromFile: 0, blockedProducts: 1 });
  });
  it('applies it: the blocked product is updated, but no change row is written or counted', async () => {
    const before = recon.calls.length;
    expect((await h.request('POST', `/api/uploads/${upload}/apply`, a, manager)).statusCode).toBe(200);
    await recon.drain();
    const c = await h.fixture.prisma.product.findUniqueOrThrow({ where: { id: idC } });
    expect([c.erpPrice.toNumber(), c.erpStock, c.blockedReason]).toEqual([3, 7, 'seasonal']);
    expect((await h.fixture.prisma.product.findUniqueOrThrow({ where: { id: idN } })).inLatestErpFile).toBe(false);
    expect(await h.fixture.prisma.erpUploadChange.count({ where: { uploadId: upload, productId: { in: [idC, idN] } } })).toBe(0);
    const changes = await get(`/api/uploads/${upload}/changes`);
    expect(changes.counts).toMatchObject({ all: 0, new: 0, price: 0 });
    expect(reasonsSince(before)).toContain('upload.applied');
    // still not reconciled after the recompute the upload asked for
    expect(await reconBarcodes()).toEqual([A, B, D].sort());
  });
});

describe('a filter selection', () => {
  it('blocks by the catalogue filter, and refuses one matching more than 10,000 products', async () => {
    const p = await ok('/api/products/block/preview', { filter: { q: 'Bread' }, reason: 'old' });
    expect(p).toMatchObject({ toBlock: 1, alreadyBlocked: 0, notFound: 0 });
    await h.fixture.prisma.product.createMany({
      data: Array.from({ length: 10_001 }, (_, i) => {
        const barcode = String(7_000_000_000_000 + i);
        return { tenantId: b.id, nameEn: `Item ${i}`, barcode, normalizedBarcode: barcode, erpPrice: 1, status: 'active' };
      }),
    });
    const r = await post('/api/products/block/preview', { filter: {}, reason: 'old' }, b.owner, b);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/10,001 products.*Narrow the filter/);
    expect(await h.fixture.prisma.product.count({ where: { tenantId: b.id, blockedAt: { not: null } } })).toBe(0);
  }, 60_000);
});

describe('POST /api/products/unblock', () => {
  it('restores the products exactly as they were (ended offers stay ended) and queues a recompute', async () => {
    const before = recon.calls.length;
    const d = await ok('/api/products/unblock', { productIds: [idC, idA, randomUUID()] });
    expect(d).toEqual({ unblocked: 1, notBlocked: 1, notFound: 1, offersRestored: 0, offersNote: expect.stringMatching(/not restored/) });
    await recon.drain();
    expect(reasonsSince(before)).toContain('product.unblocked');
    const c = await h.fixture.prisma.product.findUniqueOrThrow({ where: { id: idC } });
    expect([c.status, c.blockedAt, c.blockedReason, c.blockedBy, c.erpPrice.toNumber()]).toEqual(['active', null, null, null, 3]);
    const offer = await h.fixture.prisma.productOffer.findFirstOrThrow({ where: { productId: idC } });
    expect(offer.validUntil!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await reconBarcodes()).toEqual([A, B, C, D].sort());
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'product.unblocked', entityId: idC } })).toBe(1);
  });
  it('unblocks by filter over the blocked products only', async () => {
    const d = await ok('/api/products/unblock', { filter: { tab: 'new' } });
    expect(d).toMatchObject({ unblocked: 1, notBlocked: 0 });
    expect((await h.fixture.prisma.product.findUniqueOrThrow({ where: { id: idN } })).status).toBe('new');
    expect((await get('/api/products')).counts.blocked).toBe(0);
  });
  it('never touches another store', async () => {
    const d = await ok('/api/products/unblock', { productIds: [idB] }, b.owner, b);
    expect(d).toMatchObject({ unblocked: 0, notFound: 1 });
  });
});
