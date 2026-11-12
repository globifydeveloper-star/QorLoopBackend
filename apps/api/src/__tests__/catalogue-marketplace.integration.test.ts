import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { Prisma } from '../../../../packages/db/src/generated/client.js';
import { marketplaceValuesSql } from '../../../../packages/db/src/products.js';

// GET /api/products?marketplaceId=...: each product's winning listing, its upload time and the stored recon row.
// Listings, uploads and recon rows are written straight into the database here (recon.integration.test.ts checks the
// same fields after the real upload and recompute pipeline).

let h: Harness;
let a: Store, b: Store;
let analyst: Session;
const ids: Record<string, string> = {};
const OLD_UPLOAD = new Date('2026-11-01T10:00:00.000Z');
const NEW_UPLOAD = new Date('2026-11-08T10:00:00.000Z');
const MARKETPLACE_KEYS = ['available', 'comparison', 'inFile', 'marketplaceId', 'price', 'priceIssue', 'reference', 'sourceUploadedAt', 'stockIssue'];

let serial = 0;
async function product(store: Store, key: string, nameEn: string, status = 'active') {
  const barcode = String(6_286_000_000_000 + ++serial);
  const p = await h.fixture.prisma.product.create({ data: { tenantId: store.id, nameEn, barcode, normalizedBarcode: barcode, erpPrice: 10, erpStock: 5, status } });
  ids[key] = p.id;
  return p.id;
}
async function upload(store: Store, source: string, createdAt: Date) {
  const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id } });
  const u = await h.fixture.prisma.upload.create({ data: {
    tenantId: store.id, source, fileName: `${source}.xlsx`, size: 1, storageKey: `t/${source}/${createdAt.getTime()}`, uploadedById: owner.id,
    status: 'applied', appliedAt: createdAt, createdAt,
  } });
  return u.id;
}
async function listing(store: Store, key: string, o: { id?: string; price: number; available: boolean; uploadId: string | null; updatedAt?: Date; marketplaceId?: string }) {
  const marketplaceId = o.marketplaceId ?? 'talabat';
  const l = await h.fixture.prisma.listing.create({ data: {
    tenantId: store.id, marketplaceId, marketplaceProductId: o.id ?? `${marketplaceId}-${key}`, productId: ids[key]!, barcodes: [], price: o.price, available: o.available, uploadId: o.uploadId,
  } });
  if (o.updatedAt) await h.fixture.prisma.$executeRaw`UPDATE listings SET updated_at = ${o.updatedAt} WHERE id = ${l.id}::uuid`;
}
type Recon = Partial<Prisma.ReconRowUncheckedCreateInput>;
const recon = (store: Store, key: string, o: Recon) => h.fixture.prisma.reconRow.create({ data: {
  tenantId: store.id, productId: ids[key]!, marketplaceId: 'talabat', status: 'in_sync', statusVsErp: o.status ?? 'in_sync',
  stockIssueVsErp: o.stockIssue ?? null, actualPrice: 10, actualAvailable: true, marketplacePrice: 10, erpPrice: 10, ...o,
} });

const list = (query: string, store = a, who: Session = store.owner) => h.request('GET', '/api/products' + query, store, who);
async function ok(query: string, store = a, who: Session = store.owner) {
  const r = await list(query, store, who);
  expect([r.statusCode, r.statusCode === 200 ? null : r.body]).toEqual([200, null]);
  return r.json().data as { items: { id: string; nameEn: string; marketplace?: Record<string, unknown> }[]; nextCursor: string | null; counts: Record<string, number> };
}
const byKey = (items: { id: string }[]) => Object.fromEntries(items.map(i => [Object.keys(ids).find(k => ids[k] === i.id)!, i])) as Record<string, { marketplace: Record<string, unknown> }>;
const keysOf = (items: { id: string }[]) => items.map(i => Object.keys(ids).find(k => ids[k] === i.id)!);

beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('mkcola');
  b = await h.createOwner('mkcolb');
  analyst = await h.member(a, 'analyst');

  // Talabat: two applied uploads (no switch row: enabled by its uploads). Snoonu: switched on, no upload.
  // Rafeeq: an applied upload but switched off. Keeta: neither.
  const oldUpload = await upload(a, 'talabat', OLD_UPLOAD);
  const newUpload = await upload(a, 'talabat', NEW_UPLOAD);
  await upload(a, 'rafeeq', NEW_UPLOAD);
  await h.fixture.prisma.tenantMarketplace.createMany({ data: [
    { tenantId: a.id, marketplaceId: 'snoonu', enabled: true }, { tenantId: a.id, marketplaceId: 'rafeeq', enabled: false },
  ] });

  await product(a, 'sync', 'A1 In Sync');
  await listing(a, 'sync', { price: 10, available: true, uploadId: oldUpload });
  await recon(a, 'sync', {});

  await product(a, 'stock', 'A2 Stock Mismatch');
  await listing(a, 'stock', { price: 10, available: false, uploadId: newUpload });
  await recon(a, 'stock', { status: 'mismatch', stockIssue: 'unavailable_but_in_stock', actualAvailable: false });

  // Marketplace reference: 12.5 against the Marketplace price 11. ERP reference: 12.5 = ERP price, in sync.
  await product(a, 'price', 'A3 Price Higher');
  await listing(a, 'price', { price: 12.5, available: true, uploadId: newUpload });
  await recon(a, 'price', { status: 'mismatch', priceMismatchVsMarketplace: true, actualPrice: 12.5, marketplacePrice: 11, erpPrice: 12.5, statusVsErp: 'in_sync' });

  await product(a, 'gone', 'A4 Missing From ERP');
  await listing(a, 'gone', { price: 10, available: true, uploadId: newUpload });
  await recon(a, 'gone', { status: 'missing_from_erp', stockIssue: 'available_but_out_of_stock' });

  await product(a, 'absent', 'A5 Not In File');
  await recon(a, 'absent', { status: 'not_listed', actualPrice: null, actualAvailable: null });

  await product(a, 'legacy', 'A6 Legacy Listing');
  await listing(a, 'legacy', { price: 7.25, available: true, uploadId: null });
  await recon(a, 'legacy', { actualPrice: 7.25, marketplacePrice: 7.25 });

  // Two marketplace ids for one product: the one written last wins, as in recon.
  await product(a, 'dup', 'A7 Duplicate Listing');
  await listing(a, 'dup', { id: 'T7-old', price: 5, available: false, uploadId: oldUpload, updatedAt: OLD_UPLOAD });
  await listing(a, 'dup', { id: 'T7-new', price: 6, available: true, uploadId: newUpload, updatedAt: NEW_UPLOAD });
  await recon(a, 'dup', { actualPrice: 6, marketplacePrice: 6 });

  await product(a, 'new', 'A8 New Product', 'new');
  await listing(a, 'new', { price: 10, available: true, uploadId: newUpload });
  await recon(a, 'new', { status: 'new', stockIssue: 'available_but_out_of_stock' });

  // Listed after the last recompute: no recon row yet.
  await product(a, 'pending', 'A9 Not Recomputed');
  await listing(a, 'pending', { price: 3, available: true, uploadId: newUpload });

  // Store B: its own Talabat data, a mismatch at 99.
  const bUpload = await upload(b, 'talabat', NEW_UPLOAD);
  await product(b, 'b1', 'B1 Other Store');
  await listing(b, 'b1', { price: 99, available: true, uploadId: bUpload });
  await recon(b, 'b1', { status: 'mismatch', priceMismatchVsMarketplace: true, actualPrice: 99, marketplacePrice: 10 });
}, 120_000);
afterAll(async () => { await h.close(); });

describe('GET /api/products with marketplaceId', () => {
  it('without marketplaceId nothing changes: no marketplace object', async () => {
    const d = await ok('');
    expect(d.items).toHaveLength(9);
    expect(d.items.some(i => 'marketplace' in i)).toBe(false);
    expect(d.counts).toEqual({ all: 9, active: 8, inactive: 0, new: 1, missing: 0 });
  });

  it('adds the exact marketplace shape to every item', async () => {
    const d = await ok('?marketplaceId=talabat');
    expect(d.items).toHaveLength(9);
    expect(d.counts.all).toBe(9);
    for (const i of d.items) expect(Object.keys(i.marketplace!).sort()).toEqual(MARKETPLACE_KEYS);
    const m = byKey(d.items);
    expect(m.sync!.marketplace).toEqual({
      marketplaceId: 'talabat', reference: 'marketplace', available: true, price: '10.000', inFile: true, comparison: 'in_sync',
      stockIssue: null, priceIssue: null, sourceUploadedAt: OLD_UPLOAD.toISOString(),
    });
    expect(m.stock!.marketplace).toMatchObject({ available: false, comparison: 'mismatch', stockIssue: 'unavailable_but_in_stock', priceIssue: null, sourceUploadedAt: NEW_UPLOAD.toISOString() });
    expect(m.price!.marketplace).toMatchObject({ price: '12.500', comparison: 'mismatch', stockIssue: null, priceIssue: 'marketplace_price_higher' });
    expect(m.gone!.marketplace).toMatchObject({ comparison: 'mismatch', stockIssue: 'available_but_out_of_stock' });
    expect(m.legacy!.marketplace).toMatchObject({ price: '7.250', inFile: true, comparison: 'in_sync', sourceUploadedAt: null });
    expect(m.dup!.marketplace).toMatchObject({ price: '6.000', available: true, sourceUploadedAt: NEW_UPLOAD.toISOString() });
    expect(m.new!.marketplace).toMatchObject({ inFile: true, comparison: 'not_applicable', stockIssue: null });
    expect(m.pending!.marketplace).toMatchObject({ inFile: true, price: '3.000', comparison: 'not_applicable', stockIssue: null, priceIssue: null });
  });

  it('a product not in the file has null file values', async () => {
    const m = byKey((await ok('?marketplaceId=talabat')).items);
    expect(m.absent!.marketplace).toEqual({
      marketplaceId: 'talabat', reference: 'marketplace', available: null, price: null, inFile: false, comparison: 'not_in_file',
      stockIssue: null, priceIssue: null, sourceUploadedAt: null,
    });
  });

  it('filters by marketplaceStatus; the tab counts follow the filter', async () => {
    const sync = await ok('?marketplaceId=talabat&marketplaceStatus=in_sync');
    expect(keysOf(sync.items)).toEqual(['sync', 'legacy', 'dup']);
    expect(sync.items.every(i => i.marketplace!.comparison === 'in_sync')).toBe(true);
    expect(sync.counts).toEqual({ all: 3, active: 3, inactive: 0, new: 0, missing: 0 });

    const mismatch = await ok('?marketplaceId=talabat&marketplaceStatus=mismatch');
    expect(keysOf(mismatch.items)).toEqual(['stock', 'price', 'gone']);
    expect(mismatch.items.every(i => i.marketplace!.comparison === 'mismatch')).toBe(true);
    expect(mismatch.counts.all).toBe(3);

    const absent = await ok('?marketplaceId=talabat&marketplaceStatus=not_in_file');
    expect(keysOf(absent.items)).toEqual(['absent']);
    expect(absent.counts.all).toBe(1);
  });

  it('the filter combines with the tab and the search', async () => {
    expect(keysOf((await ok('?marketplaceId=talabat&marketplaceStatus=mismatch&q=price')).items)).toEqual(['price']);
    expect((await ok('?marketplaceId=talabat&marketplaceStatus=mismatch&tab=new')).items).toHaveLength(0);
  });

  it('keyset pages through a filtered list without gaps or repeats', async () => {
    const first = await ok('?marketplaceId=talabat&marketplaceStatus=in_sync&limit=2');
    expect(keysOf(first.items)).toEqual(['sync', 'legacy']);
    expect(first.nextCursor).toBeTruthy();
    const second = await ok(`?marketplaceId=talabat&marketplaceStatus=in_sync&limit=2&cursor=${first.nextCursor}`);
    expect(keysOf(second.items)).toEqual(['dup']);
    expect(second.nextCursor).toBeNull();
    expect(second.items[0]!.marketplace).toMatchObject({ comparison: 'in_sync' });
  });

  it('rejects a filter without marketplaceId, an unknown and a disabled marketplace', async () => {
    const noMarketplace = await list('?marketplaceStatus=mismatch');
    expect(noMarketplace.statusCode).toBe(400);
    expect(noMarketplace.body).toMatch(/marketplaceStatus/);
    expect((await list('?marketplaceId=amazon')).statusCode).toBe(400);
    expect((await list('?marketplaceId=talabat&marketplaceStatus=bogus')).statusCode).toBe(400);
    for (const disabled of ['rafeeq', 'keeta']) {
      const r = await list(`?marketplaceId=${disabled}`);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.details).toEqual([{ path: 'marketplaceId', message: expect.stringMatching(/is not enabled for this store/) }]);
    }
  });

  it('an enabled marketplace without an upload: nothing in the file, nothing compared, filters match nothing', async () => {
    const d = await ok('?marketplaceId=snoonu');
    expect(d.items).toHaveLength(9);
    expect(d.items.every(i => i.marketplace!.inFile === false && i.marketplace!.comparison === 'not_applicable' && i.marketplace!.price === null)).toBe(true);
    for (const status of ['in_sync', 'mismatch', 'not_in_file']) {
      const f = await ok(`?marketplaceId=snoonu&marketplaceStatus=${status}`);
      expect([status, f.items.length, f.counts.all]).toEqual([status, 0, 0]);
    }
  });

  it('every store sees only its own listings and recon rows', async () => {
    const own = await ok('?marketplaceId=talabat', b);
    expect(own.items.map(i => i.nameEn)).toEqual(['B1 Other Store']);
    expect(own.items[0]!.marketplace).toMatchObject({ price: '99.000', comparison: 'mismatch', priceIssue: 'marketplace_price_higher' });
    expect((await ok('?marketplaceId=talabat&marketplaceStatus=mismatch', b)).items).toHaveLength(1);
    const mine = await ok('?marketplaceId=talabat');
    expect(mine.items.map(i => i.nameEn)).not.toContain('B1 Other Store');
    expect(JSON.stringify(mine)).not.toMatch(/99\.000/);
    // Store B has no Snoonu switch or upload: not enabled there.
    expect((await list('?marketplaceId=snoonu', b)).statusCode).toBe(400);
  });

  it('is readable with products.view only (analyst)', async () => {
    const d = await ok('?marketplaceId=talabat&marketplaceStatus=mismatch', a, analyst);
    expect(keysOf(d.items)).toEqual(['stock', 'price', 'gone']);
    expect(d.items.some(i => 'costPrice' in i)).toBe(false);
  });

  it('follows the tenant default ERP reference', async () => {
    await h.fixture.prisma.pricingSettings.upsert({
      where: { tenantId: a.id }, create: { tenantId: a.id, compareReferenceDefault: 'erp' }, update: { compareReferenceDefault: 'erp' },
    });
    try {
      const m = byKey((await ok('?marketplaceId=talabat')).items);
      expect(m.price!.marketplace).toMatchObject({ reference: 'erp', comparison: 'in_sync', priceIssue: null });
      expect(m.stock!.marketplace).toMatchObject({ reference: 'erp', comparison: 'mismatch', stockIssue: 'unavailable_but_in_stock' });
      expect(keysOf((await ok('?marketplaceId=talabat&marketplaceStatus=mismatch')).items)).toEqual(['stock', 'gone']);
      expect(keysOf((await ok('?marketplaceId=talabat&marketplaceStatus=in_sync')).items)).toEqual(['sync', 'price', 'legacy', 'dup']);
    } finally {
      await h.fixture.prisma.pricingSettings.update({ where: { tenantId: a.id }, data: { compareReferenceDefault: 'marketplace' } });
    }
  });

  it('the page statement can be served by the listing, upload and recon indexes', async () => {
    const plan = await h.fixture.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`EXPLAIN ${marketplaceValuesSql(a.id, 'talabat', Object.values(ids).slice(0, 9))}`);
      return rows.map(r => r['QUERY PLAN']).join('\n');
    });
    // on the tiny CI data the planner may pick either listings index; any index (never a scan of the table) is fine
    expect(plan).toMatch(/(using|on) listings_\w+_(key|idx)/);
    // on a few rows the planner may pick either recon_rows index; any index (never a scan of the table) is fine
    expect(plan).toMatch(/(using|on) recon_rows_\w+_(key|idx)/);
    expect(plan).not.toMatch(/Seq Scan on (listings|recon_rows|uploads)/);
  });
});
