import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { processUpload } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';
import { generateFile } from '../../../worker/src/generate-file.js';
import { ROLES, hasPermission } from '../../../../packages/core/src/roles.js';
import { readSpreadsheetValues } from '../../../../packages/core/src/upload/parse.js';
import { generationJobId, generatedFileId, type GenerateFileJob } from '../../../../packages/shared/src/generated-files.js';
import { storageKeys } from '../../../../packages/shared/src/storage.js';
import { GENERATION_JOB_ID_MAX } from '../../../../packages/shared/src/contracts.js';
import { TenantData } from '../../../../packages/db/src/database.js';
import { talabatHeaders, talabatMapping, talabatRows, snoonuHeaders, snoonuMapping, snoonuRows, snoonuRowsWithDuplicate, barcodes, marketplaceWorkbook } from '../../../../packages/core/src/__tests__/fixtures/marketplace-files.js';

let h: Harness, a: Store, b: Store;
let manager: Session, analyst: Session, uploadId: string, original: Buffer;
let generatedId: string, jobId: string;
let nextJobMinute = 10;
const body = { marketplaceId: 'talabat', kind: 'price', reference: 'marketplace' };
const post = (path: string, input = body, session?: Session) => h.request('POST', `/api/generated-files${path}`, a, session ?? manager, input);

async function applyFile(source: string, data: Buffer, fields: Record<string, string>, extension = 'xlsx') {
  const created = await h.request('POST', '/api/uploads', a, manager, { source, fileName: `${source}.${extension}`, size: data.length });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id;
  const record = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } });
  await h.storage.put(record.storageKey, data);
  expect((await h.request('POST', `/api/uploads/${id}/complete`, a, manager)).statusCode).toBe(200);
  if ((await h.request('GET', `/api/uploads/${id}`, a, manager)).json().data.status === 'needs_mapping') {
    expect((await h.request('POST', `/api/uploads/${id}/mapping`, a, manager, { fields })).statusCode).toBe(200);
  }
  expect((await h.request('POST', `/api/uploads/${id}/apply`, a, manager)).statusCode).toBe(200);
  expect((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).status).toBe('applied');
  await h.recon.drain();
  return id as string;
}
const deps = () => ({ database: h.fixture.database, storage: h.storage });
async function freshJob(): Promise<GenerateFileJob> {
  const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id, name: 'Owner' } });
  return { tenantId: a.id, actorId: owner.id, requestId: randomUUID(), marketplaceId: 'talabat', kind: 'price', scope: 'all', reference: 'erp', requestedAt: new Date(Date.now() + nextJobMinute++ * 60_000).toISOString() };
}

beforeAll(async () => {
  h = await createHarness();
  h.queue.handler = job => processUpload(deps(), job).then(() => undefined);
  h.queue.applyHandler = job => applyUpload({ ...deps(), recon: h.recon }, job).then(() => undefined);
  h.recon.handler = job => recomputeRecon(deps(), job);
  h.generatedFiles.handler = job => generateFile(deps(), job);
  a = await h.createOwner('filesa'); b = await h.createOwner('filesb');
  manager = await h.member(a, 'catalogue_manager'); analyst = await h.member(a, 'analyst');
  const erp = new ExcelJS.Workbook();
  const ws = erp.addWorksheet('ERP');
  ws.addRow(['Barcode', 'Item Name', 'Sale Price', 'Qty']);
  [0, 1, 2, 3].forEach(i => ws.addRow([barcodes[i], talabatRows[i][1], [2, 3, 4, 5][i], i === 0 ? 0 : 5]));
  ws.addRow(['99999', 'Not in source', 9, 1]);
  await applyFile('erp', Buffer.from(await erp.xlsx.writeBuffer()), { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' });
  original = await marketplaceWorkbook(talabatHeaders, talabatRows.map((row, i) => i === 0 ? [...row, null, null, '=HYPERLINK("bad")'] : row));
  uploadId = await applyFile('talabat', original, talabatMapping);
  await applyFile('snoonu', await marketplaceWorkbook(snoonuHeaders, snoonuRows), snoonuMapping);
  await h.fixture.prisma.pricingSettings.create({ data: { tenantId: a.id, defaultRuleMode: 'percent', defaultRuleValue: 10 } });
  const absent = await h.fixture.prisma.product.findFirstOrThrow({ where: { tenantId: a.id, normalizedBarcode: '99999' } });
  await h.fixture.prisma.listing.create({ data: { tenantId: a.id, productId: absent.id, marketplaceId: 'talabat', marketplaceProductId: 'T4', price: 8, available: true } });
  await h.fixture.prisma.product.updateMany({ where: { tenantId: a.id, normalizedBarcode: barcodes[3] }, data: { inLatestErpFile: false } });
  await recomputeRecon(deps(), { tenantId: a.id, reason: 'manual' });
}, 120_000);
afterAll(async () => { await h?.recon.drain(); await h?.close(); });

describe('generated files API and worker', () => {
  it('preview writes no files/jobs/events, agrees with stored recon and reports missing source rows', async () => {
    const before = await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'file.generated' } });
    const response = await post('/preview');
    expect(response.statusCode).toBe(200);
    const preview = response.json().data;
    const rows = await h.fixture.prisma.reconRow.findMany({ where: { tenantId: a.id, marketplaceId: 'talabat', priceMismatchVsMarketplace: true } });
    expect(preview).toMatchObject({ productCount: rows.length - 1, priceChanges: 3, availabilityChanges: 0, notInFile: 1,
      referenceUsed: 'marketplace', largestPriceChange: { name: 'Milk', from: 1.75, to: 2.2 }, sourceFile: { name: 'talabat.xlsx' }, warnings: [] });
    expect(preview.firstRows[0]).toMatchObject({ sku: 'T0', price: '2.20', active: true });
    expect(Object.keys(preview.firstRows[0])).toEqual(talabatHeaders);
    expect(await h.fixture.prisma.generatedFile.count()).toBe(0);
    expect(h.generatedFiles.jobs.size).toBe(0);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'file.generated' } })).toBe(before);
    expect(response.body).not.toContain('storageKey');
  });

  it('202 enqueues once, polling returns the file, and the output and single audit agree with preview', async () => {
    const preview = (await post('/preview')).json().data;
    const response = await post('');
    expect(response.statusCode).toBe(202);
    jobId = response.json().data.jobId;
    expect((await post('')).json().data.jobId).toBe(jobId);
    expect(h.generatedFiles.jobs.size).toBe(1);
    const job = (await h.request('GET', `/api/generated-files/jobs/${jobId}`, a, analyst)).json().data;
    expect(job.state).toBe('done'); generatedId = job.fileId;
    const file = await h.fixture.prisma.generatedFile.findUniqueOrThrow({ where: { id: generatedId } });
    expect(file.storageKey).toMatch(new RegExp(`^tenants/${a.id}/generated/[a-f0-9-]+\\.xlsx$`));
    expect(file.fileName).toMatch(/^Talabat_Price_\d{2}[A-Z][a-z]{2}\d{4}_\d{4}\.xlsx$/);
    expect(file.productCount).toBe(preview.productCount);
    expect(file.expiresAt.getTime() - file.generatedAt.getTime()).toBe(30 * 86_400_000);
    const written = await readSpreadsheetValues({ path: '', buffer: h.storage.objects.get(file.storageKey)! }, 'xlsx');
    expect(written.raw).toHaveLength(preview.productCount + 1);
    for (let i = 0; i < 3; i++) {
      const recon = await h.fixture.prisma.reconRow.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'talabat', product: { normalizedBarcode: barcodes[i] } } });
      expect(written.raw[i + 1][2]).toBe(recon.marketplacePrice!.toNumber().toFixed(2));
      expect(written.raw[i + 1][3]).toBe(talabatRows[i][3]);
    }
    expect(written.raw[1][19]).toBe('\'=HYPERLINK("bad")');
    // A worker retry after commit must return the existing file without another upload or event.
    const put = jest.spyOn(h.storage, 'put');
    await generateFile(deps(), h.generatedFiles.jobs.get(jobId)!);
    expect(put).not.toHaveBeenCalled(); put.mockRestore();
    const events = await h.fixture.prisma.auditEvent.findMany({ where: { tenantId: a.id, action: 'file.generated', entityId: generatedId } });
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ productCount: preview.productCount, priceChanges: preview.priceChanges, availabilityChanges: preview.availabilityChanges, notInFile: preview.notInFile });
  });

  it('Snoonu uses mapped barcode IDs and writes text prices and True/False text', async () => {
    const input = { marketplaceId: 'snoonu', kind: 'stock_price', reference: 'erp' };
    const preview = (await post('/preview', input)).json().data;
    expect(preview).toMatchObject({ productCount: 3, priceChanges: 1, availabilityChanges: 3, notInFile: 0, referenceUsed: 'erp' });
    const queued = (await post('', input)).json().data;
    const status = (await h.request('GET', `/api/generated-files/jobs/${queued.jobId}`, a, manager)).json().data;
    const file = await h.fixture.prisma.generatedFile.findUniqueOrThrow({ where: { id: status.fileId } });
    const output = await readSpreadsheetValues({ path: '', buffer: h.storage.objects.get(file.storageKey)! }, 'xlsx');
    expect(output.raw[0]).toEqual(snoonuHeaders);
    expect(output.raw[1].slice(2)).toEqual(['False', '2.00']);
    expect(output.raw[2].slice(2)).toEqual(['True', '3.00']);
  });

  it('uses the tenant reference default and warns about the upload age', async () => {
    await h.fixture.prisma.pricingSettings.update({ where: { tenantId: a.id }, data: { compareReferenceDefault: 'erp' } });
    const record = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
    await h.fixture.prisma.upload.update({ where: { id: uploadId }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    const r = await post('/preview', { marketplaceId: 'talabat', kind: 'price' } as typeof body);
    expect(r.json().data).toMatchObject({ productCount: 1, referenceUsed: 'erp', warnings: ['The marketplace file is 2 days old'] });
    await h.fixture.prisma.upload.update({ where: { id: uploadId }, data: { createdAt: record.createdAt } });
    await h.fixture.prisma.pricingSettings.update({ where: { tenantId: a.id }, data: { compareReferenceDefault: 'marketplace' } });
  });

  it('history contains only public fields, and downloads are signed for at most five minutes', async () => {
    const response = await h.request('GET', '/api/generated-files', a, analyst);
    expect(response.statusCode).toBe(200);
    const files = response.json().data;
    expect(files).toHaveLength(2);
    expect(new Date(files[0].generatedAt).getTime()).toBeGreaterThanOrEqual(new Date(files[1].generatedAt).getTime());
    expect(files[0].generatedBy).toBe('catalogue_manager');
    expect(Object.keys(files[0]).sort()).toEqual(['id', 'marketplaceId', 'kind', 'scope', 'reference', 'fileName', 'productCount', 'generatedAt', 'generatedBy', 'expiresAt'].sort());
    const responseDownload = await h.request('GET', `/api/generated-files/${generatedId}/download`, a, analyst);
    expect(responseDownload.statusCode).toBe(200);
    const signed = responseDownload.json().data;
    expect(new Date(signed.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(h.storage.downloads.has(signed.url)).toBe(true);
    expect(responseDownload.body).not.toContain('tenants/');
    expect(responseDownload.body).not.toContain('storageKey');
  });

  it('permissions match roles.ts exactly, including analyst preview being forbidden', async () => {
    for (const role of ROLES) {
      const session = role === 'owner' ? a.owner : role === 'catalogue_manager' ? manager : role === 'analyst' ? analyst : await h.member(a, role);
      for (const [method, url, permission] of [
        ['GET', '/api/generated-files', 'files.view'], ['GET', `/api/generated-files/jobs/${jobId}`, 'files.view'],
        ['GET', `/api/generated-files/${generatedId}/download`, 'files.download'],
        ['POST', '/api/generated-files/preview', 'files.preview'], ['POST', '/api/generated-files', 'files.generate'],
      ] as const) {
        const r = await h.request(method, url, a, session, method === 'POST' ? body : undefined);
        expect(r.statusCode).toBe(hasPermission(role, permission) ? method === 'POST' && url === '/api/generated-files' ? 202 : 200 : 403);
      }
    }
  });

  it('enforces Origin, CSRF, strict inputs and authentication', async () => {
    for (const path of ['/preview', '']) {
      expect((await h.request('POST', `/api/generated-files${path}`, a, undefined, body)).statusCode).toBe(401);
      expect((await h.request('POST', `/api/generated-files${path}`, a, { ...manager, csrf: '' }, body)).statusCode).toBe(403);
      expect((await h.api.server.inject({ method: 'POST', url: `/api/generated-files${path}`, headers: { host: a.hostname + ':4000', cookie: manager.cookie, 'x-csrf-token': manager.csrf }, payload: body })).statusCode).toBe(403);
      for (const invalid of [{ ...body, tenantId: b.id }, { ...body, marketplaceId: 'erp' }, { ...body, kind: 'new_products' }, { ...body, reference: 'cost' }, { ...body, scope: 'partial' }]) {
        expect((await h.request('POST', `/api/generated-files${path}`, a, manager, invalid)).statusCode).toBe(400);
      }
    }
    for (const url of ['/api/generated-files', `/api/generated-files/jobs/${jobId}`, `/api/generated-files/${generatedId}/download`]) expect((await h.request('GET', url, a)).statusCode).toBe(401);
  });

  it('isolates tenants, hides missing/expired files and jobs, and omits expired history', async () => {
    expect((await h.request('GET', '/api/generated-files', b, b.owner)).json().data).toEqual([]);
    expect((await h.request('GET', `/api/generated-files/${generatedId}/download`, b, b.owner)).statusCode).toBe(404);
    expect((await h.request('GET', `/api/generated-files/jobs/${jobId}`, b, b.owner)).statusCode).toBe(404);
    expect((await h.request('GET', `/api/generated-files/jobs/generate-missing`, a, manager)).statusCode).toBe(404);
    expect((await h.request('GET', '/api/generated-files', b, manager)).statusCode).toBe(401);
    const record = await h.fixture.prisma.generatedFile.findUniqueOrThrow({ where: { id: generatedId } });
    await h.fixture.prisma.generatedFile.update({ where: { id: generatedId }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await h.request('GET', `/api/generated-files/${generatedId}/download`, a, manager)).statusCode).toBe(404);
    expect((await h.request('GET', '/api/generated-files', a, manager)).json().data.some((f: { id: string }) => f.id === generatedId)).toBe(false);
    await h.fixture.prisma.generatedFile.update({ where: { id: generatedId }, data: { expiresAt: record.expiresAt } });
  });

  it('returns clear 409 reasons on preview and enqueue without writing a job', async () => {
    const record = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
    for (const path of ['/preview', '']) {
      const missingUpload = await post(path, { ...body, marketplaceId: 'rafeeq' });
      expect(missingUpload.statusCode).toBe(409); expect(missingUpload.json().error.message).toContain('no applied upload');
      await h.storage.delete(record.storageKey);
      const missingObject = await post(path);
      expect(missingObject.statusCode).toBe(409); expect(missingObject.json().error.message).toContain('Upload a fresh Talabat file');
      await h.storage.put(record.storageKey, original);
      await h.fixture.prisma.upload.update({ where: { id: uploadId }, data: { mapping: { ...talabatMapping, price: '' } } });
      expect((await post(path)).json().error.message).toContain('price column is not mapped');
      await h.fixture.prisma.upload.update({ where: { id: uploadId }, data: { mapping: talabatMapping, headers: ['sku'] } });
      expect((await post(path)).json().error.message).toContain('headers no longer include');
      await h.fixture.prisma.upload.update({ where: { id: uploadId }, data: { headers: talabatHeaders } });
      await h.storage.put(record.storageKey, await marketplaceWorkbook(talabatHeaders, talabatRows.map(row => { const next = [...row]; next[3] = 42; return next; })));
      expect((await post(path)).json().error.message).toContain('quantities');
      await h.storage.put(record.storageKey, original);
    }
    const otherOwner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: b.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: b.id, source: 'talabat', fileName: 'talabat.xlsx', size: 1, status: 'applied', storageKey: storageKeys.upload(b.id, randomUUID(), '.xlsx'), uploadedById: otherOwner.id } });
    const unreconciled = await h.request('POST', '/api/generated-files/preview', b, b.owner, body);
    expect(unreconciled.statusCode).toBe(409); expect(unreconciled.json().error.message).toContain('not been reconciled');
    const ids = await h.fixture.prisma.reconRow.findMany({ where: { tenantId: a.id, marketplaceId: 'talabat' } });
    await h.fixture.prisma.reconRow.updateMany({ where: { tenantId: a.id, marketplaceId: 'talabat' }, data: { priceMismatchVsMarketplace: false } });
    expect((await post('/preview')).json().error.message).toContain('nothing to update');
    for (const row of ids) await h.fixture.prisma.reconRow.update({ where: { id: row.id }, data: { priceMismatchVsMarketplace: row.priceMismatchVsMarketplace } });
  });

  it('surfaces queued/running/failed safely and records a safe worker failure', async () => {
    const job = await freshJob(), id = generationJobId(job);
    h.generatedFiles.jobs.set(id, job);
    for (const state of ['queued', 'running', 'failed'] as const) {
      h.generatedFiles.states.set(id, { state, ...(state === 'failed' ? { message: 'We could not generate this file. Please try again.' } : {}) });
      expect((await h.request('GET', `/api/generated-files/jobs/${id}`, a, manager)).json().data.state).toBe(state);
    }
    const spy = jest.spyOn(h.storage, 'put').mockRejectedValueOnce(new Error('private-token=DO_NOT_EXPOSE'));
    const logs: object[] = [];
    await expect(generateFile({ ...deps(), log: { info: () => undefined, warn: o => { logs.push(o); } } }, job)).rejects.toThrow('We could not generate');
    spy.mockRestore();
    const audit = await h.fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.id, action: 'file.generation_failed', entityId: generatedFileId(id) } });
    expect(JSON.stringify(audit.details) + JSON.stringify(logs)).not.toContain('DO_NOT_EXPOSE');
    expect(await h.fixture.prisma.generatedFile.findUnique({ where: { id: generatedFileId(id) } })).toBeNull();
  });

  it('rolls back the generated row and removes the object if the success audit fails', async () => {
    const job = await freshJob(), id = generatedFileId(generationJobId(job));
    const objectKeysBefore = [...h.storage.objects.keys()].sort();
    const event = TenantData.prototype.event;
    const spy = jest.spyOn(TenantData.prototype, 'event').mockImplementation(function (this: TenantData, ...args: Parameters<TenantData['event']>) {
      if (args[0] === 'file.generated') return Promise.reject(new Error('audit failed'));
      return event.apply(this, args);
    });
    try { await expect(generateFile(deps(), job)).rejects.toThrow('We could not generate'); }
    finally { spy.mockRestore(); }
    expect(await h.fixture.prisma.generatedFile.findUnique({ where: { id } })).toBeNull();
    expect([...h.storage.objects.keys()].sort()).toEqual(objectKeysBefore);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, entityId: id, action: 'file.generated' } })).toBe(0);
  });

  it('round-trips a CSV original and always uses the newest APPLIED upload rather than a newer un-applied file', async () => {
    const csv = ['sku;name;price;active;barcode 1', ...talabatRows.map(row => `${row[0]};${row[1]};${row[2]};${row[3] ? 'True' : 'False'};${row[9]}`)].join('\r\n');
    const csvId = await applyFile('talabat', Buffer.from(csv), talabatMapping, 'csv');
    const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: a.id, source: 'talabat', fileName: 'newer.xlsx', size: 1, storageKey: 'unused/newer', uploadedById: owner.id, status: 'needs_review' } });
    const input = { marketplaceId: 'talabat', kind: 'stock_price', scope: 'all', reference: 'erp' };
    const preview = (await post('/preview', input)).json().data;
    expect(preview.sourceFile.name).toBe('talabat.csv');
    // Use a separate minute to avoid a previous all/erp request's idempotency key.
    const job = { ...await freshJob(), kind: 'stock_price' as const };
    const result = await generateFile(deps(), job);
    const file = await h.fixture.prisma.generatedFile.findUniqueOrThrow({ where: { id: result.fileId } });
    expect(file.fileName).toMatch(/\.csv$/);
    const output = await readSpreadsheetValues({ path: '', buffer: h.storage.objects.get(file.storageKey)! }, 'csv');
    expect(output.raw).toHaveLength(preview.productCount + 1);
    expect(output.raw[1]).toEqual(['T0', 'Milk', '2.00', 'False', barcodes[0]]);
    expect((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: csvId } })).status).toBe('applied');
  });

  it('a Snoonu file listing a barcode on two rows updates both rows alike, warns, and keeps one recon row per product', async () => {
    const source = await marketplaceWorkbook(snoonuHeaders, snoonuRowsWithDuplicate);
    await applyFile('snoonu', source, snoonuMapping);
    const recon = await h.fixture.prisma.reconRow.findMany({ where: { tenantId: a.id, marketplaceId: 'snoonu', actualPrice: { not: null } } });
    const distinct = new Set(snoonuRowsWithDuplicate.map(row => String(row[0]).replace(/^0+/, '')));
    expect(recon).toHaveLength(distinct.size); // products listed, not file rows
    const input = { marketplaceId: 'snoonu', kind: 'stock_price', scope: 'all', reference: 'erp' };
    const response = await post('/preview', input);
    expect(response.statusCode).toBe(200);
    const preview = response.json().data;
    const warning = '1 product appears on more than one row of the Snoonu file; all its rows are updated';
    expect(preview).toMatchObject({ rowsToWrite: preview.productCount + 1, warnings: [warning] });
    const job = { ...await freshJob(), marketplaceId: 'snoonu' as const, kind: 'stock_price' as const };
    const { fileId } = await generateFile(deps(), job);
    const file = await h.fixture.prisma.generatedFile.findUniqueOrThrow({ where: { id: fileId } });
    expect(file.productCount).toBe(preview.productCount);
    const before = await readSpreadsheetValues({ path: '', buffer: source }, 'xlsx');
    const output = await readSpreadsheetValues({ path: '', buffer: h.storage.objects.get(file.storageKey)! }, 'xlsx');
    expect(output.raw).toHaveLength(preview.rowsToWrite + 1);
    const milk = output.raw.slice(1).filter(row => String(row[0]).endsWith(barcodes[0]));
    expect(milk).toHaveLength(2);
    expect(milk.map(row => row.slice(0, 2))).toEqual([before.raw[1].slice(0, 2), before.raw[3].slice(0, 2)]);
    // ERP price 2 and ERP qty 0 for Milk; each row keeps its own text casing and decimals.
    expect(milk.map(row => row.slice(2))).toEqual([['False', '2.00'], ['FALSE', '2.000']]);
    const event = await h.fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.id, action: 'file.generated', entityId: fileId } });
    expect(event.details).toMatchObject({ productCount: preview.productCount, rowsToWrite: preview.rowsToWrite, duplicateProducts: 1, duplicateExtraRows: 1, warnings: [warning] });
  });

  it('documents all five endpoints and the 202 response', () => {
    expect(Object.keys(h.api.spec.paths)).toEqual(expect.arrayContaining(['/api/generated-files/preview', '/api/generated-files', '/api/generated-files/jobs/{jobId}', '/api/generated-files/{id}/download']));
    expect(h.api.spec.paths['/api/generated-files'].post!.responses['202']).toBeDefined();
  });
});

describe('export values in files and the batch request (migration 202611100001)', () => {
  const send = (path: string, input: Record<string, unknown>) => h.request('POST', `/api/generated-files${path}`, a, manager, input);
  it('a pending export price is written in every file, the preview carries an exportToken, and a stale token is refused', async () => {
    const fruit = await h.fixture.prisma.product.findFirstOrThrow({ where: { tenantId: a.id, normalizedBarcode: barcodes[1] } });
    const set = await h.request('PUT', `/api/marketplace-values/talabat/products/${fruit.id}`, a, manager, { values: { price: { value: 3.75 } }, expected: null });
    expect(set.statusCode).toBe(200);
    const preview = (await send('/preview', { marketplaceId: 'talabat', kind: 'price', reference: 'marketplace' })).json().data;
    expect(preview).toMatchObject({ valueBasis: 'export_values', exportValueProducts: 1, blockedExportProducts: 0 });
    expect(preview.exportToken).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.firstRows.find((r: Record<string, unknown>) => r.sku === 'T1')).toMatchObject({ price: '3.75' });
    // owner decision C: the ERP-reference file writes the export value too
    const erp = (await send('/preview', { marketplaceId: 'talabat', kind: 'price', scope: 'all', reference: 'erp' })).json().data;
    expect(erp.firstRows.find((r: Record<string, unknown>) => r.sku === 'T1')).toMatchObject({ price: '3.75' });
    // an edit after the preview: generating with the old token is a 409, never a file of the old values
    expect((await h.request('PUT', `/api/marketplace-values/talabat/products/${fruit.id}`, a, manager, { values: { price: { value: 3.8 } }, expected: set.json().data.item.version })).statusCode).toBe(200);
    expect((await send('', { marketplaceId: 'talabat', kind: 'price', reference: 'marketplace', exportToken: preview.exportToken })).statusCode).toBe(409);
  });

  it('one request queues the updated files of every enabled marketplace; a marketplace that is not enabled is reported', async () => {
    const r = await send('/batch', { kind: 'stock_price' });
    expect(r.statusCode).toBe(202);
    const d = r.json().data as { jobs: { marketplaceId: string; jobId: string }[]; blocked: { marketplaceId: string; message: string }[] };
    expect([...d.jobs.map(j => j.marketplaceId), ...d.blocked.map(x => x.marketplaceId)].sort()).toEqual(['snoonu', 'talabat']);
    for (const j of d.jobs) expect((await h.request('GET', `/api/generated-files/jobs/${j.jobId}`, a, manager)).statusCode).toBe(200);
    expect((await send('/batch', { marketplaceIds: ['keeta'] })).json().data).toEqual({ jobs: [], blocked: [{ marketplaceId: 'keeta', message: 'Keeta is not enabled for this store' }] });
    expect((await h.request('POST', '/api/generated-files/batch', a, analyst, {})).statusCode).toBe(403);
  });

  it('a worst-case token-bearing job id reaches the jobs route; the route keeps auth, tenant isolation and its length limit', async () => {
    const job: GenerateFileJob = { ...await freshJob(), kind: 'stock_price', scope: 'mismatches', reference: 'marketplace', exportToken: 'f'.repeat(64) };
    const id = generationJobId(job), fileId = randomUUID();
    expect(id.length).toBeLessThanOrEqual(GENERATION_JOB_ID_MAX);
    h.generatedFiles.jobs.set(id, job);
    h.generatedFiles.states.set(id, { state: 'done', fileId });
    const url = '/api/generated-files/jobs/' + id;
    const r = await h.request('GET', url, a, manager);
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual({ state: 'done', fileId });
    expect((await h.request('GET', url, a)).statusCode).toBe(401);
    expect((await h.request('GET', url, b, b.owner)).statusCode).toBe(404);
    // the longest id the validator allows still reaches it (404: no such job); one character more is refused by the router
    expect((await h.request('GET', '/api/generated-files/jobs/' + 'g'.repeat(GENERATION_JOB_ID_MAX), a, manager)).statusCode).toBe(404);
    expect((await h.request('GET', '/api/generated-files/jobs/' + 'g'.repeat(GENERATION_JOB_ID_MAX + 1), a, manager)).statusCode).toBe(414);
  });
});


describe('generation job status route length', () => {
  it('accepts real token-bearing job IDs longer than 100 characters and preserves authentication and tenant isolation', async () => {
    const job: GenerateFileJob = { ...await freshJob(), kind: 'stock_price', scope: 'mismatches', reference: 'marketplace', exportToken: 'a'.repeat(64) };
    const id = generationJobId(job), fileId = randomUUID();
    expect(id.length).toBeGreaterThan(100);
    expect(id.length).toBeLessThanOrEqual(200);
    h.generatedFiles.jobs.set(id, job);
    h.generatedFiles.states.set(id, { state: 'done', fileId });
    const response = await h.request('GET', '/api/generated-files/jobs/' + id, a, manager);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ state: 'done', fileId });
    expect((await h.request('GET', '/api/generated-files/jobs/' + id, a)).statusCode).toBe(401);
    expect((await h.request('GET', '/api/generated-files/jobs/' + id, b, b.owner)).statusCode).toBe(404);
  });

  it('keeps the job ID length bounded at the validated 200 characters', async () => {
    const job = await freshJob(), id = 'g'.repeat(200);
    h.generatedFiles.jobs.set(id, job);
    h.generatedFiles.states.set(id, { state: 'queued' });
    expect((await h.request('GET', '/api/generated-files/jobs/' + id, a, manager)).statusCode).toBe(200);
    expect((await h.request('GET', '/api/generated-files/jobs/' + 'g'.repeat(201), a, manager)).statusCode).toBe(414);
  });
});
