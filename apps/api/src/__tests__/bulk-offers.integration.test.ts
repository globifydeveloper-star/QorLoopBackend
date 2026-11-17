import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session, analyst: Session;
const ids: Record<string, string> = {};

let serial = 0;
async function product(store: Store, key: string, nameEn: string, erpPrice: number, data: { status?: string } = {}) {
  const barcode = String(6_288_000_000_000 + ++serial);
  const p = await h.fixture.prisma.product.create({ data: { tenantId: store.id, nameEn, barcode, normalizedBarcode: barcode, erpPrice, erpStock: 5, status: 'active', ...data } });
  ids[key] = p.id;
  return p.id;
}
const listing = (store: Store, marketplaceId: string, key: string, price: number) =>
  h.fixture.prisma.listing.create({ data: { tenantId: store.id, marketplaceId, marketplaceProductId: `${marketplaceId}-${key}`, productId: ids[key]!, barcodes: [], price, available: true } });
async function applied(store: Store, source: string) {
  const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id } });
  await h.fixture.prisma.upload.create({ data: { tenantId: store.id, source, fileName: `${source}.xlsx`, size: 1, storageKey: `t/${source}`, uploadedById: owner.id, status: 'applied', appliedAt: new Date() } });
}

type Body = Record<string, unknown>;
type Row = { index: number; productId: string; outcome: string; reason: string | null; message: string | null; warnings: { code: string }[]; normalPrice: number | null; currentOffer: unknown; offer: unknown };
const call = (path: 'preview' | 'apply', who: Session, body: Body, store = a) => h.request('POST', `/api/pricing/offers/bulk/${path}`, store, who, body);
async function preview(body: Body, who = manager, store = a) {
  const r = await call('preview', who, body, store);
  expect([r.statusCode, r.statusCode === 200 ? null : r.body]).toEqual([200, null]);
  return r.json().data;
}
async function apply(body: Body, who = manager, store = a) {
  const r = await call('apply', who, body, store);
  expect([r.statusCode, r.statusCode === 200 ? null : r.body]).toEqual([200, null]);
  return r.json().data;
}
const events = (action: string, store = a) => h.fixture.prisma.auditEvent.findMany({ where: { tenantId: store.id, action }, orderBy: { createdAt: 'asc' } });
const offersOf = async (key: string) => (await h.fixture.prisma.productOffer.findMany({ where: { productId: ids[key]! } }))
  .map(o => ({ price: o.price.toNumber(), validFrom: o.validFrom?.toISOString() ?? null, validUntil: o.validUntil?.toISOString() ?? null }));
async function reconCalls(fn: () => Promise<unknown>) {
  const before = h.recon.calls.length;
  await fn();
  await h.recon.drain();
  return h.recon.calls.slice(before);
}

// Qatar calendar days as the UI sends them
const day = (d: string) => `${d}T00:00:00.000+03:00`;
const endOf = (d: string) => `${d}T23:59:59.999+03:00`;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const START = day(inDays(3)), END = endOf(inDays(10));
const iso = (s: string) => new Date(s).toISOString();

beforeAll(async () => {
  h = await createHarness();
  h.recon.handler = job => recomputeRecon({ database: h.fixture.database }, job);
  a = await h.createOwner('offers-a');
  b = await h.createOwner('offers-b');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
  await product(a, 'milk', 'A Milk', 10);
  await product(a, 'laban', 'B Laban', 8);
  await product(a, 'bread', 'C Bread', 4);
  await product(a, 'cheese', 'D Cheese', 20);
  await product(a, 'eggs', 'E Eggs', 6);
  await product(a, 'fresh', 'F New', 5, { status: 'new' });
  await product(a, 'old', 'G Inactive', 5, { status: 'inactive' });
  await product(b, 'other', 'Other milk', 10);
  // cheese already has an offer (8 days left); laban has a pending Talabat price export value
  await h.fixture.prisma.productOffer.create({ data: { tenantId: a.id, productId: ids.cheese!, price: 15, validFrom: null, validUntil: new Date(END) } });
  const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id } });
  await h.fixture.prisma.marketplaceValueOverride.create({ data: { tenantId: a.id, productId: ids.laban!, marketplaceId: 'talabat', priceValue: 7.75, priceState: 'pending', priceSetById: owner.id, priceSetAt: new Date() } });
  for (const k of ['milk', 'laban', 'bread', 'cheese']) await listing(a, 'talabat', k, 9);
  await applied(a, 'talabat');
  await applied(a, 'snoonu');
  await h.recon.enqueueRecon(a.id, 'manual');
  await h.recon.drain();
}, 120_000);
afterAll(async () => { await h.close(); });

describe('bulk offers: access and contract', () => {
  const body = { items: [{ productId: randomUUID(), price: 1, validUntil: END }] };
  it('needs pricing.bulk and the CSRF token', async () => {
    for (const path of ['preview', 'apply'] as const) {
      const b2 = path === 'apply' ? { ...body, idempotencyKey: randomUUID() } : body;
      expect((await call(path, analyst, b2)).statusCode).toBe(403);
      expect((await call(path, { ...manager, csrf: 'wrong' }, b2)).statusCode).toBe(403);
      expect((await h.request('POST', `/api/pricing/offers/bulk/${path}`, a, undefined, b2)).statusCode).toBe(401);
    }
    expect(await events('pricing.offers_bulk_set')).toEqual([]);
  });

  it('refuses a malformed request as a whole (400)', async () => {
    const item = { productId: randomUUID(), price: 1, validUntil: END };
    const bad: Body[] = [
      {}, { items: [] }, { items: Array.from({ length: 501 }, () => ({ ...item, productId: randomUUID() })) },
      { items: [{ ...item, productId: 'nope' }] }, { items: [{ ...item, price: '1' }] }, { items: [{ ...item, validUntil: '2026-11-30' }] },
      { items: [{ ...item, validFrom: '2026-11-20T00:00:00' }] }, { items: [{ ...item, percent: 10 }] }, { ...body, selection: { all: true } },
    ];
    for (const b2 of bad) expect([JSON.stringify(b2).slice(0, 80), (await call('preview', manager, b2)).statusCode]).toEqual([JSON.stringify(b2).slice(0, 80), 400]);
    expect((await call('apply', manager, body)).statusCode).toBe(400); // no idempotency key
    expect((await call('apply', manager, { ...body, idempotencyKey: 'short' })).statusCode).toBe(400);
    expect((await call('apply', manager, { ...body, idempotencyKey: randomUUID(), previewToken: 'abc' })).statusCode).toBe(400);
  });

  it('accepts 500 rows with both dates (about 68 KB) on these routes; other routes keep the 32 KB limit', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ productId: randomUUID(), price: 12.345 + i / 1000, validFrom: START, validUntil: END }));
    expect(JSON.stringify({ items }).length).toBeGreaterThan(64 * 1024);
    const data = await preview({ items });
    expect(data.totals).toEqual(expect.objectContaining({ items: 500, rejected: 500, set: 0 }));
    expect(data.totals.rejectedReasons).toEqual([expect.objectContaining({ reason: 'not_found', count: 500 })]);
    const other = await h.request('POST', '/api/pricing/bulk/preview', a, manager, { marketplaceId: 'talabat', selection: { productIds: items.map(i => i.productId) }, action: { type: 'match_erp' }, padding: 'x'.repeat(40_000) });
    expect(other.statusCode).toBe(413);
  });

  it('is documented in OpenAPI', () => {
    expect(h.api.spec.paths['/api/pricing/offers/bulk/preview']?.post?.requestBody).toBeDefined();
    expect(h.api.spec.paths['/api/pricing/offers/bulk/apply']?.post?.requestBody).toBeDefined();
  });
});

describe('bulk offers: preview', () => {
  it('judges every row on its own, with the normal price, the current offer, warnings and totals; writes nothing', async () => {
    const items = [
      { productId: ids.milk, price: 8.5, validFrom: START, validUntil: END },       // 0 set
      { productId: ids.laban, price: 7, validUntil: END },                           // 1 set, export_value_outranks (talabat)
      { productId: ids.cheese, price: 15, validFrom: null, validUntil: END },        // 2 unchanged (same price, same dates)
      { productId: ids.bread, price: 4, validUntil: END },                           // 3 price_not_below_normal
      { productId: ids.eggs, price: 5, validFrom: START, validUntil: null },         // 4 end_required
      { productId: ids.fresh, price: 1, validUntil: END },                           // 5 product_not_active
      { productId: ids.old, price: 1, validUntil: END },                             // 6 product_not_active
      { productId: ids.other, price: 1, validUntil: END },                           // 7 not_found (other store)
    ];
    const data = await preview({ items });
    const rows = data.items as Row[];
    expect(rows.map(r => [r.index, r.outcome, r.reason])).toEqual([
      [0, 'set', null], [1, 'set', null], [2, 'unchanged', null], [3, 'rejected', 'price_not_below_normal'],
      [4, 'rejected', 'end_required'], [5, 'rejected', 'product_not_active'], [6, 'rejected', 'product_not_active'], [7, 'rejected', 'not_found'],
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({
      nameEn: 'A Milk', normalPrice: 10, lowestNormalPrice: 10, currentOffer: null, warnings: [],
      offer: { price: 8.5, validFrom: iso(START), validUntil: iso(END) },
    }));
    expect(rows[1]!.warnings).toEqual([{ code: 'export_value_outranks', marketplaceIds: ['talabat'] }]);
    expect(rows[2]).toEqual(expect.objectContaining({ normalPrice: 20, currentOffer: { price: 15, validFrom: null, validUntil: iso(END), state: 'active' } }));
    expect(rows[3]!.message).toBe('The offer price must be below the normal price (QAR 4.000)');
    expect(rows[7]).toEqual(expect.objectContaining({ nameEn: null, barcode: null, normalPrice: null, offer: null }));
    expect(data.totals).toEqual(expect.objectContaining({ items: 8, set: 2, unchanged: 1, rejected: 5, warnings: { replaces_offer: 0, export_value_outranks: 1 } }));
    expect(data.previewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await offersOf('milk')).toEqual([]);
    expect(await events('pricing.offers_bulk_set')).toEqual([]);
  });

  it('flags duplicate rows (all of them) and other date rules', async () => {
    const rows = (await preview({ items: [
      { productId: ids.eggs, price: 5, validUntil: END },
      { productId: ids.eggs, price: 4, validUntil: END },
      { productId: ids.milk, price: 5, validFrom: END, validUntil: START },
      { productId: ids.bread, price: 3, validUntil: '2020-01-01T23:59:59.999+03:00' },
      { productId: ids.laban, price: 0 },
    ] })).items as Row[];
    expect(rows.map(r => r.reason)).toEqual(['duplicate_row', 'duplicate_row', 'end_before_start', 'already_ended', 'invalid_price']);
  });
});

describe('bulk offers: apply', () => {
  it('writes the valid rows only, in one transaction with one event and one recompute; a replay returns the first result', async () => {
    const body = { items: [
      { productId: ids.milk, price: 8.5, validFrom: START, validUntil: END },
      { productId: ids.cheese, price: 14, validFrom: START, validUntil: END }, // replaces the 15 offer
      { productId: ids.bread, price: 4, validUntil: END },                    // rejected: not below normal
    ] };
    const { previewToken } = await preview(body);
    const idempotencyKey = randomUUID();
    let result: Record<string, unknown> = {};
    const calls = await reconCalls(async () => { result = await apply({ ...body, idempotencyKey, previewToken }); });
    expect(calls).toEqual([{ tenantId: a.id, reason: 'pricing.offers_bulk' }]);
    expect(result).toEqual(expect.objectContaining({
      replayed: false, created: 1, replaced: 1,
      totals: expect.objectContaining({ items: 3, set: 2, unchanged: 0, rejected: 1, warnings: { replaces_offer: 1, export_value_outranks: 0 } }),
      rejected: [{ index: 2, productId: ids.bread, reason: 'price_not_below_normal', message: 'The offer price must be below the normal price (QAR 4.000)' }],
    }));
    expect(await offersOf('milk')).toEqual([{ price: 8.5, validFrom: iso(START), validUntil: iso(END) }]);
    expect(await offersOf('cheese')).toEqual([{ price: 14, validFrom: iso(START), validUntil: iso(END) }]);
    expect(await offersOf('bread')).toEqual([]);
    const [event, ...more] = await events('pricing.offers_bulk_set');
    expect(more).toEqual([]);
    expect(event!.details).toEqual(expect.objectContaining({
      idempotencyKey, previewToken,
      changeColumns: ['productId', 'oldPrice', 'oldFrom', 'oldUntil', 'newPrice', 'newFrom', 'newUntil'],
      changes: [
        [ids.milk, null, null, null, 8.5, iso(START), iso(END)],
        [ids.cheese, 15, null, iso(END), 14, iso(START), iso(END)],
      ],
    }));
    expect(result.operationId).toBe(event!.id);

    // the same key and body: the first result, nothing written again, no recompute
    const again = await reconCalls(async () => {
      expect(await apply({ ...body, idempotencyKey, previewToken })).toEqual({ ...result, replayed: true });
    });
    expect(again).toEqual([]);
    expect((await events('pricing.offers_bulk_set')).length).toBe(1);
    // the same key with another body: 409
    expect((await call('apply', manager, { items: body.items.slice(0, 1), idempotencyKey })).statusCode).toBe(409);
    // the product history shows the bulk operation
    const history = await h.request('GET', `/api/products/${ids.cheese}/history`, a, a.owner);
    expect(history.statusCode).toBe(200);
    expect(JSON.stringify(history.json().data)).toContain('Product offer set by a bulk operation');
  });

  it('a stale preview token is refused (409) and nothing is written', async () => {
    const body = { items: [{ productId: ids.eggs, price: 5, validUntil: END }] };
    const { previewToken } = await preview(body);
    await h.fixture.prisma.product.update({ where: { id: ids.eggs! }, data: { erpPrice: 4 } }); // now 5 is not below normal
    expect((await call('apply', manager, { ...body, idempotencyKey: randomUUID(), previewToken })).statusCode).toBe(409);
    expect(await offersOf('eggs')).toEqual([]);
    await h.fixture.prisma.product.update({ where: { id: ids.eggs! }, data: { erpPrice: 6 } });
  });

  it('an apply where every row is rejected or unchanged writes nothing and queues no recompute, but is recorded', async () => {
    const calls = await reconCalls(async () => {
      const r = await apply({ items: [{ productId: ids.bread, price: 9, validUntil: END }], idempotencyKey: randomUUID() });
      expect(r).toEqual(expect.objectContaining({ created: 0, replaced: 0, totals: expect.objectContaining({ set: 0, rejected: 1 }) }));
    });
    expect(calls).toEqual([]);
    expect((await events('pricing.offers_bulk_set')).length).toBe(2);
  });
});

describe('offer fields on the product list and the Review', () => {
  it('product list rows carry normalPrice and the offer in any state', async () => {
    const r = await h.request('GET', '/api/products?limit=50', a, manager);
    expect(r.statusCode).toBe(200);
    const items = r.json().data.items as { id: string; normalPrice: number; offer: unknown; marketplacePrice: { price: number; source: string } }[];
    const milk = items.find(i => i.id === ids.milk)!;
    expect(milk).toEqual(expect.objectContaining({
      normalPrice: 10, marketplacePrice: { price: 10, source: 'default' },
      offer: { price: 8.5, validFrom: iso(START), validUntil: iso(END), state: 'scheduled' },
    }));
    expect(items.find(i => i.id === ids.bread)).toEqual(expect.objectContaining({ normalPrice: 4, offer: null }));
  });

  it('Review items carry catalogue.normalPrice and catalogue.offer', async () => {
    // an active offer on bread (started yesterday)
    await h.fixture.prisma.productOffer.create({ data: { tenantId: a.id, productId: ids.bread!, price: 3.5, validFrom: new Date(Date.now() - 86_400_000), validUntil: new Date(END) } });
    await h.recon.enqueueRecon(a.id, 'manual');
    await h.recon.drain();
    const r = await h.request('GET', '/api/marketplace-values/review?marketplaceId=talabat&show=all&limit=50', a, manager);
    expect(r.statusCode).toBe(200);
    const items = r.json().data.items as { productId: string; catalogue: { price: number; priceSource: string; normalPrice: number; offer: { state: string } | null } }[];
    const bread = items.find(i => i.productId === ids.bread)!;
    expect(bread.catalogue).toEqual(expect.objectContaining({ price: 3.5, priceSource: 'offer', normalPrice: 4, offer: expect.objectContaining({ price: 3.5, state: 'active' }) }));
    expect(items.find(i => i.productId === ids.laban)!.catalogue).toEqual(expect.objectContaining({ normalPrice: 8, offer: null }));
    const one = await h.request('GET', `/api/marketplace-values/talabat/products/${ids.bread}`, a, manager);
    expect(one.json().data.catalogue).toEqual(expect.objectContaining({ normalPrice: 4, offer: expect.objectContaining({ state: 'active' }) }));
  });
});
