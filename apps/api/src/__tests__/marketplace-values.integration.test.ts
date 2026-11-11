// The Review screen and export values (migration 202611100001): GET /api/marketplace-values/review, single set and
// "use catalogue value", bulk preview/apply with a required token and an idempotency key, the summary counts, roles,
// tenant isolation, and the agreement of the SQL states (filters, counts, order) with core reviewRow.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';
import { acknowledgeExportValues } from '../../../worker/src/apply-upload.js';
import { EXPORT_STATES } from '../../../../packages/core/src/marketplace-values.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session, analyst: Session;
const ids: Record<string, string> = {};
type Item = Record<string, unknown> & { productId: string; exportState: string; version: { id: string; version: number } | null };

async function seed(store: Store) {
  const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id } });
  const upload = (source: string, key: string) => h.fixture.prisma.upload.create({ data: { tenantId: store.id, source, fileName: `${source}.xlsx`, size: 1,
    storageKey: key, uploadedById: user.id, status: 'applied', appliedAt: new Date(Date.now() - 3_600_000), createdAt: new Date(Date.now() - 3_700_000) } });
  const talabat = await upload('talabat', `mv-${store.id}-t`);
  const snoonu = await upload('snoonu', `mv-${store.id}-s`);
  const product = (name: string, barcode: string, extra: Record<string, unknown> = {}) => h.fixture.prisma.product.create({ data: {
    tenantId: store.id, barcode, normalizedBarcode: barcode, nameEn: name, erpPrice: 10, erpStock: 5, status: 'active', ...extra } });
  const p = {
    inSync: await product('In sync', '6281000000011'),
    price: await product('Wrong price', '6281000000028'),
    stock: await product('Sold out', '6281000000035', { erpStock: 0 }),
    unlisted: await product('Not listed', '6281000000042'),
    erpOff: await product('ERP inactive', '6281000000059', { erpActive: false }),
  };
  const listing = (productId: string, marketplaceId: string, uploadId: string, price: number, available: boolean) => h.fixture.prisma.listing.create({ data: {
    tenantId: store.id, productId, marketplaceId, marketplaceProductId: `${marketplaceId}-${productId}`, barcodes: [], price, available, uploadId } });
  await listing(p.inSync.id, 'talabat', talabat.id, 10, true);
  await listing(p.price.id, 'talabat', talabat.id, 12, true);
  await listing(p.stock.id, 'talabat', talabat.id, 10, true);
  await listing(p.erpOff.id, 'talabat', talabat.id, 10, false);
  await listing(p.inSync.id, 'snoonu', snoonu.id, 11, true);
  await recomputeRecon({ database: h.fixture.database }, { tenantId: store.id, reason: 'manual' });
  return { ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.id])), talabatUpload: talabat.id };
}

const review = async (query: string, who: Session = manager, store: Store = a) => {
  const r = await h.request('GET', `/api/marketplace-values/review?marketplaceId=talabat${query}`, store, who);
  expect(r.statusCode).toBe(200);
  return r.json().data as { counts: Record<string, number>; items: Item[]; nextCursor: string | null; marketplaceEnabled: boolean; latestFile: { uploadId: string } | null };
};
const item = async (productId: string) => (await h.request('GET', `/api/marketplace-values/talabat/products/${productId}`, a, manager)).json().data as Item;
const put = (productId: string, body: Record<string, unknown>, who: Session = manager, store: Store = a) =>
  h.request('PUT', `/api/marketplace-values/talabat/products/${productId}`, store, who, body);

beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('mv-a');
  b = await h.createOwner('mv-b');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
  Object.assign(ids, await seed(a));
  await seed(b);
});
afterAll(async () => { await h.close(); });

describe('the Review list', () => {
  it('by default shows the rows that need a change, with catalogue, marketplace and export values and the file they came from', async () => {
    const d = await review('');
    expect(d.marketplaceEnabled).toBe(true);
    expect(d.counts).toEqual({ toFix: 2, waitingForExport: 0, pinned: 0, blocked: 0 });
    expect(d.items.map(i => i.productId).sort()).toEqual([ids.price, ids.stock].sort());
    const price = d.items.find(i => i.productId === ids.price)!;
    expect(price).toMatchObject({
      nameEn: 'Wrong price', barcode: '6281000000028', exportState: 'to_fix', needsChange: true,
      marketplaceCurrent: { available: true, price: 12 }, catalogue: { available: true, price: 10 },
      export: { available: true, price: 10, availabilitySource: 'catalogue', priceSource: 'catalogue' },
      fields: { availability: { state: 'in_sync' }, price: { state: 'to_fix' } }, rulePrice: 10, differsFromRulePrice: false, version: null,
      values: { availability: null, price: null },
      marketplaceSource: { uploadId: ids.talabatUpload, fileName: 'talabat.xlsx', isLatestFile: true },
    });
    expect(d.items.find(i => i.productId === ids.stock)).toMatchObject({ fields: { availability: { state: 'to_fix' } }, export: { available: false } });
  });

  it('show=all lists every row, most urgent first; every state filter returns exactly the rows core puts in that state', async () => {
    const all = await review('&show=all&limit=2');
    const items = [...all.items];
    let cursor = all.nextCursor;
    while (cursor) { const next = await review(`&show=all&limit=2&cursor=${cursor}`); items.push(...next.items); cursor = next.nextCursor; }
    expect(items).toHaveLength(5);
    const ranks = items.map(i => EXPORT_STATES.indexOf(i.exportState as never));
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
    expect(items.find(i => i.productId === ids.unlisted)).toMatchObject({ exportState: 'not_exportable', notExportableReason: 'not_listed', marketplaceSource: null });
    for (const s of EXPORT_STATES) {
      const filtered = (await review(`&exportState=${s}`)).items.map(i => i.productId).sort();
      expect([s, filtered]).toEqual([s, items.filter(i => i.exportState === s).map(i => i.productId).sort()]);
    }
    expect((await review('&q=Wrong')).items.map(i => i.productId)).toEqual([ids.price]);
    expect((await review('&show=all&q=6281000000035')).items.map(i => i.productId)).toEqual([ids.stock]);
  });
});

describe('single set and use catalogue value', () => {
  it('sets a price for this marketplace only; it waits for export, differs from the rule price, and a repeat is no change', async () => {
    const r = await put(ids.price!, { values: { price: { value: 11 } }, reason: 'promo', expected: null });
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.changed).toBe(true);
    expect(d.item).toMatchObject({ exportState: 'waiting_for_export', exportStateLabel: 'Adjusted, waiting for export', differsFromRulePrice: true,
      export: { price: 11, priceSource: 'override' }, values: { price: { value: 11, persistent: false, state: 'pending', reason: 'promo', fieldState: 'waiting_for_export' } },
      version: { version: 1 } });
    expect((await put(ids.price!, { values: { price: { value: 11 } }, reason: 'promo', expected: d.item.version })).json().data.changed).toBe(false);
    expect((await put(ids.price!, { values: { price: { value: 12 } }, expected: null })).statusCode).toBe(409);
    // Snoonu is untouched
    const snoonu = (await h.request('GET', `/api/marketplace-values/snoonu/products/${ids.price}`, a, manager)).json().data;
    expect(snoonu === null || snoonu.values.price === null).toBe(true);
    const events = await h.fixture.prisma.auditEvent.findMany({ where: { tenantId: a.id, action: 'product.marketplace_values_set', entityId: ids.price } });
    expect(events).toHaveLength(1);
  });

  it('a pin the marketplace shows is pinned and leaves the default list; a "yes" on an ineligible product is refused', async () => {
    const r = await put(ids.inSync!, { values: { availability: { value: true, persistent: true } }, expected: null });
    expect(r.json().data.item).toMatchObject({ exportState: 'pinned', exportStateLabel: 'Pinned', needsChange: false });
    expect((await review('')).items.map(i => i.productId)).not.toContain(ids.inSync);
    const refused = await put(ids.erpOff!, { values: { availability: { value: true } }, expected: null });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.json())).toContain('Inactive in the ERP');
  });

  it('a pending value becomes blocked with a plain reason when the product leaves the ERP', async () => {
    await put(ids.stock!, { values: { availability: { value: true } }, expected: null });
    await h.fixture.prisma.product.update({ where: { id: ids.stock }, data: { erpActive: false } });
    expect(await item(ids.stock!)).toMatchObject({ exportState: 'blocked', blockedReason: 'erp_inactive', exportStateLabel: 'Adjusted, cannot be exported: Inactive in the ERP',
      export: { available: false, availabilitySource: 'catalogue' } });
    expect((await review('')).counts).toMatchObject({ blocked: 1, waitingForExport: 1, pinned: 1 });
    await h.fixture.prisma.product.update({ where: { id: ids.stock }, data: { erpActive: true } });
  });

  it('use catalogue value removes the export value; the file writes the catalogue value again', async () => {
    const before = await item(ids.price!);
    expect((await h.request('DELETE', `/api/marketplace-values/talabat/products/${ids.price}?fields=price`, a, manager)).statusCode).toBe(400);
    const stale = await h.request('DELETE', `/api/marketplace-values/talabat/products/${ids.price}?fields=price&expectedId=${before.version!.id}&expectedVersion=99`, a, manager);
    expect(stale.statusCode).toBe(409);
    const r = await h.request('DELETE', `/api/marketplace-values/talabat/products/${ids.price}?fields=price&expectedId=${before.version!.id}&expectedVersion=${before.version!.version}`, a, manager);
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ changed: true, item: { exportState: 'to_fix', export: { price: 10, priceSource: 'catalogue' }, values: { price: { state: 'cleared' } }, version: { version: 2 } } });
  });
});

describe('bulk', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    marketplaceId: 'talabat', selection: { filter: { show: 'all' } }, action: { type: 'use_catalogue', fields: ['availability', 'price'] }, ...extra,
  });
  it('"use catalogue values" for every row of the filter: preview token required, idempotent, one event', async () => {
    const preview = await h.request('POST', '/api/marketplace-values/bulk/preview', a, manager, body());
    expect(preview.statusCode).toBe(200);
    const p = preview.json().data;
    expect(p).toMatchObject({ selected: 5, willChange: 2, limit: 5000 });
    expect(p.previewToken).toMatch(/^[a-f0-9]{64}$/);
    expect((await h.request('POST', '/api/marketplace-values/bulk/apply', a, manager, { ...body(), idempotencyKey: 'mv-bulk-1' })).statusCode).toBe(400);
    expect((await h.request('POST', '/api/marketplace-values/bulk/apply', a, manager, { ...body(), idempotencyKey: 'mv-bulk-1', previewToken: 'f'.repeat(64) })).statusCode).toBe(409);
    const applied = await h.request('POST', '/api/marketplace-values/bulk/apply', a, manager, { ...body(), idempotencyKey: 'mv-bulk-1', previewToken: p.previewToken });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({ replayed: false, willChange: 2, clearedFields: 2 });
    const replay = await h.request('POST', '/api/marketplace-values/bulk/apply', a, manager, { ...body(), idempotencyKey: 'mv-bulk-1', previewToken: p.previewToken });
    expect(replay.json().data).toMatchObject({ replayed: true, operationId: applied.json().data.operationId });
    const other = await h.request('POST', '/api/marketplace-values/bulk/apply', a, manager, { ...body({ reason: 'other' }), idempotencyKey: 'mv-bulk-1', previewToken: p.previewToken });
    expect(other.statusCode).toBe(409);
    expect((await review('')).counts).toEqual({ toFix: 2, waitingForExport: 0, pinned: 0, blocked: 0 });
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'marketplace.values_bulk_applied' } })).toBe(1);
  });

  it('bulk set on the "to fix" rows blocks nothing eligible and counts ids of another store as not found', async () => {
    const otherStoreProduct = await h.fixture.prisma.product.findFirstOrThrow({ where: { tenantId: b.id } });
    const set = { marketplaceId: 'talabat', selection: { productIds: [ids.price, ids.erpOff, otherStoreProduct.id] }, action: { type: 'set', values: { price: { value: 9.5 } } } };
    const p = (await h.request('POST', '/api/marketplace-values/bulk/preview', a, manager, set)).json().data;
    expect(p).toMatchObject({ selected: 3, willChange: 1, blocked: 2 });
    expect(p.blockedByReason.map((x: { reason: string }) => x.reason).sort()).toEqual(['erp_inactive', 'not_found']);
  });
});

describe('roles, tenants and the dashboard summary', () => {
  it('the Analyst reads; only managers change; another store sees nothing of this one', async () => {
    expect((await h.request('GET', '/api/marketplace-values/review?marketplaceId=talabat', a, analyst)).statusCode).toBe(200);
    expect((await put(ids.price!, { values: { price: { value: 11 } }, expected: null }, analyst)).statusCode).toBe(403);
    expect((await h.request('POST', '/api/marketplace-values/bulk/preview', a, analyst, { marketplaceId: 'talabat', selection: { filter: {} }, action: { type: 'use_catalogue', fields: ['price'] } })).statusCode).toBe(403);
    expect((await put(ids.price!, { values: { price: { value: 11 } }, expected: null }, b.owner, b)).statusCode).toBe(404);
    const bReview = await review('&show=all', b.owner, b);
    expect(bReview.items.map(i => i.productId)).not.toContain(ids.price);
  });

  it('the dashboard summary carries the Review counts per marketplace', async () => {
    const r = await h.request('GET', '/api/recon/summary', a, manager);
    const byId = Object.fromEntries(r.json().data.marketplaces.map((m: { marketplaceId: string }) => [m.marketplaceId, m]));
    expect(byId.talabat.export).toEqual((await review('')).counts);
    expect(byId.snoonu.export).toEqual({ toFix: 1, waitingForExport: 0, pinned: 0, blocked: 0 });
  });
});

describe('Step 3: pins in the comparison, and acknowledgement by a later upload', () => {
  it('a pin queues a recompute, and after it the dashboard no longer counts the pinned price as a mismatch', async () => {
    const before = (await h.request('GET', '/api/recon/summary?reference=marketplace', a, manager)).json().data.marketplaces.find((m: { marketplaceId: string }) => m.marketplaceId === 'talabat');
    const current = await item(ids.price!);
    const r = await put(ids.price!, { values: { price: { value: 12, persistent: true } }, expected: current.version });
    expect(r.json().data.item).toMatchObject({ exportState: 'pinned' });
    expect(h.recon.calls.at(-1)).toEqual({ tenantId: a.id, reason: 'marketplace.values' });
    await recomputeRecon({ database: h.fixture.database }, { tenantId: a.id, reason: 'marketplace.values' });
    const after = (await h.request('GET', '/api/recon/summary?reference=marketplace', a, manager)).json().data.marketplaces.find((m: { marketplaceId: string }) => m.marketplaceId === 'talabat');
    expect(after.price).toBe(before.price - 1);
    expect(after.export).toMatchObject({ pinned: 1 });
  });

  it('a fix-once value clears when a later file of that marketplace shows it; an earlier file and a pin never clear', async () => {
    const current = await item(ids.stock!);
    const set = await put(ids.stock!, { values: { availability: { value: false } }, expected: current.version });
    expect(set.json().data.item).toMatchObject({ exportState: 'waiting_for_export' });
    const setAt = new Date(set.json().data.item.values.availability.setAt);
    await h.fixture.prisma.listing.updateMany({ where: { tenantId: a.id, productId: ids.stock, marketplaceId: 'talabat' }, data: { available: false } });
    const incoming = [{ marketplaceProductId: `talabat-${ids.stock}`, productId: ids.stock!, barcodes: [], name: null, price: 10, available: false }];
    // a file created before the value was set is no evidence
    expect(await h.fixture.database.run(a.id, d => acknowledgeExportValues(d, 'talabat', ids.talabatUpload!, new Date(setAt.getTime() - 1000), incoming, null))).toBe(0);
    expect(await h.fixture.database.run(a.id, d => acknowledgeExportValues(d, 'talabat', ids.talabatUpload!, new Date(setAt.getTime() + 1000), incoming, null))).toBe(1);
    expect((await item(ids.stock!))).toMatchObject({ values: { availability: { state: 'cleared' } } });
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'marketplace.values_upload_cleared' } })).toBe(1);
    // the pinned price of the other product matches its listing (12) but is never cleared by a file
    const pinnedListing = [{ marketplaceProductId: `talabat-${ids.price}`, productId: ids.price!, barcodes: [], name: null, price: 12, available: true }];
    expect(await h.fixture.database.run(a.id, d => acknowledgeExportValues(d, 'talabat', ids.talabatUpload!, new Date(Date.now() + 60_000), pinnedListing, null))).toBe(0);
    expect((await item(ids.price!))).toMatchObject({ values: { price: { state: 'pending', persistent: true } } });
  });
});
