import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';

// GET /api/products?marketplaceId=A&compareMarketplaceId=B[&marketplacesDiffer=any|price|availability]: two
// marketplaces side by side in the catalogue, and the products where they differ (or that are on only one).
// Listings and uploads are written straight into the database, as in catalogue-marketplace.integration.test.ts.

let h: Harness;
let a: Store, b: Store, c: Store;
let analyst: Session;
const ids: Record<string, string> = {};
const OLD = new Date('2026-11-01T10:00:00.000Z');
const NEW = new Date('2026-11-08T10:00:00.000Z');

let serial = 0;
async function product(store: Store, key: string, nameEn: string) {
  const barcode = String(6_287_000_000_000 + ++serial);
  const p = await h.fixture.prisma.product.create({ data: { tenantId: store.id, nameEn, barcode, normalizedBarcode: barcode, erpPrice: 10, erpStock: 5, status: 'active' } });
  ids[key] = p.id;
}
async function upload(store: Store, source: string) {
  const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id } });
  const u = await h.fixture.prisma.upload.create({ data: {
    tenantId: store.id, source, fileName: `${source}.xlsx`, size: 1, storageKey: `t/${source}/${store.id}`, uploadedById: owner.id,
    status: 'applied', appliedAt: NEW, createdAt: NEW,
  } });
  return u.id;
}
async function listing(store: Store, key: string, marketplaceId: string, price: number, available: boolean, uploadId: string, o: { id?: string; updatedAt?: Date } = {}) {
  const l = await h.fixture.prisma.listing.create({ data: {
    tenantId: store.id, marketplaceId, marketplaceProductId: o.id ?? `${marketplaceId}-${key}`, productId: ids[key]!, barcodes: [], price, available, uploadId,
  } });
  if (o.updatedAt) await h.fixture.prisma.$executeRaw`UPDATE listings SET updated_at = ${o.updatedAt} WHERE id = ${l.id}::uuid`;
}

type Page = { items: { id: string; marketplace?: Record<string, unknown>; compareMarketplace?: Record<string, unknown> }[]; nextCursor: string | null; counts: Record<string, number> };
const list = (query: string, store = a, who: Session = store.owner) => h.request('GET', '/api/products' + query, store, who);
async function ok(query: string, store = a, who: Session = store.owner) {
  const r = await list(query, store, who);
  expect([r.statusCode, r.statusCode === 200 ? null : r.body]).toEqual([200, null]);
  return r.json().data as Page;
}
const keysOf = (items: { id: string }[]) => items.map(i => Object.keys(ids).find(k => ids[k] === i.id)!);
const BOTH = '?marketplaceId=talabat&compareMarketplaceId=snoonu';

beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('cmpmka');
  b = await h.createOwner('cmpmkb');
  c = await h.createOwner('cmpmkc');
  analyst = await h.member(a, 'analyst');

  const t = await upload(a, 'talabat');
  const s = await upload(a, 'snoonu');
  // Names give the list order (by English name).
  await product(a, 'same', 'C1 Same On Both');
  await listing(a, 'same', 'talabat', 10, true, t); await listing(a, 'same', 'snoonu', 10, true, s);
  await product(a, 'price', 'C2 Price Differs');
  await listing(a, 'price', 'talabat', 10, true, t); await listing(a, 'price', 'snoonu', 9.5, true, s);
  await product(a, 'avail', 'C3 Availability Differs');
  await listing(a, 'avail', 'talabat', 10, true, t); await listing(a, 'avail', 'snoonu', 10, false, s);
  await product(a, 'onlyT', 'C4 Only On Talabat');
  await listing(a, 'onlyT', 'talabat', 10, true, t);
  await product(a, 'onlyS', 'C5 Only On Snoonu');
  await listing(a, 'onlyS', 'snoonu', 10, true, s);
  await product(a, 'neither', 'C6 On Neither');
  // Two Snoonu listings: the newest one (10, available) is the one compared, as in the comparison.
  await product(a, 'dup', 'C7 Duplicate On Snoonu');
  await listing(a, 'dup', 'talabat', 10, true, t);
  await listing(a, 'dup', 'snoonu', 7, false, s, { id: 'S7-old', updatedAt: OLD });
  await listing(a, 'dup', 'snoonu', 10, true, s, { id: 'S7-new', updatedAt: NEW });
  await product(a, 'both', 'C8 Price And Availability Differ');
  await listing(a, 'both', 'talabat', 10, true, t); await listing(a, 'both', 'snoonu', 11, false, s);

  // Store B: its own differences, never seen from store A.
  const bt = await upload(b, 'talabat'); const bs = await upload(b, 'snoonu');
  await product(b, 'b1', 'C1 Other Store');
  await listing(b, 'b1', 'talabat', 10, true, bt); await listing(b, 'b1', 'snoonu', 1, false, bs);

  // Store C: Talabat has a file, Snoonu is switched on without one.
  const ct = await upload(c, 'talabat');
  await h.fixture.prisma.tenantMarketplace.create({ data: { tenantId: c.id, marketplaceId: 'snoonu', enabled: true } });
  await product(c, 'c1', 'C1 Only Talabat File');
  await listing(c, 'c1', 'talabat', 10, true, ct);
});
afterAll(async () => { await h.close(); });

describe('two marketplaces side by side', () => {
  it('adds compareMarketplace, with the same shape as marketplace, for every product', async () => {
    const page = await ok(BOTH);
    expect(keysOf(page.items)).toEqual(['same', 'price', 'avail', 'onlyT', 'onlyS', 'neither', 'dup', 'both']);
    for (const i of page.items) {
      expect(Object.keys(i.compareMarketplace!).sort()).toEqual(Object.keys(i.marketplace!).sort());
      expect(i.compareMarketplace!.marketplaceId).toBe('snoonu');
      expect(i.marketplace!.marketplaceId).toBe('talabat');
    }
    const by = Object.fromEntries(page.items.map(i => [keysOf([i])[0], i]));
    expect(by.price!.compareMarketplace).toMatchObject({ price: '9.500', available: true, inFile: true });
    expect(by.onlyT!.compareMarketplace).toMatchObject({ inFile: false, price: null, available: null });
    expect(by.dup!.compareMarketplace).toMatchObject({ price: '10.000', available: true });
    // Without compareMarketplaceId nothing changes.
    expect((await ok('?marketplaceId=talabat')).items.every(i => i.compareMarketplace === undefined)).toBe(true);
  });

  it('marketplacesDiffer keeps products whose listings differ, or that are on only one; counts follow', async () => {
    const any = await ok(`${BOTH}&marketplacesDiffer=any`);
    expect(keysOf(any.items)).toEqual(['price', 'avail', 'onlyT', 'onlyS', 'both']);
    expect(any.counts.all).toBe(5);
    expect(keysOf((await ok(`${BOTH}&marketplacesDiffer=price`)).items)).toEqual(['price', 'onlyT', 'onlyS', 'both']);
    expect(keysOf((await ok(`${BOTH}&marketplacesDiffer=availability`)).items)).toEqual(['avail', 'onlyT', 'onlyS', 'both']);
    // The order of the two marketplaces does not change which products differ.
    expect(keysOf((await ok('?marketplaceId=snoonu&compareMarketplaceId=talabat&marketplacesDiffer=any')).items)).toEqual(keysOf(any.items));
  });

  it('pages through the filtered list without gaps, and combines with search and the status filter', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await ok(`${BOTH}&marketplacesDiffer=any&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...keysOf(page.items));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['price', 'avail', 'onlyT', 'onlyS', 'both']);
    expect(keysOf((await ok(`${BOTH}&marketplacesDiffer=any&q=Only`)).items)).toEqual(['onlyT', 'onlyS']);
    // marketplaceStatus still applies to marketplaceId only: not_in_file on Talabat = onlyS, onlyS differs.
    expect(keysOf((await ok(`${BOTH}&marketplacesDiffer=any&marketplaceStatus=not_in_file`)).items)).toEqual(['onlyS']);
  });

  it('never shows another store\'s listings, and is empty when one marketplace has no file', async () => {
    expect(keysOf((await ok(`${BOTH}&marketplacesDiffer=any`, b)).items)).toEqual(['b1']);
    const none = await ok(`${BOTH}&marketplacesDiffer=any`, c);
    expect(none.items).toEqual([]);
    expect(none.counts.all).toBe(0);
    // Side by side still works: Snoonu shows "not applicable" (no file yet).
    expect((await ok(BOTH, c)).items[0]!.compareMarketplace).toMatchObject({ marketplaceId: 'snoonu', comparison: 'not_applicable' });
  });

  it('an Analyst can read it too (products.view)', async () => {
    expect(keysOf((await ok(`${BOTH}&marketplacesDiffer=any`, a, analyst)).items)).toEqual(['price', 'avail', 'onlyT', 'onlyS', 'both']);
  });

  it('400 for a second marketplace without a first, the same one twice, a filter without a second, or one not enabled', async () => {
    for (const q of ['?compareMarketplaceId=snoonu', '?marketplaceId=talabat&compareMarketplaceId=talabat', '?marketplaceId=talabat&marketplacesDiffer=any',
      `${BOTH}&marketplacesDiffer=stock`, '?marketplaceId=talabat&compareMarketplaceId=keeta']) {
      expect([q, (await list(q)).statusCode]).toEqual([q, 400]);
    }
  });
});
