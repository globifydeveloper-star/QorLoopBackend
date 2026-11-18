// "Copy from marketplace" (owner decisions of 12 November 2026): bulk preview/apply with
// { type: 'copy_from_marketplace', sourceMarketplaceId, fields } fills Talabat's export values from Snoonu's current
// listings. Price only, availability only, both; not on the source; blocked on the target; pins kept or replaced;
// values from an older source file; the source refused when it is the target, switched off or has no file; tenants.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session;
const ids: Record<string, string> = {};
let latestSnoonu = '';

async function seed(store: Store) {
  const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id } });
  const upload = (source: string, name: string, hoursAgo: number) => h.fixture.prisma.upload.create({ data: {
    tenantId: store.id, source, fileName: name, size: 1, storageKey: `cfm-${store.id}-${name}`, uploadedById: user.id, status: 'applied',
    appliedAt: new Date(Date.now() - hoursAgo * 3_600_000), createdAt: new Date(Date.now() - hoursAgo * 3_600_000 - 60_000) } });
  const talabat = await upload('talabat', 'talabat.xlsx', 1);
  const older = await upload('snoonu', 'snoonu-old.xlsx', 3);
  const snoonu = await upload('snoonu', 'snoonu.xlsx', 1);
  // catalogue: available (stock 5), 10 QAR (rule "same" on the ERP price)
  const product = (name: string, barcode: string, extra: Record<string, unknown> = {}) => h.fixture.prisma.product.create({ data: {
    tenantId: store.id, barcode, normalizedBarcode: barcode, nameEn: name, erpPrice: 10, erpStock: 5, status: 'active', ...extra } });
  const p = {
    both: await product('Copy both', '6282000000011'),
    same: await product('Same on both', '6282000000028'),
    notOnSource: await product('Talabat only', '6282000000035'),
    erpOff: await product('ERP inactive', '6282000000042', { erpActive: false }),
    inactive: await product('Inactive', '6282000000059', { status: 'inactive' }),
    missing: await product('Missing from ERP', '6282000000066', { inLatestErpFile: false }),
    pinned: await product('Pinned on Talabat', '6282000000073'),
    older: await product('From an older Snoonu file', '6282000000080'),
    badPrice: await product('Snoonu price zero', '6282000000097'),
    availOnly: await product('Availability differs', '6282000000103'),
  };
  const listing = (productId: string, marketplaceId: string, uploadId: string, price: number, available: boolean) => h.fixture.prisma.listing.create({ data: {
    tenantId: store.id, productId, marketplaceId, marketplaceProductId: `${marketplaceId}-${productId}`, barcodes: [], price, available, uploadId } });
  for (const id of Object.values(p).map(x => x.id)) await listing(id, 'talabat', talabat.id, 10, true);
  await listing(p.both.id, 'snoonu', snoonu.id, 12.5, false);
  await listing(p.same.id, 'snoonu', snoonu.id, 10, true);
  for (const x of [p.erpOff, p.inactive, p.missing]) await listing(x.id, 'snoonu', snoonu.id, 8, false);
  await listing(p.pinned.id, 'snoonu', snoonu.id, 14, true);
  await listing(p.older.id, 'snoonu', older.id, 9, true);
  await listing(p.badPrice.id, 'snoonu', snoonu.id, 0, true);
  await listing(p.availOnly.id, 'snoonu', snoonu.id, 10, false);
  await recomputeRecon({ database: h.fixture.database }, { tenantId: store.id, reason: 'manual' });
  return { ids: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.id])), latestSnoonu: snoonu.id };
}

const body = (fields: string[], productIds: string[], extra: Record<string, unknown> = {}, action: Record<string, unknown> = {}) => ({
  marketplaceId: 'talabat', selection: { productIds }, action: { type: 'copy_from_marketplace', sourceMarketplaceId: 'snoonu', fields, ...action }, ...extra,
});
const preview = (b: Record<string, unknown>, who: Session = manager, store: Store = a) => h.request('POST', '/api/marketplace-values/bulk/preview', store, who, b);
const apply = async (b: Record<string, unknown>, key: string) => {
  const p = await preview(b);
  expect(p.statusCode).toBe(200);
  const r = await h.request('POST', '/api/marketplace-values/bulk/apply', a, manager, { ...b, idempotencyKey: key, previewToken: p.json().data.previewToken });
  expect(r.statusCode).toBe(200);
  return r.json().data;
};
const stored = (productId: string) => h.fixture.prisma.marketplaceValueOverride.findFirst({ where: { tenantId: a.id, productId, marketplaceId: 'talabat' } });
const all = () => Object.values(ids);

beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('cfm-a');
  b = await h.createOwner('cfm-b');
  manager = await h.member(a, 'catalogue_manager');
  const s = await seed(a);
  Object.assign(ids, s.ids);
  latestSnoonu = s.latestSnoonu;
  await seed(b);
});
// the harness drains queued recomputes before closing the database
afterAll(async () => { await h.close(); });

describe('copy from marketplace', () => {
  it('both fields: Snoonu\'s listing values become fix-once Talabat export values; the catalogue is unchanged; the event names the source', async () => {
    const p = (await preview(body(['availability', 'price'], [ids.both!]))).json().data;
    expect(p).toMatchObject({
      selected: 1, willChange: 1, unchanged: 0, blocked: 0, notOnSource: 0, pinnedKept: 0, fromOlderFile: 0, reason: 'Copied from Snoonu',
      source: { marketplaceId: 'snoonu', latestFile: { uploadId: latestSnoonu, fileName: 'snoonu.xlsx' } },
      rows: [{ productId: ids.both, source: { available: false, price: 12.5, uploadId: latestSnoonu, fileName: 'snoonu.xlsx', isLatestFile: true }, changes: [
        { field: 'availability', op: 'set', before: null, after: { value: false, state: 'pending', persistent: false, reason: 'Copied from Snoonu' } },
        { field: 'price', op: 'set', before: null, after: { value: 12.5, state: 'pending', persistent: false, reason: 'Copied from Snoonu' } },
      ] }],
    });
    const r = await apply(body(['availability', 'price'], [ids.both!]), 'cfm-both-1');
    expect(r).toMatchObject({ replayed: false, sourceMarketplaceId: 'snoonu', willChange: 1, created: 1 });
    expect(await stored(ids.both!)).toMatchObject({ availabilityValue: false, availabilityState: 'pending', availabilityPersistent: false, priceState: 'pending', priceReason: 'Copied from Snoonu' });
    expect(Number((await stored(ids.both!))!.priceValue)).toBe(12.5);
    expect(Number((await h.fixture.prisma.product.findUniqueOrThrow({ where: { id: ids.both } })).erpPrice)).toBe(10);
    const event = await h.fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.id, action: 'marketplace.values_bulk_applied' } });
    expect(event.details).toMatchObject({ sourceMarketplaceId: 'snoonu', sourceUploadId: latestSnoonu, action: { type: 'copy_from_marketplace', sourceMarketplaceId: 'snoonu' } });
    // Snoonu has no export value of its own
    expect(await h.fixture.prisma.marketplaceValueOverride.count({ where: { tenantId: a.id, marketplaceId: 'snoonu' } })).toBe(0);
  });

  it('price only over every case: unchanged, not on source, invalid source price, blocked, pinned kept, older file', async () => {
    const pin = await h.request('PUT', `/api/marketplace-values/talabat/products/${ids.pinned}`, a, manager, { values: { price: { value: 11, persistent: true } }, expected: null });
    expect(pin.statusCode).toBe(200);
    const p = (await preview(body(['price'], all()))).json().data;
    // both (already 12.5), same (10 = catalogue), availOnly (10 = catalogue): unchanged
    expect(p).toMatchObject({ selected: 10, willChange: 1, unchanged: 3, blocked: 3, notOnSource: 2, pinnedKept: 1, fromOlderFile: 1 });
    expect(p.blockedByReason.map((x: { reason: string }) => x.reason).sort()).toEqual(['erp_inactive', 'inactive', 'missing_from_erp']);
    expect(p.notOnSourceByReason).toEqual([
      { reason: 'not_on_source', label: 'Not listed on the marketplace copied from', count: 1 },
      { reason: 'source_price_invalid', label: expect.any(String), count: 1 },
    ]);
    expect(p.rows).toEqual([expect.objectContaining({ productId: ids.older, source: expect.objectContaining({ price: 9, fileName: 'snoonu-old.xlsx', isLatestFile: false }) })]);
  });

  it('availability only sets only availability; "No" on an ERP-inactive, inactive or missing product is blocked', async () => {
    const p = (await preview(body(['availability'], [ids.availOnly!, ids.same!, ids.erpOff!, ids.inactive!, ids.missing!]))).json().data;
    expect(p).toMatchObject({ selected: 5, willChange: 1, unchanged: 1, blocked: 3 });
    await apply(body(['availability'], [ids.availOnly!]), 'cfm-avail-1');
    expect(await stored(ids.availOnly!)).toMatchObject({ availabilityValue: false, availabilityState: 'pending', priceState: null });
  });

  it('a pin on Talabat is kept by default; replacePins overwrites it and it stays pinned (a recompute is queued)', async () => {
    expect((await preview(body(['price'], [ids.pinned!]))).json().data).toMatchObject({ willChange: 0, pinnedKept: 1 });
    const r = await apply(body(['price'], [ids.pinned!], {}, { replacePins: true }), 'cfm-pin-1');
    expect(r).toMatchObject({ willChange: 1, updated: 1 });
    const o = await stored(ids.pinned!);
    expect(o).toMatchObject({ pricePersistent: true, priceState: 'pending', version: 2 });
    expect(Number(o!.priceValue)).toBe(14);
    expect(h.recon.calls.at(-1)).toEqual({ tenantId: a.id, reason: 'marketplace.values' });
  });

  it('refuses the target as its own source, a switched-off source and a source without a file', async () => {
    const self = await preview(body(['price'], [ids.both!], {}, { sourceMarketplaceId: 'talabat' }));
    expect(self.statusCode).toBe(400);
    expect(JSON.stringify(self.json())).toContain('another marketplace');
    await h.fixture.prisma.tenantMarketplace.upsert({ where: { tenantId_marketplaceId: { tenantId: a.id, marketplaceId: 'keeta' } }, create: { tenantId: a.id, marketplaceId: 'keeta', enabled: true }, update: { enabled: true } });
    const noFile = await preview(body(['price'], [ids.both!], {}, { sourceMarketplaceId: 'keeta' }));
    expect(noFile.statusCode).toBe(400);
    expect(JSON.stringify(noFile.json())).toContain('no applied file');
    await h.fixture.prisma.tenantMarketplace.upsert({ where: { tenantId_marketplaceId: { tenantId: a.id, marketplaceId: 'snoonu' } }, create: { tenantId: a.id, marketplaceId: 'snoonu', enabled: false }, update: { enabled: false } });
    const off = await preview(body(['price'], [ids.both!]));
    expect(off.statusCode).toBe(400);
    expect(JSON.stringify(off.json())).toContain('not enabled');
    await h.fixture.prisma.tenantMarketplace.update({ where: { tenantId_marketplaceId: { tenantId: a.id, marketplaceId: 'snoonu' } }, data: { enabled: true } });
    expect((await preview(body(['price', 'price'], [ids.both!]))).statusCode).toBe(400);
  });

  it('tenants: another store\'s products are not found, and its Snoonu listings are never read', async () => {
    const other = await h.fixture.prisma.product.findMany({ where: { tenantId: b.id }, select: { id: true } });
    const p = (await preview(body(['price'], other.map(x => x.id)))).json().data;
    expect(p).toMatchObject({ selected: other.length, willChange: 0, blocked: other.length, blockedByReason: [{ reason: 'not_found', count: other.length }] });
    const fromB = (await preview(body(['price'], [ids.older!]), b.owner, b)).json().data;
    expect(fromB).toMatchObject({ willChange: 0, blocked: 1 });
    expect(fromB.source.latestFile.uploadId).not.toBe(latestSnoonu);
  });

  it('a new Snoonu file between preview and apply is a 409 with no writes', async () => {
    const req = body(['price'], [ids.older!]);
    const p = (await preview(req)).json().data;
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: a.id, source: 'snoonu', fileName: 'snoonu-new.xlsx', size: 1, storageKey: `cfm-${a.id}-new`,
      uploadedById: user.id, status: 'applied', appliedAt: new Date(), createdAt: new Date() } });
    const r = await h.request('POST', '/api/marketplace-values/bulk/apply', a, manager, { ...req, idempotencyKey: 'cfm-stale-1', previewToken: p.previewToken });
    expect(r.statusCode).toBe(409);
    expect(await stored(ids.older!)).toBeNull();
  });
});
