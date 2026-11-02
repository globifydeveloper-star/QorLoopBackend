import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import { createHarness, type Harness, type Store } from './harness.js';

// Timings only mean something on a real PostgreSQL; the embedded database is single-connection WASM.
const realPostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const PRODUCTS = 25_000;
/** One request over the whole catalogue, under the tenant row lock. */
const PREVIEW_BUDGET_MS = 3_000;
const APPLY_BUDGET_MS = 10_000;

let h: Harness;
let s: Store;

/** Markup like the real stores: ~+43 % under 2 QAR down to ~+17 % over 100 QAR, rounded to 0.25. */
const markup = (erp: number) => (erp < 2 ? 0.43 : erp < 10 ? 0.3 : erp < 100 ? 0.22 : 0.17);
const quarter = (qar: number) => Math.max(0.25, Math.round(qar * 4) / 4);

async function timed<T>(fn: () => Promise<T>) {
  const t = performance.now();
  const result = await fn();
  return { result, ms: Math.round((performance.now() - t) * 10) / 10 };
}

realPostgres(`adopt marketplace prices at ${PRODUCTS.toLocaleString('en')} products (real PostgreSQL)`, () => {
  beforeAll(async () => {
    h = await createHarness();
    s = await h.createOwner('adoptperf');
    const prisma = h.fixture.prisma;
    const categories = await Promise.all(Array.from({ length: 20 }, (_, i) => prisma.category.create({ data: { tenantId: s.id, nameEn: `Category ${i}` } })));
    const erp = (i: number) => [0.75, 1.5, 3.25, 7.5, 12, 24.5, 55, 120, 240][i % 9]! + (i % 17) * 0.05;
    const products = Array.from({ length: PRODUCTS }, (_, i) => ({
      tenantId: s.id, barcode: String(6_281_000_000_000 + i * 7), normalizedBarcode: String(6_281_000_000_000 + i * 7), nameEn: `Product ${String(i).padStart(5, '0')}`,
      erpPrice: Math.round(erp(i) * 1000) / 1000, erpStock: 5, status: 'active', categoryId: categories[i % 20]!.id,
    }));
    for (let i = 0; i < products.length; i += 5_000) await prisma.product.createMany({ data: products.slice(i, i + 5_000) });
    const rows = await prisma.product.findMany({ where: { tenantId: s.id }, select: { id: true, erpPrice: true }, orderBy: { normalizedBarcode: 'asc' } });
    await prisma.pricingSettings.create({ data: { tenantId: s.id, defaultRuleMode: 'percent', defaultRuleValue: 10, rounding: '0.25' } });
    // 2 % with their own rule, 1 % with an offer; 95 % listed on Talabat, 90 % on Snoonu, which agrees for ~98 %
    await prisma.productPriceRule.createMany({ data: rows.filter((_, i) => i % 50 === 0).map(p => ({ tenantId: s.id, productId: p.id, mode: 'fixed', value: 3 })) });
    await prisma.productOffer.createMany({ data: rows.filter((_, i) => i % 100 === 7).map(p => ({ tenantId: s.id, productId: p.id, price: 2 })) });
    for (const [m, share] of [['talabat', 0.95], ['snoonu', 0.9]] as const) {
      const listings = rows.flatMap((p, i) => ((i * 13) % 100) / 100 < share ? [{
        tenantId: s.id, marketplaceId: m, marketplaceProductId: `${m}-${i}`, productId: p.id, barcodes: [],
        price: quarter(p.erpPrice.toNumber() * (1 + markup(p.erpPrice.toNumber()))) + (m === 'snoonu' && i % 55 === 0 ? 0.5 : 0), available: true,
      }] : []);
      for (let i = 0; i < listings.length; i += 5_000) await prisma.listing.createMany({ data: listings.slice(i, i + 5_000) });
    }
    await prisma.$executeRawUnsafe('ANALYZE');
  }, 600_000);
  afterAll(async () => { await h?.close(); });

  it('previews, applies in one transaction, and a second apply adopts nothing, within budget', async () => {
    const body = { sourceMarketplaceId: 'talabat', mode: 'percent', scope: { all: true } };
    const call = (path: string) => timed(async () => {
      const r = await h.request('POST', `/api/pricing/adopt/${path}`, s, s.owner, body);
      expect(r.statusCode).toBe(200);
      return r.json().data;
    });
    await call('preview'); // warm-up
    const previews = [await call('preview'), await call('preview'), await call('preview')];
    const preview = previews[0]!.result;
    const previewMs = previews.map(p => p.ms).sort((x, y) => x - y)[1]!;

    const before = h.recon.calls.length;
    const applied = await call('apply');
    const again = await call('apply');
    const rules = await h.fixture.prisma.productPriceRule.count({ where: { tenantId: s.id } });
    const events = await h.fixture.prisma.auditEvent.groupBy({ by: ['action'], where: { tenantId: s.id, action: { in: ['pricing.prices_adopted', 'product.price_rule_set'] } }, _count: { _all: true } });

    console.log('[perf] ' + JSON.stringify({
      products: PRODUCTS, previewMedianMs: previewMs, previewRunsMs: previews.map(p => p.ms), applyMs: applied.ms, repeatApplyMs: again.ms,
      adopted: applied.result.adopted, fixedFallback: applied.result.fixedFallback, fallbacks: applied.result.fallbacks, skipped: applied.result.skipped,
      conflicts: applied.result.conflicts, rules, events: Object.fromEntries(events.map(e => [e.action, e._count._all])),
    }, null, 2));

    expect(preview.willAdopt).toBe(applied.result.adopted);
    expect(applied.result.adopted).toBeGreaterThan(22_000);
    expect(again.result.adopted).toBe(0);
    expect(rules).toBe(applied.result.adopted + PRODUCTS / 50);
    expect(events).toEqual([{ action: 'pricing.prices_adopted', _count: { _all: 1 } }]);
    expect(h.recon.calls.slice(before)).toEqual([{ tenantId: s.id, reason: 'pricing.adopt' }]);
    expect(previewMs).toBeLessThanOrEqual(PREVIEW_BUDGET_MS);
    expect(applied.ms).toBeLessThanOrEqual(APPLY_BUDGET_MS);
  }, 600_000);
});
