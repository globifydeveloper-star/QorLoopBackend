import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';

let h: Harness, a: Store, b: Store, analyst: Session;
let productId: string, uploadId: string;
const path = '/api/products/marketplace-listings';
const get = (query = '', store = a, session: Session | undefined = a.owner) => h.request('GET', path + '?marketplaceId=talabat' + query, store, session);

beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('marketplace-catalogue');
  b = await h.createOwner('other-catalogue');
  analyst = await h.member(a, 'analyst');
  const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id } });
  const product = await h.fixture.prisma.product.create({ data: { tenantId: a.id, barcode: '6281000111', normalizedBarcode: '6281000111', nameEn: 'Catalogue milk', erpPrice: 12, erpStock: 5, status: 'active' } });
  productId = product.id;
  const upload = await h.fixture.prisma.upload.create({ data: {
    tenantId: a.id, source: 'talabat', fileName: 'talabat.xlsx', storageKey: `tenants/${a.id}/uploads/private.xlsx`, size: 100,
    uploadedById: owner.id, status: 'applied', appliedAt: new Date(),
  } });
  uploadId = upload.id;
  await h.fixture.prisma.listing.createMany({ data: [
    { tenantId: a.id, marketplaceId: 'talabat', marketplaceProductId: 'T-1', productId, uploadId, name: 'Milk on Talabat', barcodes: ['6281000111'], price: 13.75, available: true },
    { tenantId: a.id, marketplaceId: 'talabat', marketplaceProductId: 'T-2', uploadId, name: '50% Cocoa', barcodes: ['999001', '999002'], price: 9, available: false },
    { tenantId: a.id, marketplaceId: 'talabat', marketplaceProductId: 'T-3', productId, uploadId, name: '50X Cocoa', barcodes: ['6281000222'], price: 14, available: false },
    { tenantId: a.id, marketplaceId: 'snoonu', marketplaceProductId: 'S-1', productId, name: 'Snoonu milk', barcodes: ['6281000111'], price: 15, available: true },
    { tenantId: b.id, marketplaceId: 'talabat', marketplaceProductId: 'FOREIGN', name: 'Other store', barcodes: ['123'], price: 1, available: true },
  ] });
});
afterAll(async () => { await h.close(); });

describe('marketplace catalogue listings', () => {
  it('returns every listing, including unmatched and multiple listings for one product, without a recon run', async () => {
    const response = await get('', a, analyst);
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.total).toBe(3);
    expect(data.items.map((r: { marketplaceProductId: string }) => r.marketplaceProductId)).toEqual(['T-1', 'T-2', 'T-3']);
    expect(data.items[0]).toMatchObject({ price: 13.75, available: true, product: { id: productId, nameEn: 'Catalogue milk' }, sourceFile: { id: uploadId, fileName: 'talabat.xlsx' } });
    expect(data.items[1]).toMatchObject({ product: null, barcodes: ['999001', '999002'], available: false });
    expect(data.latestUpload).toMatchObject({ id: uploadId, fileName: 'talabat.xlsx' });
    expect(response.body).not.toMatch(/storageKey|private.xlsx|costPrice|password/);
  });

  it('paginates without dropping or duplicating rows and keeps the filtered total', async () => {
    const first = (await get('&limit=2')).json().data;
    const second = (await get('&limit=2&cursor=' + first.nextCursor)).json().data;
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect([...first.items, ...second.items].map(r => r.marketplaceProductId)).toEqual(['T-1', 'T-2', 'T-3']);
    expect(second.nextCursor).toBeNull();
  });

  it('searches names, marketplace IDs and barcode prefixes, including unmatched barcodes; escapes wildcards', async () => {
    expect((await get('&q=milk')).json().data.total).toBe(2);
    expect((await get('&q=T-2')).json().data.total).toBe(1);
    expect((await get('&q=999')).json().data.items[0].marketplaceProductId).toBe('T-2');
    expect((await get('&q=' + encodeURIComponent('50%'))).json().data.total).toBe(1);
  });

  it('filters current availability and catalogue match on the server', async () => {
    expect((await get('&availability=available')).json().data.total).toBe(1);
    expect((await get('&availability=unavailable&match=matched')).json().data.items.map((r: { marketplaceProductId: string }) => r.marketplaceProductId)).toEqual(['T-3']);
    expect((await get('&match=unmatched')).json().data.total).toBe(1);
  });

  it('isolates marketplaces and tenants, and requires a session', async () => {
    const otherMarket = await h.request('GET', path + '?marketplaceId=snoonu', a, a.owner);
    expect(otherMarket.json().data.items.map((r: { marketplaceProductId: string }) => r.marketplaceProductId)).toEqual(['S-1']);
    expect((await get('', b, b.owner)).json().data.items[0].marketplaceProductId).toBe('FOREIGN');
    expect((await h.request('GET', path + '?marketplaceId=talabat', a)).statusCode).toBe(401);
    expect((await get('&tenantId=' + b.id)).statusCode).toBe(400);
  });

  it('returns an empty page before a marketplace has been uploaded', async () => {
    const response = await h.request('GET', path + '?marketplaceId=keeta', a, a.owner);
    expect(response.json().data).toEqual({ items: [], total: 0, latestUpload: null, nextCursor: null });
  });

  it.each(['&limit=201', '&cursor=invalid', '&availability=other', '&match=other'])('rejects invalid filters %s', async query => {
    expect((await get(query)).statusCode).toBe(400);
  });

  it('rejects a cursor from a different marketplace', async () => {
    const first = (await get('&limit=1')).json().data;
    expect((await h.request('GET', path + '?marketplaceId=snoonu&cursor=' + first.nextCursor, a, a.owner)).statusCode).toBe(400);
  });
});
