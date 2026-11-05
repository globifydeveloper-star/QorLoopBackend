import { describe, expect, it } from '@jest/globals';
import {
  currentVersions, layoutView, mappingOf, notSetUpReason, outgoingView, planLayoutEdit, sourceEntry, type LayoutRow,
} from '../upload/templates.js';
import { fileColumns } from '../generated-files.js';
import { presentActivity } from '../activity.js';
import { snoonuHeaders, snoonuMapping, talabatHeaders, talabatMapping } from './fixtures/marketplace-files.js';

const erpHeaders = ['Barcode', 'Item Name', 'Sale Price', 'Qty', 'Cost', 'Retail Price'];
const erpFields = { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty', cost: 'Cost' };
const at = new Date('2026-11-04T08:00:00.000Z');
const row = (over: Partial<LayoutRow> = {}): LayoutRow => ({ id: 'l1', tenantId: 't', source: 'erp', name: 'Shop ERP', version: 1, fields: erpFields, createdAt: at, ...over });

describe('currentVersions', () => {
  it('keeps the newest version of each name, tenant and built-in layouts apart', () => {
    const layouts = [
      { tenantId: 't', source: 'erp', name: 'A', version: 1 }, { tenantId: 't', source: 'erp', name: 'A', version: 3 },
      { tenantId: 't', source: 'erp', name: 'A', version: 2 }, { tenantId: null, source: 'erp', name: 'A', version: 1 },
      { tenantId: 't', source: 'talabat', name: 'A', version: 1 }, { tenantId: 't', source: 'erp', name: 'B', version: 1 },
    ];
    expect(currentVersions(layouts).map(l => [l.tenantId, l.source, l.name, l.version])).toEqual([
      ['t', 'erp', 'A', 3], [null, 'erp', 'A', 1], ['t', 'talabat', 'A', 1], ['t', 'erp', 'B', 1],
    ]);
  });
});

describe('layout and source views', () => {
  it('lists every field of the source, null when unmapped or not a string', () => {
    expect(mappingOf('erp', { barcode: 'Barcode', nameEn: '', price: 3, stray: 'x' })).toEqual({
      barcode: 'Barcode', nameEn: null, nameAr: null, price: null, cost: null, stock: null, active: null, category: null, brand: null, sku: null,
    });
    expect(Object.keys(mappingOf('talabat', null))).toEqual(['marketplaceProductId', 'barcode1', 'barcode2', 'barcode3', 'name', 'price', 'available']);
  });
  it('says which fields are mapped and which required ones are missing', () => {
    const v = layoutView(row({ fields: { barcode: 'Barcode', price: 'Sale Price' } }), { usedByUploads: 2, lastUsedAt: at, headers: erpHeaders });
    expect(v).toMatchObject({
      name: 'Shop ERP', version: 1, builtIn: false, editable: true, savedAt: at.toISOString(), lastUsedAt: at.toISOString(), usedByUploads: 2,
      mapped: ['barcode', 'price'], missingRequired: ['nameEn', 'stock'], headers: erpHeaders,
    });
    expect(layoutView(row({ tenantId: null }), { usedByUploads: 0, lastUsedAt: null, headers: null })).toMatchObject({ builtIn: true, editable: false, lastUsedAt: null, headers: null });
  });
  it('gives a plain reason when a source has no layout; unknown marketplace formats say so', () => {
    expect(notSetUpReason('rafeeq')).toBe('No saved layout yet. Qorloop does not know the Rafeeq file format; upload a Rafeeq file and save its column mapping to set it up.');
    expect(notSetUpReason('keeta')).toMatch(/does not know the Keeta file format/);
    expect(notSetUpReason('erp')).toBe('No saved layout yet. Upload an ERP file and choose to save its column mapping.');
    expect(notSetUpReason('talabat')).toBe('No saved layout yet. Upload a Talabat file and choose to save its column mapping.');
    const empty = sourceEntry('keeta', [], null);
    expect(empty).toMatchObject({ source: 'keeta', label: 'Keeta', status: 'not_set_up', layouts: [], outgoing: null });
    expect(empty.fields.filter(f => f.required).map(f => f.key)).toEqual(['barcode1', 'price', 'available']);
  });
  it('orders layouts by last use, then newest saved', () => {
    const view = (name: string, lastUsedAt: Date | null, createdAt = at) => layoutView(row({ name, createdAt }), { usedByUploads: 0, lastUsedAt, headers: null });
    const entry = sourceEntry('erp', [view('never', null, new Date('2026-11-05T00:00:00Z')), view('old', new Date('2026-11-01T00:00:00Z')), view('recent', at)], null);
    expect(entry.layouts.map(l => l.name)).toEqual(['recent', 'old', 'never']);
    expect(entry).toMatchObject({ status: 'set_up', reason: null });
  });
});

describe('outgoing files', () => {
  const applied = (mapping: unknown, headers: unknown = talabatHeaders) => ({ fileName: 'talabat.xlsx', appliedAt: at, mapping, headers, templateId: 'v1' });
  const layoutOf = (id: string) => (id === 'v1' ? { name: 'Talabat export', version: 1, current: false } : null);
  it('match by the marketplace product ID when mapped, else by the first barcode (as generation does)', () => {
    expect(outgoingView('talabat', applied(talabatMapping), layoutOf)).toEqual({
      status: 'ready', reason: null,
      basedOn: { fileName: 'talabat.xlsx', appliedAt: at.toISOString(), layout: { name: 'Talabat export', version: 1, current: false } },
      columns: { matchBy: { field: 'marketplaceProductId', header: 'sku' }, price: 'price', availability: 'active' },
    });
    expect(outgoingView('snoonu', { ...applied(snoonuMapping, snoonuHeaders), templateId: null }, layoutOf)).toMatchObject({
      status: 'ready', basedOn: { layout: null },
      columns: { matchBy: { field: 'barcode1', header: snoonuHeaders[0] }, price: snoonuHeaders[3], availability: snoonuHeaders[2] },
    });
    expect(fileColumns({ ...talabatMapping, marketplaceProductId: '' }).identifierField).toBe('barcode1');
  });
  it('is not ready without an applied file, with an unmapped column, or when headers no longer fit', () => {
    expect(outgoingView('rafeeq', null, layoutOf)).toEqual({ status: 'not_ready', reason: 'No Rafeeq file has been applied yet. Apply one to generate Rafeeq files.', basedOn: null, columns: null });
    expect(outgoingView('talabat', applied({ ...talabatMapping, price: '' }), layoutOf)).toMatchObject({ status: 'not_ready', reason: expect.stringMatching(/no identifying, price or availability column mapped/), columns: { price: null } });
    expect(outgoingView('talabat', applied(talabatMapping, ['sku', 'price']), layoutOf).reason).toMatch(/no longer fit its mapping/);
    expect(outgoingView('talabat', applied({ ...talabatMapping, available: 'price' }), layoutOf).status).toBe('not_ready');
  });
});

describe('planLayoutEdit', () => {
  it('changes only the given fields and stores the file\'s own spelling; null unmaps an optional field', () => {
    const plan = planLayoutEdit('erp', erpFields, { price: '  retail   PRICE ', cost: null }, erpHeaders);
    expect(plan).toEqual({
      ok: true,
      fields: { barcode: 'Barcode', nameEn: 'Item Name', price: 'Retail Price', stock: 'Qty' },
      signature: ['Barcode', 'Item Name', 'Retail Price', 'Qty'],
      changes: [{ field: 'price', old: 'Sale Price', new: 'Retail Price' }, { field: 'cost', old: 'Cost', new: null }],
    });
  });
  it('is a no-op when nothing changes, including an unchanged header no longer in the file', () => {
    expect(planLayoutEdit('erp', erpFields, { price: 'Sale Price' }, erpHeaders)).toMatchObject({ ok: true, changes: [] });
    expect(planLayoutEdit('erp', erpFields, { cost: 'Cost' }, ['Barcode', 'Item Name', 'Sale Price', 'Qty'])).toMatchObject({ ok: true, changes: [] });
  });
  it('matches Snoonu branch columns whatever the branch', () => {
    const plan = planLayoutEdit('snoonu', snoonuMapping, { price: 'Price For Branch Al Meera Al Khor(Update)', name: null }, snoonuHeaders);
    expect(plan).toMatchObject({ ok: true, fields: { price: snoonuHeaders[3] }, changes: [{ field: 'name', old: snoonuHeaders[1], new: null }] });
  });
  it('takes headers by name when no file is on record', () => {
    expect(planLayoutEdit('erp', erpFields, { price: 'Typed Price' }, null)).toMatchObject({ ok: true, fields: { price: 'Typed Price' } });
  });
  it.each([
    [{ price: 'Nope' }, [{ path: 'fields.price', message: 'Column "Nope" is not in the last ERP file' }]],
    [{ barcode: null }, [{ path: 'fields.barcode', message: 'Barcode must be mapped' }]],
    [{ stock: '' }, [{ path: 'fields.stock', message: 'Stock quantity must be mapped' }]],
    [{ nameEn: 'barcode' }, [{ path: 'fields.nameEn', message: 'Column "Barcode" is already mapped to Barcode; a column can only be mapped to one field' }]],
    [{ colour: 'Barcode' }, [{ path: 'fields.colour', message: 'ERP files have no field "colour"' }]],
  ])('refuses %j', (requested, problems) => {
    expect(planLayoutEdit('erp', erpFields, requested, erpHeaders)).toEqual({ ok: false, problems });
  });
  it('refuses a header that the last file holds twice under one key', () => {
    const twoBranches = [...snoonuHeaders, 'Price For Branch Other(Update)'];
    expect(planLayoutEdit('snoonu', snoonuMapping, { price: 'Price For Branch X(Update)' }, twoBranches)).toEqual({
      ok: false, problems: [{ path: 'fields.price', message: 'Column "Price For Branch X(Update)" appears more than once in the last Snoonu file' }],
    });
  });
  it('requires the Talabat product ID, which is optional elsewhere', () => {
    expect(planLayoutEdit('talabat', talabatMapping, { marketplaceProductId: null }, talabatHeaders)).toMatchObject({ ok: false, problems: [{ path: 'fields.marketplaceProductId' }] });
    expect(planLayoutEdit('snoonu', { ...snoonuMapping, marketplaceProductId: snoonuHeaders[1], name: undefined }, { marketplaceProductId: null }, snoonuHeaders)).toMatchObject({ ok: true });
  });
});

describe('template.updated activity', () => {
  it('shows known fields only, as cleaned text, in the uploads group', () => {
    const shown = presentActivity('template.updated', {
      source: 'erp', name: 'Shop ERP', fromVersion: 1, toVersion: 2,
      changes: [{ field: 'price', old: 'Sale Price', new: 'Retail\u0007 Price' }, { field: 'secret', old: 'a', new: 'b' }, { field: 'cost', old: 'Cost', new: null }],
    });
    expect(shown).toEqual({
      type: 'template.updated', group: 'stock_uploads', summary: 'Upload file mapping changed',
      beforeAfter: [{ field: 'price', before: 'Sale Price', after: 'Retail Price' }, { field: 'cost', before: 'Cost', after: null }],
    });
    expect(presentActivity('template.updated', { changes: 'nope' }).beforeAfter).toEqual([]);
  });
});
