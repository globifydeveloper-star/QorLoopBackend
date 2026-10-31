import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { ROLE_PERMISSIONS } from '../../../../packages/core/src/roles.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session, analyst: Session;

type Seed = {
  barcode: string; nameEn: string; sku?: string | null; nameAr?: string | null; status?: string; inLatestErpFile?: boolean;
  erpCategory?: string | null; categoryId?: string | null; subcategoryId?: string | null; costPrice?: number | null; imageKey?: string | null;
};
let serial = 0;
const nextBarcode = () => String(6_299_000_000_000 + ++serial);

/** Products straight into the database (the upload pipeline has its own tests); returns their ids by barcode. */
async function seed(store: Store, rows: Seed[]) {
  await h.fixture.prisma.product.createMany({
    data: rows.map(r => ({ erpPrice: 2.5, erpStock: 4, ...r, tenantId: store.id, normalizedBarcode: r.barcode })),
  });
  const saved = await h.fixture.prisma.product.findMany({ where: { tenantId: store.id, normalizedBarcode: { in: rows.map(r => r.barcode) } }, select: { id: true, normalizedBarcode: true } });
  return Object.fromEntries(saved.map(p => [p.normalizedBarcode, p.id])) as Record<string, string>;
}
const products = (store: Store, who: Session, query = '') => h.request('GET', '/api/products' + query, store, who);
const names = (r: Awaited<ReturnType<typeof products>>) => (r.json().data.items as { nameEn: string }[]).map(i => i.nameEn);
async function category(store: Store, body: Record<string, unknown>) {
  const r = await h.request('POST', '/api/categories', store, store.owner, body);
  expect(r.statusCode).toBe(200);
  return r.json().data.id as string;
}
const events = (store: Store, action: string, entityId?: string) =>
  h.fixture.prisma.auditEvent.findMany({ where: { tenantId: store.id, action, ...(entityId ? { entityId } : {}) }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('alpha');
  b = await h.createOwner('beta');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
});
afterAll(async () => { await h.close(); });

describe('product list', () => {
  let s: Store, m: Session, an: Session;
  let dairy: string, milkSub: string, bakery: string;
  beforeAll(async () => {
    s = await h.createOwner('listing');
    m = await h.member(s, 'catalogue_manager');
    an = await h.member(s, 'analyst');
    dairy = await category(s, { nameEn: 'Dairy' });
    milkSub = await category(s, { nameEn: 'Milk', parentId: dairy });
    bakery = await category(s, { nameEn: 'Bakery' });
    await seed(s, [
      { barcode: '6281000000011', nameEn: 'Fresh Milk 1L', sku: 'SKU-1', status: 'active', categoryId: dairy, subcategoryId: milkSub, costPrice: 1.2, imageKey: 'tenants/x/images/secret-key.png' },
      { barcode: '6281000000028', nameEn: 'Laban 500ml', status: 'new', categoryId: dairy },
      { barcode: '6281000000035', nameEn: 'Arabic Bread', status: 'inactive', categoryId: bakery },
      { barcode: '6282000000042', nameEn: 'milk powder', sku: 'MP-9', status: 'new', inLatestErpFile: false },
      { barcode: '6282000000059', nameEn: '50% Cocoa', status: 'active' },
    ]);
  });

  it('lists products by name with every tab count; never the image key', async () => {
    const r = await products(s, m);
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.counts).toEqual({ all: 5, active: 2, inactive: 1, new: 2, missing: 1 });
    expect(d.nextCursor).toBeNull();
    expect(d.items).toHaveLength(5);
    const milk = d.items.find((i: { barcode: string }) => i.barcode === '6281000000011');
    expect(Object.keys(milk).sort()).toEqual(['barcode', 'brand', 'categoryId', 'costPrice', 'erpCategory', 'erpPrice', 'erpStock', 'id', 'inLatestErpFile',
      'marketplacePrice', 'nameAr', 'nameEn', 'sku', 'status', 'subcategoryId', 'updatedAt'].sort());
    expect(milk).toMatchObject({ sku: 'SKU-1', erpPrice: 2.5, costPrice: 1.2, erpStock: 4, status: 'active', inLatestErpFile: true, categoryId: dairy, subcategoryId: milkSub });
    expect(r.body).not.toMatch(/imageKey|secret-key|storage/i);
  });
  it('shows cost only to roles that may change prices', async () => {
    const items = (await products(s, an)).json().data.items as Record<string, unknown>[];
    expect(items).toHaveLength(5);
    expect(items.some(i => 'costPrice' in i)).toBe(false);
    expect(((await products(s, s.owner)).json().data.items as Record<string, unknown>[]).every(i => 'costPrice' in i)).toBe(true);
  });
  it.each([
    ['active', ['50% Cocoa', 'Fresh Milk 1L']], ['inactive', ['Arabic Bread']], ['new', ['Laban 500ml', 'milk powder']], ['missing', ['milk powder']],
  ])('tab %s', async (tab, expected) => {
    const r = await products(s, m, '?tab=' + tab);
    expect(names(r).sort()).toEqual([...expected].sort());
    expect(r.json().data.counts.all).toBe(5);
  });
  it('searches the English name without regard to case; counts follow the search', async () => {
    const r = await products(s, m, '?q=MILK');
    expect(names(r).sort()).toEqual(['Fresh Milk 1L', 'milk powder']);
    expect(r.json().data.counts).toEqual({ all: 2, active: 1, inactive: 0, new: 1, missing: 1 });
  });
  it('reads % and _ in a search as text, not as wildcards', async () => {
    expect(names(await products(s, m, '?q=' + encodeURIComponent('50%')))).toEqual(['50% Cocoa']);
    expect(names(await products(s, m, '?q=' + encodeURIComponent('%')))).toEqual(['50% Cocoa']);
    expect(names(await products(s, m, '?q=_'))).toEqual([]);
  });
  it('searches a barcode normalised like an upload, exactly or by prefix', async () => {
    expect(names(await products(s, m, '?q=06281000000011'))).toEqual(['Fresh Milk 1L']);
    expect(names(await products(s, m, '?q=' + encodeURIComponent(' 6281000000011.0 ')))).toEqual(['Fresh Milk 1L']);
    expect(names(await products(s, m, '?q=6282')).sort()).toEqual(['50% Cocoa', 'milk powder']);
    expect(names(await products(s, m, '?q=628100000')).sort()).toEqual(['Arabic Bread', 'Fresh Milk 1L', 'Laban 500ml']);
  });
  it('searches the SKU exactly', async () => {
    expect(names(await products(s, m, '?q=SKU-1'))).toEqual(['Fresh Milk 1L']);
    expect(names(await products(s, m, '?q=MP-9'))).toEqual(['milk powder']);
    expect(names(await products(s, m, '?q=SKU'))).toEqual([]);
  });
  it('filters by category and subcategory', async () => {
    expect(names(await products(s, m, '?categoryId=' + dairy)).sort()).toEqual(['Fresh Milk 1L', 'Laban 500ml']);
    expect(names(await products(s, m, '?subcategoryId=' + milkSub))).toEqual(['Fresh Milk 1L']);
    const r = await products(s, m, `?categoryId=${dairy}&tab=new`);
    expect(names(r)).toEqual(['Laban 500ml']);
    expect(r.json().data.counts).toEqual({ all: 2, active: 1, inactive: 0, new: 1, missing: 0 });
  });
  it.each([
    ['?tenantId=' + randomUUID(), 'an unknown parameter'], ['?limit=201', 'limit over 200'], ['?limit=0', 'limit 0'], ['?tab=deleted', 'an unknown tab'],
    ['?categoryId=not-a-uuid', 'a category that is not a uuid'], ['?cursor=not-a-cursor', 'a cursor that is not ours'],
    ['?cursor=' + Buffer.from(JSON.stringify(['x', 'y'])).toString('base64url'), 'a cursor with a bad id'],
  ])('rejects %s (%s)', async query => {
    expect((await products(s, m, query)).statusCode).toBe(400);
  });
  it('needs a session and only shows the own tenant', async () => {
    expect((await products(s, undefined as unknown as Session)).statusCode).toBe(401);
    expect((await products(a, a.owner)).json().data.items).toEqual([]);
  });
});

describe('cursor paging', () => {
  it('walks more than 200 rows with no duplicates or gaps, including equal names', async () => {
    const s = await h.createOwner('paging');
    // 260 products sharing 40 names: the (name_en, id) keyset must break ties by id
    await seed(s, Array.from({ length: 260 }, (_, i) => ({ barcode: nextBarcode(), nameEn: 'Item ' + String(i % 40).padStart(2, '0'), status: i % 3 ? 'active' : 'new' })));
    const expected = (await h.fixture.prisma.product.findMany({ where: { tenantId: s.id }, orderBy: [{ nameEn: 'asc' }, { id: 'asc' }], select: { id: true } })).map(p => p.id);
    for (const limit of [200, 37]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = await products(s, s.owner, `?limit=${limit}` + (cursor ? '&cursor=' + cursor : ''));
        expect(r.statusCode).toBe(200);
        const d = r.json().data;
        expect(d.counts.all).toBe(260);
        seen.push(...d.items.map((i: { id: string }) => i.id));
        cursor = d.nextCursor;
        pages++;
      } while (cursor);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(260);
      expect(pages).toBe(Math.ceil(260 / limit));
    }
    // one tab, paged: only that tab's rows
    const first = (await products(s, s.owner, '?tab=new&limit=50')).json().data;
    const second = (await products(s, s.owner, '?tab=new&limit=50&cursor=' + first.nextCursor)).json().data;
    expect(first.items.length + second.items.length).toBe(first.counts.new);
    expect(second.nextCursor).toBeNull();
  });
  it('defaults to 50 per page', async () => {
    const s = await h.createOwner('paging-default');
    await seed(s, Array.from({ length: 51 }, (_, i) => ({ barcode: nextBarcode(), nameEn: 'P' + i })));
    const d = (await products(s, s.owner)).json().data;
    expect(d.items).toHaveLength(50);
    expect(d.nextCursor).toEqual(expect.any(String));
  });
});

describe('product detail', () => {
  let id: string, otherId: string, dairy: string, milk: string;
  beforeAll(async () => {
    dairy = await category(a, { nameEn: 'Dairy', nameAr: 'ألبان' });
    milk = await category(a, { nameEn: 'Milk', parentId: dairy });
    const barcode = nextBarcode();
    id = (await seed(a, [{ barcode, nameEn: 'Detail Milk', categoryId: dairy, subcategoryId: milk, imageKey: 'tenants/a/images/hidden.png' }]))[barcode]!;
    await h.fixture.prisma.listing.create({ data: { tenantId: a.id, productId: id, marketplaceId: 'talabat', marketplaceProductId: 'T-1', barcodes: [barcode], price: 3.25, available: true } });
    const bBarcode = nextBarcode();
    otherId = (await seed(b, [{ barcode: bBarcode, nameEn: 'Beta product' }]))[bBarcode]!;
  });
  it('returns the product with its listings and category names', async () => {
    const r = await h.request('GET', '/api/products/' + id, a, analyst);
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d).toMatchObject({ id, nameEn: 'Detail Milk', category: { id: dairy, nameEn: 'Dairy', nameAr: 'ألبان' }, subcategory: { id: milk, nameEn: 'Milk', nameAr: null } });
    expect(d.listings).toEqual([{ marketplaceId: 'talabat', marketplaceProductId: 'T-1', price: 3.25, available: true, updatedAt: expect.any(String) }]);
    expect('costPrice' in d).toBe(false);
    expect(r.body).not.toMatch(/imageKey|hidden\.png/);
  });
  it("404 for another tenant's product or an unknown id; 400 for a malformed id", async () => {
    expect((await h.request('GET', '/api/products/' + otherId, a, a.owner)).statusCode).toBe(404);
    expect((await h.request('GET', '/api/products/' + randomUUID(), a, a.owner)).statusCode).toBe(404);
    expect((await h.request('GET', '/api/products/nope', a, a.owner)).statusCode).toBe(400);
    expect((await h.request('PATCH', '/api/products/' + otherId, a, a.owner, { nameAr: 'x' })).statusCode).toBe(404);
  });
});

describe('editing a product', () => {
  let dairy: string, milk: string, bakery: string, bread: string, otherCategory: string;
  async function fresh(over: Partial<Seed> = {}) {
    const barcode = nextBarcode();
    return (await seed(a, [{ barcode, nameEn: 'Edit ' + barcode, status: 'new', ...over }]))[barcode]!;
  }
  const patch = (id: string, body: Record<string, unknown>, who: Session = manager) => h.request('PATCH', '/api/products/' + id, a, who, body);
  beforeAll(async () => {
    dairy = await category(a, { nameEn: 'Edit Dairy' });
    milk = await category(a, { nameEn: 'Edit Milk', parentId: dairy });
    bakery = await category(a, { nameEn: 'Edit Bakery' });
    bread = await category(a, { nameEn: 'Edit Bread', parentId: bakery });
    otherCategory = await category(b, { nameEn: 'Beta category' });
  });

  it('Analyst can read but not edit', async () => {
    const id = await fresh();
    expect((await h.request('GET', '/api/products/' + id, a, analyst)).statusCode).toBe(200);
    expect((await patch(id, { nameAr: 'حليب' }, analyst)).statusCode).toBe(403);
  });
  it('sets a trimmed Arabic name and clears it with an empty string', async () => {
    const id = await fresh();
    const r = await patch(id, { nameAr: '  حليب طازج  ' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.nameAr).toBe('حليب طازج');
    expect((await patch(id, { nameAr: '' })).json().data.nameAr).toBeNull();
  });
  it.each([
    [{ nameAr: 'x'.repeat(201) }, 'an Arabic name over 200 characters'],
    [{ nameEn: 'ERP owned' }, 'an ERP-owned field'],
    [{ status: 'new' }, 'status back to new'],
    [{ status: 'deleted' }, 'an unknown status'],
    [{ categoryId: 'nope' }, 'a malformed category id'],
    [{ expectedUpdatedAt: 'yesterday' }, 'a malformed timestamp'],
  ])('rejects %j (%s)', async body => {
    expect((await patch(await fresh(), body)).statusCode).toBe(400);
  });
  it('accepts only a top-level category of this tenant', async () => {
    const id = await fresh();
    expect((await patch(id, { categoryId: milk })).statusCode).toBe(400);
    expect((await patch(id, { categoryId: otherCategory })).statusCode).toBe(400);
    expect((await patch(id, { categoryId: randomUUID() })).statusCode).toBe(400);
    expect((await patch(id, { categoryId: dairy })).json().data.categoryId).toBe(dairy);
  });
  it('accepts a subcategory only under the chosen category', async () => {
    const id = await fresh();
    expect((await patch(id, { subcategoryId: milk })).statusCode).toBe(400); // no category yet
    expect((await patch(id, { categoryId: dairy, subcategoryId: bread })).statusCode).toBe(400);
    expect((await patch(id, { categoryId: dairy, subcategoryId: dairy })).statusCode).toBe(400); // a top-level one is no subcategory
    const ok = await patch(id, { categoryId: dairy, subcategoryId: milk });
    expect(ok.json().data).toMatchObject({ categoryId: dairy, subcategoryId: milk, subcategory: { nameEn: 'Edit Milk' } });
    expect((await patch(id, { subcategoryId: bread })).statusCode).toBe(400);
  });
  it('a new category drops the old subcategory; null clears both', async () => {
    const id = await fresh({ categoryId: dairy, subcategoryId: milk });
    expect((await patch(id, { categoryId: bakery })).json().data).toMatchObject({ categoryId: bakery, subcategoryId: null });
    expect((await patch(id, { subcategoryId: bread })).json().data.subcategoryId).toBe(bread);
    expect((await patch(id, { subcategoryId: null })).json().data).toMatchObject({ categoryId: bakery, subcategoryId: null });
    await patch(id, { subcategoryId: bread });
    expect((await patch(id, { categoryId: null })).json().data).toMatchObject({ categoryId: null, subcategoryId: null });
  });
  it('activates only a ready product; deactivating needs no readiness', async () => {
    const id = await fresh();
    const notReady = await patch(id, { status: 'active' });
    expect(notReady.statusCode).toBe(400);
    expect(notReady.json().error.details).toEqual([{ path: 'nameAr', message: 'Arabic name missing' }, { path: 'category', message: 'Category missing' }]);
    const ok = await patch(id, { nameAr: 'حليب', categoryId: dairy, status: 'active' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.status).toBe('active');
    expect((await patch(id, { status: 'inactive' })).json().data.status).toBe('inactive');
    expect((await patch(id, { status: 'active' })).json().data.status).toBe('active');
  });
  it('setting active needs products.activate on top of products.edit', async () => {
    const id = await fresh({ nameAr: 'حليب', categoryId: dairy });
    const perms = ROLE_PERMISSIONS.catalogue_manager;
    perms.splice(perms.indexOf('products.activate'), 1);
    try {
      expect((await patch(id, { status: 'active' })).statusCode).toBe(403);
      expect((await patch(id, { status: 'inactive' })).statusCode).toBe(200);
    } finally { perms.push('products.activate'); }
    expect((await patch(id, { status: 'active' })).statusCode).toBe(200);
  });
  it('409 when expectedUpdatedAt is not the current version', async () => {
    const id = await fresh();
    const seen = (await h.request('GET', '/api/products/' + id, a, manager)).json().data.updatedAt;
    const first = await patch(id, { nameAr: 'أ', expectedUpdatedAt: seen });
    expect(first.statusCode).toBe(200);
    expect((await patch(id, { nameAr: 'ب', expectedUpdatedAt: seen })).statusCode).toBe(409);
    expect((await patch(id, { nameAr: 'ب', expectedUpdatedAt: first.json().data.updatedAt })).statusCode).toBe(200);
  });
  it('writes one audit event per changed field and none for an unchanged one', async () => {
    const id = await fresh({ nameAr: 'قديم' });
    await patch(id, { nameAr: 'قديم', categoryId: dairy, subcategoryId: milk });
    const changed = await events(a, 'product.field_changed', id);
    expect(changed.map(e => e.details)).toEqual([
      { field: 'categoryId', old: null, new: dairy },
      { field: 'subcategoryId', old: null, new: milk },
    ]);
    expect(changed.every(e => e.actorId && e.requestId)).toBe(true);
    await patch(id, { nameAr: 'قديم' });
    expect(await events(a, 'product.field_changed', id)).toHaveLength(2);
  });
});

describe('categories', () => {
  const post = (body: Record<string, unknown>, who: Session = manager, store = a) => h.request('POST', '/api/categories', store, who, body);
  it('builds a two-level tree, unique names among siblings ignoring case', async () => {
    const s = await h.createOwner('tree');
    const frozen = await category(s, { nameEn: 'Frozen', sort: 2 });
    const drinks = await category(s, { nameEn: 'Drinks', nameAr: 'مشروبات', sort: 1 });
    const juice = await category(s, { nameEn: 'Juice', parentId: drinks });
    expect((await h.request('POST', '/api/categories', s, s.owner, { nameEn: ' drinks ' })).statusCode).toBe(409);
    expect((await h.request('POST', '/api/categories', s, s.owner, { nameEn: 'JUICE', parentId: drinks })).statusCode).toBe(409);
    expect((await h.request('POST', '/api/categories', s, s.owner, { nameEn: 'Juice', parentId: frozen })).statusCode).toBe(200); // other parent
    expect((await h.request('POST', '/api/categories', s, s.owner, { nameEn: 'Too deep', parentId: juice })).statusCode).toBe(400);
    expect((await h.request('POST', '/api/categories', s, s.owner, { nameEn: '' })).statusCode).toBe(400);
    const barcode = nextBarcode();
    await seed(s, [{ barcode, nameEn: 'OJ', categoryId: drinks, subcategoryId: juice }]);
    const tree = (await h.request('GET', '/api/categories', s, s.owner)).json().data;
    expect(tree.map((c: { nameEn: string }) => c.nameEn)).toEqual(['Drinks', 'Frozen']);
    expect(tree[0]).toMatchObject({ id: drinks, nameAr: 'مشروبات', sort: 1, productCount: 1, children: [{ id: juice, nameEn: 'Juice', parentId: drinks, productCount: 1 }] });
    expect(tree[1]).toMatchObject({ productCount: 0, children: [{ nameEn: 'Juice' }] });
  });
  it('edits names, sort and level with the same rules', async () => {
    const top = await category(a, { nameEn: 'Cat Top' });
    const other = await category(a, { nameEn: 'Cat Other' });
    const child = await category(a, { nameEn: 'Cat Child', parentId: top });
    const url = (id: string) => '/api/categories/' + id;
    expect((await h.request('PATCH', url(other), a, manager, { nameEn: 'cat top' })).statusCode).toBe(409);
    expect((await h.request('PATCH', url(other), a, manager, {})).statusCode).toBe(400);
    expect((await h.request('PATCH', url(other), a, manager, { nameEn: 'Cat Other 2', nameAr: 'فئة', sort: 5 })).json().data).toMatchObject({ nameEn: 'Cat Other 2', nameAr: 'فئة', sort: 5 });
    expect((await h.request('PATCH', url(top), a, manager, { parentId: other })).statusCode).toBe(400); // has children
    expect((await h.request('PATCH', url(other), a, manager, { parentId: other })).statusCode).toBe(400);
    expect((await h.request('PATCH', url(other), a, manager, { parentId: child })).statusCode).toBe(400); // too deep
    expect((await h.request('PATCH', url(child), a, manager, { parentId: other })).json().data.parentId).toBe(other);
    expect((await h.request('PATCH', url(child), a, manager, { parentId: null })).json().data.parentId).toBeNull();
    const barcode = nextBarcode();
    await seed(a, [{ barcode, nameEn: 'Uses child', categoryId: child }]);
    const moved = await h.request('PATCH', url(child), a, manager, { parentId: other });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.details).toEqual([{ path: 'products', count: 1 }]);
    expect((await events(a, 'category.updated', other)).at(-1)?.details).toEqual({ fields: ['nameEn', 'nameAr', 'sort'] });
  });
  it('refuses to delete a category that products or subcategories use, with counts', async () => {
    const top = await category(a, { nameEn: 'Del Top' });
    const child = await category(a, { nameEn: 'Del Child', parentId: top });
    const barcode = nextBarcode();
    const pid = (await seed(a, [{ barcode, nameEn: 'Del product', categoryId: top, subcategoryId: child }]))[barcode]!;
    const r = await h.request('DELETE', '/api/categories/' + top, a, manager);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details).toEqual([{ path: 'products', count: 1 }, { path: 'children', count: 1 }]);
    expect((await h.request('DELETE', '/api/categories/' + child, a, manager)).json().error.details).toEqual([{ path: 'products', count: 1 }]);
    await h.request('PATCH', '/api/products/' + pid, a, manager, { categoryId: null });
    expect((await h.request('DELETE', '/api/categories/' + child, a, manager)).statusCode).toBe(200);
    expect((await h.request('DELETE', '/api/categories/' + top, a, manager)).statusCode).toBe(200);
    expect(await h.fixture.prisma.category.count({ where: { id: { in: [top, child] } } })).toBe(0);
    expect(await events(a, 'category.deleted', top)).toHaveLength(1);
  });
  it("Analyst can read the tree but not change it; another tenant's category is 404", async () => {
    const top = await category(a, { nameEn: 'Role test' });
    const foreign = await category(b, { nameEn: 'Beta only' });
    expect((await h.request('GET', '/api/categories', a, analyst)).statusCode).toBe(200);
    expect((await post({ nameEn: 'Nope' }, analyst)).statusCode).toBe(403);
    expect((await h.request('PATCH', '/api/categories/' + top, a, analyst, { nameEn: 'x' })).statusCode).toBe(403);
    expect((await h.request('DELETE', '/api/categories/' + top, a, analyst)).statusCode).toBe(403);
    expect((await h.request('GET', '/api/categories/erp-suggestions', a, analyst)).statusCode).toBe(403);
    expect((await h.request('POST', `/api/categories/${top}/assign-from-erp`, a, analyst, { erpCategories: ['x'] })).statusCode).toBe(403);
    expect((await h.request('PATCH', '/api/categories/' + foreign, a, manager, { nameEn: 'x' })).statusCode).toBe(404);
    expect((await h.request('DELETE', '/api/categories/' + foreign, a, manager)).statusCode).toBe(404);
    expect((await h.request('POST', `/api/categories/${foreign}/assign-from-erp`, a, manager, { erpCategories: ['x'] })).statusCode).toBe(404);
    expect((await post({ nameEn: 'Child of foreign', parentId: foreign })).statusCode).toBe(400);
    expect(((await h.request('GET', '/api/categories', a, manager)).json().data as { id: string }[]).some(c => c.id === foreign)).toBe(false);
  });
});

describe('ERP category suggestions and assignment', () => {
  let s: Store, m: Session, ids: Record<string, string>, dairy: string;
  beforeAll(async () => {
    s = await h.createOwner('erpcats');
    m = await h.member(s, 'catalogue_manager');
    dairy = await category(s, { nameEn: 'Dairy' });
    ids = await seed(s, [
      { barcode: '6201', nameEn: 'A', erpCategory: 'DAIRY' }, { barcode: '6202', nameEn: 'B', erpCategory: ' DAIRY ' },
      { barcode: '6203', nameEn: 'C', erpCategory: 'DIARY' }, { barcode: '6204', nameEn: 'D', erpCategory: 'BAKERY' },
      { barcode: '6205', nameEn: 'E', erpCategory: '   ' }, { barcode: '6206', nameEn: 'F', erpCategory: null },
      { barcode: '6207', nameEn: 'G', erpCategory: 'DAIRY', categoryId: dairy },
    ]);
    await seed(b, [{ barcode: '6208', nameEn: 'Beta dairy', erpCategory: 'DAIRY' }]);
  });
  it('lists distinct trimmed ERP categories by count, without empty text', async () => {
    const r = await h.request('GET', '/api/categories/erp-suggestions', s, m);
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual([
      { erpCategory: 'DAIRY', products: 3, unassigned: 2 },
      { erpCategory: 'BAKERY', products: 1, unassigned: 1 },
      { erpCategory: 'DIARY', products: 1, unassigned: 1 },
    ]);
  });
  it('files uncategorised products by ERP category, leaving filed ones and other tenants alone', async () => {
    const other = await category(s, { nameEn: 'Other' });
    await h.request('PATCH', '/api/products/' + ids['6204'], s, m, { categoryId: other });
    const r = await h.request('POST', `/api/categories/${dairy}/assign-from-erp`, s, m, { erpCategories: ['DAIRY', 'DIARY', 'BAKERY', 'DAIRY'] });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual({ updated: 3 });
    const after = await h.fixture.prisma.product.findMany({ where: { tenantId: s.id }, select: { normalizedBarcode: true, categoryId: true } });
    expect(Object.fromEntries(after.map(p => [p.normalizedBarcode, p.categoryId]))).toEqual({
      6201: dairy, 6202: dairy, 6203: dairy, 6204: other, 6205: null, 6206: null, 6207: dairy,
    });
    expect((await h.fixture.prisma.product.findFirstOrThrow({ where: { tenantId: b.id, normalizedBarcode: '6208' } })).categoryId).toBeNull();
    const audit = await events(s, 'category.assigned_from_erp', dairy);
    expect(audit.map(e => e.details)).toEqual([{ erpCategories: ['DAIRY', 'DIARY', 'BAKERY'], updated: 3 }]);
    expect((await h.request('POST', `/api/categories/${dairy}/assign-from-erp`, s, m, { erpCategories: ['DAIRY'] })).json().data).toEqual({ updated: 0 });
  });
  it('refuses a subcategory target and bad bodies', async () => {
    const sub = await category(s, { nameEn: 'Milk', parentId: dairy });
    expect((await h.request('POST', `/api/categories/${sub}/assign-from-erp`, s, m, { erpCategories: ['DAIRY'] })).statusCode).toBe(400);
    for (const body of [{ erpCategories: [] }, { erpCategories: Array.from({ length: 51 }, (_, i) => 'c' + i) }, { erpCategories: [' '] }, { erpCategories: ['x'], all: true }]) {
      expect((await h.request('POST', `/api/categories/${dairy}/assign-from-erp`, s, m, body)).statusCode).toBe(400);
    }
  });
});

describe('activating new products', () => {
  let s: Store, m: Session, an: Session, cat: string;
  const activate = (body: Record<string, unknown>, who: Session = m) => h.request('POST', '/api/products/activate', s, who, body);
  const status = async (id: string) => (await h.fixture.prisma.product.findUniqueOrThrow({ where: { id } })).status;
  beforeAll(async () => {
    s = await h.createOwner('activation');
    m = await h.member(s, 'catalogue_manager');
    an = await h.member(s, 'analyst');
    cat = await category(s, { nameEn: 'Ready' });
  });

  it('activates the ready ones among the given ids and says why the others were skipped', async () => {
    const ids = await seed(s, [
      { barcode: '7101', nameEn: 'Ready', status: 'new', nameAr: 'جاهز', categoryId: cat },
      { barcode: '7102', nameEn: 'No Arabic', status: 'new', categoryId: cat },
      { barcode: '7103', nameEn: 'No category', status: 'new', nameAr: 'فئة' },
      { barcode: '7104', nameEn: 'Already active', status: 'active', nameAr: 'نشط', categoryId: cat },
    ]);
    const foreign = Object.values(await seed(b, [{ barcode: nextBarcode(), nameEn: 'Beta new', status: 'new', nameAr: 'ب' }]))[0]!;
    const unknown = randomUUID();
    const r = await activate({ ids: [ids['7101'], ids['7102'], ids['7103'], ids['7104'], foreign, unknown, ids['7101']] });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual({
      activated: 1, skippedCount: 5,
      skipped: [
        { id: ids['7102'], reason: 'Arabic name missing' }, { id: ids['7103'], reason: 'Category missing' },
        { id: ids['7104'], reason: 'Not a new product' }, { id: foreign, reason: 'Not found' }, { id: unknown, reason: 'Not found' },
      ],
    });
    expect(await status(ids['7101']!)).toBe('active');
    expect(await status(ids['7102']!)).toBe('new');
    expect(await status(foreign)).toBe('new');
    expect((await events(s, 'product.field_changed', ids['7101'])).map(e => e.details)).toEqual([{ field: 'status', old: 'new', new: 'active' }]);
    const summary = await events(s, 'products.activated');
    expect(summary.map(e => e.details)).toEqual([{ mode: 'ids', activated: 1, skipped: 5 }]);
    expect(summary[0]!.actorId).toBeTruthy();
  });
  it('all: activates every ready new product and caps the skipped list at 200', async () => {
    await seed(s, [
      ...Array.from({ length: 30 }, (_, i) => ({ barcode: '72' + String(i).padStart(4, '0'), nameEn: 'Ready all ' + i, status: 'new', nameAr: 'ج', categoryId: cat })),
      ...Array.from({ length: 205 }, (_, i) => ({ barcode: '73' + String(i).padStart(4, '0'), nameEn: 'Not ready ' + i, status: 'new' })),
    ]);
    const before = await h.fixture.prisma.product.count({ where: { tenantId: s.id, status: 'new' } });
    const r = await activate({ all: true });
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.activated).toBe(30);
    expect(d.skippedCount).toBe(before - 30);
    expect(d.skipped).toHaveLength(200);
    expect(d.skipped.every((x: { reason: string }) => x.reason === 'Arabic name missing' || x.reason === 'Category missing')).toBe(true);
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id, status: 'new', nameAr: { not: null }, categoryId: { not: null } } })).toBe(0);
    expect(await h.fixture.prisma.product.count({ where: { tenantId: b.id, status: 'active' } })).toBe(0);
    expect((await events(s, 'products.activated')).at(-1)?.details).toEqual({ mode: 'all', activated: 30, skipped: before - 30 });
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'product.field_changed', details: { path: ['new'], equals: 'active' } } })).toBe(31);
  });
  it('needs products.activate and a strict body', async () => {
    expect((await activate({ all: true }, an)).statusCode).toBe(403);
    for (const body of [{}, { all: false }, { ids: [] }, { ids: ['nope'] }, { ids: Array.from({ length: 501 }, randomUUID) }, { ids: [randomUUID()], all: true }]) {
      expect((await activate(body)).statusCode).toBe(400);
    }
  });
});

describe('OpenAPI', () => {
  it('documents every products and categories route', () => {
    const paths = h.api.spec.paths;
    expect(paths['/api/products']?.get).toBeDefined();
    expect(paths['/api/products/{id}']?.get).toBeDefined();
    expect(paths['/api/products/{id}']?.patch?.requestBody).toBeDefined();
    expect(paths['/api/products/activate']?.post?.requestBody).toBeDefined();
    expect(paths['/api/categories']?.get).toBeDefined();
    expect(paths['/api/categories']?.post?.requestBody).toBeDefined();
    expect(paths['/api/categories/{id}']?.patch).toBeDefined();
    expect(paths['/api/categories/{id}']?.delete).toBeDefined();
    expect(paths['/api/categories/erp-suggestions']?.get).toBeDefined();
    expect(paths['/api/categories/{id}/assign-from-erp']?.post?.requestBody).toBeDefined();
    const params = (paths['/api/products']!.get!.parameters ?? []) as { name: string }[];
    expect(params.map(p => p.name).sort()).toEqual(['categoryId', 'cursor', 'limit', 'q', 'subcategoryId', 'tab']);
    expect(paths['/api/products/{id}']!.patch!.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'X-CSRF-Token' })]));
  });
});
