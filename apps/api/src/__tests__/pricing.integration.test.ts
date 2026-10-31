import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createHarness, type Harness, type Session, type Store } from './harness.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session, analyst: Session;
let dairy: string, milk: string, laban: string, bakery: string, otherDairySub: string;
const ids: Record<string, string> = {};

let serial = 0;
async function product(store: Store, nameEn: string, data: { erpPrice?: number; categoryId?: string | null; subcategoryId?: string | null; costPrice?: number } = {}) {
  const barcode = String(6_288_000_000_000 + ++serial);
  const p = await h.fixture.prisma.product.create({ data: { erpPrice: 10, erpStock: 1, ...data, nameEn, barcode, normalizedBarcode: barcode, tenantId: store.id } });
  return p.id;
}
async function category(store: Store, body: Record<string, unknown>) {
  const r = await h.request('POST', '/api/categories', store, store.owner, body);
  expect(r.statusCode).toBe(200);
  return r.json().data.id as string;
}
const events = (store: Store, action: string) =>
  h.fixture.prisma.auditEvent.findMany({ where: { tenantId: store.id, action }, orderBy: { createdAt: 'asc' } });
const put = (url: string, who: Session, body: Record<string, unknown>, store = a) => h.request('PUT', url, store, who, body);
const del = (url: string, who: Session, store = a) => h.request('DELETE', url, store, who);
const get = (url: string, who: Session, store = a) => h.request('GET', url, store, who);
/** Recon calls made by `fn` (the recording double collects every call). */
async function reconCalls(fn: () => Promise<unknown>) {
  const before = h.recon.calls.length;
  await fn();
  return h.recon.calls.slice(before);
}
const listed = async (who: Session, store = a) =>
  Object.fromEntries(((await get('/api/products?limit=200', who, store)).json().data.items as { nameEn: string; marketplacePrice: unknown }[]).map(i => [i.nameEn, i.marketplacePrice]));

beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('pricing-a');
  b = await h.createOwner('pricing-b');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
  dairy = await category(a, { nameEn: 'Dairy' });
  milk = await category(a, { nameEn: 'Milk', parentId: dairy });
  laban = await category(a, { nameEn: 'Laban', parentId: dairy });
  bakery = await category(a, { nameEn: 'Bakery' });
  const juice = await category(a, { nameEn: 'Juice' });
  otherDairySub = await category(a, { nameEn: 'Fresh', parentId: juice });
  ids.offer = await product(a, 'A offer', { categoryId: dairy, subcategoryId: milk });
  ids.product = await product(a, 'B product rule', { categoryId: dairy, subcategoryId: milk });
  ids.sub = await product(a, 'C subcategory', { categoryId: dairy, subcategoryId: milk });
  ids.cat = await product(a, 'D category', { categoryId: dairy, subcategoryId: laban });
  ids.def = await product(a, 'E default', { categoryId: bakery, costPrice: 4 });
  ids.expired = await product(a, 'F expired offer', { erpPrice: 5.5 });
  ids.future = await product(a, 'G future offer', { erpPrice: 5.5 });
  ids.other = await product(b, 'Other tenant');
});
afterAll(async () => { await h.close(); });

describe('pricing settings', () => {
  it('starts from the defaults (same price, exact) and shows the rule order', async () => {
    const r = await get('/api/pricing/settings', analyst);
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({
      defaultRule: { mode: 'same' }, rounding: 'exact', perMarketplaceEnabled: false, compareReferenceDefault: 'marketplace', marketplaceRules: [],
      order: ['offer', 'product', 'subcategory', 'category', 'marketplace', 'default'],
    });
  });

  it('an analyst can read but not change pricing', async () => {
    expect((await put('/api/pricing/settings', analyst, { rounding: '0.25' })).statusCode).toBe(403);
    expect((await put('/api/pricing/category-rules', analyst, { categoryId: dairy, mode: 'percent', value: 5 })).statusCode).toBe(403);
    expect((await put(`/api/products/${ids.def}/price-rule`, analyst, { mode: 'fixed', value: 3 })).statusCode).toBe(403);
    expect((await put(`/api/products/${ids.def}/offer`, analyst, { price: 3 })).statusCode).toBe(403);
    expect((await del(`/api/products/${ids.def}/offer`, analyst)).statusCode).toBe(403);
    expect((await get('/api/pricing/category-rules', analyst)).statusCode).toBe(200);
  });

  it('writes one audit event per changed field and asks for a recon recompute', async () => {
    const calls = await reconCalls(async () => {
      const r = await put('/api/pricing/settings', manager, { defaultRule: { mode: 'percent', value: 10 }, rounding: '0.25', compareReferenceDefault: 'marketplace' });
      expect(r.statusCode).toBe(200);
      expect(r.json().data).toMatchObject({ defaultRule: { mode: 'percent', value: 10 }, rounding: '0.25', compareReferenceDefault: 'marketplace' });
    });
    expect(calls).toEqual([{ tenantId: a.id, reason: 'pricing.settings' }]);
    const changed = await events(a, 'pricing.settings_changed');
    // compareReferenceDefault was sent unchanged: no event for it
    expect(changed.map(e => e.details)).toEqual([
      { field: 'defaultRule', old: { mode: 'same' }, new: { mode: 'percent', value: 10 } },
      { field: 'rounding', old: 'exact', new: '0.25' },
    ]);
  });

  it('an unchanged value writes nothing and enqueues nothing', async () => {
    const before = (await events(a, 'pricing.settings_changed')).length;
    const calls = await reconCalls(async () => expect((await put('/api/pricing/settings', manager, { rounding: '0.25' })).statusCode).toBe(200));
    expect(calls).toEqual([]);
    expect(await events(a, 'pricing.settings_changed')).toHaveLength(before);
  });

  it('sets, changes and removes per-marketplace rules with an event each', async () => {
    let r = await put('/api/pricing/settings', manager, {
      perMarketplaceEnabled: true,
      marketplaceRules: [{ marketplaceId: 'talabat', mode: 'percent', value: 15, rounding: '0.25' }, { marketplaceId: 'snoonu', mode: 'same', rounding: 'exact' }],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.marketplaceRules).toEqual([
      { marketplaceId: 'snoonu', mode: 'same', rounding: 'exact' }, { marketplaceId: 'talabat', mode: 'percent', value: 15, rounding: '0.25' },
    ]);
    r = await put('/api/pricing/settings', manager, { marketplaceRules: [{ marketplaceId: 'talabat', mode: 'amount', value: 1, rounding: 'exact' }] });
    expect(r.json().data.marketplaceRules).toEqual([{ marketplaceId: 'talabat', mode: 'amount', value: 1, rounding: 'exact' }]);
    expect((await events(a, 'pricing.marketplace_rule_set')).map(e => e.details)).toEqual([
      { marketplaceId: 'talabat', old: null, new: { mode: 'percent', value: 15, rounding: '0.25' } },
      { marketplaceId: 'snoonu', old: null, new: { mode: 'same', rounding: 'exact' } },
      { marketplaceId: 'talabat', old: { mode: 'percent', value: 15, rounding: '0.25' }, new: { mode: 'amount', value: 1, rounding: 'exact' } },
    ]);
    expect((await events(a, 'pricing.marketplace_rule_deleted')).map(e => e.details)).toEqual([{ marketplaceId: 'snoonu', old: { mode: 'same', rounding: 'exact' } }]);
  });

  it('keeps settings per tenant', async () => {
    expect((await get('/api/pricing/settings', b.owner, b)).json().data).toMatchObject({ defaultRule: { mode: 'same' }, rounding: 'exact', marketplaceRules: [] });
  });

  it.each([
    ['percent below -90', { defaultRule: { mode: 'percent', value: -91 } }],
    ['percent above 1000', { defaultRule: { mode: 'percent', value: 1000.5 } }],
    ['amount below -100000', { defaultRule: { mode: 'amount', value: -100001 } }],
    ['amount above 100000', { defaultRule: { mode: 'amount', value: 100000.001 } }],
    ['fixed of 0', { defaultRule: { mode: 'fixed', value: 0 } }],
    ['fixed of 1,000,000,000', { defaultRule: { mode: 'fixed', value: 1_000_000_000 } }],
    ['same with a value', { defaultRule: { mode: 'same', value: 0 } }],
    ['an unknown mode', { defaultRule: { mode: 'double', value: 2 } }],
    ['more than 3 decimals', { defaultRule: { mode: 'amount', value: 1.0001 } }],
    ['a rounding not in the list', { rounding: '0.10' }],
    ['an unknown reference', { compareReferenceDefault: 'cost' }],
    ['an unknown marketplace', { marketplaceRules: [{ marketplaceId: 'amazon', mode: 'same', rounding: 'exact' }] }],
    ['the same marketplace twice', { marketplaceRules: [{ marketplaceId: 'keeta', mode: 'same', rounding: 'exact' }, { marketplaceId: 'keeta', mode: 'same', rounding: 'exact' }] }],
    ['an unknown field', { rounding: 'exact', tenantId: randomUUID() }],
    ['nothing', {}],
  ])('refuses %s', async (_label, body) => {
    const r = await put('/api/pricing/settings', manager, body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts the limits themselves', async () => {
    for (const defaultRule of [{ mode: 'percent', value: -90 }, { mode: 'percent', value: 1000 }, { mode: 'amount', value: -100000 }, { mode: 'amount', value: 100000 },
      { mode: 'fixed', value: 999_999_999.999 }, { mode: 'fixed', value: 0.001 }]) {
      expect((await put('/api/pricing/settings', b.owner, { defaultRule }, b)).statusCode).toBe(200);
    }
  });
});

describe('category rules', () => {
  it('sets a category rule and a subcategory rule; lists them with names', async () => {
    const calls = await reconCalls(async () => {
      expect((await put('/api/pricing/category-rules', manager, { categoryId: dairy, mode: 'percent', value: 8 })).statusCode).toBe(200);
      expect((await put('/api/pricing/category-rules', manager, { categoryId: dairy, subcategoryId: milk, mode: 'amount', value: 2 })).statusCode).toBe(200);
    });
    expect(calls.map(c => c.reason)).toEqual(['pricing.category_rule', 'pricing.category_rule']);
    const r = await get('/api/pricing/category-rules', analyst);
    expect(r.json().data).toHaveLength(2);
    expect(r.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ categoryId: dairy, subcategoryId: null, mode: 'percent', value: 8, category: expect.objectContaining({ nameEn: 'Dairy' }), subcategory: null }),
      expect.objectContaining({ categoryId: dairy, subcategoryId: milk, mode: 'amount', value: 2, subcategory: expect.objectContaining({ nameEn: 'Milk' }) }),
    ]));
  });

  it('updates in place (no second category-level row) and audits old and new', async () => {
    expect((await put('/api/pricing/category-rules', manager, { categoryId: dairy, mode: 'percent', value: 9 })).statusCode).toBe(200);
    expect((await put('/api/pricing/category-rules', manager, { categoryId: dairy, subcategoryId: null, mode: 'percent', value: 8 })).statusCode).toBe(200);
    expect(await h.fixture.prisma.categoryPriceRule.count({ where: { tenantId: a.id, categoryId: dairy, subcategoryId: null } })).toBe(1);
    const set = await events(a, 'pricing.category_rule_set');
    expect(set.at(-1)).toMatchObject({ entityId: dairy, details: { categoryId: dairy, subcategoryId: null, old: { mode: 'percent', value: 9 }, new: { mode: 'percent', value: 8 } } });
  });

  it('refuses a subcategory that does not belong to the category, a subcategory as category, and unknown ids', async () => {
    for (const body of [
      { categoryId: dairy, subcategoryId: otherDairySub, mode: 'same' },
      { categoryId: milk, mode: 'same' },
      { categoryId: dairy, subcategoryId: bakery, mode: 'same' },
      { categoryId: randomUUID(), mode: 'same' },
    ]) {
      expect((await put('/api/pricing/category-rules', manager, body)).statusCode).toBe(400);
    }
    // another tenant's category is not found
    expect((await put('/api/pricing/category-rules', b.owner, { categoryId: dairy, mode: 'same' }, b)).statusCode).toBe(400);
    expect((await put('/api/pricing/category-rules', manager, { categoryId: 'not-a-uuid', mode: 'same' })).statusCode).toBe(400);
  });

  it('a category with a rule cannot be deleted', async () => {
    expect((await h.request('DELETE', '/api/categories/' + dairy, a, a.owner)).statusCode).toBe(409);
  });

  it('deletes a rule (404 when there is none); another tenant cannot see or delete it', async () => {
    expect((await put('/api/pricing/category-rules', manager, { categoryId: bakery, mode: 'fixed', value: 3 })).statusCode).toBe(200);
    expect((await get('/api/pricing/category-rules', b.owner, b)).json().data).toEqual([]);
    expect((await del(`/api/pricing/category-rules?categoryId=${bakery}`, b.owner, b)).statusCode).toBe(404);
    const calls = await reconCalls(async () => expect((await del(`/api/pricing/category-rules?categoryId=${bakery}`, manager)).statusCode).toBe(200));
    expect(calls).toEqual([{ tenantId: a.id, reason: 'pricing.category_rule' }]);
    expect((await del(`/api/pricing/category-rules?categoryId=${bakery}`, manager)).statusCode).toBe(404);
    expect((await events(a, 'pricing.category_rule_deleted')).at(-1)).toMatchObject({ entityId: bakery, details: { old: { mode: 'fixed', value: 3 } } });
  });
});

describe('product rule and offer', () => {
  it('sets the product rule, audits it, enqueues recon and returns the explained price', async () => {
    const calls = await reconCalls(async () => {
      const r = await put(`/api/products/${ids.product}/price-rule`, manager, { mode: 'fixed', value: 17.5 });
      expect(r.statusCode).toBe(200);
      expect(r.json().data.marketplacePrice).toEqual({ price: 17.5, source: 'product' });
      expect(r.json().data.pricing.productRule).toMatchObject({ mode: 'fixed', value: 17.5 });
    });
    expect(calls).toEqual([{ tenantId: a.id, reason: 'product.price_rule' }]);
    expect((await events(a, 'product.price_rule_set')).at(-1)).toMatchObject({ entityId: ids.product, details: { old: null, new: { mode: 'fixed', value: 17.5 } } });
  });

  it('sets an offer with dates and replaces it on a second PUT', async () => {
    expect((await put(`/api/products/${ids.offer}/offer`, manager, { price: 7.37 })).statusCode).toBe(200);
    expect((await put(`/api/products/${ids.offer}/price-rule`, manager, { mode: 'fixed', value: 30 })).statusCode).toBe(200);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const calls = await reconCalls(async () => {
      const r = await put(`/api/products/${ids.offer}/offer`, manager, { price: 6.123, validFrom: null, validUntil: until });
      expect(r.statusCode).toBe(200);
      expect(r.json().data.marketplacePrice).toEqual({ price: 6.123, source: 'offer' });
      expect(r.json().data.pricing.offer).toMatchObject({ price: 6.123, state: 'valid' });
    });
    expect(calls.map(c => c.reason)).toEqual(['product.offer']);
    expect(await h.fixture.prisma.productOffer.count({ where: { tenantId: a.id, productId: ids.offer } })).toBe(1);
    expect((await events(a, 'product.offer_set')).at(-1)).toMatchObject({
      entityId: ids.offer, details: { old: { price: 7.37, validFrom: null, validUntil: null }, new: { price: 6.123, validUntil: until } },
    });
  });

  it('keeps a future offer waiting: the next rule applies until it starts', async () => {
    const from = new Date(Date.now() + 3_600_000).toISOString();
    const r = await put(`/api/products/${ids.future}/offer`, manager, { price: 1, validFrom: from });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.marketplacePrice.source).toBe('default');
    expect(r.json().data.pricing.chain[0]).toMatchObject({ source: 'offer', status: 'scheduled' });
  });

  it.each([
    ['a price of 0', { price: 0 }],
    ['a negative price', { price: -1 }],
    ['a price of 1,000,000,000', { price: 1_000_000_000 }],
    ['more than 3 decimals', { price: 1.2345 }],
    ['validUntil before validFrom', { price: 1, validFrom: '2030-01-02T00:00:00Z', validUntil: '2030-01-01T00:00:00Z' }],
    ['an offer that has already ended', { price: 1, validUntil: '2020-01-01T00:00:00Z' }],
    ['a date without a zone', { price: 1, validFrom: '2030-01-01' }],
    ['an unknown field', { price: 1, discount: 5 }],
  ])('refuses an offer with %s', async (_label, body) => {
    expect((await put(`/api/products/${ids.def}/offer`, manager, body)).statusCode).toBe(400);
  });

  it('refuses rule values beyond the limits on a product', async () => {
    for (const body of [{ mode: 'percent', value: -90.5 }, { mode: 'fixed', value: 0 }, { mode: 'same', value: 1 }, { mode: 'amount' }]) {
      expect((await put(`/api/products/${ids.def}/price-rule`, manager, body)).statusCode).toBe(400);
    }
  });

  it("is tenant-scoped: another tenant's product is not found", async () => {
    expect((await put(`/api/products/${ids.other}/price-rule`, manager, { mode: 'fixed', value: 3 })).statusCode).toBe(404);
    expect((await put(`/api/products/${ids.other}/offer`, manager, { price: 3 })).statusCode).toBe(404);
    expect((await del(`/api/products/${ids.other}/offer`, manager)).statusCode).toBe(404);
    expect(await h.fixture.prisma.productPriceRule.count({ where: { productId: ids.other } })).toBe(0);
  });

  it('deletes the rule and the offer (404 the second time), each audited and enqueued', async () => {
    const tmp = await product(a, 'Z temporary', { categoryId: bakery });
    expect((await put(`/api/products/${tmp}/price-rule`, manager, { mode: 'amount', value: 1 })).statusCode).toBe(200);
    expect((await put(`/api/products/${tmp}/offer`, manager, { price: 2 })).statusCode).toBe(200);
    const calls = await reconCalls(async () => {
      expect((await del(`/api/products/${tmp}/offer`, manager)).json().data.marketplacePrice.source).toBe('product');
      expect((await del(`/api/products/${tmp}/price-rule`, manager)).json().data.marketplacePrice.source).toBe('default');
    });
    expect(calls.map(c => c.reason)).toEqual(['product.offer', 'product.price_rule']);
    expect((await del(`/api/products/${tmp}/offer`, manager)).statusCode).toBe(404);
    expect((await del(`/api/products/${tmp}/price-rule`, manager)).statusCode).toBe(404);
    expect((await events(a, 'product.offer_deleted')).at(-1)).toMatchObject({ entityId: tmp, details: { old: { price: 2 } } });
    expect((await events(a, 'product.price_rule_deleted')).at(-1)).toMatchObject({ entityId: tmp, details: { old: { mode: 'amount', value: 1 } } });
  });

  it('a new category on a product enqueues recon', async () => {
    const calls = await reconCalls(async () => expect((await h.request('PATCH', `/api/products/${ids.def}`, a, manager, { categoryId: bakery, subcategoryId: null })).statusCode).toBe(200));
    expect(calls).toEqual([]); // unchanged
    const moved = await reconCalls(async () => expect((await h.request('PATCH', `/api/products/${ids.cat}`, a, manager, { subcategoryId: laban, nameAr: 'لبن' })).statusCode).toBe(200));
    expect(moved).toEqual([]); // same subcategory, only the Arabic name changed
    const tmp = await product(a, 'Z move me');
    expect(await reconCalls(async () => h.request('PATCH', `/api/products/${tmp}`, a, manager, { categoryId: dairy }))).toEqual([{ tenantId: a.id, reason: 'product.category' }]);
  });
});

describe('resolved price on products', () => {
  beforeAll(async () => {
    // An offer that ended yesterday, written directly (the API refuses to create one).
    await h.fixture.prisma.productOffer.create({ data: { tenantId: a.id, productId: ids.expired, price: 1, validFrom: new Date(Date.now() - 172_800_000), validUntil: new Date(Date.now() - 86_400_000) } });
  });

  it('lists marketplacePrice {price, source} for every source in order', async () => {
    // default: percent 10, rounding 0.25; dairy 8%; milk +2; erp 10 unless set
    expect(await listed(analyst)).toMatchObject({
      'A offer': { price: 6.123, source: 'offer' },
      'B product rule': { price: 17.5, source: 'product' },
      'C subcategory': { price: 12, source: 'subcategory' },
      'D category': { price: 10.75, source: 'category' },
      'E default': { price: 11, source: 'default' },
      'F expired offer': { price: 6, source: 'default' }, // 5.5 x 1.1 = 6.05 -> 6.00 at 0.25
      'G future offer': { price: 6, source: 'default' },
    });
  });

  it('a subcategory rule beats its category rule; the other subcategory falls back to the category', async () => {
    const l = await listed(manager);
    expect(l['C subcategory']).toMatchObject({ source: 'subcategory' });
    expect(l['D category']).toMatchObject({ source: 'category' });
  });

  it('explains the price in the detail: the rule chain', async () => {
    const r = await get('/api/products/' + ids.sub, analyst);
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.marketplacePrice).toEqual({ price: 12, source: 'subcategory' });
    expect(d.pricing.order).toEqual(['offer', 'product', 'subcategory', 'category', 'marketplace', 'default']);
    expect(d.pricing.chain.map((s: { source: string; status: string }) => [s.source, s.status])).toEqual([
      ['offer', 'not_set'], ['product', 'not_set'], ['subcategory', 'applied'], ['category', 'overridden'], ['marketplace', 'not_set'], ['default', 'overridden'],
    ]);
    expect(d.pricing.chain[3]).toMatchObject({ price: 10.75, rule: { mode: 'percent', value: 8 }, rounding: '0.25' });
    // per-marketplace pricing is on with a talabat rule: below the subcategory rule, so it does not change this product
    expect(d.pricing.marketplaces).toEqual([{ marketplaceId: 'talabat', price: 12, source: 'subcategory' }]);
    expect(d).not.toHaveProperty('costPrice');
  });

  it('shows an expired offer as expired, with the price from the next step', async () => {
    const d = (await get('/api/products/' + ids.expired, manager)).json().data;
    expect(d.pricing.offer).toMatchObject({ price: 1, state: 'expired' });
    expect(d.pricing.chain[0]).toMatchObject({ source: 'offer', status: 'expired' });
    expect(d.pricing.marketplaces).toEqual([{ marketplaceId: 'talabat', price: 6.5, source: 'marketplace' }]); // 5.5 + 1 exact
    expect(d.marketplacePrice).toEqual({ price: 6, source: 'default' });
  });

  it('cost stays visible only to roles that may change prices', async () => {
    expect((await get('/api/products/' + ids.def, manager)).json().data.costPrice).toBe(4);
    expect((await get('/api/products/' + ids.def, analyst)).json().data).not.toHaveProperty('costPrice');
  });

  it("another tenant's prices use only its own rules", async () => {
    expect(await listed(b.owner, b)).toEqual({ 'Other tenant': { price: 0.001, source: 'default' } }); // b's last default: fixed 0.001
  });
});
