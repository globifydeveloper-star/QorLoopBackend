import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { processUpload } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';
import { InlineReconQueue } from '../../../../packages/shared/src/recon.js';
import { loadGenerationInputs } from '../../../../packages/shared/src/generated-files.js';

/** ERP change review and catalogue stock (ADR 017) through the real API, pipeline, apply and recon workers. */
let h: Harness;
let recon: InlineReconQueue;
let a: Store, b: Store;
let manager: Session, analyst: Session, managerB: Session;

async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const erpHeader = ['Barcode', 'Item Name', 'Sale Price', 'Qty'];
const erpFields = { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' };
const talabatHeader = ['sku', 'barcode 1', 'name', 'price', 'active'];
const talabatFields = { marketplaceProductId: 'sku', barcode1: 'barcode 1', name: 'name', price: 'price', available: 'active' };
const A = '6281000000011', B = '6281000000028', C = '6281000000035', D = '6281000000042', E = '6281000000059';

/** Upload, map, review, apply; the inline queues run the real workers. Returns the upload id. */
async function uploadFile(store: Store, who: Session, source: string, rows: unknown[][], fields: Record<string, string>, apply = true) {
  const file = await xlsx(rows);
  const created = await h.request('POST', '/api/uploads', store, who, { source, fileName: `${source}.xlsx`, size: file.length, contains: 'full' });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  h.storage.put((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).storageKey, file);
  expect((await h.request('POST', `/api/uploads/${id}/complete`, store, who)).statusCode).toBe(200);
  const status = async () => (await h.request('GET', `/api/uploads/${id}`, store, who)).json().data.status;
  if (await status() === 'needs_mapping') expect((await h.request('POST', `/api/uploads/${id}/mapping`, store, who, { fields })).statusCode).toBe(200);
  expect(await status()).toBe('needs_review');
  if (apply) {
    expect((await h.request('POST', `/api/uploads/${id}/apply`, store, who)).statusCode).toBe(200);
    expect(await status()).toBe('applied');
    await recon.drain();
  }
  return id;
}
/** A full ERP file: every product listed (barcode, name, price, stock). */
const erp = (store: Store, rows: [string, string, number, number][]) => uploadFile(store, manager, 'erp', [erpHeader, ...rows], erpFields);
const productId = async (store: Store, barcode: string) => (await h.fixture.prisma.product.findFirstOrThrow({ where: { tenantId: store.id, normalizedBarcode: barcode } })).id;
const get = async (url: string, store = a, who = manager) => {
  const r = await h.request('GET', url, store, who);
  return { status: r.statusCode, data: r.json().data };
};
const send = async (method: 'PUT' | 'POST' | 'DELETE', url: string, body?: Record<string, unknown>, store = a, who = manager) => {
  const r = await h.request(method, url, store, who, body);
  return { status: r.statusCode, data: r.json().data, body: r.json() };
};
const stockOf = (id: string) => get(`/api/products/${id}/stock`);
const talabatRow = async (barcode: string) => {
  const r = await get('/api/recon/rows?marketplaceId=talabat&limit=50&reference=marketplace');
  return (r.data.items as Record<string, unknown>[]).find(i => i.barcode === barcode)!;
};
const catalogueRows = (store: Store, reference: 'marketplace' | 'erp') =>
  h.fixture.database.readSnapshot(store.id, d => loadGenerationInputs(d, 'talabat', reference)).then(i => new Map(i.rows.map(r => [r.productId, r])));
const stockCalls = () => recon.calls.filter(c => c.reason === 'catalogue.stock').length;

let first: string, second: string;
let idA: string, idB: string, idC: string;

beforeAll(async () => {
  h = await createHarness();
  recon = h.recon as InlineReconQueue;
  h.queue.handler = job => processUpload({ database: h.fixture.database, storage: h.storage }, job).then(() => undefined);
  h.queue.applyHandler = job => applyUpload({ database: h.fixture.database, recon }, job).then(() => undefined);
  recon.handler = job => recomputeRecon({ database: h.fixture.database }, job);
  a = await h.createOwner('stocka');
  b = await h.createOwner('stockb');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
  managerB = await h.member(b, 'catalogue_manager');
  // first import: four active products
  first = await erp(a, [[A, 'Laban', 10, 5], [B, 'Juice', 4, 0], [C, 'Water', 1, 10], [D, 'Bread', 2, 3]]);
  await uploadFile(a, manager, 'talabat', [talabatHeader, ['T-A', A, 'Laban', 10, 'TRUE'], ['T-B', B, 'Juice', 4, 'FALSE'], ['T-C', C, 'Water', 1, 'TRUE'], ['T-D', D, 'Bread', 2, 'TRUE']], talabatFields);
  [idA, idB, idC] = [await productId(a, A), await productId(a, B), await productId(a, C)];
  // a fixed price on A: the change list says it still applies (D6)
  expect((await send('PUT', `/api/products/${idA}/price-rule`, { mode: 'fixed', value: 12 })).status).toBe(200);
  await recon.drain();
  // next day: A price 11, B stock 0 -> 6, C renamed, D gone, E new
  second = await erp(a, [[A, 'Laban', 11, 5], [B, 'Juice', 4, 6], [C, 'Water 1L', 1, 10], [E, 'Eggs', 7, 12]]);
}, 180_000);
afterAll(async () => { await h.close(); });

describe('GET /api/uploads/:id/changes', () => {
  it('lists what the first import created', async () => {
    const r = await get(`/api/uploads/${first}/changes?kind=new`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ changesRecorded: true, kind: 'new', total: 4, counts: { all: 4, new: 4, price: 0, stockConflicts: 0 } });
    expect(r.data.rows.map((x: { barcode: string; rowNumber: number }) => [x.barcode, x.rowNumber])).toEqual([[A, 2], [B, 3], [C, 4], [D, 5]]);
  });

  it('lists the next ERP file\'s changes by kind, in file order with missing products last', async () => {
    const r = await get(`/api/uploads/${second}/changes`);
    expect(r.data.counts).toMatchObject({ all: 5, new: 1, price: 1, stock: 1, name: 1, missing: 1, cost: 0, stockConflicts: 0 });
    expect(r.data.rows.map((x: { kind: string }) => x.kind)).toEqual(['price', 'stock', 'name', 'new', 'missing']);
    const [price, stock, name, , missing] = r.data.rows;
    expect(price).toMatchObject({ productId: idA, barcode: A, field: 'erpPrice', old: 10, new: 11, fixedPriceRule: true, catalogueStock: null, product: { nameEn: 'Laban', status: 'active' } });
    expect(stock).toMatchObject({ productId: idB, field: 'erpStock', old: 0, new: 6, stockConflict: false, fixedPriceRule: null, catalogueStock: { erpStock: 6, catalogueStock: 6, source: 'erp', conflict: null } });
    expect(name).toMatchObject({ field: 'nameEn', old: 'Water', new: 'Water 1L' });
    expect(missing).toMatchObject({ barcode: D, rowNumber: null, field: 'inLatestErpFile', old: true, new: false });
  });

  it('filters and pages', async () => {
    const page = await get(`/api/uploads/${second}/changes?pageSize=2&page=2`);
    expect(page.data).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(page.data.rows.map((x: { kind: string }) => x.kind)).toEqual(['name', 'new']);
    expect((await get(`/api/uploads/${second}/changes?kind=stock`)).data.total).toBe(1);
    expect((await get(`/api/uploads/${second}/changes?conflict=true`)).data.total).toBe(0);
  });

  it('the review summary now counts names and compares prices at 3 decimals; the apply records what it did', async () => {
    const u = (await get(`/api/uploads/${second}`)).data;
    expect(u.summary).toMatchObject({ priceChanges: 1, stockChanges: 1, nameChanges: 1, costChanges: 0, stockConflicts: 0, newProducts: 1, missingFromFile: 1 });
    expect(u.summary.applied).toEqual({ changesRecorded: true, changes: 5, stockConflicts: 0, stockEditsCleared: 0 });
  });

  it('Analyst may read it; a marketplace upload is 400, an upload not applied 409, another store\'s 404, bad query 400', async () => {
    expect((await get(`/api/uploads/${second}/changes`, a, analyst)).status).toBe(200);
    expect((await get(`/api/uploads/${second}/changes?kind=cost`, a, analyst)).status).toBe(400); // costs hidden from Analyst
    expect((await get(`/api/uploads/${second}/changes`, a, analyst)).data.counts.cost).toBeUndefined();
    const talabat = (await h.fixture.prisma.upload.findFirstOrThrow({ where: { tenantId: a.id, source: 'talabat' } })).id;
    expect((await get(`/api/uploads/${talabat}/changes`)).status).toBe(400);
    const pending = await uploadFile(a, manager, 'erp', [erpHeader, [A, 'Laban', 11, 5]], erpFields, false);
    expect((await get(`/api/uploads/${pending}/changes`)).status).toBe(409);
    expect((await send('POST', `/api/uploads/${pending}/discard`)).status).toBe(200);
    expect((await get(`/api/uploads/${second}/changes`, b, managerB)).status).toBe(404);
    expect((await get(`/api/uploads/${second}/changes?kind=bogus`)).status).toBe(400);
  });
});

describe('editing the catalogue stock', () => {
  it('starts equal to the ERP stock', async () => {
    expect((await stockOf(idA)).data).toMatchObject({ erpStock: 5, catalogueStock: 5, source: 'erp', conflict: null, edit: null });
    const listed = (await get('/api/products?q=Laban')).data.items[0];
    expect(listed).toMatchObject({ erpStock: 5, catalogueStock: 5, catalogueStockSource: 'erp', stockConflict: false });
  });

  it('sets an owner value with who, when and why; one recon recompute; recon and the files use it', async () => {
    const before = stockCalls();
    const r = await send('PUT', `/api/products/${idA}/stock`, { stock: 0, reason: 'Damaged on the shelf', expected: { erpStock: 5, catalogueStock: 5 } });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ changed: true, erpStock: 5, catalogueStock: 0, source: 'owner', edit: { stock: 0, erpStockAtEdit: 5, state: 'active', reason: 'Damaged on the shelf' } });
    expect(r.data.edit.setBy.name).toBe('catalogue_manager');
    expect(stockCalls()).toBe(before + 1);
    await recon.drain();
    // the catalogue reference uses the catalogue stock, the ERP reference the ERP stock; both shown
    const row = await talabatRow(A);
    expect(row).toMatchObject({ erpStock: 5, catalogueStock: 0, catalogueStockSource: 'owner', catalogueAvailable: false, erpAvailable: true,
      stockIssue: 'available_but_out_of_stock', stockIssueVsCatalogue: 'available_but_out_of_stock', stockIssueVsErp: null });
    const erpRow = (await get('/api/recon/rows?marketplaceId=talabat&limit=50&reference=erp')).data.items.find((i: { barcode: string }) => i.barcode === A);
    expect(erpRow.stockIssue).toBeNull();
    // generated files: availability per reference
    expect((await catalogueRows(a, 'marketplace')).get(idA)).toMatchObject({ available: false, stockIssue: 'available_but_out_of_stock' });
    expect((await catalogueRows(a, 'erp')).get(idA)).toMatchObject({ available: true, stockIssue: null });
    const history = (await get(`/api/products/${idA}/history`)).data.items.map((i: { type: string; summary: string }) => [i.type, i.summary]);
    expect(history).toContainEqual(['product.stock_set', 'Catalogue stock set']);
  });

  it('stock summaries count per reference', async () => {
    const mp = (await get('/api/recon/summary?reference=marketplace')).data.marketplaces[0];
    const er = (await get('/api/recon/summary?reference=erp')).data.marketplaces[0];
    // B: listed unavailable and ERP stock 6 -> both references flag it; A: only the catalogue reference
    expect(mp.stock - er.stock).toBe(1);
  });

  it('stale expected values are 409; Analyst 403; another store\'s product 404; invalid stock 400', async () => {
    expect((await send('PUT', `/api/products/${idA}/stock`, { stock: 1, expected: { erpStock: 5, catalogueStock: 5 } })).status).toBe(409);
    expect((await send('PUT', `/api/products/${idA}/stock`, { stock: 1, expected: { erpStock: 5, catalogueStock: 0 } }, a, analyst)).status).toBe(403);
    expect((await send('PUT', `/api/products/${idA}/stock`, { stock: 1, expected: { erpStock: 5, catalogueStock: 0 } }, b, managerB)).status).toBe(404);
    expect((await send('PUT', `/api/products/${idA}/stock`, { stock: -1, expected: { erpStock: 5, catalogueStock: 0 } })).status).toBe(400);
    expect((await send('PUT', `/api/products/${idA}/stock`, { stock: 1.5, expected: { erpStock: 5, catalogueStock: 0 } })).status).toBe(400);
    expect((await stockOf(idA)).data.catalogueStock).toBe(0);
  });

  it('the same value is unchanged; the ERP value clears the edit; DELETE goes back to ERP', async () => {
    expect((await send('PUT', `/api/products/${idC}/stock`, { stock: 7, expected: { erpStock: 10, catalogueStock: 10 } })).data.changed).toBe(true);
    expect((await send('PUT', `/api/products/${idC}/stock`, { stock: 7, expected: { erpStock: 10, catalogueStock: 7 } })).data.changed).toBe(false);
    expect((await send('PUT', `/api/products/${idC}/stock`, { stock: 10, expected: { erpStock: 10, catalogueStock: 7 } })).data).toMatchObject({ changed: true, source: 'erp', edit: null });
    await send('PUT', `/api/products/${idC}/stock`, { stock: 4, expected: { erpStock: 10, catalogueStock: 10 } });
    expect((await send('DELETE', `/api/products/${idC}/stock?expectedErpStock=10&expectedCatalogueStock=4`)).data).toMatchObject({ changed: true, catalogueStock: 10, source: 'erp' });
    expect((await send('DELETE', `/api/products/${idC}/stock?expectedErpStock=10&expectedCatalogueStock=10`)).data.changed).toBe(false);
  });
});

describe('a later ERP upload that changes an edited stock', () => {
  let third: string;
  beforeAll(async () => {
    // A: ERP stock 5 -> 8 while the owner says 0
    third = await erp(a, [[A, 'Laban', 11, 8], [B, 'Juice', 4, 6], [C, 'Water 1L', 1, 10], [E, 'Eggs', 7, 12]]);
  });

  it('is predicted by the review, flagged on the change row and listed with both values', async () => {
    expect((await get(`/api/uploads/${third}`)).data.summary).toMatchObject({ stockConflicts: 1, applied: { stockConflicts: 1 } });
    const rows = (await get(`/api/uploads/${third}/changes?conflict=true`)).data;
    expect(rows.total).toBe(1);
    expect(rows.rows[0]).toMatchObject({ productId: idA, old: 5, new: 8, stockConflict: true, catalogueStock: { catalogueStock: 0, source: 'owner', conflict: { ownerStock: 0, erpStock: 8, erpStockAtEdit: 5, inEffect: 'owner' } } });
    const list = (await get('/api/catalogue/stock/conflicts')).data;
    expect(list).toMatchObject({ inEffect: 'owner', total: 1 });
    expect(list.rows[0]).toMatchObject({ productId: idA, erpStock: 8, ownerStock: 0, erpStockAtEdit: 5, catalogueStock: 0, reason: 'Damaged on the shelf', conflictUploadId: third });
  });

  it('D1: the owner value stays in effect; the dashboard shows the count', async () => {
    expect((await get('/api/catalogue/stock/conflicts/count')).data).toEqual({ count: 1 });
    expect((await get('/api/recon/summary')).data.stockConflicts).toBe(1);
    expect(await talabatRow(A)).toMatchObject({ catalogueStock: 0, stockConflict: true, catalogueAvailable: false });
    expect((await get('/api/catalogue/stock/conflicts/count', a, analyst)).data.count).toBe(1);
    expect((await get('/api/catalogue/stock/conflicts/count', b, managerB)).data.count).toBe(0);
  });

  it('"keep mine" re-bases the edit on the current ERP stock; stale or absent conflicts are 409', async () => {
    expect((await send('POST', `/api/products/${idA}/stock/resolve`, { choice: 'keep', expected: { erpStock: 5, ownerStock: 0 } })).status).toBe(409);
    expect((await send('POST', `/api/products/${idA}/stock/resolve`, { choice: 'keep', expected: { erpStock: 8, ownerStock: 0 } }, a, analyst)).status).toBe(403);
    const r = await send('POST', `/api/products/${idA}/stock/resolve`, { choice: 'keep', expected: { erpStock: 8, ownerStock: 0 } });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ catalogueStock: 0, source: 'owner', conflict: null, edit: { erpStockAtEdit: 8, state: 'active' } });
    expect((await send('POST', `/api/products/${idA}/stock/resolve`, { choice: 'keep', expected: { erpStock: 8, ownerStock: 0 } })).status).toBe(409);
    expect((await get('/api/catalogue/stock/conflicts/count')).data.count).toBe(0);
  });

  it('an ERP stock that reaches the owner value removes the edit (no conflict)', async () => {
    const fourth = await erp(a, [[A, 'Laban', 11, 0], [B, 'Juice', 4, 6], [C, 'Water 1L', 1, 10], [E, 'Eggs', 7, 12]]);
    expect((await get(`/api/uploads/${fourth}`)).data.summary.applied).toMatchObject({ stockConflicts: 0, stockEditsCleared: 1 });
    expect((await stockOf(idA)).data).toMatchObject({ erpStock: 0, catalogueStock: 0, source: 'erp', edit: null });
    const history = (await get(`/api/products/${idA}/history`)).data.items.map((i: { type: string }) => i.type);
    expect(history).toContain('product.stock_reset');
  });

  it('"use ERP" removes the edit; only stock changes raise a conflict (D2)', async () => {
    await send('PUT', `/api/products/${idA}/stock`, { stock: 2, expected: { erpStock: 0, catalogueStock: 0 } });
    // price-only change on A: no conflict
    const priceOnly = await erp(a, [[A, 'Laban', 13, 0], [B, 'Juice', 4, 6], [C, 'Water 1L', 1, 10], [E, 'Eggs', 7, 12]]);
    expect((await get(`/api/uploads/${priceOnly}`)).data.summary.applied.stockConflicts).toBe(0);
    await erp(a, [[A, 'Laban', 13, 9], [B, 'Juice', 4, 6], [C, 'Water 1L', 1, 10], [E, 'Eggs', 7, 12]]);
    expect((await stockOf(idA)).data.conflict).toMatchObject({ ownerStock: 2, erpStock: 9 });
    const r = await send('POST', `/api/products/${idA}/stock/resolve`, { choice: 'erp', expected: { erpStock: 9, ownerStock: 2 } });
    expect(r.data).toMatchObject({ catalogueStock: 9, source: 'erp', edit: null, conflict: null });
    await recon.drain();
    expect(await talabatRow(A)).toMatchObject({ catalogueStock: 9, catalogueAvailable: true, stockIssue: null });
  });
});

describe('bulk catalogue stock', () => {
  const body = () => ({ selection: { productIds: [idB, idC] }, action: { mode: 'set', stock: 0 }, reason: 'Stock count' });

  it('previews, applies once with one event and one recompute, and replays the same key', async () => {
    const preview = await send('POST', '/api/catalogue/stock/bulk/preview', body());
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ selected: 2, willChange: 2, unchanged: 0, notFound: 0, sets: 2, clears: 0, limit: 5000 });
    expect(preview.data.rows[0]).toMatchObject({ op: 'set', old: { source: 'erp' }, new: { stock: 0, source: 'owner' } });
    const before = stockCalls();
    const key = 'bulk-stock-0001';
    const applied = await send('POST', '/api/catalogue/stock/bulk/apply', { ...body(), idempotencyKey: key, previewToken: preview.data.previewToken });
    expect(applied.status).toBe(200);
    expect(applied.data).toMatchObject({ replayed: false, willChange: 2, sets: 2 });
    expect(stockCalls()).toBe(before + 1);
    const again = await send('POST', '/api/catalogue/stock/bulk/apply', { ...body(), idempotencyKey: key, previewToken: preview.data.previewToken });
    expect(again.data).toMatchObject({ replayed: true, operationId: applied.data.operationId, willChange: 2 });
    expect(stockCalls()).toBe(before + 1);
    expect((await send('POST', '/api/catalogue/stock/bulk/apply', { ...body(), action: { mode: 'erp' }, idempotencyKey: key })).status).toBe(409);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'catalogue.stock_bulk_set' } })).toBe(1);
    expect((await stockOf(idB)).data).toMatchObject({ catalogueStock: 0, source: 'owner', edit: { reason: 'Stock count' } });
    const history = (await get(`/api/products/${idB}/history`)).data.items.map((i: { summary: string }) => i.summary);
    expect(history).toContain('Catalogue stock changed by a bulk operation');
  });

  it('a stale preview token is 409 and writes nothing', async () => {
    const preview = await send('POST', '/api/catalogue/stock/bulk/preview', { ...body(), action: { mode: 'erp' } });
    await send('PUT', `/api/products/${idC}/stock`, { stock: 3, expected: { erpStock: 10, catalogueStock: 0 } });
    const r = await send('POST', '/api/catalogue/stock/bulk/apply', { ...body(), action: { mode: 'erp' }, idempotencyKey: 'bulk-stock-0002', previewToken: preview.data.previewToken });
    expect(r.status).toBe(409);
    expect((await stockOf(idB)).data.source).toBe('owner');
  });

  it('a filter selection and back to ERP; another store\'s ids are not found; Analyst 403', async () => {
    const r = await send('POST', '/api/catalogue/stock/bulk/apply', { selection: { filter: {} }, action: { mode: 'erp' }, idempotencyKey: 'bulk-stock-0003' });
    expect(r.data).toMatchObject({ selected: 5, clears: 2 });
    const other = await send('POST', '/api/catalogue/stock/bulk/preview', body(), b, managerB);
    expect(other.data).toMatchObject({ selected: 2, notFound: 2, willChange: 0 });
    expect((await send('POST', '/api/catalogue/stock/bulk/preview', body(), a, analyst)).status).toBe(403);
  });
});

describe('bulk conflict resolution', () => {
  beforeAll(async () => {
    await send('PUT', `/api/products/${idB}/stock`, { stock: 1, expected: { erpStock: 6, catalogueStock: 6 } });
    await send('PUT', `/api/products/${idC}/stock`, { stock: 2, expected: { erpStock: 10, catalogueStock: 10 } });
    await erp(a, [[A, 'Laban', 13, 9], [B, 'Juice', 4, 7], [C, 'Water 1L', 1, 11], [E, 'Eggs', 7, 12]]);
  });

  it('previews and resolves every open conflict once, idempotently', async () => {
    expect((await get('/api/catalogue/stock/conflicts/count')).data.count).toBe(2);
    const preview = await send('POST', '/api/catalogue/stock/conflicts/resolve/preview', { selection: { all: true }, choice: 'keep' });
    expect(preview.data).toMatchObject({ selected: 2, willResolve: 2, notInConflict: 0, notFound: 0 });
    const body = { selection: { all: true }, choice: 'keep', idempotencyKey: 'resolve-0001', previewToken: preview.data.previewToken };
    const applied = await send('POST', '/api/catalogue/stock/conflicts/resolve/apply', body);
    expect(applied.data).toMatchObject({ replayed: false, willResolve: 2 });
    expect((await send('POST', '/api/catalogue/stock/conflicts/resolve/apply', body)).data).toMatchObject({ replayed: true, operationId: applied.data.operationId });
    expect((await get('/api/catalogue/stock/conflicts/count')).data.count).toBe(0);
    expect((await stockOf(idB)).data).toMatchObject({ catalogueStock: 1, edit: { erpStockAtEdit: 7, state: 'active' } });
    const history = (await get(`/api/products/${idC}/history`)).data.items.map((i: { summary: string }) => i.summary);
    expect(history).toContain('Stock conflict resolved in bulk: kept the catalogue stock');
  });

  it('explicit ids count products without a conflict', async () => {
    const r = await send('POST', '/api/catalogue/stock/conflicts/resolve/preview', { selection: { productIds: [idA, idB] }, choice: 'erp' });
    expect(r.data).toMatchObject({ selected: 2, willResolve: 0, notInConflict: 2 });
  });
});
