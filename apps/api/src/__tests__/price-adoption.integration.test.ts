import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session, analyst: Session;
let dairy: string, milk: string, bakery: string, otherTenantCategory: string;
const ids: Record<string, string> = {};
const barcodes: Record<string, string> = {};

let serial = 0;
async function product(store: Store, key: string, nameEn: string, erpPrice: number, data: { categoryId?: string; subcategoryId?: string } = {}) {
  const barcode = String(6_289_000_000_000 + ++serial);
  const p = await h.fixture.prisma.product.create({ data: { tenantId: store.id, nameEn, barcode, normalizedBarcode: barcode, erpPrice, erpStock: 5, status: 'active', ...data } });
  ids[key] = p.id;
  barcodes[key] = barcode;
  return p.id;
}
const listing = (store: Store, marketplaceId: string, key: string, price: number, marketplaceProductId = `${marketplaceId}-${key}`) =>
  h.fixture.prisma.listing.create({ data: { tenantId: store.id, marketplaceId, marketplaceProductId, productId: ids[key]!, barcodes: [barcodes[key]!], price, available: true } });
async function category(store: Store, body: Record<string, unknown>) {
  const r = await h.request('POST', '/api/categories', store, store.owner, body);
  expect(r.statusCode).toBe(200);
  return r.json().data.id as string;
}
const post = (path: string, who: Session, body: Record<string, unknown>, store = a) => h.request('POST', `/api/pricing/adopt/${path}`, store, who, body);
const preview = async (body: Record<string, unknown>, store = a, who = manager) => {
  const r = await post('preview', who, body, store);
  expect(r.statusCode).toBe(200);
  return r.json().data;
};
const apply = async (body: Record<string, unknown>, store = a, who = manager) => {
  const r = await post('apply', who, body, store);
  expect(r.statusCode).toBe(200);
  return r.json().data;
};
const events = (store: Store, action: string) => h.fixture.prisma.auditEvent.findMany({ where: { tenantId: store.id, action }, orderBy: { createdAt: 'asc' } });
const rules = async (store: Store) => Object.fromEntries((await h.fixture.prisma.productPriceRule.findMany({ where: { tenantId: store.id } }))
  .map(r => [Object.keys(ids).find(k => ids[k] === r.productId)!, { mode: r.mode, value: r.value.toNumber() }]));
async function reconCalls(fn: () => Promise<unknown>) {
  const before = h.recon.calls.length;
  await fn();
  await h.recon.drain();
  return h.recon.calls.slice(before);
}
const talabat = { sourceMarketplaceId: 'talabat', scope: { all: true } };

beforeAll(async () => {
  h = await createHarness();
  h.recon.handler = job => recomputeRecon({ database: h.fixture.database }, job);
  a = await h.createOwner('adopt-a');
  b = await h.createOwner('adopt-b');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
  dairy = await category(a, { nameEn: 'Dairy' });
  milk = await category(a, { nameEn: 'Milk', parentId: dairy });
  bakery = await category(a, { nameEn: 'Bakery' });
  otherTenantCategory = await category(b, { nameEn: 'Dairy B' });
  const prisma = h.fixture.prisma;
  // Default +10 %, prices rounded to 0.25: a percent rule can only reach listing prices on that step.
  await prisma.pricingSettings.create({ data: { tenantId: a.id, defaultRuleMode: 'percent', defaultRuleValue: 10, rounding: '0.25' } });

  await product(a, 'milk', 'Almarai Milk 1L', 4, { categoryId: dairy, subcategoryId: milk });
  await product(a, 'laban', 'Baladna Laban', 4, { categoryId: dairy });
  await product(a, 'bread', 'Bread Arabic', 2, { categoryId: bakery });
  await product(a, 'cheese', 'Cheese Slices', 10);
  await product(a, 'dates', 'Dates Khalas', 10);
  await product(a, 'eggs', 'Eggs 30', 3);
  await product(a, 'sample', 'Free Sample', 0);
  await product(b, 'other', 'Other tenant milk', 4, { categoryId: otherTenantCategory });

  // Two Talabat listings matched to the milk: the recon reconciles the one written last (5.75), and so does adoption.
  await listing(a, 'talabat', 'milk', 5.5, 'talabat-milk-old');
  await prisma.$executeRaw`UPDATE listings SET updated_at = now() - interval '1 day' WHERE marketplace_product_id = 'talabat-milk-old'`;
  await listing(a, 'talabat', 'milk', 5.75);
  await listing(a, 'talabat', 'laban', 5.1);
  await listing(a, 'talabat', 'bread', 2.5);
  await listing(a, 'talabat', 'cheese', 12);
  await listing(a, 'talabat', 'dates', 12);
  await listing(a, 'talabat', 'sample', 1);
  await listing(a, 'snoonu', 'milk', 5.75);
  await listing(a, 'snoonu', 'laban', 5.25);
  await listing(a, 'snoonu', 'eggs', 4);
  await listing(b, 'talabat', 'other', 6);
  await prisma.productPriceRule.create({ data: { tenantId: a.id, productId: ids.cheese!, mode: 'fixed', value: 11 } });
  await prisma.productOffer.create({ data: { tenantId: a.id, productId: ids.dates!, price: 9 } });
  for (const [store, source] of [[a, 'talabat'], [a, 'snoonu'], [b, 'talabat']] as const) {
    const owner = await prisma.user.findFirstOrThrow({ where: { tenantId: store.id } });
    await prisma.upload.create({ data: { tenantId: store.id, source, fileName: `${source}.xlsx`, size: 1, storageKey: `t/${source}`, uploadedById: owner.id, status: 'applied', appliedAt: new Date() } });
  }
});
afterAll(async () => { await h.close(); });

describe('adopt marketplace prices: access and contract', () => {
  it('needs pricing.edit and the CSRF token, like every other POST', async () => {
    for (const path of ['preview', 'apply']) {
      expect((await post(path, analyst, talabat)).statusCode).toBe(403);
      expect((await post(path, { ...manager, csrf: 'wrong' }, talabat)).statusCode).toBe(403);
      expect((await h.request('POST', `/api/pricing/adopt/${path}`, a, undefined, talabat)).statusCode).toBe(401);
    }
    expect(await h.fixture.prisma.productPriceRule.count({ where: { tenantId: a.id } })).toBe(1);
  });

  it('refuses a body outside the strict contract', async () => {
    const bad = [
      {}, { sourceMarketplaceId: 'talabat' }, { ...talabat, extra: 1 }, { ...talabat, sourceMarketplaceId: 'amazon' },
      { ...talabat, mode: 'amount' }, { ...talabat, onlyWithoutRule: 'yes' }, { ...talabat, scope: { all: false } },
      { ...talabat, scope: { all: true, categoryId: dairy } }, { ...talabat, scope: { categoryId: 'nope' } }, { ...talabat, scope: { subcategoryId: milk } },
    ];
    for (const body of bad) expect([JSON.stringify(body), (await post('preview', manager, body)).statusCode]).toEqual([JSON.stringify(body), 400]);
  });

  it('refuses a scope that is not a top-level category of this store with its own subcategory', async () => {
    for (const scope of [{ categoryId: milk }, { categoryId: bakery, subcategoryId: milk }, { categoryId: otherTenantCategory }]) {
      expect((await post('preview', manager, { ...talabat, scope })).statusCode).toBe(400);
    }
  });
});

describe('adopt marketplace prices: preview', () => {
  it('fixed (the default): counts, skips by reason, conflicts, the largest changes and the first rows; writes nothing', async () => {
    const calls = await reconCalls(async () => {
      const p = await preview(talabat);
      expect(p).toMatchObject({
        sourceMarketplaceId: 'talabat', mode: 'fixed', onlyWithoutRule: true, scope: { all: true },
        products: 7, willAdopt: 3, created: 3, replaced: 0, fixedFallback: 0,
        skipped: { no_listing: 1, non_positive_erp_price: 1, non_positive_listing_price: 0, has_rule: 1, has_offer: 1, offer_active: 0, unchanged: 0, unverifiable: 0 },
        conflicts: {
          products: 1, byMarketplace: { snoonu: 1 },
          examples: [{ productId: ids.laban, nameEn: 'Baladna Laban', barcode: barcodes.laban, marketplaceId: 'snoonu', sourcePrice: 5.1, otherPrice: 5.25 }],
        },
      });
      expect(p.rows).toEqual([
        { productId: ids.milk, nameEn: 'Almarai Milk 1L', barcode: barcodes.milk, erpPrice: 4, currentPrice: 4.5, currentSource: 'default', newPrice: 5.75, difference: 1.25, rule: { mode: 'fixed', value: 5.75 }, fallback: null, previousRule: null },
        { productId: ids.laban, nameEn: 'Baladna Laban', barcode: barcodes.laban, erpPrice: 4, currentPrice: 4.5, currentSource: 'default', newPrice: 5.1, difference: 0.6, rule: { mode: 'fixed', value: 5.1 }, fallback: null, previousRule: null },
        { productId: ids.bread, nameEn: 'Bread Arabic', barcode: barcodes.bread, erpPrice: 2, currentPrice: 2.25, currentSource: 'default', newPrice: 2.5, difference: 0.25, rule: { mode: 'fixed', value: 2.5 }, fallback: null, previousRule: null },
      ]);
      expect(p.largestDifferences.map((r: { nameEn: string }) => r.nameEn)).toEqual(['Almarai Milk 1L', 'Baladna Laban', 'Bread Arabic']);
    });
    expect(calls).toEqual([]);
    expect(await rules(a)).toEqual({ cheese: { mode: 'fixed', value: 11 } });
    expect(await events(a, 'pricing.prices_adopted')).toEqual([]);
  });

  it('percent: verified with the pricing engine; a price the 0.25 rounding cannot reach falls back to fixed', async () => {
    const p = await preview({ ...talabat, mode: 'percent' });
    expect(p).toMatchObject({ willAdopt: 3, fixedFallback: 1, fallbacks: { rounding: 1, range: 0 } });
    expect(p.rows.map((r: { nameEn: string; rule: unknown; fallback: unknown }) => [r.nameEn, r.rule, r.fallback])).toEqual([
      ['Almarai Milk 1L', { mode: 'percent', value: 43.75 }, null],
      ['Baladna Laban', { mode: 'fixed', value: 5.1 }, 'rounding'],
      ['Bread Arabic', { mode: 'percent', value: 25 }, null],
    ]);
  });

  it('scope: a category, or one of its subcategories', async () => {
    expect(await preview({ ...talabat, scope: { categoryId: dairy } })).toMatchObject({ products: 2, willAdopt: 2 });
    expect(await preview({ ...talabat, scope: { categoryId: dairy, subcategoryId: milk } })).toMatchObject({ products: 1, willAdopt: 1 });
    expect(await preview({ ...talabat, scope: { categoryId: bakery } })).toMatchObject({ products: 1, willAdopt: 1, conflicts: { products: 0 } });
  });

  it('another source marketplace adopts its own prices', async () => {
    const p = await preview({ sourceMarketplaceId: 'snoonu', scope: { all: true } });
    expect(p).toMatchObject({ willAdopt: 3, skipped: { no_listing: 4 }, conflicts: { products: 1, byMarketplace: { talabat: 1 } } });
    expect(p.rows.map((r: { nameEn: string; newPrice: number }) => [r.nameEn, r.newPrice])).toEqual([['Almarai Milk 1L', 5.75], ['Baladna Laban', 5.25], ['Eggs 30', 4]]);
  });
});

describe('adopt marketplace prices: apply', () => {
  it('writes the rules in one go, ONE summary event, no per-product events for new rules, and queues one recompute', async () => {
    const calls = await reconCalls(async () => {
      expect(await apply({ ...talabat, mode: 'percent' })).toEqual({
        products: 7, adopted: 3, created: 3, replaced: 0, fixedFallback: 1, fallbacks: { rounding: 1, range: 0 },
        skipped: { no_listing: 1, non_positive_erp_price: 1, non_positive_listing_price: 0, has_rule: 1, has_offer: 1, offer_active: 0, unchanged: 0, unverifiable: 0 },
        conflicts: { products: 1, byMarketplace: { snoonu: 1 } },
      });
    });
    expect(calls).toEqual([{ tenantId: a.id, reason: 'pricing.adopt' }]);
    expect(await rules(a)).toEqual({
      milk: { mode: 'percent', value: 43.75 }, laban: { mode: 'fixed', value: 5.1 }, bread: { mode: 'percent', value: 25 }, cheese: { mode: 'fixed', value: 11 },
    });
    const summary = await events(a, 'pricing.prices_adopted');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ entityId: null, details: { sourceMarketplaceId: 'talabat', mode: 'percent', onlyWithoutRule: true, adopted: 3, created: 3, replaced: 0 } });
    expect(await events(a, 'product.price_rule_set')).toEqual([]);

    // millisecond timestamps: the updatedAt a client reads back is the stored value
    const [{ truncated }] = await h.fixture.prisma.$queryRaw<{ truncated: boolean }[]>`
      SELECT bool_and(updated_at = date_trunc('milliseconds', updated_at) AND created_at = date_trunc('milliseconds', created_at)) AS truncated
      FROM product_price_rules WHERE tenant_id = ${a.id}::uuid`;
    expect(truncated).toBe(true);

    // the products now resolve to the Talabat price, and the recon (run by the queued job) agrees
    for (const [key, price] of [['milk', 5.75], ['laban', 5.1], ['bread', 2.5]] as const) {
      expect((await h.request('GET', `/api/products/${ids[key]}`, a, manager)).json().data.marketplacePrice).toEqual({ price, source: 'product' });
    }
    const recon = await h.fixture.prisma.reconRow.findMany({ where: { tenantId: a.id, marketplaceId: 'talabat' } });
    const mismatched = recon.filter(r => r.priceMismatchVsMarketplace).map(r => Object.keys(ids).find(k => ids[k] === r.productId)).sort();
    expect(mismatched).toEqual(['cheese', 'dates', 'sample']);
    const snoonu = await h.fixture.prisma.reconRow.findMany({ where: { tenantId: a.id, marketplaceId: 'snoonu', priceMismatchVsMarketplace: true } });
    expect(snoonu.map(r => Object.keys(ids).find(k => ids[k] === r.productId)).sort()).toEqual(['eggs', 'laban']);
  });

  it('is idempotent: a second run adopts 0, writes nothing and queues nothing', async () => {
    const before = await h.fixture.prisma.productPriceRule.findMany({ where: { tenantId: a.id }, orderBy: { productId: 'asc' } });
    const calls = await reconCalls(async () => {
      const r = await apply({ ...talabat, mode: 'percent' });
      expect(r).toMatchObject({ adopted: 0, skipped: { has_rule: 4, has_offer: 1 } });
    });
    expect(calls).toEqual([]);
    expect(await h.fixture.prisma.productPriceRule.findMany({ where: { tenantId: a.id }, orderBy: { productId: 'asc' } })).toEqual(before);
    expect(await events(a, 'pricing.prices_adopted')).toHaveLength(1);
  });

  it('onlyWithoutRule false: replaces a different rule (one product.price_rule_set event each), keeps equal ones, never beats a valid offer', async () => {
    const body = { ...talabat, mode: 'percent', onlyWithoutRule: false };
    const p = await preview(body);
    expect(p).toMatchObject({ willAdopt: 1, replaced: 1, skipped: { unchanged: 3, offer_active: 1, has_rule: 0, has_offer: 0 } });
    expect(p.rows).toEqual([expect.objectContaining({ nameEn: 'Cheese Slices', currentPrice: 11, currentSource: 'product', newPrice: 12, rule: { mode: 'percent', value: 20 }, previousRule: { mode: 'fixed', value: 11 } })]);
    const calls = await reconCalls(async () => expect(await apply(body)).toMatchObject({ adopted: 1, created: 0, replaced: 1 }));
    expect(calls).toHaveLength(1);
    expect((await rules(a)).cheese).toEqual({ mode: 'percent', value: 20 });
    expect(await h.fixture.prisma.productOffer.count({ where: { tenantId: a.id, productId: ids.dates! } })).toBe(1);
    const set = await events(a, 'product.price_rule_set');
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ entityId: ids.cheese, details: { old: { mode: 'fixed', value: 11 }, new: { mode: 'percent', value: 20 }, via: 'pricing.adopt' } });
    expect(await events(a, 'pricing.prices_adopted')).toHaveLength(2);
    expect(await apply(body)).toMatchObject({ adopted: 0 });
  });

  it('stays inside the tenant: the other store is untouched and adopts only its own listings', async () => {
    expect(await h.fixture.prisma.productPriceRule.count({ where: { tenantId: b.id } })).toBe(0);
    expect(await events(b, 'pricing.prices_adopted')).toEqual([]);
    const p = await preview(talabat, b, b.owner);
    expect(p).toMatchObject({ products: 1, willAdopt: 1, rows: [{ productId: ids.other, newPrice: 6 }] });
    expect(await apply(talabat, b, b.owner)).toMatchObject({ adopted: 1 });
    expect(await h.fixture.prisma.productPriceRule.count({ where: { tenantId: b.id } })).toBe(1);
    expect(await h.fixture.prisma.productPriceRule.count({ where: { tenantId: a.id } })).toBe(4);
  });
});
