import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Store } from './harness.js';

let h: Harness;
let store: Store;
let other: Store;
const url = '/api/pricing/active-offers';

async function offer(nameEn: string, price: number, validFrom: Date | null, validUntil: Date | null, target = store, status = 'active') {
  const barcode = String(6_288_000_000_100 + ++serial);
  const product = await h.fixture.prisma.product.create({ data: {
    tenantId: target.id, nameEn, barcode, normalizedBarcode: barcode,
    erpPrice: 10, erpStock: 1, status,
  } });
  await h.fixture.prisma.productOffer.create({ data: { tenantId: target.id, productId: product.id, price, validFrom, validUntil } });
  return product.id;
}
let serial = 0;

beforeAll(async () => {
  h = await createHarness();
  store = await h.createOwner('offers-dashboard');
  other = await h.createOwner('offers-other');
  const now = Date.now();
  await offer('A open offer', 7.5, null, null);
  await offer('B bounded offer', 8, new Date(now - 60_000), new Date(now + 60_000));
  await offer('C scheduled', 8, new Date(now + 60_000), null);
  await offer('D expired', 8, null, new Date(now - 60_000));
  await offer('E inactive', 8, null, null, store, 'inactive');
  await offer('F another store', 8, null, null, other);
});
afterAll(async () => { await h.close(); });

describe('active offers dashboard', () => {
  it('returns only currently valid offers on active products, with a count and bounded pages', async () => {
    const first = await h.request('GET', `${url}?page=1&limit=1`, store, store.owner);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ total: 2, page: 1, limit: 1,
      items: [{ nameEn: 'A open offer', price: 7.5, erpPrice: 10, validFrom: null, validUntil: null }],
    });
    expect(Date.parse(first.json().data.asOf)).toBeGreaterThan(0);
    const second = await h.request('GET', `${url}?page=2&limit=1`, store, store.owner);
    expect(second.json().data.items).toMatchObject([{ nameEn: 'B bounded offer', price: 8 }]);
    const beyond = await h.request('GET', `${url}?page=3&limit=1`, store, store.owner);
    expect(beyond.json().data).toMatchObject({ total: 2, items: [] });
  });

  it('is tenant scoped, read-only for analysts, and rejects invalid paging and missing sessions', async () => {
    const analyst = await h.member(store, 'analyst');
    expect((await h.request('GET', url, store, analyst)).json().data.total).toBe(2);
    expect((await h.request('GET', url, other, other.owner)).json().data).toMatchObject({ total: 1, items: [{ nameEn: 'F another store' }] });
    expect((await h.request('GET', `${url}?page=0`, store, store.owner)).statusCode).toBe(400);
    expect((await h.request('GET', `${url}?limit=201`, store, store.owner)).statusCode).toBe(400);
    expect((await h.request('GET', `${url}?unexpected=1`, store, store.owner)).statusCode).toBe(400);
    expect((await h.request('GET', url, store, undefined)).statusCode).toBe(401);
  });
});
