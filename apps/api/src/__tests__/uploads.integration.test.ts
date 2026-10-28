import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { processUpload, markFailed, recoverStuckUploads } from '../../../worker/src/process-upload.js';
import type { ProcessUploadJob } from '../../../../packages/shared/src/queue.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session, analyst: Session, admin: Session, otherManager: Session, analystB: Session;
const external = Boolean(process.env.TEST_DATABASE_URL);

async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const erpHeader = ['Barcode', 'Item Name', 'Sale Price', 'Qty'];

/** Drives the real API: create -> (client PUT to storage) -> complete. The inline queue runs the real worker. */
async function upload(store: Store, who: Session, file: Buffer, opts: { source?: string; fileName?: string; contains?: string } = {}) {
  const created = await h.request('POST', '/api/uploads', store, who, { source: opts.source ?? 'erp', fileName: opts.fileName ?? 'erp.xlsx', size: file.length, contains: opts.contains ?? 'full' });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  const row = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } });
  h.storage.put(row.storageKey, file);
  const done = await h.request('POST', `/api/uploads/${id}/complete`, store, who);
  return { id, created: created.json().data, done, final: await status(store, who, id) };
}
async function status(store: Store, who: Session, id: string) { return (await h.request('GET', `/api/uploads/${id}`, store, who)).json().data; }

beforeAll(async () => {
  h = await createHarness();
  h.queue.handler = job => processUpload({ database: h.fixture.database, storage: h.storage }, job).then(() => undefined);
  a = await h.createOwner('alpha');
  b = await h.createOwner('beta');
  manager = await h.member(a, 'catalogue_manager');
  otherManager = await h.member(a, 'catalogue_manager');
  admin = await h.member(a, 'admin');
  analyst = await h.member(a, 'analyst');
  analystB = await h.member(b, 'analyst');
});
afterAll(async () => { await h.close(); });

describe('creating an upload', () => {
  it('returns a signed, tenant-prefixed upload target and never leaks the storage key', async () => {
    const r = await h.request('POST', '/api/uploads', a, manager, { source: 'erp', fileName: 'stock.xlsx', size: 1024, contains: 'full' });
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.status).toBe('uploading');
    expect(d.uploadMethod).toBe('PUT');
    expect(d.uploadUrl).toContain(`tenants/${a.id}/uploads/${d.id}/original.xlsx`);
    expect(d.uploadHeaders['Content-Type']).toContain('spreadsheetml');
    expect(JSON.stringify(d)).not.toMatch(/storageKey|checksum/);
  });
  it.each([
    [{ source: 'erp', fileName: 'x.exe', size: 10 }, 'extension'],
    [{ source: 'erp', fileName: 'x.xlsx', size: 25 * 1024 * 1024 + 1 }, 'size over 25 MB'],
    [{ source: 'erp', fileName: 'x.xlsx', size: 0 }, 'empty'],
    [{ source: 'amazon', fileName: 'x.xlsx', size: 10 }, 'unknown source'],
    [{ source: 'erp', fileName: '../x.xlsx', size: 10 }, 'path in file name'],
    [{ source: 'erp', fileName: 'x.xlsx', size: 10, tenantId: 'x' }, 'client-supplied tenant'],
  ])('rejects %j (%s)', async body => {
    expect((await h.request('POST', '/api/uploads', a, manager, body as Record<string, unknown>)).statusCode).toBe(400);
  });
  it('requires authentication', async () => {
    expect((await h.request('POST', '/api/uploads', a, undefined, { source: 'erp', fileName: 'x.xlsx', size: 10 })).statusCode).toBe(401);
    expect((await h.request('GET', '/api/uploads', a)).statusCode).toBe(401);
  });
});

describe('role permissions', () => {
  const body = { source: 'erp', fileName: 'x.xlsx', size: 10 };
  it('Owner, Admin and Catalogue Manager can upload; Analyst cannot but can view', async () => {
    expect((await h.request('POST', '/api/uploads', a, a.owner, body)).statusCode).toBe(200);
    expect((await h.request('POST', '/api/uploads', a, admin, body)).statusCode).toBe(200);
    expect((await h.request('POST', '/api/uploads', a, manager, body)).statusCode).toBe(200);
    expect((await h.request('POST', '/api/uploads', a, analyst, body)).statusCode).toBe(403);
    expect((await h.request('GET', '/api/uploads', a, analyst)).statusCode).toBe(200);
  });
  it('Analyst cannot map or discard', async () => {
    const id = (await h.request('POST', '/api/uploads', a, manager, body)).json().data.id;
    expect((await h.request('POST', `/api/uploads/${id}/mapping`, a, analyst, { fields: {} })).statusCode).toBe(403);
    expect((await h.request('POST', `/api/uploads/${id}/discard`, a, analyst)).statusCode).toBe(403);
  });
});

describe('completing an upload', () => {
  it('409 when the file never reached storage', async () => {
    const id = (await h.request('POST', '/api/uploads', a, manager, { source: 'erp', fileName: 'x.xlsx', size: 10 })).json().data.id;
    expect((await h.request('POST', `/api/uploads/${id}/complete`, a, manager)).statusCode).toBe(409);
  });
  it('rejects a size that differs from the declared size and deletes the object', async () => {
    const created = (await h.request('POST', '/api/uploads', a, manager, { source: 'erp', fileName: 'x.xlsx', size: 100 })).json().data;
    const row = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: created.id } });
    h.storage.put(row.storageKey, Buffer.alloc(99));
    expect((await h.request('POST', `/api/uploads/${created.id}/complete`, a, manager)).statusCode).toBe(400);
    expect((await status(a, manager, created.id)).status).toBe('rejected');
    expect(h.storage.objects.has(row.storageKey)).toBe(false);
  });
  it('only the uploader may complete it', async () => {
    const created = (await h.request('POST', '/api/uploads', a, manager, { source: 'erp', fileName: 'x.xlsx', size: 10 })).json().data;
    expect((await h.request('POST', `/api/uploads/${created.id}/complete`, a, otherManager)).statusCode).toBe(403);
  });
  it('enqueues exactly once, even when the client retries', async () => {
    const before = h.queue.jobs.length;
    const { id, done } = await upload(a, manager, await xlsx([erpHeader, ['111', 'A', 1, 1]]));
    expect(done.statusCode).toBe(200);
    expect(h.queue.jobs.length).toBe(before + 1);
    const again = await h.request('POST', `/api/uploads/${id}/complete`, a, manager);
    expect(again.statusCode).toBe(200);
    expect(h.queue.jobs.length).toBe(before + 1);
  });
});

describe('ERP pipeline: detect → suggest mapping → validate → review', () => {
  it('asks for a mapping, suggests one, then produces the review after confirmation', async () => {
    const file = await xlsx([
      ['Daily export'], erpHeader,
      ['06281000000011', 'Laban 1L', 1.75, 12],
      ['6281000000028', 'Milk 2L', '4.5', 0],
      ['', 'No barcode', 1, 1],
      [6281000000035, 'Bread', 2, 3],
      ['6281000000042', 'Eggs', 8, 3], ['6281000000059', 'Rice', 12, 3], ['6281000000066', 'Tea', 6, 3], ['6281000000073', 'Oil', 15, 3],
    ]);
    const { id, final } = await upload(a, manager, file);
    expect(final.status).toBe('needs_mapping');
    const s = await status(a, manager, id);
    expect(s.headers).toEqual(erpHeader);
    expect(s.mappingSuggestion.fields).toMatchObject({ barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' });
    expect(s.mappingSuggestion.missingRequired).toEqual([]);

    // an incomplete mapping is refused with details
    const bad = await h.request('POST', `/api/uploads/${id}/mapping`, a, manager, { fields: { barcode: 'Nope' } });
    expect(bad.statusCode).toBe(400);

    const ok = await h.request('POST', `/api/uploads/${id}/mapping`, a, manager, { fields: s.mappingSuggestion.fields, saveAs: 'Acme ERP export' });
    expect(ok.statusCode).toBe(200);
    const after = await status(a, manager, id);
    expect(after.status).toBe('needs_review');
    expect(after.summary).toMatchObject({ rowsRead: 8, newProducts: 7, rowsWithErrors: 1, firstImport: true });

    const review = (await h.request('GET', `/api/uploads/${id}/review?tab=new`, a, manager)).json().data;
    expect(review.total).toBe(7);
    expect(review.rows[0].parsed.data).toMatchObject({ barcode: '6281000000011', nameEn: 'Laban 1L', price: 1.75, stock: 12, rowNumber: 3 });
    const errors = (await h.request('GET', `/api/uploads/${id}/errors`, a, manager)).json().data;
    expect(errors.errors).toEqual([{ row: 5, column: 'Barcode', value: null, reason: 'Barcode is empty' }]);
    // the catalogue is untouched until the user applies
    expect(await h.fixture.prisma.product.count({ where: { tenantId: a.id } })).toBe(0);
  });

  it('recognises the saved layout on the next file and goes straight to review, with price/stock diffs', async () => {
    await h.fixture.prisma.product.createMany({ data: [
      { tenantId: a.id, barcode: '6281000000011', normalizedBarcode: '6281000000011', nameEn: 'Laban 1L', erpPrice: 1.5, erpStock: 12, status: 'active' },
      { tenantId: a.id, barcode: '6281000000028', normalizedBarcode: '6281000000028', nameEn: 'Milk 2L', erpPrice: 4.5, erpStock: 5, status: 'active' },
      { tenantId: a.id, barcode: '6281000000099', normalizedBarcode: '6281000000099', nameEn: 'Gone', erpPrice: 9, erpStock: 1, status: 'active' },
    ] });
    const { id, final } = await upload(a, manager, await xlsx([erpHeader, ['6281000000011', 'Laban 1L', 1.75, 12], ['6281000000028', 'Milk 2L', 4.5, 0]]));
    expect(final.status).toBe('needs_review');
    const s = (await status(a, manager, id)).summary;
    expect(s).toMatchObject({ matched: 2, priceChanges: 1, stockChanges: 1, newProducts: 0, missingFromFile: 1, firstImport: false });
    const price = (await h.request('GET', `/api/uploads/${id}/review?tab=price`, a, manager)).json().data;
    expect(price.rows.map((r: { parsed: { change: unknown } }) => r.parsed.change)).toEqual([{ price: { old: 1.5, new: 1.75 } }]);
    // a partial file never flags missing products
    const partial = await upload(a, manager, await xlsx([erpHeader, ['6281000000011', 'Laban 1L', 1.75, 12]]), { contains: 'partial' });
    expect((await status(a, manager, partial.id)).summary.missingFromFile).toBe(0);
  });

  it('rejects a file with more than 20% invalid rows, keeping the errors for download', async () => {
    const rows = [erpHeader, ...Array.from({ length: 10 }, (_, i) => [i < 3 ? '' : `62810000${i}`, 'x', 1, 1])];
    const { id, final } = await upload(a, manager, await xlsx(rows));
    expect(final).toMatchObject({ status: 'rejected' });
    expect(final.errorMessage).toMatch(/3 of 10 rows are invalid/);
    expect((await h.request('GET', `/api/uploads/${id}/errors`, a, manager)).json().data.total).toBe(3);
  });
});

describe('file safety in the worker', () => {
  it('rejects macro-enabled workbooks, fake spreadsheets and password-protected files', async () => {
    const zip = await JSZip.loadAsync(await xlsx([erpHeader, ['1', 'a', 1, 1]]));
    zip.file('xl/vbaProject.bin', Buffer.from('x'));
    const macros = await upload(a, manager, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(macros.final).toMatchObject({ status: 'rejected', errorMessage: 'Files with macros are not accepted' });
    const fake = await upload(a, manager, Buffer.from('MZ this is a program'), { fileName: 'totally-excel.xlsx' });
    expect(fake.final.status).toBe('rejected');
    const locked = await upload(a, manager, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('EncryptedPackage', 'utf16le')]), { fileName: 'locked.xlsx' });
    expect(locked.final.errorMessage).toMatch(/Password-protected/);
  });
  it('re-verifies the stored size when the worker picks the job up', async () => {
    const file = await xlsx([erpHeader, ['1', 'a', 1, 1]]);
    const created = (await h.request('POST', '/api/uploads', a, manager, { source: 'erp', fileName: 'e.xlsx', size: file.length })).json().data;
    const row = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: created.id } });
    h.storage.put(row.storageKey, Buffer.concat([file, Buffer.from('tampered')])); // swapped after the API check
    await h.fixture.prisma.upload.update({ where: { id: created.id }, data: { status: 'processing', revision: 1 } });
    expect(await processUpload({ database: h.fixture.database, storage: h.storage }, { tenantId: a.id, uploadId: created.id, revision: 1 })).toBe('rejected');
    expect((await status(a, manager, created.id)).errorMessage).toMatch(/does not match the declared size/);
  });
});

describe('marketplace uploads: wrong-file guard, matching, unmatched rows', () => {
  const mpHeader = ['sku', 'barcode 1', 'name', 'price', 'active'];
  it('blocks a file that matches another source\'s saved mapping', async () => {
    const snoonu = await upload(a, manager, await xlsx([mpHeader, ['S1', '6281000000011', 'Laban', 1.75, 'TRUE']]), { source: 'snoonu' });
    const sug = (await status(a, manager, snoonu.id)).mappingSuggestion.fields;
    await h.request('POST', `/api/uploads/${snoonu.id}/mapping`, a, manager, { fields: sug, saveAs: 'Snoonu export' });
    const wrong = await upload(a, manager, await xlsx([mpHeader, ['S1', '6281000000011', 'Laban', 1.75, 'TRUE']]), { source: 'rafeeq' });
    expect(wrong.final).toMatchObject({ status: 'rejected', errorMessage: 'This looks like a Snoonu file, not a Rafeeq file' });
  });
  it('matches on any barcode, falls back to SKU, reports unmatched rows and availability changes', async () => {
    const r = await upload(a, manager, await xlsx([mpHeader, ['S1', '06281000000011', 'Laban', 2, 'FALSE'], ['S2', '999', 'Mystery', 5, 'TRUE']]), { source: 'snoonu' });
    expect(r.final.status).toBe('needs_review');
    const s = (await status(a, manager, r.id)).summary;
    expect(s).toMatchObject({ matched: 1, unmatched: 1, priceChanges: 1, stockChanges: 1 });
    expect((await h.request('GET', `/api/uploads/${r.id}/review?tab=unmatched`, a, manager)).json().data.total).toBe(1);
    expect((await h.request('GET', `/api/uploads/${r.id}/review?tab=availability`, a, manager)).json().data.total).toBe(1);
  });
});

describe('discard', () => {
  it('removes staging rows and the stored original; cannot discard twice', async () => {
    const { id } = await upload(a, manager, await xlsx([erpHeader, ['6281000000011', 'Laban 1L', 1.75, 12]]));
    expect((await status(a, manager, id)).status).toBe('needs_review');
    const key = (await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).storageKey;
    expect((await h.request('POST', `/api/uploads/${id}/discard`, a, manager)).statusCode).toBe(200);
    expect((await status(a, manager, id)).status).toBe('discarded');
    expect(await h.fixture.prisma.uploadRow.count({ where: { uploadId: id } })).toBe(0);
    expect(h.storage.objects.has(key)).toBe(false);
    expect((await h.request('POST', `/api/uploads/${id}/discard`, a, manager)).statusCode).toBe(409);
    expect((await h.request('GET', `/api/uploads/${id}/review`, a, manager)).statusCode).toBe(409);
  });
});

describe('tenant isolation (two tenants, one database)', () => {
  it('tenant B can neither see nor touch tenant A uploads', async () => {
    const { id } = await upload(a, manager, await xlsx([erpHeader, ['6281000000011', 'Laban 1L', 1.75, 12]]));
    const bManager = await h.member(b, 'catalogue_manager');
    for (const [method, path, body] of [
      ['GET', `/api/uploads/${id}`], ['GET', `/api/uploads/${id}/review`], ['GET', `/api/uploads/${id}/errors`],
      ['POST', `/api/uploads/${id}/discard`], ['POST', `/api/uploads/${id}/mapping`, { fields: {} }], ['POST', `/api/uploads/${id}/complete`],
    ] as const) {
      const r = await h.request(method, path, b, bManager, body as Record<string, unknown> | undefined);
      expect([r.statusCode, path]).toEqual([404, path]);
    }
    expect((await h.request('GET', '/api/uploads', b, bManager)).json().data).toEqual([]);
    expect((await h.request('GET', `/api/uploads/${id}`, b, analystB)).statusCode).toBe(404);
    // A's cookie is useless on B's host
    expect((await h.request('GET', `/api/uploads/${id}`, b, manager)).statusCode).toBe(401);
    // and B's processing never sees A's catalogue: same barcode in B is a NEW product there
    const bUpload = await upload(b, bManager, await xlsx([erpHeader, ['6281000000011', 'Laban 1L', 1.75, 12]]));
    const sug = (await status(b, bManager, bUpload.id)).mappingSuggestion.fields;
    await h.request('POST', `/api/uploads/${bUpload.id}/mapping`, b, bManager, { fields: sug });
    expect((await status(b, bManager, bUpload.id)).summary).toMatchObject({ matched: 0, newProducts: 1, firstImport: true });
  });
  it('every stored object key and row carries the owning tenant', async () => {
    const rows = await h.fixture.prisma.upload.findMany({ where: { tenantId: a.id } });
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect(r.storageKey.startsWith(`tenants/${a.id}/uploads/${r.id}/`)).toBe(true);
    expect(await h.fixture.prisma.uploadRow.count({ where: { tenantId: b.id, upload: { tenantId: a.id } } })).toBe(0);
  });
  it('the database refuses a staging row that points at another tenant\'s upload', async () => {
    const aUpload = await h.fixture.prisma.upload.findFirstOrThrow({ where: { tenantId: a.id } });
    await expect(h.fixture.prisma.uploadRow.create({ data: { tenantId: b.id, uploadId: aUpload.id, rowNumber: 99999, parsed: {} } })).rejects.toThrow();
  });
});

describe('worker resilience', () => {
  it('skips stale and already-handled jobs', async () => {
    const { id } = await upload(a, manager, await xlsx([erpHeader, ['6281000000011', 'Laban 1L', 1.75, 12]]));
    const deps = { database: h.fixture.database, storage: h.storage };
    expect(await processUpload(deps, { tenantId: a.id, uploadId: id, revision: 1 })).toBe('skipped'); // not "processing" any more
    expect(await processUpload(deps, { tenantId: a.id, uploadId: '00000000-0000-4000-8000-000000000000', revision: 1 })).toBe('skipped');
    expect(await processUpload(deps, { tenantId: b.id, uploadId: id, revision: 1 })).toBe('skipped'); // wrong tenant
  });
  it('re-queues uploads stuck in processing, and marks exhausted jobs failed', async () => {
    const created = (await h.request('POST', '/api/uploads', a, manager, { source: 'erp', fileName: 'x.xlsx', size: 10 })).json().data;
    await h.fixture.prisma.upload.update({ where: { id: created.id }, data: { status: 'processing', revision: 7, updatedAt: new Date(Date.now() - 3_600_000) } });
    const queued: ProcessUploadJob[] = [];
    const deps = { database: h.fixture.database, storage: h.storage };
    expect(await recoverStuckUploads(deps, async j => { queued.push(j); })).toBeGreaterThanOrEqual(1);
    expect(queued).toContainEqual({ tenantId: a.id, uploadId: created.id, revision: 7 });
    await markFailed(deps, { tenantId: a.id, uploadId: created.id, revision: 7 });
    const failed = await status(a, manager, created.id);
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).not.toMatch(/Error|stack|prisma/i);
  });
});

describe('scale', () => {
  it(`processes a ${external ? '50,000' : '5,000'}-row ERP file end to end`, async () => {
    const n = external ? 50_000 : 5_000;
    const lines = ['Barcode,Item Name,Sale Price,Qty'];
    for (let i = 0; i < n; i++) lines.push(`${6290000000000 + i},Product ${i},${(1 + (i % 90) / 10).toFixed(2)},${i % 20}`);
    const file = Buffer.from(lines.join('\n'));
    const t0 = Date.now();
    const { id } = await upload(b, b.owner, file, { fileName: 'big.csv' });
    const sug = (await status(b, b.owner, id)).mappingSuggestion.fields;
    await h.request('POST', `/api/uploads/${id}/mapping`, b, b.owner, { fields: sug });
    const s = await status(b, b.owner, id);
    expect(s.status).toBe('needs_review');
    expect(s.summary).toMatchObject({ rowsRead: n, newProducts: n, rowsWithErrors: 0 });
    const page = (await h.request('GET', `/api/uploads/${id}/review?tab=new&page=3&pageSize=100`, b, b.owner)).json().data;
    expect(page.total).toBe(n);
    expect(page.rows).toHaveLength(100);
    console.log(`${n} rows processed in ${Date.now() - t0} ms`);
    expect(Date.now() - t0).toBeLessThan(180_000); // plan: under 3 minutes
  }, 240_000);
});
