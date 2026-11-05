import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import ExcelJS from 'exceljs';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { processUpload } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';
import { generateFile } from '../../../worker/src/generate-file.js';
import type { TemplateSourceEntry } from '../../../../packages/core/src/upload/templates.js';
import { barcodes, marketplaceWorkbook, snoonuHeaders, snoonuMapping, snoonuRows, talabatHeaders, talabatMapping, talabatRows } from '../../../../packages/core/src/__tests__/fixtures/marketplace-files.js';

let h: Harness, a: Store, b: Store;
let admin: Session, manager: Session, analyst: Session;
let erpApplied: string, talabatApplied: string;
let snapshot: Awaited<ReturnType<typeof takeSnapshot>>;
let previewBefore: unknown;

const erpHeaders = ['Barcode', 'Item Name', 'Sale Price', 'Qty', 'Cost', 'Retail Price'];
const erpFields = { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty', cost: 'Cost' };
const previewBody = { marketplaceId: 'talabat', kind: 'stock_price', scope: 'all', reference: 'erp' };

async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ERP');
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** Sale price base + i, retail price 9 + i. */
const erpFile = (base: number, headers = erpHeaders) =>
  xlsx([headers, ...[0, 1, 2, 3].map(i => [barcodes[i], String(talabatRows[i]![1]), base + i, 5, 1, 9 + i].slice(0, headers.length))]);

/** Real API and upload worker. Confirms (and optionally saves) a mapping only when the layout is not recognised. */
async function prepare(store: Store, who: Session, source: string, data: Buffer, fields?: Record<string, string>, saveAs?: string) {
  const created = await h.request('POST', '/api/uploads', store, who, { source, fileName: `${source}.xlsx`, size: data.length });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  const row = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } });
  await h.storage.put(row.storageKey, data);
  expect((await h.request('POST', `/api/uploads/${id}/complete`, store, who)).statusCode).toBe(200);
  if (fields && (await h.request('GET', `/api/uploads/${id}`, store, who)).json().data.status === 'needs_mapping') {
    expect((await h.request('POST', `/api/uploads/${id}/mapping`, store, who, { fields, ...(saveAs ? { saveAs } : {}) })).statusCode).toBe(200);
  }
  return id;
}
async function apply(store: Store, who: Session, id: string) {
  expect((await h.request('POST', `/api/uploads/${id}/apply`, store, who)).statusCode).toBe(200);
  expect((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).status).toBe('applied');
  await h.recon.drain();
}
async function list(store: Store = a, who: Session = admin) {
  const r = await h.request('GET', '/api/templates', store, who);
  expect(r.statusCode).toBe(200);
  return r.json().data.items as TemplateSourceEntry[];
}
const entry = async (source: string, store: Store = a, who: Session = admin) => (await list(store, who)).find(e => e.source === source)!;
const put = (source: string, body: Record<string, unknown>, who: Session = admin, store: Store = a) => h.request('PUT', `/api/templates/${source}`, store, who, body);
const audits = (store: Store = a) => h.fixture.prisma.auditEvent.findMany({ where: { tenantId: store.id, action: 'template.updated' }, orderBy: { createdAt: 'asc' } });
const versions = (source: string, store: Store = a) => h.fixture.prisma.inputTemplate.findMany({ where: { tenantId: store.id, source }, orderBy: { version: 'asc' } });

/** Everything an edit must leave alone: applied uploads, the catalogue, listings and stored comparisons. */
async function takeSnapshot() {
  const db = h.fixture.prisma;
  return {
    uploads: await db.upload.findMany({ where: { tenantId: a.id, status: 'applied' }, orderBy: { id: 'asc' }, select: { id: true, mapping: true, headers: true, templateId: true, templateVersion: true, status: true, updatedAt: true } }),
    products: await db.product.findMany({ where: { tenantId: a.id }, orderBy: { id: 'asc' }, select: { id: true, erpPrice: true, erpStock: true, status: true, updatedAt: true } }),
    listings: await db.listing.findMany({ where: { tenantId: a.id }, orderBy: { id: 'asc' }, select: { id: true, price: true, available: true, updatedAt: true } }),
    recon: await db.reconRow.findMany({ where: { tenantId: a.id }, orderBy: { id: 'asc' } }),
    summaries: await db.reconSummary.findMany({ where: { tenantId: a.id }, orderBy: { id: 'asc' } }),
  };
}

beforeAll(async () => {
  h = await createHarness();
  const deps = () => ({ database: h.fixture.database, storage: h.storage });
  h.queue.handler = job => processUpload(deps(), job).then(() => undefined);
  h.queue.applyHandler = job => applyUpload({ ...deps(), recon: h.recon }, job).then(() => undefined);
  h.recon.handler = job => recomputeRecon(deps(), job);
  h.generatedFiles.handler = job => generateFile(deps(), job);
  a = await h.createOwner('templatesa');
  b = await h.createOwner('templatesb');
  admin = await h.member(a, 'admin');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');

  erpApplied = await prepare(a, manager, 'erp', await erpFile(2), erpFields, 'Shop ERP');
  await apply(a, manager, erpApplied);
  // the saved layout is recognised on the next file (no mapping asked); that upload is then discarded
  const second = await prepare(a, manager, 'erp', await erpFile(2));
  expect(await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ status: 'needs_review', templateVersion: 1 });
  expect((await h.request('POST', `/api/uploads/${second}/discard`, a, manager)).statusCode).toBe(200);
  talabatApplied = await prepare(a, manager, 'talabat', await marketplaceWorkbook(talabatHeaders, talabatRows), talabatMapping, 'Talabat export');
  await apply(a, manager, talabatApplied);
  await apply(a, manager, await prepare(a, manager, 'snoonu', await marketplaceWorkbook(snoonuHeaders, snoonuRows), snoonuMapping, 'Snoonu export'));
  await prepare(b, b.owner, 'erp', await erpFile(3), erpFields, 'Beta ERP');

  snapshot = await takeSnapshot();
  const preview = await h.request('POST', '/api/generated-files/preview', a, manager, previewBody);
  expect(preview.statusCode).toBe(200);
  previewBefore = preview.json().data;
}, 120_000);
afterAll(async () => { await h?.recon.drain(); await h?.close(); });

describe('GET /api/templates', () => {
  it('lists one entry per source: saved layouts with usage, mapping and the last file\'s columns', async () => {
    const items = await list();
    expect(items.map(e => [e.source, e.label, e.status])).toEqual([
      ['erp', 'ERP', 'set_up'], ['talabat', 'Talabat', 'set_up'], ['snoonu', 'Snoonu', 'set_up'], ['rafeeq', 'Rafeeq', 'not_set_up'], ['keeta', 'Keeta', 'not_set_up'],
    ]);
    const [erp, talabat, snoonu, rafeeq] = items as [TemplateSourceEntry, TemplateSourceEntry, TemplateSourceEntry, TemplateSourceEntry];
    expect(erp.fields.filter(f => f.required).map(f => f.key)).toEqual(['barcode', 'nameEn', 'price', 'stock']);
    expect(erp.outgoing).toBeNull();
    expect(erp.layouts).toEqual([{
      name: 'Shop ERP', version: 1, builtIn: false, editable: true, savedAt: expect.any(String), lastUsedAt: expect.any(String), usedByUploads: 2,
      mapping: { barcode: 'Barcode', nameEn: 'Item Name', nameAr: null, price: 'Sale Price', cost: 'Cost', stock: 'Qty', active: null, category: null, brand: null, sku: null },
      mapped: ['barcode', 'nameEn', 'price', 'cost', 'stock'], missingRequired: [], headers: erpHeaders,
    }]);
    expect(talabat.layouts.map(l => [l.name, l.version, l.usedByUploads, l.headers])).toEqual([['Talabat export', 1, 1, talabatHeaders]]);
    expect(talabat.fields.filter(f => f.required).map(f => f.key)).toEqual(['marketplaceProductId', 'barcode1', 'price', 'available']);
    expect(talabat.outgoing).toEqual({
      status: 'ready', reason: null,
      basedOn: { fileName: 'talabat.xlsx', appliedAt: expect.any(String), layout: { name: 'Talabat export', version: 1, current: true } },
      columns: { matchBy: { field: 'marketplaceProductId', header: 'sku' }, price: 'price', availability: 'active' },
    });
    expect(snoonu.outgoing).toMatchObject({ status: 'ready', columns: { matchBy: { field: 'barcode1', header: snoonuHeaders[0] }, price: snoonuHeaders[3], availability: snoonuHeaders[2] } });
    expect(rafeeq).toEqual({
      source: 'rafeeq', label: 'Rafeeq', status: 'not_set_up',
      reason: 'No saved layout yet. Qorloop does not know the Rafeeq file format; upload a Rafeeq file and save its column mapping to set it up.',
      fields: expect.any(Array), layouts: [],
      outgoing: { status: 'not_ready', reason: 'No Rafeeq file has been applied yet. Apply one to generate Rafeeq files.', basedOn: null, columns: null },
    });
  });
  it('exposes no internals: storage keys, upload ids or layout ids', async () => {
    const body = (await h.request('GET', '/api/templates', a, admin)).body;
    expect(body).not.toMatch(/storageKey|storage_key|tenants\/|templateId|checksum/);
    const ids = [
      ...(await h.fixture.prisma.upload.findMany({ where: { tenantId: a.id }, select: { id: true } })).map(u => u.id),
      ...(await h.fixture.prisma.inputTemplate.findMany({ where: { tenantId: a.id }, select: { id: true } })).map(t => t.id),
      a.id,
    ];
    for (const id of ids) expect(body).not.toContain(id);
  });
  it('every role may read; signed-out requests are refused', async () => {
    expect((await list(a, analyst)).map(e => e.status)).toEqual(['set_up', 'set_up', 'set_up', 'not_set_up', 'not_set_up']);
    expect((await list(a, manager)).length).toBe(5);
    expect((await h.request('GET', '/api/templates', a)).statusCode).toBe(401);
  });
  it('keeps stores apart', async () => {
    const theirs = await list(b, b.owner);
    expect(theirs.find(e => e.source === 'erp')!.layouts.map(l => [l.name, l.usedByUploads])).toEqual([['Beta ERP', 1]]);
    expect(theirs.filter(e => e.status === 'set_up').map(e => e.source)).toEqual(['erp']);
    expect(JSON.stringify(theirs)).not.toMatch(/Shop ERP|Talabat export/);
    expect(JSON.stringify(await list())).not.toMatch(/Beta ERP/);
  });
});

describe('PUT /api/templates/:source', () => {
  it('Owner and Admin only; Catalogue Manager and Analyst are refused and nothing changes', async () => {
    const body = { name: 'Shop ERP', expectedVersion: 1, fields: { price: 'Retail Price' } };
    for (const who of [manager, analyst]) expect([(await put('erp', body, who)).statusCode]).toEqual([403]);
    expect((await h.request('PUT', '/api/templates/erp', a, undefined, body)).statusCode).toBe(401);
    // an Owner's no-op edit: 200, no new version, no audit
    const same = await put('erp', { ...body, fields: { price: 'Sale Price' } }, a.owner);
    expect(same.statusCode).toBe(200);
    expect(same.json().data.layouts[0]).toMatchObject({ name: 'Shop ERP', version: 1 });
    expect((await versions('erp')).length).toBe(1);
    expect(await audits()).toEqual([]);
  });
  it('refuses invalid edits with field-level details and writes nothing', async () => {
    const base = { name: 'Shop ERP', expectedVersion: 1 };
    const cases: [Record<string, unknown>, { path: string; message: string }[]][] = [
      [{ price: 'Nope' }, [{ path: 'fields.price', message: 'Column "Nope" is not in the last ERP file' }]],
      [{ barcode: null }, [{ path: 'fields.barcode', message: 'Barcode must be mapped' }]],
      [{ nameEn: 'Barcode' }, [{ path: 'fields.nameEn', message: 'Column "Barcode" is already mapped to Barcode; a column can only be mapped to one field' }]],
      [{ colour: 'Barcode' }, [{ path: 'fields.colour', message: 'ERP files have no field "colour"' }]],
      [{ marketplaceProductId: 'Barcode' }, [{ path: 'fields.marketplaceProductId', message: 'ERP files have no field "marketplaceProductId"' }]],
    ];
    for (const [fields, details] of cases) {
      const r = await put('erp', { ...base, fields });
      expect([r.statusCode, r.json().error.code, r.json().error.details]).toEqual([400, 'VALIDATION_ERROR', details]);
    }
    for (const body of [
      { ...base, fields: {} }, { ...base, fields: { 'bad key': 'Barcode' } }, { ...base, fields: { price: 'x'.repeat(301) } },
      { ...base, expectedVersion: 0, fields: { price: 'Retail Price' } }, { name: 'Shop ERP', fields: { price: 'Retail Price' } },
      { ...base, fields: { price: 'Retail Price' }, tenantId: b.id },
    ]) expect((await put('erp', body)).statusCode).toBe(400);
    expect((await put('amazon', { ...base, fields: { price: 'Retail Price' } })).statusCode).toBe(400);
    for (const [source, name] of [['erp', 'Nope'], ['erp', 'Beta ERP'], ['rafeeq', 'Shop ERP'], ['talabat', 'Shop ERP']]) {
      const r = await put(source!, { name, expectedVersion: 1, fields: { price: 'price' } });
      expect([r.statusCode, r.json().error.code]).toEqual([404, 'NOT_FOUND']);
    }
    expect((await h.fixture.prisma.inputTemplate.count({ where: { tenantId: a.id } }))).toBe(3);
    expect(await audits()).toEqual([]);
  });
  it('writes the next version and an audit event with old and new headers; asks for no recompute', async () => {
    const calls = h.recon.calls.length;
    const [v1] = await versions('erp');
    const r = await put('erp', { name: 'Shop ERP', expectedVersion: 1, fields: { price: '  retail PRICE ', cost: null } });
    expect(r.statusCode).toBe(200);
    const updated = r.json().data as TemplateSourceEntry;
    expect(updated.source).toBe('erp');
    expect(updated.layouts).toHaveLength(1);
    expect(updated.layouts[0]).toMatchObject({
      name: 'Shop ERP', version: 2, usedByUploads: 2, headers: erpHeaders,
      mapping: { price: 'Retail Price', cost: null }, mapped: ['barcode', 'nameEn', 'price', 'stock'], missingRequired: [],
    });
    const [old, next] = await versions('erp');
    expect(old).toEqual(v1); // the version applied uploads point at is never rewritten
    expect([next!.version, next!.fields, next!.signature]).toEqual([2, { barcode: 'Barcode', nameEn: 'Item Name', price: 'Retail Price', stock: 'Qty' }, ['Barcode', 'Item Name', 'Retail Price', 'Qty']]);

    const adminUser = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id, name: 'admin' } });
    const events = await audits();
    expect(events.map(e => [e.entityId, e.actorId, e.details])).toEqual([[next!.id, adminUser.id, {
      source: 'erp', name: 'Shop ERP', fromVersion: 1, toVersion: 2,
      changes: [{ field: 'price', old: 'Sale Price', new: 'Retail Price' }, { field: 'cost', old: 'Cost', new: null }],
    }]]);
    expect(events[0]!.requestId).toBeTruthy();
    await h.recon.drain();
    expect(h.recon.calls.length).toBe(calls);

    const activity = (await h.request('GET', '/api/activity?eventType=stock_uploads', a, a.owner)).json().data.items as { type: string; summary: string; beforeAfter: unknown }[];
    expect(activity.find(x => x.type === 'template.updated')).toMatchObject({
      summary: 'Upload file mapping changed',
      beforeAfter: [{ field: 'price', before: 'Sale Price', after: 'Retail Price' }, { field: 'cost', before: 'Cost', after: null }],
    });
  });
  it('409 for a stale version; nothing is written', async () => {
    const r = await put('erp', { name: 'Shop ERP', expectedVersion: 1, fields: { price: 'Sale Price' } });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'CONFLICT']);
    expect((await versions('erp')).length).toBe(2);
    expect(await audits()).toHaveLength(1);
  });
  it('leaves applied uploads, the catalogue, comparisons and generated files as they were', async () => {
    const r = await put('talabat', { name: 'Talabat export', expectedVersion: 1, fields: { name: 'category 1' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.layouts[0]).toMatchObject({ version: 2, mapping: { name: 'category 1', price: 'price', available: 'active' } });
    await h.recon.drain();
    expect(await takeSnapshot()).toEqual(snapshot);
    // generated files keep reading the last applied file's own mapping until a file read with the new version is applied
    expect((await entry('talabat')).outgoing).toMatchObject({
      status: 'ready', basedOn: { layout: { name: 'Talabat export', version: 1, current: false } },
      columns: { matchBy: { field: 'marketplaceProductId', header: 'sku' }, price: 'price', availability: 'active' },
    });
    const preview = await h.request('POST', '/api/generated-files/preview', a, manager, previewBody);
    expect([preview.statusCode, preview.json().data]).toEqual([200, previewBefore]);
  });
  it('the next upload reads the new version; a file only the superseded version fits asks for a mapping', async () => {
    const next = await prepare(a, manager, 'erp', await erpFile(4));
    expect(await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: next } })).toMatchObject({
      status: 'needs_review', templateVersion: 2, mapping: { barcode: 'Barcode', nameEn: 'Item Name', price: 'Retail Price', stock: 'Qty' },
    });
    const review = (await h.request('GET', `/api/uploads/${next}/review?tab=all`, a, manager)).json().data;
    expect(review.rows[0].parsed.data).toMatchObject({ barcode: barcodes[0], price: 9 });
    expect(review.rows[0].parsed.data.cost).toBeUndefined();
    // version 1 (with Cost) would be the longer match for this file; superseded versions are no longer used
    const oldLayout = await prepare(a, manager, 'erp', await erpFile(4, erpHeaders.slice(0, 5)));
    expect((await h.request('GET', `/api/uploads/${oldLayout}`, a, manager)).json().data.status).toBe('needs_mapping');
    for (const id of [next, oldLayout]) expect((await h.request('POST', `/api/uploads/${id}/discard`, a, manager)).statusCode).toBe(200);
    expect((await entry('erp')).layouts[0]).toMatchObject({ version: 2, usedByUploads: 3 });
  });
  it('Snoonu branch columns match whatever the branch; an optional field can be unmapped', async () => {
    const same = await put('snoonu', { name: 'Snoonu export', expectedVersion: 1, fields: { price: 'price for branch Al Meera Al Khor(Update)' } });
    expect([same.statusCode, same.json().data.layouts[0].version, same.json().data.layouts[0].mapping.price]).toEqual([200, 1, snoonuHeaders[3]]);
    const r = await put('snoonu', { name: 'Snoonu export', expectedVersion: 1, fields: { name: null } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.layouts[0]).toMatchObject({ version: 2, mapped: ['barcode1', 'price', 'available'], mapping: { name: null, available: snoonuHeaders[2] } });
    expect((await put('snoonu', { name: 'Snoonu export', expectedVersion: 2, fields: { available: null } })).json().error.details)
      .toEqual([{ path: 'fields.available', message: 'Availability (True/False) or stock quantity must be mapped' }]);
  });
  it('another store can neither edit nor see these layouts, and its own edits stay its own', async () => {
    const theirs = await put('erp', { name: 'Shop ERP', expectedVersion: 2, fields: { price: 'Sale Price' } }, b.owner, b);
    expect(theirs.statusCode).toBe(404);
    const own = await put('erp', { name: 'Beta ERP', expectedVersion: 1, fields: { price: 'Retail Price' } }, b.owner, b);
    expect([own.statusCode, own.json().data.layouts[0].version]).toEqual([200, 2]);
    expect((await versions('erp')).map(v => v.version)).toEqual([1, 2]);
    expect((await entry('erp')).layouts.map(l => [l.name, l.version])).toEqual([['Shop ERP', 2]]);
    expect(await audits(b)).toHaveLength(1);
    expect((await audits()).map(e => (e.details as { source: string }).source)).toEqual(['erp', 'talabat', 'snoonu']);
  });
});
