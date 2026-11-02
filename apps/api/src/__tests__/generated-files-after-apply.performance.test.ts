import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import ExcelJS from 'exceljs';
import { createHarness, type Harness, type Store } from './harness.js';
import { processUpload } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';
import { marketplaceWorkbook, talabatHeaders, talabatMapping } from '../../../../packages/core/src/__tests__/fixtures/marketplace-files.js';

/**
 * G12 follow-up: apply and recompute ANALYZE what they rewrote, after commit. A preview right after the pipeline (no
 * manual ANALYZE anywhere in this file) must be fast, and the statistics must come from the workers (last_analyze is
 * only set by an explicit ANALYZE; autovacuum sets last_autoanalyze).
 */
const realPostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const ROWS = Number(process.env.FILES_APPLY_SCALE_ROWS) || 25_000;
/** About 2.5 s is reading the 25,000-row original file (a second preview takes as long); a plan built without
 * statistics shows up as minutes (GeneratedFilesRepository.reconRows), not as a slower second. */
const PREVIEW_BUDGET_MS = 8_000;
const BARCODE = (i: number) => String(6_281_000_000_000 + i);

let h: Harness, store: Store;
const logged: { message?: string; analyzeMs?: unknown; source?: string }[] = [];
const log = { info: (o: object, message?: string) => { logged.push({ ...(o as object), message }); }, warn: (o: object, message?: string) => { logged.push({ ...(o as object), message }); } };

async function applyFile(source: string, data: Buffer, fields: Record<string, string>) {
  const created = await h.request('POST', '/api/uploads', store, store.owner, { source, fileName: `${source}.xlsx`, size: data.length });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  await h.storage.put((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).storageKey, data);
  expect((await h.request('POST', `/api/uploads/${id}/complete`, store, store.owner)).statusCode).toBe(200);
  if ((await h.request('GET', `/api/uploads/${id}`, store, store.owner)).json().data.status === 'needs_mapping') {
    expect((await h.request('POST', `/api/uploads/${id}/mapping`, store, store.owner, { fields })).statusCode).toBe(200);
  }
  expect((await h.request('POST', `/api/uploads/${id}/apply`, store, store.owner)).statusCode).toBe(200);
  expect((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).status).toBe('applied');
  await h.recon.drain();
}

realPostgres(`G1 preview right after a ${ROWS.toLocaleString('en')}-row apply, without a manual ANALYZE (real PostgreSQL)`, () => {
  const pipeline: Record<string, number> = {};
  beforeAll(async () => {
    h = await createHarness();
    const deps = { database: h.fixture.database, storage: h.storage, log };
    h.queue.handler = job => processUpload(deps, job).then(() => undefined);
    h.queue.applyHandler = job => applyUpload({ ...deps, recon: h.recon }, job).then(() => undefined);
    h.recon.handler = job => recomputeRecon(deps, job);
    store = await h.createOwner('filesapplyperf');

    let t = performance.now();
    const erp = new ExcelJS.Workbook();
    const ws = erp.addWorksheet('ERP');
    ws.addRow(['Barcode', 'Item Name', 'Sale Price', 'Qty']);
    for (let i = 0; i < ROWS; i++) ws.addRow([BARCODE(i), `Product ${i}`, 2.5, 5]);
    await applyFile('erp', Buffer.from(await erp.xlsx.writeBuffer()), { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' });
    pipeline.erpUploadToReconMs = Math.round(performance.now() - t);

    t = performance.now();
    // every other listing is priced below the ERP price: ROWS / 2 price mismatches against the ERP reference
    const rows = Array.from({ length: ROWS }, (_, i) => [`T-scale-${i}`, `Product ${i}`, i % 2 ? '2.50' : '1.75', true, null, false, null, null, null, BARCODE(i), null, null, null, null, null, null, 'Dairy']);
    await applyFile('talabat', await marketplaceWorkbook(talabatHeaders, rows), talabatMapping);
    pipeline.talabatUploadToReconMs = Math.round(performance.now() - t);
  }, 900_000);
  afterAll(async () => { await h?.recon.drain(); await h?.close(); });

  it('the workers refreshed the statistics and the first preview is fast', async () => {
    const stats = await h.fixture.prisma.$queryRaw<{ table: string; analyzed: boolean; rows: number }[]>`
      SELECT relname AS table, last_analyze IS NOT NULL AS analyzed, n_live_tup::int AS rows FROM pg_stat_user_tables
      WHERE schemaname = current_schema() AND relname IN ('products', 'listings', 'recon_rows') ORDER BY relname`;
    const analyzeMs = logged.filter(l => l.message === 'Upload applied' || l.message === 'Recon recomputed').map(l => ({ step: l.message, analyzeMs: l.analyzeMs }));
    expect(logged.filter(l => l.message === 'Could not refresh planner statistics')).toEqual([]);

    const body = { marketplaceId: 'talabat', kind: 'price', scope: 'mismatches', reference: 'erp' };
    const t = performance.now();
    const response = await h.request('POST', '/api/generated-files/preview', store, store.owner, body);
    const previewMs = Math.round(performance.now() - t);
    expect(response.statusCode).toBe(200);
    const independent = await h.fixture.prisma.reconRow.count({ where: { tenantId: store.id, marketplaceId: 'talabat', priceMismatchVsErp: true } });
    expect(independent).toBe(ROWS / 2);
    expect(response.json().data).toMatchObject({ productCount: independent, priceChanges: independent, notInFile: 0 });
    const t2 = performance.now();
    expect((await h.request('POST', '/api/generated-files/preview', store, store.owner, body)).statusCode).toBe(200);
    const secondPreviewMs = Math.round(performance.now() - t2);
    console.info(JSON.stringify({ previewAfterApply: { rows: ROWS, ...pipeline, analyzeMs, stats, previewMs, secondPreviewMs } }, null, 2));
    expect(stats.map(s => [s.table, s.analyzed])).toEqual([['listings', true], ['products', true], ['recon_rows', true]]);
    expect(previewMs).toBeLessThan(PREVIEW_BUDGET_MS);
  }, 120_000);
});
