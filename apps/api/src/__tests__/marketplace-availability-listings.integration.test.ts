import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';

let h: Harness, a: Store, b: Store, analyst: Session, ownerId: string;
const ids: Record<string, string> = {};
const listPath = '/api/products/marketplace-listings?marketplaceId=';
const valuePath = (id: string, marketplace = 'talabat') => `/api/marketplace-values/${marketplace}/products/${id}`;
const snapshot = async (key = 'active', marketplace = 'talabat') => {
  const response = await h.request('GET', listPath + marketplace, a, a.owner);
  expect(response.statusCode).toBe(200);
  return response.json().data.items.find((item: { marketplaceProductId: string }) => item.marketplaceProductId === key).availabilityAdjustment;
};
beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('availability-catalogue');
  b = await h.createOwner('availability-other');
  analyst = await h.member(a, 'analyst');
  const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id, email: 'owner@availability-catalogue.test' } });
  ownerId = owner.id;
  const upload = await h.fixture.prisma.upload.create({ data: { tenantId: a.id, source: 'talabat', fileName: 'talabat.xlsx', size: 1, storageKey: 'availability-t', uploadedById: ownerId, status: 'applied', appliedAt: new Date() } });
  await h.fixture.prisma.upload.create({ data: { tenantId: a.id, source: 'snoonu', fileName: 'snoonu.xlsx', size: 1, storageKey: 'availability-s', uploadedById: ownerId, status: 'applied', appliedAt: new Date() } });
  let serial = 0;
  for (const [key, fields] of Object.entries({ active: {}, inactive: { status: 'inactive' }, erpOff: { erpActive: false }, missing: { inLatestErpFile: false }, noStock: { erpStock: 0 } })) {
    const barcode = String(6281000000 + ++serial);
    const product = await h.fixture.prisma.product.create({ data: { tenantId: a.id, barcode, normalizedBarcode: barcode, nameEn: key, status: 'active', erpStock: 5, erpPrice: 12, ...fields } });
    ids[key] = product.id;
    await h.fixture.prisma.listing.create({ data: { tenantId: a.id, productId: product.id, marketplaceId: 'talabat', marketplaceProductId: key, barcodes: [barcode], price: 14, available: true, uploadId: upload.id } });
  }
  await h.fixture.prisma.listing.create({ data: { tenantId: a.id, productId: ids.active, marketplaceId: 'snoonu', marketplaceProductId: 'active', barcodes: [], price: 15, available: true } });
  await h.fixture.prisma.listing.create({ data: { tenantId: a.id, marketplaceId: 'talabat', marketplaceProductId: 'unmatched', barcodes: ['999'], price: 9, available: true } });
});
afterAll(async () => { await h.close(); });

describe('availability controls in marketplace listings', () => {
  it('reads the live catalogue baseline and version before any comparison, and leaves unmatched listings uneditable', async () => {
    expect(await snapshot()).toEqual({ catalogueAvailable: true, override: null, version: null, blockedReason: null });
    expect(await snapshot('noStock')).toMatchObject({ catalogueAvailable: false, override: null });
    expect(await snapshot('unmatched')).toBeNull();
  });

  it.each([['inactive', 'Product is not active'], ['erpOff', 'Inactive in the ERP'], ['missing', 'Not in the latest ERP file']])('returns and enforces the blocked reason for %s', async (key, reason) => {
    expect(await snapshot(key)).toMatchObject({ catalogueAvailable: false, blockedReason: reason });
    expect((await h.request('PUT', valuePath(ids[key]!), a, a.owner, { expected: null, values: { availability: { value: false } } })).statusCode).toBe(400);
  });

  it('uses owner-edited catalogue stock and the store stock threshold', async () => {
    await h.fixture.prisma.catalogueStockEdit.create({ data: { tenantId: a.id, productId: ids.noStock!, stock: 7, erpStockAtEdit: 0, state: 'active', setById: ownerId, setAt: new Date() } });
    expect(await snapshot('noStock')).toMatchObject({ catalogueAvailable: true });
    await h.fixture.prisma.tenantSettings.update({ where: { tenantId: a.id }, data: { stockThreshold: 10 } });
    expect(await snapshot()).toMatchObject({ catalogueAvailable: false });
    await h.fixture.prisma.tenantSettings.update({ where: { tenantId: a.id }, data: { stockThreshold: 0 } });
  });

  it('sets, pins, handles a stale version and resets availability without touching prices, stock or another marketplace', async () => {
    const id = ids.active!;
    expect((await h.request('PUT', valuePath(id), a, a.owner, { expected: null, values: { price: { value: 16, persistent: true } } })).statusCode).toBe(200);
    let state = await snapshot();
    expect((await h.request('PUT', valuePath(id), a, a.owner, { expected: state.version, values: { availability: { value: false, persistent: false } } })).statusCode).toBe(200);
    state = await snapshot();
    expect(state.override).toEqual({ value: false, persistent: false });
    const oldVersion = state.version;
    expect((await h.request('PUT', valuePath(id), a, a.owner, { expected: oldVersion, values: { availability: { value: false, persistent: true } } })).statusCode).toBe(200);
    state = await snapshot();
    expect(state.override).toEqual({ value: false, persistent: true });
    expect(state.version.version).toBe(oldVersion.version + 1);
    expect((await h.request('PUT', valuePath(id), a, a.owner, { expected: oldVersion, values: { availability: { value: true } } })).statusCode).toBe(409);
    expect((await snapshot('active', 'snoonu')).override).toBeNull();
    expect((await h.fixture.prisma.product.findUniqueOrThrow({ where: { id } })).erpStock).toBe(5);
    expect((await h.fixture.prisma.listing.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'talabat', productId: id } })).available).toBe(true);
    expect((await h.request('DELETE', valuePath(id) + `?fields=availability&expectedId=${state.version.id}&expectedVersion=${state.version.version}`, a, a.owner)).statusCode).toBe(200);
    expect(await snapshot()).toMatchObject({ catalogueAvailable: true, override: null });
    const [stored] = await h.fixture.prisma.$queryRaw<{ price: number; price_state: string }[]>`SELECT price_value::float8 AS price, price_state FROM marketplace_value_overrides WHERE tenant_id = ${a.id}::uuid AND product_id = ${id}::uuid`;
    expect(stored!.price).toBe(16);
    expect(stored!.price_state).toBe('pending');
  });

  it('blocks a disabled marketplace and enforces write permission and tenant ownership', async () => {
    await h.fixture.prisma.tenantMarketplace.create({ data: { tenantId: a.id, marketplaceId: 'talabat', enabled: false } });
    const state = await snapshot();
    expect(state.blockedReason).toBe('Marketplace is switched off');
    expect((await h.request('PUT', valuePath(ids.active!), a, a.owner, { expected: state.version, values: { availability: { value: false } } })).statusCode).toBe(400);
    expect((await h.request('PUT', valuePath(ids.active!), a, analyst, { expected: state.version, values: { availability: { value: false } } })).statusCode).toBe(403);
    expect((await h.request('GET', '/api/products/marketplace-listings?marketplaceId=talabat', b, b.owner)).json().data.items).toEqual([]);
  });
});
