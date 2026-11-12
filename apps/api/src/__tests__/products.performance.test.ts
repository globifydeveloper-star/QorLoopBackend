import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import { createHarness, type Harness, type Store } from './harness.js';
import { ProductRepository, marketplaceValuesSql, type ProductFilter, type ProductTab } from '../../../../packages/db/src/products.js';
import { Prisma } from '../../../../packages/db/src/generated/client.js';

// Timings and query plans only mean something on a real PostgreSQL with pg_trgm; the embedded database has neither.
const realPostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const PRODUCTS = 25_000;
const SLOW_MS = 300;

const brands = ['Almarai', 'Nadec', 'Al Rawabi', 'Baladna', 'Lusine', 'Americana', 'Sadia', 'Doux', 'Puck', 'Kiri', 'Nestle', 'Lipton',
  'Nescafe', 'Maggi', 'Heinz', 'Kelloggs', 'Galaxy', 'Snickers', 'Pepsi', 'Rani', 'Tang', 'Barakat', 'Al Ain', 'Masafi', 'Oasis'];
const items = ['Fresh Milk', 'Laban', 'Yoghurt', 'Cheese Slices', 'Labneh', 'Butter', 'Cream', 'Arabic Bread', 'Croissant', 'Chicken Breast',
  'Frozen Chicken', 'Beef Burger', 'Rice', 'Sugar', 'Tea Bags', 'Instant Coffee', 'Orange Juice', 'Mango Juice', 'Mineral Water', 'Cornflakes',
  'Chocolate Bar', 'Biscuits', 'Tomato Paste', 'Ketchup', 'Olive Oil', 'Sunflower Oil', 'Pasta', 'Noodles', 'Dates', 'Honey',
  'Milk Powder', 'Chocolate Milk', 'Feta Cheese', 'Halloumi', 'Hummus', 'Tahini', 'Chickpeas', 'Lentils', 'Tuna', 'Sardines'];
const sizes = ['200ml', '500ml', '1L', '2L', '100g', '250g', '500g', '1kg', '5kg', 'Pack of 6'];

let h: Harness;
let s: Store;
let repo: ProductRepository;

/** Median of `runs` timed calls after one warm-up call, in ms. */
async function time(fn: () => Promise<unknown>, runs = 7) {
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((x, y) => x - y);
  return Math.round(samples[runs >> 1]! * 10) / 10;
}
/** `withoutSeqScan` shows whether an index can serve the query at all; SET LOCAL ends with the transaction. */
const explain = (sql: string, params: unknown[], withoutSeqScan = false) => h.fixture.prisma.$transaction(async tx => {
  if (withoutSeqScan) await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
  const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>('EXPLAIN (ANALYZE, BUFFERS) ' + sql, ...params);
  return rows.map(r => r['QUERY PLAN']).join('\n');
});
const NAME_SEARCH = `SELECT id, name_en FROM products WHERE tenant_id = $1::uuid AND (name_en ILIKE $2 OR sku = $3) ORDER BY name_en, id LIMIT 51`;

realPostgres('products at 25,000 rows (real PostgreSQL)', () => {
  beforeAll(async () => {
    h = await createHarness();
    s = await h.createOwner('perf');
    const rows = Array.from({ length: PRODUCTS }, (_, i) => ({
      tenantId: s.id,
      barcode: String(6_281_000_000_000 + i * 7), normalizedBarcode: String(6_281_000_000_000 + i * 7), sku: 'SKU-' + String(i).padStart(6, '0'),
      // A few rare names, like most real searches that match a handful of products.
      nameEn: i % 1_000 === 0 ? `Zaatar Manakish ${i}` : `${brands[i % brands.length]} ${items[(i * 7) % items.length]} ${sizes[(i * 3) % sizes.length]}`,
      status: i % 10 < 6 ? 'active' : i % 10 < 8 ? 'new' : 'inactive', inLatestErpFile: i % 20 !== 0, erpPrice: 2.5, erpStock: 4,
    }));
    for (let i = 0; i < rows.length; i += 5_000) await h.fixture.prisma.product.createMany({ data: rows.slice(i, i + 5_000) });
    await h.fixture.prisma.$executeRawUnsafe('ANALYZE products');
    repo = new ProductRepository(s.id, h.fixture.prisma as unknown as Prisma.TransactionClient);
  }, 600_000);
  afterAll(async () => { await h?.close(); });

  it('reports list, search and counts timings and the name-search plan', async () => {
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id } })).toBe(PRODUCTS);
    const cases: [string, ProductFilter, ProductTab][] = [
      ['list (all)', {}, 'all'],
      ['list (tab new)', {}, 'new'],
      ['search name "milk"', { q: 'milk' }, 'all'],
      ['search name "manakish"', { q: 'manakish' }, 'all'],
      ['search barcode prefix "628100001"', { q: '628100001', barcodePrefix: '628100001' }, 'all'],
      ['search barcode exact', { q: '6281000070000', barcodePrefix: '6281000070000' }, 'all'],
      ['search sku "SKU-012345"', { q: 'SKU-012345' }, 'all'],
    ];
    const timings: Record<string, number> = {};
    for (const [label, filter, tab] of cases) {
      timings[label + ': list query'] = await time(() => repo.list(filter, tab, null, 51));
      timings[label + ': counts query'] = await time(() => repo.counts(filter));
    }
    // The whole request as the client sees it: session, tenant transaction, list + counts, serialisation.
    for (const [label, query] of [['GET /api/products', ''], ['GET /api/products?q=milk', '?q=milk'], ['GET /api/products?q=628100001', '?q=628100001'],
      ['GET /api/products?q=SKU-012345', '?q=SKU-012345']] as const) {
      timings[label + ' (endpoint)'] = await time(async () => expect((await h.request('GET', '/api/products' + query, s, s.owner)).statusCode).toBe(200));
    }
    const slow = Object.entries(timings).filter(([, ms]) => ms > SLOW_MS).map(([k]) => k);

    // The same SQL shape the repository builds for a name search (ILIKE with an OR on sku), first page.
    const selectivePlan = await explain(NAME_SEARCH, [s.id, '%manakish%', 'manakish']);
    const broadPlan = await explain(NAME_SEARCH, [s.id, '%milk%', 'milk']);
    // The name predicate alone, seq scan off: shows the trigram index can serve ILIKE '%text%'.
    const indexPlan = await explain(`SELECT id FROM products WHERE name_en ILIKE $1`, ['%manakish%'], true);
    const barcodePlan = await explain(
      `SELECT id, name_en FROM products WHERE tenant_id = $1::uuid AND (name_en ILIKE $2 OR sku = $3 OR normalized_barcode LIKE $4) ORDER BY name_en, id LIMIT 51`,
      [s.id, '%628100001%', '628100001', '628100001%']);
    const listPlan = await explain(`SELECT id, name_en FROM products WHERE tenant_id = $1::uuid ORDER BY name_en, id LIMIT 51`, [s.id]);
    const collation = (await h.fixture.prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT datcollate AS c FROM pg_database WHERE datname = current_database()`))[0]!.c;

    console.log('[perf] ' + JSON.stringify({ products: PRODUCTS, medianMs: timings, over300ms: slow, collation }, null, 2));
    console.log('[perf] EXPLAIN name search "manakish" (25 rows)\n' + selectivePlan);
    console.log('[perf] EXPLAIN name search "milk" (broad)\n' + broadPlan);
    console.log('[perf] EXPLAIN name predicate alone, seq scan off\n' + indexPlan);
    console.log('[perf] EXPLAIN barcode search\n' + barcodePlan);
    console.log('[perf] EXPLAIN list\n' + listPlan);
    // At this size the planner may rightly scan for the full query (the GIN scan is costed above a 4 MB table);
    // the index itself must still serve the name predicate.
    expect(indexPlan).toMatch(/Bitmap Index Scan on products_name_en_trgm_idx/);
  }, 600_000);

  it('prices a 50-row page of 25,000 products with rules everywhere within budget', async () => {
    const prisma = h.fixture.prisma;
    // 20 categories x 5 subcategories, every product filed; rules on every category and half the subcategories;
    // a product rule on every 10th product, an offer on every 25th (a third of them expired).
    const parents = await Promise.all(Array.from({ length: 20 }, (_, i) => prisma.category.create({ data: { tenantId: s.id, nameEn: 'Cat ' + i } })));
    const subs = (await Promise.all(parents.flatMap(p => Array.from({ length: 5 }, (_, j) =>
      prisma.category.create({ data: { tenantId: s.id, nameEn: 'Sub ' + j, parentId: p.id } }))))).map(c => ({ id: c.id, parentId: c.parentId! }));
    await prisma.$executeRawUnsafe(`
      WITH numbered AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM products WHERE tenant_id = $1::uuid)
      UPDATE products p SET category_id = (($2::uuid[])[1 + (n % 100)]), subcategory_id = (($3::uuid[])[1 + (n % 100)])
      FROM numbered WHERE p.id = numbered.id`, s.id, subs.map(x => x.parentId), subs.map(x => x.id));
    await prisma.categoryPriceRule.createMany({ data: [
      ...parents.map(p => ({ tenantId: s.id, categoryId: p.id, mode: 'percent', value: 8 })),
      ...subs.filter((_, i) => i % 2 === 0).map(x => ({ tenantId: s.id, categoryId: x.parentId, subcategoryId: x.id, mode: 'amount', value: 1.5 })),
    ] });
    await prisma.pricingSettings.create({ data: { tenantId: s.id, defaultRuleMode: 'percent', defaultRuleValue: 10, rounding: '0.25', perMarketplaceEnabled: true } });
    await prisma.marketplacePriceRule.create({ data: { tenantId: s.id, marketplaceId: 'talabat', mode: 'percent', value: 15, rounding: '0.25' } });
    await prisma.$executeRawUnsafe(`
      INSERT INTO product_price_rules (id, tenant_id, product_id, mode, value, updated_at)
      SELECT gen_random_uuid(), tenant_id, id, 'fixed', 9.99, now() FROM (SELECT id, tenant_id, row_number() OVER (ORDER BY name_en, id) AS n FROM products WHERE tenant_id = $1::uuid) x WHERE n % 10 = 0`, s.id);
    await prisma.$executeRawUnsafe(`
      INSERT INTO product_offers (id, tenant_id, product_id, price, valid_until, updated_at)
      SELECT gen_random_uuid(), tenant_id, id, 1.25, CASE WHEN n % 3 = 0 THEN now() - interval '1 day' ELSE NULL END, now()
      FROM (SELECT id, tenant_id, row_number() OVER (ORDER BY name_en, id) AS n FROM products WHERE tenant_id = $1::uuid) x WHERE n % 25 = 0`, s.id);
    await prisma.$executeRawUnsafe('ANALYZE');

    const first = (await h.request('GET', '/api/products?limit=50', s, s.owner)).json().data;
    const sources = new Set((first.items as { marketplacePrice: { source: string } }[]).map(i => i.marketplacePrice.source));
    expect(first.items).toHaveLength(50);
    expect([...sources]).toEqual(expect.arrayContaining(['category', 'offer', 'product', 'subcategory']));
    const timings: Record<string, number> = {
      'GET /api/products (priced)': await time(async () => expect((await h.request('GET', '/api/products?limit=50', s, s.owner)).statusCode).toBe(200)),
      'GET /api/products?q=milk (priced)': await time(async () => expect((await h.request('GET', '/api/products?limit=50&q=milk', s, s.owner)).statusCode).toBe(200)),
      'GET /api/products page 2 (priced)': await time(async () => expect((await h.request('GET', '/api/products?limit=50&cursor=' + first.nextCursor, s, s.owner)).statusCode).toBe(200)),
      'GET /api/products/:id (chain)': await time(async () => expect((await h.request('GET', '/api/products/' + first.items[0].id, s, s.owner)).statusCode).toBe(200)),
    };
    console.log('[perf] ' + JSON.stringify({ products: PRODUCTS, categoryRules: 70, productRules: PRODUCTS / 10, offers: PRODUCTS / 25, medianMs: timings }, null, 2));
    for (const [label, ms] of Object.entries(timings)) expect([label, ms <= SLOW_MS]).toEqual([label, true]);
  }, 600_000);

  it('adds Talabat values and filters by marketplace status within budget', async () => {
    const prisma = h.fixture.prisma;
    const owner = await prisma.user.findFirstOrThrow({ where: { tenantId: s.id } });
    const upload = await prisma.upload.create({ data: { tenantId: s.id, source: 'talabat', fileName: 'talabat.xlsx', size: 1, storageKey: 'perf/talabat-list', uploadedById: owner.id, status: 'applied', appliedAt: new Date() } });
    // 90% listed (every 50th twice), every 7th a stock mismatch, every 11th a price mismatch.
    await prisma.$executeRawUnsafe(`
      INSERT INTO listings (id, tenant_id, marketplace_id, marketplace_product_id, product_id, barcodes, price, available, upload_id, created_at, updated_at)
      SELECT gen_random_uuid(), tenant_id, 'talabat', 'T-' || n || '-' || k, id, ARRAY[]::text[], 2.5 + k, n % 7 <> 0, $2::uuid, now(), now() - (k || ' seconds')::interval
      FROM (SELECT id, tenant_id, row_number() OVER (ORDER BY id) AS n FROM products WHERE tenant_id = $1::uuid) x
      CROSS JOIN LATERAL (SELECT generate_series(0, CASE WHEN n % 50 = 0 THEN 1 ELSE 0 END) AS k) g
      WHERE n % 10 <> 0`, s.id, upload.id);
    await prisma.$executeRawUnsafe(`
      INSERT INTO recon_rows (id, tenant_id, product_id, marketplace_id, status, status_vs_erp, stock_issue, stock_issue_vs_erp,
                              price_mismatch_vs_marketplace, price_mismatch_vs_erp, actual_price, actual_available, marketplace_price, erp_price, last_updated)
      SELECT gen_random_uuid(), tenant_id, id, 'talabat', st, st, si, si, pm, pm, 2.5, n % 7 <> 0, 2.5, 2.5, now()
      FROM (SELECT id, tenant_id, n,
                   CASE WHEN n % 10 = 0 THEN 'not_listed' WHEN n % 7 = 0 OR n % 11 = 0 THEN 'mismatch' ELSE 'in_sync' END AS st,
                   CASE WHEN n % 10 <> 0 AND n % 7 = 0 THEN 'unavailable_but_in_stock' END AS si, (n % 10 <> 0 AND n % 11 = 0) AS pm
            FROM (SELECT id, tenant_id, row_number() OVER (ORDER BY id) AS n FROM products WHERE tenant_id = $1::uuid) y) x`, s.id);
    await prisma.$executeRawUnsafe('ANALYZE');

    const query = (q: string) => async () => expect((await h.request('GET', '/api/products?limit=50&marketplaceId=talabat' + q, s, s.owner)).statusCode).toBe(200);
    const page = (await h.request('GET', '/api/products?limit=50&marketplaceId=talabat&marketplaceStatus=mismatch', s, s.owner)).json().data;
    expect(page.items).toHaveLength(50);
    expect(page.items.every((i: { marketplace: { comparison: string } }) => i.marketplace.comparison === 'mismatch')).toBe(true);
    const timings: Record<string, number> = {
      'GET /api/products?marketplaceId=talabat': await time(query('')),
      '... &marketplaceStatus=mismatch': await time(query('&marketplaceStatus=mismatch')),
      '... &marketplaceStatus=in_sync': await time(query('&marketplaceStatus=in_sync')),
      '... &marketplaceStatus=not_in_file': await time(query('&marketplaceStatus=not_in_file')),
      '... &marketplaceStatus=mismatch&q=milk': await time(query('&marketplaceStatus=mismatch&q=milk')),
      '... &marketplaceStatus=mismatch page 2': await time(query('&marketplaceStatus=mismatch&cursor=' + page.nextCursor)),
    };
    const ids = (page.items as { id: string }[]).map(i => i.id);
    const valuesPlan = (await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${marketplaceValuesSql(s.id, 'talabat', ids)}`))
      .map(r => r['QUERY PLAN']).join('\n');
    // The shape of the Prisma relation filters for mismatch: EXISTS on listings and on recon_rows.
    const filterPlan = await explain(`
      SELECT id, name_en FROM products p WHERE p.tenant_id = $1::uuid
        AND EXISTS (SELECT 1 FROM listings l WHERE l.tenant_id = p.tenant_id AND l.product_id = p.id AND l.marketplace_id = 'talabat')
        AND EXISTS (SELECT 1 FROM recon_rows r WHERE r.tenant_id = p.tenant_id AND r.product_id = p.id AND r.marketplace_id = 'talabat'
                    AND (r.status = 'mismatch' OR (r.status = 'missing_from_erp' AND r.stock_issue IS NOT NULL)))
      ORDER BY name_en, id LIMIT 51`, [s.id]);
    console.log('[perf] ' + JSON.stringify({ products: PRODUCTS, marketplace: 'talabat', medianMs: timings }, null, 2));
    console.log('[perf] EXPLAIN page marketplace values (50 ids)\n' + valuesPlan);
    console.log('[perf] EXPLAIN marketplaceStatus=mismatch filter (equivalent SQL)\n' + filterPlan);
    expect(valuesPlan).toMatch(/listings_tenant_id_marketplace_id_product_id_idx/);
    expect(valuesPlan).not.toMatch(/Seq Scan on (listings|recon_rows)/);
    for (const [label, ms] of Object.entries(timings)) expect([label, ms <= SLOW_MS]).toEqual([label, true]);
  }, 600_000);
});
