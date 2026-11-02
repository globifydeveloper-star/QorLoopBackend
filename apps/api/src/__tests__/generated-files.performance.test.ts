import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createHarness, type Harness, type Store } from './harness.js';
import { marketplaceWorkbook, talabatHeaders, talabatMapping } from '../../../../packages/core/src/__tests__/fixtures/marketplace-files.js';
import { generateFile } from '../../../worker/src/generate-file.js';
import { readSpreadsheetValues } from '../../../../packages/core/src/upload/parse.js';
import { storageKeys } from '../../../../packages/shared/src/storage.js';
import type { GenerateFileJob } from '../../../../packages/shared/src/generated-files.js';

const realPostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let h: Harness, store: Store, actorId: string;
const SOURCE_ROWS = 25_000, UPDATE_ROWS = 14_000;

realPostgres('G1 25,000-row source / 14,000 updates (real PostgreSQL)', () => {
  beforeAll(async () => {
    h = await createHarness(); store = await h.createOwner('filesperf');
    actorId = (await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id } })).id;
    const db = h.fixture.prisma;
    await db.$executeRaw`
      INSERT INTO products (id, tenant_id, barcode, normalized_barcode, sku, name_en, erp_price, erp_stock, status, updated_at)
      SELECT gen_random_uuid(), ${store.id}::uuid, (6281000000000::bigint + i)::text, (6281000000000::bigint + i)::text,
             'scale-' || i, 'Product ' || i, 2.5, 5, 'active', now() FROM generate_series(0, ${SOURCE_ROWS - 1}::int) i`;
    await db.$executeRaw`
      INSERT INTO listings (id, tenant_id, product_id, marketplace_id, marketplace_product_id, barcodes, price, available, updated_at)
      SELECT gen_random_uuid(), tenant_id, id, 'talabat', 'T-' || sku, ARRAY[barcode], 1.75, true, now()
      FROM products WHERE tenant_id = ${store.id}::uuid`;
    await db.$executeRaw`
      INSERT INTO recon_rows (id, tenant_id, product_id, marketplace_id, erp_price, marketplace_price, actual_price, erp_available, actual_available,
                              price_mismatch_vs_erp, price_mismatch_vs_marketplace, status, status_vs_erp)
      SELECT gen_random_uuid(), tenant_id, id, 'talabat', 2.5,
             CASE WHEN split_part(sku, '-', 2)::int < ${UPDATE_ROWS} THEN 2.5 ELSE 1.75 END,
             1.75, true, true, true, split_part(sku, '-', 2)::int < ${UPDATE_ROWS},
             CASE WHEN split_part(sku, '-', 2)::int < ${UPDATE_ROWS} THEN 'mismatch' ELSE 'in_sync' END, 'mismatch'
      FROM products WHERE tenant_id = ${store.id}::uuid`;
    const rows = Array.from({ length: SOURCE_ROWS }, (_, i) => [`T-scale-${i}`, `Product ${i}`, '1.75', true, null, false, null, null, null, String(6281000000000 + i), null, null, null, null, null, null, 'Dairy']);
    const buffer = await marketplaceWorkbook(talabatHeaders, rows);
    const uploadId = randomUUID(), key = storageKeys.upload(store.id, uploadId, '.xlsx');
    await h.storage.put(key, buffer);
    await db.upload.create({ data: { id: uploadId, tenantId: store.id, source: 'talabat', fileName: 'talabat-scale.xlsx', size: buffer.length, storageKey: key,
      uploadedById: actorId, status: 'applied', appliedAt: new Date(), mapping: talabatMapping, headers: talabatHeaders, sheetName: 'Marketplace' } });
  }, 120_000);
  afterAll(async () => { await h?.close(); });

  it('preview, generated output and independent SQL counts agree, with a few-second worker budget', async () => {
    const job: GenerateFileJob = { tenantId: store.id, actorId, requestId: randomUUID(), marketplaceId: 'talabat', kind: 'price', scope: 'mismatches', reference: 'marketplace', requestedAt: new Date().toISOString() };
    const startPreview = performance.now();
    const response = await h.request('POST', '/api/generated-files/preview', store, store.owner, { marketplaceId: job.marketplaceId, kind: job.kind, scope: job.scope, reference: job.reference });
    const previewMs = Math.round(performance.now() - startPreview);
    expect(response.statusCode).toBe(200);
    const preview = response.json().data;
    expect(preview).toMatchObject({ productCount: UPDATE_ROWS, priceChanges: UPDATE_ROWS, availabilityChanges: 0, notInFile: 0 });
    const t = performance.now();
    const result = await generateFile({ database: h.fixture.database, storage: h.storage }, job);
    const workerMs = Math.round(performance.now() - t);
    const file = await h.fixture.prisma.generatedFile.findUniqueOrThrow({ where: { id: result.fileId } });
    const independentCount = await h.fixture.prisma.reconRow.count({ where: { tenantId: store.id, marketplaceId: 'talabat', priceMismatchVsMarketplace: true } });
    expect(file.productCount).toBe(independentCount);
    const written = await readSpreadsheetValues({ path: '', buffer: h.storage.objects.get(file.storageKey)! }, 'xlsx');
    expect(written.raw.length - 1).toBe(independentCount);
    expect(written.raw[0]).toEqual(talabatHeaders);
    for (const row of written.raw.slice(1)) { expect(row[2]).toBe('2.50'); expect(row[3]).toBe(true); }
    console.info(JSON.stringify({ g1Performance: { sourceRows: SOURCE_ROWS, reconRowsWritten: independentCount, previewMs, workerMs } }));
    expect(workerMs).toBeLessThan(8_000);
  }, 60_000);
});
