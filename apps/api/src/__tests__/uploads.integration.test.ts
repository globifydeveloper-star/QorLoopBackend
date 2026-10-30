import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { randomUUID } from 'node:crypto';
import { processUpload, markFailed, recoverStuckUploads } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import type { ProcessUploadJob } from '../../../../packages/shared/src/queue.js';

let h: Harness;
let a: Store, b: Store;
let manager: Session, analyst: Session, admin: Session, otherManager: Session, analystB: Session;
const external = Boolean(process.env.TEST_DATABASE_URL);
/** Rows in the apply timing test; APPLY_SCALE_ROWS=22000 measures a real-size ERP file. */
const applyScale = Number(process.env.APPLY_SCALE_ROWS) || 3_000;

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
  it('Analyst cannot complete an upload but can read it, and a rejected call changes nothing', async () => {
    const id = (await h.request('POST', '/api/uploads', a, manager, body)).json().data.id;
    expect((await h.request('POST', `/api/uploads/${id}/complete`, a, analyst)).statusCode).toBe(403);
    expect((await h.request('POST', `/api/uploads/${id}/discard`, a, analyst)).statusCode).toBe(403);
    const read = await h.request('GET', `/api/uploads/${id}`, a, analyst);
    expect(read.statusCode).toBe(200);
    expect(read.json().data.status).toBe('uploading');
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

describe('row errors as .xlsx', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const evil = '=HYPERLINK("http://evil.test","x")';

  /** Upload a file and confirm the suggested mapping if the layout is not recognised yet. */
  async function reviewed(store: Store, who: Session, file: Buffer, fileName: string) {
    const { id, final } = await upload(store, who, file, { fileName });
    if (final.status === 'needs_mapping') {
      const fields = (await status(store, who, id)).mappingSuggestion.fields;
      expect((await h.request('POST', `/api/uploads/${id}/mapping`, store, who, { fields })).statusCode).toBe(200);
    }
    return { id, final: await status(store, who, id) };
  }
  async function download(store: Store, who: Session | undefined, id: string) {
    return h.request('GET', `/api/uploads/${id}/errors.xlsx`, store, who);
  }
  async function workbook(body: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as unknown as ArrayBuffer);
    return wb;
  }

  let withErrors: string;
  beforeAll(async () => {
    const lines = ['Barcode,Item Name,Sale Price,Qty'];
    for (let i = 0; i < 13; i++) lines.push(`62810000005${i}0,Product ${i},2.5,3`);
    // file row = index + 1; three invalid rows of 17 stays under the 20% rejection threshold
    lines.splice(3, 0, ',No barcode,1,1');
    lines.splice(6, 0, `6281000000599,Evil,"${evil.replace(/"/g, '""')}",1`);
    lines.splice(9, 0, '6281000000598,Negative,2,-2');
    lines.splice(13, 0, '6281000000500,Duplicate of row 2,2,1'); // a review-stage error
    const { id, final } = await reviewed(a, a.owner, Buffer.from(lines.join('\n')), 'Daily "stock"; v2.csv');
    expect(final.status).toBe('needs_review');
    withErrors = id;
  });

  it('owner downloads a workbook with a summary and one row per error', async () => {
    const r = await download(a, a.owner, withErrors);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe(XLSX);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-disposition']).toBe('attachment; filename="Dailystockv2-errors.xlsx"');
    const wb = await workbook(r.rawPayload);
    expect(wb.worksheets.map(s => s.name)).toEqual(['Summary', 'Row errors']);
    const summary = wb.getWorksheet('Summary')!;
    expect([1, 2, 3].map(n => summary.getRow(n).values)).toEqual([
      [undefined, 'File', 'Daily "stock"; v2.csv'], [undefined, 'Source', 'erp'], [undefined, 'Total errors', 4],
    ]);
    const sheet = wb.getWorksheet('Row errors')!;
    expect(sheet.getSheetValues().slice(1)).toEqual([
      [undefined, 'Row', 'Column', 'Value', 'Problem'],
      [undefined, 4, 'Barcode', '', 'Barcode is empty'],
      [undefined, 7, 'Sale Price', `'${evil}`, 'Price must be a number above 0'],
      [undefined, 10, 'Qty', '-2', 'Stock must be 0 or more'],
      [undefined, 14, 'Barcode', '6281000000500', 'Duplicate barcode in this file'],
    ]);
  });

  it('review errors name the file\'s column header, like row errors do', async () => {
    const errors = (await h.request('GET', `/api/uploads/${withErrors}/errors`, a, a.owner)).json().data.errors;
    expect(errors.map((e: { column: string }) => e.column)).toEqual(['Barcode', 'Sale Price', 'Qty', 'Barcode']);
  });

  it('stores a formula-looking value as plain text, never as a formula', async () => {
    const r = await download(a, a.owner, withErrors);
    const sheet = (await workbook(r.rawPayload)).getWorksheet('Row errors')!;
    const cell = sheet.getCell('C3');
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.formula).toBeUndefined();
    // a plain negative number keeps its text and gets no apostrophe
    const negative = sheet.getCell('C4');
    expect([negative.type, negative.value]).toEqual([ExcelJS.ValueType.String, '-2']);
    const zip = await JSZip.loadAsync(r.rawPayload);
    const sheets = zip.file(/^xl\/worksheets\/sheet\d+\.xml$/);
    expect(sheets).toHaveLength(2);
    for (const xml of sheets) expect(await xml.async('string')).not.toMatch(/<f[ >]/);
  });

  it('an upload without errors gives a header-only sheet', async () => {
    const { id, final } = await reviewed(a, a.owner, await xlsx([erpHeader, ['6281000000611', 'Clean', 2, 1]]), 'clean.xlsx');
    expect(final.summary.rowsWithErrors).toBe(0);
    const wb = await workbook((await download(a, a.owner, id)).rawPayload);
    expect(wb.getWorksheet('Row errors')!.rowCount).toBe(1);
    expect(wb.getWorksheet('Summary')!.getRow(3).values).toEqual([undefined, 'Total errors', 0]);
  });

  it('works for a rejected upload', async () => {
    const rows = [erpHeader, ...Array.from({ length: 10 }, (_, i) => [i < 3 ? '' : `62810000007${i}`, 'x', 1, 1])];
    const { id, final } = await reviewed(a, manager, await xlsx(rows), 'rejected.xlsx');
    expect(final.status).toBe('rejected');
    const wb = await workbook((await download(a, manager, id)).rawPayload);
    expect(wb.getWorksheet('Row errors')!.rowCount).toBe(4);
  });

  it('an Analyst can download; anonymous, other tenants and bad ids cannot', async () => {
    expect((await download(a, analyst, withErrors)).statusCode).toBe(200);
    expect((await download(a, undefined, withErrors)).statusCode).toBe(401);
    expect((await download(b, analystB, withErrors)).statusCode).toBe(404);
    expect((await download(b, b.owner, withErrors)).statusCode).toBe(404);
    expect((await h.request('GET', '/api/uploads/not-a-uuid/errors.xlsx', a, a.owner)).statusCode).toBe(400);
  });

  it('is documented as a binary download', () => {
    const op = h.api.spec.paths['/api/uploads/{id}/errors.xlsx']?.get;
    expect(op?.security).toEqual([{ cookie: [] }]);
    expect((op?.responses['200'] as { content: Record<string, unknown> }).content).toEqual({ [XLSX]: { schema: { type: 'string', format: 'binary' } } });
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

describe('confirm and apply', () => {
  const erpFields = { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' };
  const deps = () => ({ database: h.fixture.database });
  let counter = 0;

  /** A fresh store (empty catalogue) with a Catalogue Manager. */
  async function store() {
    const s = await h.createOwner(`apply${++counter}`);
    return { s, manager: await h.member(s, 'catalogue_manager') };
  }
  /** Upload through the real pipeline and confirm `fields` when the layout is new; ends in needs_review. */
  async function reviewed(s: Store, who: Session, file: Buffer, fields: Record<string, string>, opts: { source?: string; contains?: string } = {}) {
    const { id, final } = await upload(s, who, file, { ...opts, fileName: 'f.xlsx' });
    if (final.status === 'needs_mapping') expect((await h.request('POST', `/api/uploads/${id}/mapping`, s, who, { fields })).statusCode).toBe(200);
    expect((await status(s, who, id)).status).toBe('needs_review');
    return id;
  }
  const apply = (s: Store, who: Session | undefined, id: string) => h.request('POST', `/api/uploads/${id}/apply`, s, who);
  const products = (s: Store) => h.fixture.prisma.product.findMany({ where: { tenantId: s.id }, orderBy: { normalizedBarcode: 'asc' } });
  const product = (s: Store, barcode: string) => h.fixture.prisma.product.findFirstOrThrow({ where: { tenantId: s.id, normalizedBarcode: barcode } });
  const events = (s: Store, action: string) => h.fixture.prisma.auditEvent.findMany({ where: { tenantId: s.id, action }, orderBy: { createdAt: 'asc' } });
  /** The Catalogue Manager's user id (the store's only invited user). */
  const managerId = async (s: Store) => (await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id, email: { startsWith: 'user' } } })).id;

  beforeAll(() => { h.queue.applyHandler = job => applyUpload(deps(), job).then(() => undefined); });

  it('applies once: the response says applying, a second call returns the applied record, nothing is applied twice', async () => {
    const { s, manager: m } = await store();
    const id = await reviewed(s, m, await xlsx([erpHeader, ['6281000000011', 'Laban', 1.75, 12]]), erpFields);
    const first = await apply(s, m, id);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ id, status: 'applying' });
    expect(JSON.stringify(first.json().data)).not.toMatch(/revision|storageKey/);
    const after = await status(s, m, id);
    expect(after).toMatchObject({ status: 'applied', step: null, progress: 100, errorMessage: null });
    expect(after.appliedAt).toBeTruthy();
    const again = await apply(s, m, id);
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ status: 'applied', appliedAt: after.appliedAt });
    expect(h.queue.applyJobs.filter(j => j.uploadId === id)).toHaveLength(1);
    expect(await events(s, 'upload.applied')).toHaveLength(1);
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id } })).toBe(1);
    // the worker skips a replayed job for the same revision
    const job = h.queue.applyJobs.find(j => j.uploadId === id)!;
    expect(await applyUpload(deps(), job)).toBe('skipped');
    // an applied upload cannot be discarded
    expect((await h.request('POST', `/api/uploads/${id}/discard`, s, m)).statusCode).toBe(409);
  });

  it('two concurrent applies apply once', async () => {
    const { s, manager: m } = await store();
    const id = await reviewed(s, m, await xlsx([erpHeader, ['6281000000011', 'Laban', 1.75, 12], ['6281000000028', 'Milk', 4.5, 3]]), erpFields);
    const [r1, r2] = await Promise.all([apply(s, m, id), apply(s, s.owner, id)]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    expect(h.queue.applyJobs.filter(j => j.uploadId === id)).toHaveLength(1);
    expect(await events(s, 'upload.applied')).toHaveLength(1);
    expect(await events(s, 'upload.apply_requested')).toHaveLength(1);
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id } })).toBe(2);
  });

  it('permissions, tenancy and state: Analyst 403, anonymous 401, other tenant 404, wrong status 409, bad id 400', async () => {
    const { s, manager: m } = await store();
    const id = await reviewed(s, m, await xlsx([erpHeader, ['6281000000011', 'Laban', 1.75, 12]]), erpFields);
    const sAnalyst = await h.member(s, 'analyst');
    expect((await apply(s, sAnalyst, id)).statusCode).toBe(403);
    expect((await apply(s, undefined, id)).statusCode).toBe(401);
    expect((await apply(b, b.owner, id)).statusCode).toBe(404);
    expect((await apply(b, analystB, id)).statusCode).toBe(403); // permission is checked before the lookup
    expect((await apply(s, b.owner, id)).statusCode).toBe(401); // B's cookie is useless on A's host
    expect((await h.request('POST', '/api/uploads/not-a-uuid/apply', s, m)).statusCode).toBe(400);
    expect((await status(s, m, id)).status).toBe('needs_review'); // none of the above changed anything
    const uploading = (await h.request('POST', '/api/uploads', s, m, { source: 'erp', fileName: 'x.xlsx', size: 10 })).json().data.id;
    expect((await apply(s, m, uploading)).statusCode).toBe(409);
    expect((await h.request('POST', `/api/uploads/${id}/discard`, s, m)).statusCode).toBe(200);
    expect((await apply(s, m, id)).statusCode).toBe(409);
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id } })).toBe(0);
  });

  it('is documented as a cookie-authenticated POST', () => {
    const op = h.api.spec.paths['/api/uploads/{id}/apply']?.post;
    expect(op?.security).toEqual([{ cookie: [] }]);
    expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['200', '401', '403', '404', '409']));
  });

  it('the first ERP import creates active products; a later import creates products with status new', async () => {
    const { s, manager: m } = await store();
    const header = [...erpHeader, 'SKU', 'Brand', 'Category', 'Cost', 'Arabic Name'];
    const fields = { ...erpFields, sku: 'SKU', brand: 'Brand', category: 'Category', cost: 'Cost', nameAr: 'Arabic Name' };
    const first = await reviewed(s, m, await xlsx([header, ['06281000000011', 'Laban', 1.75, 12, 'L1', 'Almarai', 'Dairy', 1.2, 'لبن']]), fields);
    expect((await status(s, m, first)).summary.firstImport).toBe(true);
    await apply(s, m, first);
    expect(await products(s)).toMatchObject([{
      barcode: '6281000000011', normalizedBarcode: '6281000000011', sku: 'L1', nameEn: 'Laban', nameAr: 'لبن', brand: 'Almarai', erpCategory: 'Dairy',
      erpStock: 12, erpActive: true, inLatestErpFile: true, status: 'active', categoryId: null, imageKey: null,
    }]);
    expect((await product(s, '6281000000011')).erpPrice.toNumber()).toBe(1.75);
    expect((await product(s, '6281000000011')).costPrice?.toNumber()).toBe(1.2);

    const later = await reviewed(s, m, await xlsx([header, ['6281000000011', 'Laban', 1.75, 12, 'L1', 'Almarai', 'Dairy', 1.2, 'لبن'], ['6281000000028', 'Milk', 4.5, 3, '', '', '', '', '']]), fields, { contains: 'partial' });
    await apply(s, m, later);
    expect(await product(s, '6281000000028')).toMatchObject({ status: 'new', inLatestErpFile: true, sku: null, brand: null, costPrice: null });
    // nothing changed on the existing product, so no field events; one summary event per apply
    expect(await events(s, 'product.field_changed')).toHaveLength(0);
    expect((await events(s, 'upload.applied')).map(e => e.details)).toEqual([
      { created: 1, updated: 0, flagged: 0, listingsUpserted: 0, listingsRemoved: 0, skipped: 0, uploadId: first },
      { created: 1, updated: 0, flagged: 0, listingsUpserted: 0, listingsRemoved: 0, skipped: 0, uploadId: later },
    ]);
  });

  it('matched rows update only ERP-owned fields and keep nameAr, category, image and status; nameAr is filled only when empty', async () => {
    const { s, manager: m } = await store();
    const actor = await managerId(s);
    const category = await h.fixture.prisma.category.create({ data: { tenantId: s.id, nameEn: 'Dairy' } });
    await h.fixture.prisma.product.createMany({ data: [
      { tenantId: s.id, barcode: '6281000000011', normalizedBarcode: '6281000000011', nameEn: 'Old laban', nameAr: 'لبن قديم', brand: 'X', erpPrice: 1.5, costPrice: 1, erpStock: 1, erpActive: true, status: 'active', categoryId: category.id, imageKey: 'img/1.png' },
      { tenantId: s.id, barcode: '6281000000028', normalizedBarcode: '6281000000028', nameEn: 'Milk', erpPrice: 4.5, erpStock: 3, status: 'inactive', inLatestErpFile: false },
    ] });
    const header = [...erpHeader, 'Arabic Name', 'Brand', 'Active'];
    const id = await reviewed(s, m, await xlsx([header,
      ['6281000000011', 'Laban 1L', 1.75, 12, 'لبن جديد', '', 'No'],
      ['6281000000028', 'Milk', 4.5, 3, 'حليب', 'Nadec', 'Yes'],
    ]), { ...erpFields, nameAr: 'Arabic Name', brand: 'Brand', active: 'Active' });
    await apply(s, m, id);
    const laban = await product(s, '6281000000011');
    expect(laban).toMatchObject({ nameEn: 'Laban 1L', nameAr: 'لبن قديم', brand: null, erpStock: 12, erpActive: false, status: 'active', categoryId: category.id, imageKey: 'img/1.png' });
    expect(laban.erpPrice.toNumber()).toBe(1.75);
    expect(laban.costPrice?.toNumber()).toBe(1); // cost is not mapped in this file: left as it was
    const milk = await product(s, '6281000000028');
    expect(milk).toMatchObject({ nameAr: 'حليب', brand: 'Nadec', status: 'inactive', inLatestErpFile: true });

    const changes = (await events(s, 'product.field_changed')).map(e => ({ entity: e.entityId, actor: e.actorId, ...(e.details as object) }));
    expect(changes).toEqual(expect.arrayContaining([
      { entity: laban.id, actor, field: 'nameEn', old: 'Old laban', new: 'Laban 1L', uploadId: id },
      { entity: laban.id, actor, field: 'brand', old: 'X', new: null, uploadId: id },
      { entity: laban.id, actor, field: 'erpPrice', old: 1.5, new: 1.75, uploadId: id },
      { entity: laban.id, actor, field: 'erpStock', old: 1, new: 12, uploadId: id },
      { entity: laban.id, actor, field: 'erpActive', old: true, new: false, uploadId: id },
      { entity: milk.id, actor, field: 'nameAr', old: null, new: 'حليب', uploadId: id },
      { entity: milk.id, actor, field: 'brand', old: null, new: 'Nadec', uploadId: id },
      { entity: milk.id, actor, field: 'inLatestErpFile', old: false, new: true, uploadId: id },
    ]));
    expect(changes).toHaveLength(8);
    expect((await events(s, 'upload.applied'))[0]!.details).toEqual({ created: 0, updated: 2, flagged: 0, listingsUpserted: 0, listingsRemoved: 0, skipped: 0, uploadId: id });
  });

  it('a full ERP list flags products missing from the file without deactivating them; a partial list does not', async () => {
    const { s, manager: m } = await store();
    await h.fixture.prisma.product.createMany({ data: ['11', '22', '33'].map(n => ({ tenantId: s.id, barcode: `62810000000${n}`, normalizedBarcode: `62810000000${n}`, nameEn: n, erpPrice: 1, erpStock: 1, status: 'active' })) });
    const partial = await reviewed(s, m, await xlsx([erpHeader, ['6281000000011', '11', 1, 1]]), erpFields, { contains: 'partial' });
    await apply(s, m, partial);
    expect((await products(s)).map(p => p.inLatestErpFile)).toEqual([true, true, true]);

    const full = await reviewed(s, m, await xlsx([erpHeader, ['6281000000011', '11', 1, 1]]), erpFields, { contains: 'full' });
    await apply(s, m, full);
    expect((await products(s)).map(p => [p.inLatestErpFile, p.status, p.erpActive])).toEqual([[true, 'active', true], [false, 'active', true], [false, 'active', true]]);
    const flaggedEvents = (await events(s, 'product.field_changed')).map(e => e.details);
    expect(flaggedEvents).toEqual([
      { field: 'inLatestErpFile', old: true, new: false, uploadId: full },
      { field: 'inLatestErpFile', old: true, new: false, uploadId: full },
    ]);
    expect((await events(s, 'upload.applied')).at(-1)!.details).toMatchObject({ updated: 0, flagged: 2 });
  });

  describe('marketplace listings', () => {
    const mpHeader = ['Item ID', 'EAN', 'Title', 'Price', 'In stock'];
    const mpFields = { marketplaceProductId: 'Item ID', barcode1: 'EAN', name: 'Title', price: 'Price', available: 'In stock' };
    const listings = (s: Store) => h.fixture.prisma.listing.findMany({ where: { tenantId: s.id, marketplaceId: 'keeta' }, orderBy: { marketplaceProductId: 'asc' } });

    it('upserts by marketplace product ID; unmatched rows become listings with no product; full removes absent listings, partial keeps them', async () => {
      const { s, manager: m } = await store();
      const p = await h.fixture.prisma.product.create({ data: { tenantId: s.id, barcode: '6281000000011', normalizedBarcode: '6281000000011', nameEn: 'Laban', erpPrice: 1.5, erpStock: 1, status: 'active' } });
      await h.fixture.prisma.listing.create({ data: { tenantId: s.id, marketplaceId: 'talabat', marketplaceProductId: 'T1', barcodes: [], price: 1, available: true } });

      const first = await reviewed(s, m, await xlsx([mpHeader, ['K1', '06281000000011', 'Laban', 2, 'TRUE'], ['K2', '999', 'Mystery', 5, 'FALSE'], ['K3', '888', 'Gone soon', 1, 'TRUE']]), mpFields, { source: 'keeta' });
      await apply(s, m, first);
      expect((await listings(s)).map(l => ({ id: l.marketplaceProductId, productId: l.productId, barcodes: l.barcodes, name: l.name, price: l.price.toNumber(), available: l.available, uploadId: l.uploadId }))).toEqual([
        { id: 'K1', productId: p.id, barcodes: ['6281000000011'], name: 'Laban', price: 2, available: true, uploadId: first },
        { id: 'K2', productId: null, barcodes: ['999'], name: 'Mystery', price: 5, available: false, uploadId: first },
        { id: 'K3', productId: null, barcodes: ['888'], name: 'Gone soon', price: 1, available: true, uploadId: first },
      ]);
      const k1 = (await listings(s))[0]!.id;

      const partial = await reviewed(s, m, await xlsx([mpHeader, ['K1', '6281000000011', 'Laban', 2.25, 'FALSE']]), mpFields, { source: 'keeta', contains: 'partial' });
      await apply(s, m, partial);
      expect((await listings(s)).map(l => l.marketplaceProductId)).toEqual(['K1', 'K2', 'K3']);
      expect((await listings(s))[0]).toMatchObject({ id: k1, available: false, uploadId: partial });

      const full = await reviewed(s, m, await xlsx([mpHeader, ['K1', '6281000000011', 'Laban', 2.25, 'FALSE'], ['K2', '999', 'Mystery', 5, 'TRUE']]), mpFields, { source: 'keeta', contains: 'full' });
      await apply(s, m, full);
      expect((await listings(s)).map(l => l.marketplaceProductId)).toEqual(['K1', 'K2']);
      expect((await listings(s))[0]!.id).toBe(k1); // updated in place, not re-created
      // another marketplace's listings are never touched
      expect(await h.fixture.prisma.listing.count({ where: { tenantId: s.id, marketplaceId: 'talabat' } })).toBe(1);
      // listings are summarised per apply, not per row; products are untouched
      expect((await events(s, 'upload.applied')).map(e => e.details)).toEqual([
        { created: 0, updated: 0, flagged: 0, listingsUpserted: 3, listingsRemoved: 0, skipped: 0, uploadId: first },
        { created: 0, updated: 0, flagged: 0, listingsUpserted: 1, listingsRemoved: 0, skipped: 0, uploadId: partial },
        { created: 0, updated: 0, flagged: 0, listingsUpserted: 2, listingsRemoved: 1, skipped: 0, uploadId: full },
      ]);
      expect(await events(s, 'product.field_changed')).toHaveLength(0);
      expect((await product(s, '6281000000011')).erpPrice.toNumber()).toBe(1.5);
    });
  });

  it('a failure mid-apply leaves the catalogue unchanged and the upload back in needs_review, ready to retry', async () => {
    const { s, manager: m } = await store();
    await h.fixture.prisma.product.create({ data: { tenantId: s.id, barcode: '6281000000011', normalizedBarcode: '6281000000011', nameEn: 'Laban', erpPrice: 1.5, erpStock: 1, status: 'active' } });
    const id = await reviewed(s, m, await xlsx([erpHeader, ['6281000000011', 'Laban', 1.75, 12], ['6281000000028', 'Milk', 4.5, 3], ['6281000000035', 'Bread', 2, 3]]), erpFields);
    // The planner now skips rows it can see are bad, so the database itself refuses the bulk UPDATE of this store's
    // products, after the new products were inserted, with a check_violation whose message quotes a value (like 23514 does).
    const fn = `apply_fail_${s.id.replaceAll('-', '')}`;
    await h.fixture.prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id = '${s.id}'::uuid THEN RAISE EXCEPTION 'cost of % is not valid', quote_literal(NEW.name_en) USING ERRCODE = 'check_violation'; END IF;
      RETURN NEW; END $$`);
    await h.fixture.prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const before = await products(s);
    const logged: object[] = [];
    h.queue.applyHandler = job => applyUpload({ ...deps(), log: { info: () => undefined, warn: o => { logged.push(o); } } }, job).then(() => undefined);
    try {
      expect((await apply(s, m, id)).statusCode).toBe(200);
    } finally {
      h.queue.applyHandler = job => applyUpload(deps(), job).then(() => undefined);
      await h.fixture.prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON products`);
      await h.fixture.prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
    expect(await products(s)).toEqual(before);
    const after = await status(s, m, id);
    expect(after).toMatchObject({ status: 'needs_review', appliedAt: null, errorMessage: 'We could not apply this file. Nothing was changed; please try again.' });
    expect(await events(s, 'product.field_changed')).toHaveLength(0);
    expect(await events(s, 'upload.applied')).toHaveLength(0);
    const [failed] = await events(s, 'upload.apply_failed');
    expect(logged).toHaveLength(1);
    // the phase, Postgres code and unquoted message are logged and audited; no value from the file is
    const summary = { phase: 'update products', sqlState: '23514', message: 'cost of' };
    expect(logged[0]).toMatchObject({ ...summary, errorType: expect.any(String), ms: expect.any(Number), timings: expect.objectContaining({ 'create products': expect.any(Number) }) });
    expect(failed!.details).toMatchObject(summary);
    expect(JSON.stringify([logged, failed!.details])).not.toMatch(/6281000000011|Laban|Milk|Bread|1\.75/i);
    // the review is still there and the user can retry once the database accepts the rows
    expect((await h.request('GET', `/api/uploads/${id}/review`, s, m)).statusCode).toBe(200);
    expect((await apply(s, m, id)).json().data.status).toBe('applying');
    expect((await status(s, m, id)).status).toBe('applied');
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id } })).toBe(3);
  });

  it('the recovery sweep re-queues an upload stuck in applying as an apply job', async () => {
    const { s, manager: m } = await store();
    const id = await reviewed(s, m, await xlsx([erpHeader, ['6281000000011', 'Laban', 1.75, 12]]), erpFields);
    await h.fixture.prisma.upload.update({ where: { id }, data: { status: 'applying', revision: 9, updatedAt: new Date(Date.now() - 3_600_000) } });
    const queued: [ProcessUploadJob, string][] = [];
    await recoverStuckUploads({ database: h.fixture.database, storage: h.storage }, async (j, kind) => { queued.push([j, kind]); });
    expect(queued).toContainEqual([{ tenantId: s.id, uploadId: id, revision: 9 }, 'apply']);
    expect(await applyUpload(deps(), { tenantId: s.id, uploadId: id, revision: 9 })).toBe('applied');
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id } })).toBe(1);
  });

  it(`applies ${applyScale.toLocaleString('en')} staged ERP rows (half new, half changed) in one transaction`, async () => {
    const { s, manager: m } = await store();
    const half = Math.floor(applyScale / 2);
    const barcode = (i: number) => String(6290000000000 + i);
    for (let i = 0; i < half; i += 2000) {
      await h.fixture.prisma.product.createMany({ data: Array.from({ length: Math.min(2000, half - i) }, (_, k) => ({
        tenantId: s.id, barcode: barcode(i + k), normalizedBarcode: barcode(i + k), nameEn: `Product ${i + k}`, erpPrice: 1, erpStock: 1, status: 'active',
      })) });
    }
    // Stage a reviewed upload directly: this measures apply, not parsing.
    const id = randomUUID();
    await h.fixture.prisma.upload.create({ data: {
      id, tenantId: s.id, source: 'erp', fileName: 'big.csv', size: 1, storageKey: `tenants/${s.id}/uploads/${id}/original.csv`, contains: 'full',
      uploadedById: await managerId(s), status: 'needs_review', mapping: erpFields, summary: { firstImport: false },
    } });
    const rows = Array.from({ length: applyScale }, (_, i) => ({
      tenantId: s.id, uploadId: id, rowNumber: i + 2, matchProductId: null, changeType: i < half ? 'price_stock' : 'new',
      parsed: { data: { rowNumber: i + 2, barcode: barcode(i), nameEn: `Product ${i}`, price: 2.5, stock: i % 20, active: true } },
    }));
    for (let i = 0; i < rows.length; i += 2000) await h.fixture.prisma.uploadRow.createMany({ data: rows.slice(i, i + 2000) });

    const t0 = Date.now();
    let timings: unknown;
    h.queue.applyHandler = job => applyUpload({ ...deps(), log: { info: o => { timings = (o as { timings: unknown }).timings; }, warn: () => undefined } }, job).then(() => undefined);
    try {
      expect((await apply(s, m, id)).statusCode).toBe(200); // the inline queue runs the apply before answering
    } finally {
      h.queue.applyHandler = job => applyUpload(deps(), job).then(() => undefined);
    }
    const ms = Date.now() - t0;
    console.log(`apply of ${applyScale} rows (${half} updated, ${applyScale - half} created) took ${ms} ms`, JSON.stringify(timings));
    expect((await status(s, m, id)).status).toBe('applied');
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id } })).toBe(applyScale);
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id, status: 'new' } })).toBe(applyScale - half);
    expect((await product(s, barcode(0))).erpPrice.toNumber()).toBe(2.5);
    expect((await events(s, 'upload.applied'))[0]!.details).toMatchObject({ created: applyScale - half, updated: half, flagged: 0 });
    // every existing product changes price, and stock unless the new stock is 1 (i % 20 === 1)
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'product.field_changed' } })).toBe(half * 2 - Math.ceil((half - 1) / 20));
    expect(ms).toBeLessThan(15_000);
  }, 240_000);

  it(`a first import of ${applyScale.toLocaleString('en')} rows with every ERP column mapped applies, and logs each phase's time`, async () => {
    const { s } = await store();
    const barcode = (i: number) => String(6291000000000 + i);
    const id = randomUUID();
    const mapping = { barcode: 'Barcode', sku: 'SKU', nameEn: 'Item Name', nameAr: 'Arabic Name', brand: 'Brand', category: 'Category', price: 'Sale Price', cost: 'Cost', stock: 'Qty', active: 'Active' };
    await h.fixture.prisma.upload.create({ data: {
      id, tenantId: s.id, source: 'erp', fileName: 'first.csv', size: 1, storageKey: `tenants/${s.id}/uploads/${id}/original.csv`, contains: 'full',
      uploadedById: await managerId(s), status: 'applying', mapping, summary: { firstImport: true },
    } });
    const rows = Array.from({ length: applyScale }, (_, i) => ({
      tenantId: s.id, uploadId: id, rowNumber: i + 2, matchProductId: null, changeType: 'new',
      parsed: { data: {
        rowNumber: i + 2, barcode: barcode(i), sku: `SKU-${i}`, nameEn: `Almarai Full Fat Fresh Milk 2L Family Pack ${i}`, nameAr: `حليب طازج كامل الدسم ${i}`,
        // row 7 has the real file's negative cost, staged as it was before validation ignored it
        brand: 'Almarai', category: 'Dairy / Milk / Fresh', price: 12.345, cost: i === 5 ? -42.8 : 9.5, stock: i % 500, active: i % 7 !== 0,
      } },
    }));
    for (let i = 0; i < rows.length; i += 2000) await h.fixture.prisma.uploadRow.createMany({ data: rows.slice(i, i + 2000) });

    const logged: { msg?: string; o: Record<string, unknown> }[] = [];
    const log = { info: (o: object, msg?: string) => { logged.push({ o: o as Record<string, unknown>, msg }); }, warn: (o: object, msg?: string) => { logged.push({ o: o as Record<string, unknown>, msg }); } };
    expect(await applyUpload({ ...deps(), log }, { tenantId: s.id, uploadId: id, revision: 0 })).toBe('applied');
    console.log(`first import of ${applyScale} rows:`, JSON.stringify(logged[0]?.o));
    expect(logged.map(l => l.msg)).toEqual(['Upload applied']);
    expect(logged[0]!.o).toMatchObject({ created: applyScale, skipped: 0 });
    expect(Object.keys(logged[0]!.o.timings as object)).toEqual(expect.arrayContaining(['start', 'create products', 'update products', 'flag missing', 'audit', 'finish']));
    expect(await h.fixture.prisma.product.count({ where: { tenantId: s.id, status: 'active' } })).toBe(applyScale);
    expect((await product(s, barcode(7))).erpActive).toBe(false);
    expect((await product(s, barcode(5))).costPrice).toBeNull();
    expect((await product(s, barcode(6))).costPrice?.toNumber()).toBe(9.5);
  }, 240_000);

  it('the real file\'s negative cost: the row stays valid, costIgnored is 1, and the product is created with no cost', async () => {
    const { s, manager: m } = await store();
    const header = ['Barcode', 'Item Name', 'Sale Price', 'Cost', 'Qty'];
    const id = await reviewed(s, m, await xlsx([
      header,
      ['6291069207200', 'Real row with negative cost', 5.25, -42.8, 4],
      ['6291069207217', 'Zero cost', 3, 0, 1],
      ['6291069207224', 'Normal cost', 3, 2.125, 1],
    ]), { ...erpFields, cost: 'Cost' });
    const reviewedUpload = await status(s, m, id);
    expect(reviewedUpload.summary).toMatchObject({ rowsRead: 3, rowsWithErrors: 0, newProducts: 3, costIgnored: 1 });
    expect((await apply(s, m, id)).statusCode).toBe(200);
    expect((await status(s, m, id)).status).toBe('applied');
    expect((await product(s, '6291069207200')).costPrice).toBeNull();
    expect((await product(s, '6291069207217')).costPrice?.toNumber()).toBe(0);
    expect((await product(s, '6291069207224')).costPrice?.toNumber()).toBe(2.125);
    expect((await events(s, 'upload.applied'))[0]!.details).toMatchObject({ created: 3, skipped: 0 });
  });

  it('a staged row that breaks the barcode rule is skipped and reported; the rest of the file applies', async () => {
    const { s } = await store();
    const id = randomUUID();
    await h.fixture.prisma.upload.create({ data: {
      id, tenantId: s.id, source: 'erp', fileName: 'bad.csv', size: 1, storageKey: `tenants/${s.id}/uploads/${id}/original.csv`, contains: 'full',
      uploadedById: await managerId(s), status: 'applying', mapping: erpFields, summary: { firstImport: true },
    } });
    const staged = [['6281000000011', 'Good'], ['0123456', 'Leading zero'], ['6281000000028', 'Also good']] as const;
    await h.fixture.prisma.uploadRow.createMany({ data: staged.map(([barcode, nameEn], i) => ({
      tenantId: s.id, uploadId: id, rowNumber: i + 2, matchProductId: null, changeType: 'new',
      parsed: { data: { rowNumber: i + 2, barcode, nameEn, price: 1, stock: 1, active: true } },
    })) });
    const logged: { msg?: string; o: object }[] = [];
    const log = { info: (o: object, msg?: string) => { logged.push({ o, msg }); }, warn: (o: object, msg?: string) => { logged.push({ o, msg }); } };
    expect(await applyUpload({ ...deps(), log }, { tenantId: s.id, uploadId: id, revision: 0 })).toBe('applied');
    expect((await products(s)).map(p => p.normalizedBarcode)).toEqual(['6281000000011', '6281000000028']);
    const [applied] = await events(s, 'upload.applied');
    expect(applied!.details).toMatchObject({ created: 2, skipped: 1, skippedRows: [{ row: 3, reason: 'Barcode must be digits only and not start with 0' }] });
    expect(logged).toEqual([
      { msg: 'Upload applied', o: expect.objectContaining({ created: 2, skipped: 1 }) },
      { msg: 'Upload applied without rows the database would refuse', o: expect.objectContaining({ skipped: 1, reasons: { 'Barcode must be digits only and not start with 0': 1 } }) },
    ]);
    // the row number and reason are recorded, never the row's values
    expect(JSON.stringify([applied!.details, logged])).not.toMatch(/0123456|Leading zero/);
  });
});
