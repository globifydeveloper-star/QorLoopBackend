import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createHarness, type Harness, type Store } from './harness.js';
import { recomputeRecon, type ReconCounts } from '../../../worker/src/recompute-recon.js';
import { MARKETPLACES } from '../../../../packages/core/src/constants.js';

// Timings only mean something on a real PostgreSQL; the embedded database is single-connection WASM.
const realPostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const PRODUCTS = Number(process.env.RECON_SCALE_PRODUCTS) || 50_000;
/** Share of products listed on each marketplace. */
const LISTED: Record<string, number> = { talabat: 0.9, snoonu: 0.85, rafeeq: 0.7, keeta: 0.6 };
/** A request that takes the tenant row lock while a recompute runs must not wait for it. */
const LOCKED_REQUEST_BUDGET_MS = 1_000;
/** An incremental run (few rows changed) at full scale. */
const INCREMENTAL_BUDGET_MS = 10_000;

const { Client } = pg;

let h: Harness;
let s: Store;

type Logged = { ms: number; tenantLockMs: number; timings: Record<string, number> } & ReconCounts;
async function run(reason: 'manual' | 'pricing.settings' = 'manual') {
  let logged: Logged | undefined;
  const t0 = performance.now();
  await recomputeRecon({ database: h.fixture.database, log: { info: o => { logged = o as Logged; }, warn: () => undefined } }, { tenantId: s.id, reason });
  return { wallMs: Math.round(performance.now() - t0), ...logged! };
}
async function time(fn: () => Promise<unknown>, runs = 5) {
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); samples.push(performance.now() - t); }
  samples.sort((x, y) => x - y);
  return Math.round(samples[runs >> 1]! * 10) / 10;
}

realPostgres(`recon at ${PRODUCTS.toLocaleString('en')} products x 4 marketplaces (real PostgreSQL)`, () => {
  beforeAll(async () => {
    h = await createHarness();
    s = await h.createOwner('reconperf');
    const prisma = h.fixture.prisma;
    const owner = await prisma.user.findFirstOrThrow({ where: { tenantId: s.id } });
    const categories = await Promise.all(Array.from({ length: 20 }, (_, i) => prisma.category.create({ data: { tenantId: s.id, nameEn: `Category ${i}` } })));
    const products = Array.from({ length: PRODUCTS }, (_, i) => ({
      tenantId: s.id, barcode: String(6_281_000_000_000 + i * 7), normalizedBarcode: String(6_281_000_000_000 + i * 7), nameEn: `Product ${i}`,
      erpPrice: 1 + (i % 400) * 0.25, erpStock: i % 7, erpActive: i % 50 !== 0, inLatestErpFile: i % 33 !== 0,
      status: i % 20 === 0 ? 'new' : i % 10 === 1 ? 'inactive' : 'active', categoryId: categories[i % 20]!.id,
    }));
    for (let i = 0; i < products.length; i += 2_000) await prisma.product.createMany({ data: products.slice(i, i + 2_000) });
    const ids = (await prisma.product.findMany({ where: { tenantId: s.id }, select: { id: true, erpPrice: true }, orderBy: { normalizedBarcode: 'asc' } }));
    // pricing: default +10%, rules on half the categories, product rules on 2%, offers on 1%, Snoonu +0.5 per marketplace
    await prisma.pricingSettings.create({ data: { tenantId: s.id, defaultRuleMode: 'percent', defaultRuleValue: 10, perMarketplaceEnabled: true } });
    await prisma.marketplacePriceRule.create({ data: { tenantId: s.id, marketplaceId: 'snoonu', mode: 'amount', value: 0.5 } });
    for (let c = 0; c < 10; c++) await prisma.categoryPriceRule.create({ data: { tenantId: s.id, categoryId: categories[c]!.id, mode: 'percent', value: 5 + c } });
    await prisma.productPriceRule.createMany({ data: ids.filter((_, i) => i % 50 === 0).map(p => ({ tenantId: s.id, productId: p.id, mode: 'fixed', value: 3 })) });
    await prisma.productOffer.createMany({ data: ids.filter((_, i) => i % 100 === 3).map(p => ({ tenantId: s.id, productId: p.id, price: 2, validUntil: new Date(Date.now() + 86_400_000) })) });
    // listings: a mix of right and wrong prices and availability, plus 2% unmatched rows
    for (const m of MARKETPLACES) {
      const rows = ids.flatMap((p, i) => ((i * 13) % 100) / 100 < LISTED[m]! ? [{
        tenantId: s.id, marketplaceId: m, marketplaceProductId: `${m}-${i}`, productId: p.id, barcodes: [], price: i % 3 === 0 ? p.erpPrice.toNumber() * 1.1 : p.erpPrice.toNumber() + (i % 5),
        available: i % 4 !== 0,
      }] : []);
      rows.push(...Array.from({ length: PRODUCTS / 50 }, (_, i) => ({ tenantId: s.id, marketplaceId: m, marketplaceProductId: `${m}-x${i}`, productId: null as unknown as string, barcodes: [], price: 1, available: true })));
      for (let i = 0; i < rows.length; i += 4_000) await prisma.listing.createMany({ data: rows.slice(i, i + 4_000) });
      await prisma.upload.create({ data: { tenantId: s.id, source: m, fileName: `${m}.xlsx`, size: 1, storageKey: `perf/${m}`, uploadedById: owner.id, status: 'applied', appliedAt: new Date() } });
    }
    await prisma.$executeRawUnsafe('ANALYZE');
  }, 900_000);
  afterAll(async () => { await h?.close(); });

  it('recomputes, never holds the tenant lock, and the summary equals a direct recount', async () => {
    // A second connection (the harness pool has one) takes the tenant row lock the way every API write does,
    // while a full recompute runs: it must not wait for the recompute.
    const [{ schema }] = await h.fixture.prisma.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS schema`;
    const probe = new Client({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
    await probe.connect();
    const lockedRequest = async () => {
      const t = performance.now();
      await probe.query('BEGIN');
      await probe.query('SELECT id FROM tenants WHERE id = $1::uuid FOR UPDATE', [s.id]);
      await probe.query('COMMIT');
      return Math.round(performance.now() - t);
    };
    let probeMs = 0;
    const cold = await (async () => {
      const running = run();
      await new Promise(r => setTimeout(r, 3_000)); // well inside the write phase
      probeMs = await lockedRequest();
      return running;
    })();
    await probe.end();
    const warm = await run();
    // an ERP-like change: 1% of products change stock, 1% of Talabat listings change price
    await h.fixture.prisma.$executeRaw`UPDATE products SET erp_stock = erp_stock + 10 WHERE tenant_id = ${s.id}::uuid AND (hashtext(id::text) % 100) = 0`;
    await h.fixture.prisma.$executeRaw`UPDATE listings SET price = price + 1 WHERE tenant_id = ${s.id}::uuid AND marketplace_id = 'talabat' AND (hashtext(id::text) % 100) = 0`;
    const incremental = await run();
    // a pricing change that moves every marketplace price: the worst case after the first run
    await h.fixture.prisma.pricingSettings.update({ where: { tenantId: s.id }, data: { defaultRuleValue: 12 } });
    const changed = await run('pricing.settings');
    const report = (r: Awaited<ReturnType<typeof run>>) => ({ wallMs: r.wallMs, tenantLockMs: r.tenantLockMs, rows: r.rows, inserted: r.inserted, updated: r.updated, removed: r.removed, timings: r.timings });
    console.log(JSON.stringify({
      products: PRODUCTS, lockedRequestDuringFullRunMs: probeMs,
      firstRun: report(cold), unchanged: report(warm), incremental: report(incremental), afterDefaultRuleChange: report(changed),
    }, null, 2));

    expect(cold).toMatchObject({ products: PRODUCTS, marketplaces: 4, rows: PRODUCTS * 4, inserted: PRODUCTS * 4, updated: 0, summaries: 8 });
    expect(warm).toMatchObject({ inserted: 0, updated: 0, removed: 0 });
    expect(incremental.updated).toBeGreaterThan(0);
    expect(incremental.updated).toBeLessThan(PRODUCTS * 4 / 10);
    expect(changed.updated).toBeGreaterThan(PRODUCTS);
    expect(probeMs).toBeLessThan(LOCKED_REQUEST_BUDGET_MS);
    for (const r of [warm, incremental]) expect(r.wallMs).toBeLessThan(INCREMENTAL_BUDGET_MS);

    // the stored summaries are exactly a recount of the stored rows, per marketplace and reference
    const recount = await h.fixture.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT r.marketplace_id, ref.reference,
             count(*) FILTER (WHERE r.stock_issue IS NOT NULL)::int AS stock,
             count(*) FILTER (WHERE CASE WHEN ref.reference = 'erp' THEN r.price_mismatch_vs_erp ELSE r.price_mismatch_vs_marketplace END)::int AS price,
             count(*) FILTER (WHERE r.actual_price IS NOT NULL)::int AS listed,
             count(*) FILTER (WHERE (CASE WHEN ref.reference = 'erp' THEN r.status_vs_erp ELSE r.status END) = 'not_listed')::int AS "notListed",
             count(*) FILTER (WHERE (CASE WHEN ref.reference = 'erp' THEN r.status_vs_erp ELSE r.status END) = 'missing_from_erp')::int AS "missingFromErp",
             count(*) FILTER (WHERE (CASE WHEN ref.reference = 'erp' THEN r.status_vs_erp ELSE r.status END) = 'new')::int AS "newCount"
      FROM recon_rows r CROSS JOIN (VALUES ('marketplace'), ('erp')) AS ref(reference)
      WHERE r.tenant_id = ${s.id}::uuid GROUP BY 1, 2 ORDER BY 1, 2`;
    const stored = await h.fixture.prisma.reconSummary.findMany({ where: { tenantId: s.id }, orderBy: [{ marketplaceId: 'asc' }, { reference: 'asc' }] });
    expect(stored.map(x => ({ marketplace_id: x.marketplaceId, reference: x.reference, stock: x.stock, price: x.price, listed: x.listed, notListed: x.notListed, missingFromErp: x.missingFromErp, newCount: x.newCount })))
      .toEqual(recount);
    for (const x of stored) expect(x.total).toBe(x.stock + x.price);
    expect(stored.find(x => x.marketplaceId === 'talabat' && x.reference === 'marketplace')!.stock).toBeGreaterThan(0);
  }, 300_000);

  it('the read endpoints answer quickly', async () => {
    const ok = async (url: string) => { const r = await h.request('GET', url, s, s.owner); expect(r.statusCode).toBe(200); return r.json().data; };
    const page = await ok('/api/recon/rows?marketplaceId=talabat&limit=50');
    const deep = await ok('/api/recon/rows?marketplaceId=talabat&limit=200&cursor=' + (await ok('/api/recon/rows?marketplaceId=talabat&limit=200&type=all&status=in_sync')).nextCursor);
    expect(page.items[0].stockIssue).toBe('available_but_out_of_stock');
    expect(deep.items.length).toBe(200);
    const timings = {
      'GET /api/recon/summary': await time(() => ok('/api/recon/summary')),
      'GET /api/recon/summary?reference=erp': await time(() => ok('/api/recon/summary?reference=erp')),
      'GET /api/recon/rows (all, first page)': await time(() => ok('/api/recon/rows?marketplaceId=talabat&limit=50')),
      'GET /api/recon/rows (stock)': await time(() => ok('/api/recon/rows?marketplaceId=talabat&type=stock&limit=50')),
      'GET /api/recon/rows (price, erp)': await time(() => ok('/api/recon/rows?marketplaceId=snoonu&type=price&reference=erp&limit=50')),
      'GET /api/recon/rows (deep cursor)': await time(() => ok('/api/recon/rows?marketplaceId=talabat&limit=200&cursor=' + page.nextCursor)),
    };
    console.log(JSON.stringify(timings, null, 2));
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(1_000);
  }, 300_000);
});
