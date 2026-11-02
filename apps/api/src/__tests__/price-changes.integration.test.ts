import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session, analyst: Session, managerB: Session;
let dairy: string;
const ids: Record<string, string> = {};

let serial = 0;
async function product(store: Store, key: string, nameEn: string, erpPrice: number, data: { categoryId?: string; status?: string } = {}) {
  const barcode = String(6_287_000_000_000 + ++serial);
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
const inline = (key: string, who: Session, body: Body, store = a) => h.request('PUT', `/api/pricing/products/${ids[key]}`, store, who, body);
const uninline = (key: string, who: Session, query: string, store = a) => h.request('DELETE', `/api/pricing/products/${ids[key]}?${query}`, store, who);
const bulk = (path: 'preview' | 'apply', who: Session, body: Body, store = a) => h.request('POST', `/api/pricing/bulk/${path}`, store, who, body);
async function preview(body: Body, who = manager, store = a) {
  const r = await bulk('preview', who, body, store);
  expect([r.statusCode, r.statusCode === 200 ? null : r.body]).toEqual([200, null]);
  return r.json().data;
}
async function apply(body: Body, who = manager, store = a) {
  const r = await bulk('apply', who, body, store);
  expect([r.statusCode, r.statusCode === 200 ? null : r.body]).toEqual([200, null]);
  return r.json().data;
}
const name = (id: string) => Object.keys(ids).find(k => ids[k] === id) ?? id;
const rules = async (store = a) => Object.fromEntries((await h.fixture.prisma.productPriceRule.findMany({ where: { tenantId: store.id } }))
  .map(r => [name(r.productId), { mode: r.mode, value: r.value.toNumber() }]));
const events = (action: string, store = a) => h.fixture.prisma.auditEvent.findMany({ where: { tenantId: store.id, action }, orderBy: { createdAt: 'asc' } });
/** Recon calls made by `fn`; the queued recomputes have finished when it returns. */
async function reconCalls(fn: () => Promise<unknown>) {
  const before = h.recon.calls.length;
  await fn();
  await h.recon.drain();
  return h.recon.calls.slice(before);
}
async function talabatPriceIssues(store = a) {
  const r = await h.request('GET', '/api/recon/summary?reference=marketplace', store, store === a ? manager : managerB);
  return (r.json().data.marketplaces as { marketplaceId: string; price: number }[]).find(m => m.marketplaceId === 'talabat')!.price;
}
const all = { filter: {} };
/** A response body as parsed JSON (light-my-request types it loosely). */
type Data = Awaited<ReturnType<typeof preview>>;

beforeAll(async () => {
  h = await createHarness();
  h.recon.handler = job => recomputeRecon({ database: h.fixture.database }, job);
  a = await h.createOwner('bulk-a');
  b = await h.createOwner('bulk-b');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
  managerB = await h.member(b, 'catalogue_manager');
  const cat = await h.request('POST', '/api/categories', a, a.owner, { nameEn: 'Dairy' });
  dairy = cat.json().data.id;
  // Dairy +10 % (tenant rounding exact): 4 -> 4.40. Everything else: the default rule, same price.
  expect((await h.request('PUT', '/api/pricing/category-rules', a, manager, { categoryId: dairy, mode: 'percent', value: 10 })).statusCode).toBe(200);

  await product(a, 'milk', 'A Milk', 4, { categoryId: dairy });
  await product(a, 'laban', 'B Laban', 4, { categoryId: dairy });
  await product(a, 'bread', 'C Bread', 2);
  await product(a, 'cheese', 'D Cheese', 10);
  await product(a, 'eggs', 'E Eggs', 3);
  await product(a, 'fresh', 'F New', 5, { status: 'new' });
  await product(b, 'other', 'Other milk', 4);
  await h.fixture.prisma.productPriceRule.create({ data: { tenantId: a.id, productId: ids.bread!, mode: 'fixed', value: 2.25 } });
  await h.fixture.prisma.productOffer.create({ data: { tenantId: a.id, productId: ids.cheese!, price: 9 } });
  await listing(a, 'talabat', 'milk', 5.75);
  await listing(a, 'talabat', 'laban', 5.1);
  await listing(a, 'talabat', 'bread', 2.5);
  await listing(a, 'talabat', 'cheese', 9);
  await listing(a, 'snoonu', 'milk', 5.75);
  await listing(b, 'talabat', 'other', 6);
  // Talabat and Snoonu are enabled by their applied uploads; Keeta is not enabled for either store.
  await applied(a, 'talabat');
  await applied(a, 'snoonu');
  await applied(b, 'talabat');
  await h.recon.enqueueRecon(a.id, 'manual');
  await h.recon.enqueueRecon(b.id, 'manual');
  await h.recon.drain();
}, 120_000);
afterAll(async () => { await h.close(); });

describe('inline price edit', () => {
  let version: string;

  it('sets a fixed price seen from Talabat: the resolved price, the chain, every enabled marketplace; audited; one recompute', async () => {
    let data: Data = {};
    const calls = await reconCalls(async () => {
      const r = await inline('eggs', manager, { marketplaceId: 'talabat', mode: 'fixed', value: 3.5, expectedRuleUpdatedAt: null });
      expect(r.statusCode).toBe(200);
      data = r.json().data;
    });
    expect(data).toMatchObject({
      productId: ids.eggs, marketplaceId: 'talabat', erpPrice: 3, changed: true,
      previous: { price: 3, source: 'default' }, resolved: { price: 3.5, source: 'product' }, rule: { mode: 'fixed', value: 3.5 },
      marketplaces: [{ marketplaceId: 'talabat', price: 3.5, source: 'product' }, { marketplaceId: 'snoonu', price: 3.5, source: 'product' }],
    });
    expect(data.chain.map((s: { source: string; status: string }) => [s.source, s.status])).toEqual([
      ['offer', 'not_set'], ['product', 'applied'], ['subcategory', 'not_set'], ['category', 'not_set'], ['marketplace', 'disabled'], ['default', 'overridden'],
    ]);
    expect(data.chain[1]).toEqual({ source: 'product', status: 'applied', price: 3.5, rule: { mode: 'fixed', value: 3.5 } });
    version = data.rule.updatedAt;
    const [event] = await events('product.price_rule_set');
    expect(event).toMatchObject({ entityId: ids.eggs, details: { old: null, new: { mode: 'fixed', value: 3.5 }, via: 'pricing.inline', marketplaceId: 'talabat', oldPrice: 3, newPrice: 3.5 } });
    expect(calls).toEqual([{ tenantId: a.id, reason: 'product.price_rule' }]);
    expect((await rules()).eggs).toEqual({ mode: 'fixed', value: 3.5 });
  });

  it('a percent over the ERP price, with the version last seen', async () => {
    const r = await inline('eggs', manager, { marketplaceId: 'snoonu', mode: 'percent', value: 20, expectedRuleUpdatedAt: version });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ marketplaceId: 'snoonu', previous: { price: 3.5 }, resolved: { price: 3.6, source: 'product' }, rule: { mode: 'percent', value: 20 }, changed: true });
    version = r.json().data.rule.updatedAt;
  });

  it('a stale version is 409 and writes nothing', async () => {
    const before = (await events('product.price_rule_set')).length;
    const calls = await reconCalls(async () => {
      for (const expectedRuleUpdatedAt of [null, '2026-01-01T00:00:00.000Z']) {
        const r = await inline('eggs', manager, { marketplaceId: 'talabat', mode: 'fixed', value: 9, expectedRuleUpdatedAt });
        expect(r.statusCode).toBe(409);
      }
    });
    expect(calls).toEqual([]);
    expect((await rules()).eggs).toEqual({ mode: 'percent', value: 20 });
    expect((await events('product.price_rule_set')).length).toBe(before);
  });

  it('the same rule again: changed false, no event, no recompute', async () => {
    const before = (await events('product.price_rule_set')).length;
    const calls = await reconCalls(async () => {
      const r = await inline('eggs', manager, { marketplaceId: 'talabat', mode: 'percent', value: 20, expectedRuleUpdatedAt: version });
      expect(r.json().data).toMatchObject({ changed: false, resolved: { price: 3.6 } });
    });
    expect(calls).toEqual([]);
    expect((await events('product.price_rule_set')).length).toBe(before);
  });

  it('refuses: inactive product, marketplace not enabled, an active offer, out-of-range values, another store, no permission', async () => {
    const fixed = (value: number, marketplaceId = 'talabat') => ({ marketplaceId, mode: 'fixed', value });
    const cases: [string, Session, Body, number, Store?][] = [
      ['fresh', manager, fixed(5), 400], ['eggs', manager, fixed(5, 'keeta'), 400], ['cheese', manager, fixed(8), 400],
      ['eggs', manager, fixed(0), 400], ['eggs', manager, fixed(100_000.001), 400], ['eggs', manager, fixed(1.0001), 400],
      ['eggs', manager, { marketplaceId: 'talabat', mode: 'percent', value: 1000.5 }, 400], ['eggs', manager, { marketplaceId: 'talabat', mode: 'percent', value: -91 }, 400],
      ['eggs', manager, { marketplaceId: 'talabat', mode: 'amount', value: 1 }, 400], ['eggs', manager, { mode: 'fixed', value: 5 }, 400],
      ['other', manager, fixed(5), 404], ['eggs', analyst, fixed(5), 403], ['eggs', managerB, fixed(5), 404, b],
    ];
    for (const [key, who, body, status, store] of cases) {
      expect([key, JSON.stringify(body), (await inline(key, who, body, store ?? a)).statusCode]).toEqual([key, JSON.stringify(body), status]);
    }
    expect((await inline('eggs', manager, fixed(100_000))).statusCode).toBe(200);
    expect(Object.keys(await rules(b))).toEqual([]);
    const r = await inline('cheese', manager, fixed(8));
    expect(r.json().error.details).toEqual([{ path: 'offer', message: 'A current offer sets this price; change or remove the offer first' }]);
  });

  it('DELETE goes back to the rule chain; again: changed false; a stale version 409', async () => {
    const current = (await h.fixture.prisma.productPriceRule.findFirstOrThrow({ where: { tenantId: a.id, productId: ids.eggs! } })).updatedAt.toISOString();
    expect((await uninline('eggs', manager, 'marketplaceId=talabat&expectedRuleUpdatedAt=2026-01-01T00:00:00.000Z')).statusCode).toBe(409);
    expect((await uninline('eggs', manager, 'marketplaceId=keeta')).statusCode).toBe(400);
    let data: Data = {};
    const calls = await reconCalls(async () => {
      const r = await uninline('eggs', manager, `marketplaceId=talabat&expectedRuleUpdatedAt=${encodeURIComponent(current)}`);
      expect(r.statusCode).toBe(200);
      data = r.json().data;
    });
    expect(data).toMatchObject({ previous: { price: 100_000, source: 'product' }, resolved: { price: 3, source: 'default' }, rule: null, changed: true });
    expect(calls).toEqual([{ tenantId: a.id, reason: 'product.price_rule' }]);
    expect((await events('product.price_rule_deleted')).at(-1)).toMatchObject({ entityId: ids.eggs, details: { via: 'pricing.inline', marketplaceId: 'talabat', newPrice: 3 } });
    const again = await reconCalls(async () => {
      const r = await uninline('eggs', manager, 'marketplaceId=talabat');
      expect(r.json().data).toMatchObject({ changed: false, rule: null });
    });
    expect(again).toEqual([]);
    expect((await uninline('eggs', manager, `marketplaceId=talabat&expectedRuleUpdatedAt=${encodeURIComponent(current)}`)).statusCode).toBe(409);
  });
});

describe('bulk price changes: access and contract', () => {
  const body = { marketplaceId: 'talabat', selection: all, action: { type: 'set_fixed', price: 6 } };

  it('needs pricing.bulk and the CSRF token; nothing is written', async () => {
    const before = await rules();
    for (const path of ['preview', 'apply'] as const) {
      const b2 = { ...body, ...(path === 'apply' ? { idempotencyKey: randomUUID() } : {}) };
      expect((await bulk(path, analyst, b2)).statusCode).toBe(403);
      expect((await bulk(path, { ...manager, csrf: 'wrong' }, b2)).statusCode).toBe(403);
      expect((await h.request('POST', `/api/pricing/bulk/${path}`, a, undefined, b2)).statusCode).toBe(401);
    }
    expect(await rules()).toEqual(before);
    expect(await events('pricing.bulk_applied')).toEqual([]);
  });

  it('refuses a body outside the strict contract', async () => {
    const bad: Body[] = [
      {}, { ...body, extra: 1 }, { ...body, marketplaceId: 'amazon' }, { ...body, selection: {} }, { ...body, selection: { productIds: [] } },
      { ...body, selection: { productIds: ['nope'] } }, { ...body, selection: { productIds: Array.from({ length: 501 }, () => randomUUID()) } },
      { ...body, selection: { filter: { status: 'new' } } }, { ...body, selection: { filter: { reconStatus: 'broken' } } },
      { ...body, action: { type: 'set_fixed', price: 0 } }, { ...body, action: { type: 'set_fixed', price: 100_000.5 } },
      { ...body, action: { type: 'set_fixed', price: 1.0005 } }, { ...body, action: { type: 'increase_percent', percent: 0 } },
      { ...body, action: { type: 'increase_percent', percent: 1001 } }, { ...body, action: { type: 'decrease_percent', percent: 91 } },
      { ...body, action: { type: 'decrease_amount', amount: -1 } }, { ...body, action: { type: 'increase_amount', amount: 1, rounding: '0.10' } },
      { ...body, action: { type: 'match_erp', price: 1 } }, { ...body, action: { type: 'halve' } },
    ];
    for (const b2 of bad) expect([JSON.stringify(b2).slice(0, 120), (await bulk('preview', manager, b2)).statusCode]).toEqual([JSON.stringify(b2).slice(0, 120), 400]);
    for (const idempotencyKey of [undefined, 'short', 'has spaces in it', 'x'.repeat(101)]) {
      expect((await bulk('apply', manager, { ...body, idempotencyKey })).statusCode).toBe(400);
    }
    expect((await bulk('apply', manager, { ...body, idempotencyKey: randomUUID(), previewToken: 'abc' })).statusCode).toBe(400);
  });

  it('refuses a marketplace that is not enabled for the store', async () => {
    const r = await bulk('preview', manager, { ...body, marketplaceId: 'keeta' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toEqual([{ path: 'marketplaceId', message: 'Keeta is not enabled for this store' }]);
  });
});

describe('bulk price changes: preview', () => {
  it('writes nothing: counts, blocked reasons, the largest moves, the first rows and a token', async () => {
    const [rulesBefore, eventsBefore] = [await rules(), await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id } })];
    let p: Data = {};
    const calls = await reconCalls(async () => { p = await preview({ marketplaceId: 'talabat', selection: all, action: { type: 'set_fixed', price: 6 } }); });
    expect(calls).toEqual([]);
    expect(await rules()).toEqual(rulesBefore);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id } })).toBe(eventsBefore);
    // the new product is not selected by a filter; the cheese's offer decides its price
    expect(p).toMatchObject({
      marketplaceId: 'talabat', limit: 5000, selected: 5, willChange: 4, unchanged: 0, blocked: 1,
      blockedReasons: [{ reason: 'offer_active', message: 'A current offer sets the price; change or remove the offer first', count: 1 }],
      otherMarketplaces: [{ marketplaceId: 'snoonu', products: 4 }],
      largestIncrease: { productId: ids.bread, nameEn: 'C Bread', oldPrice: 2.25, newPrice: 6, difference: 3.75 },
      largestDecrease: null,
    });
    expect(p.previewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(p.rows.map((r: Record<string, unknown>) => [r.nameEn, r.marketplaceId, r.oldPrice, r.oldSource, r.newPrice])).toEqual([
      ['A Milk', 'talabat', 4.4, 'category', 6], ['B Laban', 'talabat', 4.4, 'category', 6], ['C Bread', 'talabat', 2.25, 'product', 6], ['E Eggs', 'talabat', 3, 'default', 6],
    ]);
    expect(p.rows[2]).toMatchObject({ previousRule: { mode: 'fixed', value: 2.25 }, rule: { mode: 'fixed', value: 6 } });
    // the same data previews the same token
    expect((await preview({ marketplaceId: 'talabat', selection: all, action: { type: 'set_fixed', price: 6 } })).previewToken).toBe(p.previewToken);
  });

  it('explicit ids: percent with rounding; unknown, other-store and inactive ids are blocked with reasons', async () => {
    const p = await preview({
      marketplaceId: 'talabat', action: { type: 'increase_percent', percent: 5, rounding: '0.25' },
      selection: { productIds: [ids.milk, ids.laban, ids.eggs, ids.fresh, ids.other, randomUUID(), ids.milk] },
    });
    expect(p).toMatchObject({
      selected: 6, willChange: 3, unchanged: 0, blocked: 3,
      blockedReasons: [{ reason: 'not_found', count: 2, message: 'Not found in this store' }, { reason: 'not_active', count: 1 }],
      largestIncrease: { nameEn: 'E Eggs', oldPrice: 3, newPrice: 3.25 },
    });
    // 4.40 + 5 % = 4.62 -> 4.50; 3 + 5 % = 3.15 -> 3.25
    expect(p.rows.map((r: Record<string, unknown>) => [r.nameEn, r.newPrice])).toEqual([['A Milk', 4.5], ['B Laban', 4.5], ['E Eggs', 3.25]]);
  });

  it('filters: recon price mismatch on Talabat, search, category, listed or not, recon status', async () => {
    const select = async (filter: Body, action: Body = { type: 'set_fixed', price: 6 }) =>
      preview({ marketplaceId: 'talabat', selection: { filter }, action });
    const mismatch = await select({ reconStatus: 'price_mismatch' }, { type: 'match_marketplace' });
    expect(mismatch).toMatchObject({ reference: 'marketplace', selected: 3, willChange: 3 });
    expect(mismatch.rows.map((r: Record<string, unknown>) => [r.nameEn, r.oldPrice, r.newPrice])).toEqual([['A Milk', 4.4, 5.75], ['B Laban', 4.4, 5.1], ['C Bread', 2.25, 2.5]]);
    expect((await select({ reconStatus: 'price_mismatch', reference: 'erp' })).selected).toBe(4); // + cheese (offer 9 vs ERP 10)
    expect((await select({ q: 'milk' })).rows.map((r: Record<string, unknown>) => r.nameEn)).toEqual(['A Milk']);
    expect((await select({ categoryId: dairy })).selected).toBe(2);
    expect((await select({ listed: false })).rows.map((r: Record<string, unknown>) => r.nameEn)).toEqual(['E Eggs']);
    expect((await select({ listed: true })).selected).toBe(4);
    expect((await select({ reconStatus: 'not_listed' })).rows.map((r: Record<string, unknown>) => r.nameEn)).toEqual(['E Eggs']);
    expect((await select({ q: 'milk', listed: false })).selected).toBe(0);
    // match_marketplace blocks a product with no listing there
    expect((await select({ listed: false }, { type: 'match_marketplace' })).blockedReasons).toEqual([{ reason: 'no_listing', message: 'Not listed on Talabat', count: 1 }]);
  });
});

describe('bulk price changes: apply', () => {
  let first: Data;
  const matchMismatches = { marketplaceId: 'talabat', selection: { filter: { reconStatus: 'price_mismatch' } }, action: { type: 'match_marketplace' } };

  it('changes only the selected products, in one transaction with one audit event and one recompute; the recon follows', async () => {
    expect(await talabatPriceIssues()).toBe(3);
    const rulesSetBefore = (await events('product.price_rule_set')).length;
    const { previewToken } = await preview(matchMismatches);
    const calls = await reconCalls(async () => { first = await apply({ ...matchMismatches, idempotencyKey: 'key-match-1', previewToken }); });
    expect(first).toMatchObject({ replayed: false, selected: 3, willChange: 3, unchanged: 0, blocked: 0, created: 2, replaced: 1, removed: 0 });
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await rules()).toEqual({ milk: { mode: 'fixed', value: 5.75 }, laban: { mode: 'fixed', value: 5.1 }, bread: { mode: 'fixed', value: 2.5 } });
    expect(await rules(b)).toEqual({});
    const [event, ...more] = await events('pricing.bulk_applied');
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      id: first.operationId, entityId: null,
      details: {
        idempotencyKey: 'key-match-1', previewToken, marketplaceId: 'talabat', action: { type: 'match_marketplace' },
        result: { selected: 3, willChange: 3, created: 2, replaced: 1 },
        changeColumns: ['productId', 'oldMode', 'oldValue', 'newMode', 'newValue', 'oldPrice', 'newPrice'],
      },
    });
    expect(((event!.details as { changes: unknown[] }).changes).map(c => [name((c as string[])[0]!), ...(c as unknown[]).slice(1)])).toEqual([
      ['milk', null, null, 'fixed', 5.75, 4.4, 5.75], ['laban', null, null, 'fixed', 5.1, 4.4, 5.1], ['bread', 'fixed', 2.25, 'fixed', 2.5, 2.25, 2.5],
    ]);
    // one summary event, not one per product
    expect((await events('product.price_rule_set')).length).toBe(rulesSetBefore);
    expect(calls).toEqual([{ tenantId: a.id, reason: 'pricing.bulk' }]);
    expect(await talabatPriceIssues()).toBe(0);
  });

  it('the same idempotency key and body answers the first result again and writes nothing; another body is 409', async () => {
    const calls = await reconCalls(async () => {
      const again = await apply({ ...matchMismatches, idempotencyKey: 'key-match-1' });
      expect(again).toEqual({ ...first, replayed: true });
    });
    expect(calls).toEqual([]);
    expect((await events('pricing.bulk_applied')).length).toBe(1);
    const other = await bulk('apply', manager, { ...matchMismatches, action: { type: 'match_erp' }, idempotencyKey: 'key-match-1' });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.message).toBe('This idempotency key was already used for a different price change');
    expect((await rules()).milk).toEqual({ mode: 'fixed', value: 5.75 });
  });

  it('a double click (two identical requests at once) applies once', async () => {
    const body = { marketplaceId: 'talabat', selection: { productIds: [ids.eggs] }, action: { type: 'set_fixed', price: 7 }, idempotencyKey: 'key-double-click' };
    const calls = await reconCalls(async () => {
      const results = await Promise.all([bulk('apply', manager, body), bulk('apply', manager, body)]);
      expect(results.map(r => r.statusCode)).toEqual([200, 200]);
      expect(results.map(r => r.json().data.replayed).sort()).toEqual([false, true]);
      expect(new Set(results.map(r => r.json().data.operationId)).size).toBe(1);
    });
    expect(calls).toEqual([{ tenantId: a.id, reason: 'pricing.bulk' }]);
    expect((await events('pricing.bulk_applied')).filter(e => (e.details as { idempotencyKey: string }).idempotencyKey === 'key-double-click')).toHaveLength(1);
    expect((await rules()).eggs).toEqual({ mode: 'fixed', value: 7 });
  });

  it('a stale preview token is 409 and writes nothing; a fresh preview applies', async () => {
    const body = { marketplaceId: 'talabat', selection: { productIds: [ids.eggs] }, action: { type: 'decrease_amount', amount: 1 } };
    const { previewToken, rows } = await preview(body);
    expect(rows[0]).toMatchObject({ oldPrice: 7, newPrice: 6 });
    // someone else changes the price in between
    expect((await inline('eggs', manager, { marketplaceId: 'talabat', mode: 'fixed', value: 8 })).statusCode).toBe(200);
    const stale = await bulk('apply', manager, { ...body, idempotencyKey: 'key-stale', previewToken });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toBe('Prices or rules changed since the preview; preview again before applying');
    expect((await rules()).eggs).toEqual({ mode: 'fixed', value: 8 });
    // the refused key was not used up
    const fresh = await preview(body);
    expect(fresh.rows[0]).toMatchObject({ oldPrice: 8, newPrice: 7 });
    expect(await apply({ ...body, idempotencyKey: 'key-stale', previewToken: fresh.previewToken })).toMatchObject({ willChange: 1, replaced: 1 });
    expect((await rules()).eggs).toEqual({ mode: 'fixed', value: 7 });
  });

  it('match ERP removes the product rules: the price follows the next rule again', async () => {
    const body = { marketplaceId: 'talabat', selection: { productIds: [ids.milk, ids.laban, ids.eggs, ids.cheese] }, action: { type: 'match_erp' } };
    const p = await preview(body);
    expect(p.rows.map((r: Record<string, unknown>) => [r.nameEn, r.oldPrice, r.newPrice, r.newSource, r.rule])).toEqual([
      ['A Milk', 5.75, 4.4, 'category', null], ['B Laban', 5.1, 4.4, 'category', null], ['E Eggs', 7, 3, 'default', null],
    ]);
    const calls = await reconCalls(async () => {
      expect(await apply({ ...body, idempotencyKey: 'key-match-erp' })).toMatchObject({ willChange: 3, blocked: 1, removed: 3, created: 0, replaced: 0 });
    });
    expect(calls).toEqual([{ tenantId: a.id, reason: 'pricing.bulk' }]);
    expect(await rules()).toEqual({ bread: { mode: 'fixed', value: 2.5 } });
    expect(await talabatPriceIssues()).toBe(2); // milk and laban are back to 4.40 against 5.75 and 5.10
  });

  it('a change that changes nothing records its key but queues no recompute', async () => {
    const body = { marketplaceId: 'talabat', selection: { productIds: [ids.milk] }, action: { type: 'match_erp' }, idempotencyKey: 'key-noop' };
    const calls = await reconCalls(async () => { expect(await apply(body)).toMatchObject({ selected: 1, willChange: 0, unchanged: 1, replayed: false }); });
    expect(calls).toEqual([]);
    expect(await apply(body)).toMatchObject({ replayed: true });
  });

  it('is tenant-scoped: another store selects, changes and remembers keys only for itself', async () => {
    const rulesA = await rules();
    const body = { marketplaceId: 'talabat', selection: all, action: { type: 'set_fixed', price: 6.5 } };
    expect(await preview(body, managerB, b)).toMatchObject({ selected: 1, willChange: 1, rows: [{ productId: ids.other, nameEn: 'Other milk' }] });
    // a key already used in store A is unknown to store B
    expect(await apply({ ...body, idempotencyKey: 'key-match-1' }, managerB, b)).toMatchObject({ replayed: false, willChange: 1 });
    expect(await rules(b)).toEqual({ other: { mode: 'fixed', value: 6.5 } });
    expect(await rules()).toEqual(rulesA);
    expect((await events('pricing.bulk_applied', b)).length).toBe(1);
    // store B's selection by id cannot reach store A's products
    expect(await preview({ ...body, selection: { productIds: [ids.milk] } }, managerB, b)).toMatchObject({ selected: 1, willChange: 0, blockedReasons: [{ reason: 'not_found', count: 1 }] });
  });
});

describe('bulk price changes: limit', () => {
  it(`refuses a selection above 5,000 products, in preview and apply, writing nothing`, async () => {
    const c = await h.createOwner('bulk-c');
    await h.fixture.prisma.tenantMarketplace.create({ data: { tenantId: c.id, marketplaceId: 'talabat', enabled: true } });
    await h.fixture.prisma.$executeRaw`
      INSERT INTO products (id, tenant_id, barcode, normalized_barcode, name_en, erp_price, status, updated_at)
      SELECT gen_random_uuid(), ${c.id}::uuid, '7' || lpad(g::text, 12, '0'), '7' || lpad(g::text, 12, '0'), CASE WHEN g = 5001 THEN 'Extra item' ELSE 'Product ' || lpad(g::text, 5, '0') END, 1, 'active', now()
      FROM generate_series(1, 5001) AS g`;
    const body = { marketplaceId: 'talabat', selection: all, action: { type: 'set_fixed', price: 2 } };
    for (const [path, extra] of [['preview', {}], ['apply', { idempotencyKey: randomUUID() }]] as const) {
      const r = await bulk(path, c.owner, { ...body, ...extra }, c);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.details).toEqual([{ path: 'selection', message: 'This selection has 5,001 products; one change can price at most 5,000. Narrow the filter.' }]);
    }
    expect(await h.fixture.prisma.productPriceRule.count({ where: { tenantId: c.id } })).toBe(0);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: c.id, action: 'pricing.bulk_applied' } })).toBe(0);
    // exactly the limit is accepted
    expect(await preview({ ...body, selection: { filter: { q: 'Product' } } }, c.owner, c)).toMatchObject({ selected: 5000, willChange: 5000 });
  });
});
