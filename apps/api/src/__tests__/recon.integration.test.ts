import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import ExcelJS from 'exceljs';
import { createHarness, type Harness, type Session, type Store } from './harness.js';
import { processUpload } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';
import { ReconRepository } from '../../../../packages/db/src/recon.js';
import { InlineReconQueue } from '../../../../packages/shared/src/recon.js';

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
const snoonuHeader = ['Item ID', 'EAN', 'Title', 'Price', 'In stock'];
const snoonuFields = { marketplaceProductId: 'Item ID', barcode1: 'EAN', name: 'Title', price: 'Price', available: 'In stock' };
const A = '6281000000011', B = '6281000000028', C = '6281000000035', D = '6281000000042';

/** Upload through the real API and pipeline, confirm the mapping, apply; the inline queues run the real workers. */
async function applyFile(store: Store, who: Session, source: string, rows: unknown[][], fields: Record<string, string>) {
  const file = await xlsx(rows);
  const created = await h.request('POST', '/api/uploads', store, who, { source, fileName: `${source}.xlsx`, size: file.length, contains: 'full' });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  h.storage.put((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).storageKey, file);
  expect((await h.request('POST', `/api/uploads/${id}/complete`, store, who)).statusCode).toBe(200);
  const status = async () => (await h.request('GET', `/api/uploads/${id}`, store, who)).json().data.status;
  if (await status() === 'needs_mapping') expect((await h.request('POST', `/api/uploads/${id}/mapping`, store, who, { fields })).statusCode).toBe(200);
  expect(await status()).toBe('needs_review');
  expect((await h.request('POST', `/api/uploads/${id}/apply`, store, who)).statusCode).toBe(200);
  expect(await status()).toBe('applied');
  await recon.drain();
  return id;
}
const summary = async (store: Store, who: Session, reference?: string) => {
  const r = await h.request('GET', '/api/recon/summary' + (reference ? `?reference=${reference}` : ''), store, who);
  expect(r.statusCode).toBe(200);
  return r.json().data as { reference: string; computedAt: string | null; marketplaces: Record<string, unknown>[] };
};
const byMarketplace = (s: Awaited<ReturnType<typeof summary>>) => Object.fromEntries(s.marketplaces.map(m => [m.marketplaceId, m]));
/** Every page of GET /api/recon/rows. */
async function allRows(store: Store, who: Session, query: string, limit = 2) {
  const items: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const r = await h.request('GET', `/api/recon/rows?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, store, who);
    expect(r.statusCode).toBe(200);
    items.push(...r.json().data.items);
    cursor = r.json().data.nextCursor;
  } while (cursor);
  return items;
}
const productId = async (store: Store, barcode: string) => (await h.fixture.prisma.product.findFirstOrThrow({ where: { tenantId: store.id, normalizedBarcode: barcode } })).id;
/** The counts recomputed directly from the stored rows, the way any report would count them. */
async function recount(store: Store, marketplaceId: string, reference: 'marketplace' | 'erp') {
  const rows = await h.fixture.prisma.reconRow.findMany({ where: { tenantId: store.id, marketplaceId } });
  const st = (r: (typeof rows)[number]) => (reference === 'erp' ? r.statusVsErp : r.status);
  const pm = (r: (typeof rows)[number]) => (reference === 'erp' ? r.priceMismatchVsErp : r.priceMismatchVsMarketplace);
  const stock = rows.filter(r => r.stockIssue).length, price = rows.filter(pm).length;
  return {
    stock, price, total: stock + price, listed: rows.filter(r => r.actualPrice !== null).length,
    notListed: rows.filter(r => st(r) === 'not_listed').length, noData: rows.filter(r => st(r) === 'no_data').length,
    missingFromErp: rows.filter(r => st(r) === 'missing_from_erp').length, newCount: rows.filter(r => st(r) === 'new').length,
  };
}
const pick = (m: Record<string, unknown>) => ({ stock: m.stock, price: m.price, total: m.total, listed: m.listed, notListed: m.notListed, noData: m.noData, missingFromErp: m.missingFromErp, newCount: m.newCount });

beforeAll(async () => {
  h = await createHarness();
  recon = h.recon as InlineReconQueue;
  h.queue.handler = job => processUpload({ database: h.fixture.database, storage: h.storage }, job).then(() => undefined);
  h.queue.applyHandler = job => applyUpload({ database: h.fixture.database, recon }, job).then(() => undefined);
  recon.handler = job => recomputeRecon({ database: h.fixture.database }, job);
  a = await h.createOwner('recona');
  b = await h.createOwner('reconb');
  manager = await h.member(a, 'catalogue_manager');
  analyst = await h.member(a, 'analyst');
  managerB = await h.member(b, 'catalogue_manager');

  // Marketplace price = ERP + 10%, so the two references disagree.
  expect((await h.request('PUT', '/api/pricing/settings', a, manager, { defaultRule: { mode: 'percent', value: 10 } })).statusCode).toBe(200);
  // Keeta is switched on but has no upload; Rafeeq has neither a switch nor an upload.
  await h.fixture.prisma.tenantMarketplace.create({ data: { tenantId: a.id, marketplaceId: 'keeta', enabled: true } });
  await recon.drain();
  await applyFile(a, manager, 'erp', [erpHeader, [A, 'Laban', 10, 5], [B, 'Juice', 4, 0], [C, 'Water', 1, 10], [D, 'Bread', 2, 3]], erpFields);
  await applyFile(a, manager, 'talabat', [talabatHeader,
    ['T-A', A, 'Laban', 11, 'TRUE'], // in sync vs Marketplace (11), price mismatch vs ERP (10)
    ['T-B', B, 'Juice', 4, 'TRUE'], // no stock: available_but_out_of_stock; price 4 = ERP, != Marketplace 4.4
    ['T-C', C, 'Water', 1.1, 'FALSE'], // in stock but hidden: unavailable_but_in_stock; 1.1 = Marketplace, != ERP 1
    ['T-X', '999', 'Mystery', 3, 'TRUE'], // matches nothing: no recon row
  ], talabatFields);
  await applyFile(a, manager, 'snoonu', [snoonuHeader, ['S-A', A, 'Laban', 10, 'TRUE']], snoonuFields);
}, 120_000);
afterAll(async () => { await h.close(); });

describe('recon after ERP, Talabat and Snoonu uploads', () => {
  it('summary per marketplace against the Marketplace reference', async () => {
    const s = await summary(a, manager, 'marketplace');
    expect(s.reference).toBe('marketplace');
    expect(s.computedAt).toBeTruthy();
    const m = byMarketplace(s);
    // Rafeeq is neither switched on nor uploaded: not reconciled at all
    expect(s.marketplaces.map(x => x.marketplaceId)).toEqual(['talabat', 'snoonu', 'keeta']);
    expect(pick(m.talabat!)).toEqual({ stock: 2, price: 1, total: 3, listed: 3, notListed: 1, noData: 0, missingFromErp: 0, newCount: 0 });
    expect(pick(m.snoonu!)).toEqual({ stock: 0, price: 1, total: 1, listed: 1, notListed: 3, noData: 0, missingFromErp: 0, newCount: 0 });
    expect(m.talabat).toMatchObject({ hasData: true, stale: false });
    expect(m.talabat!.lastUploadAt).toBeTruthy();
  });

  it('against the ERP reference only the price counts move', async () => {
    const m = byMarketplace(await summary(a, analyst, 'erp'));
    expect(pick(m.talabat!)).toEqual({ stock: 2, price: 2, total: 4, listed: 3, notListed: 1, noData: 0, missingFromErp: 0, newCount: 0 });
    expect(pick(m.snoonu!)).toEqual({ stock: 0, price: 0, total: 0, listed: 1, notListed: 3, noData: 0, missingFromErp: 0, newCount: 0 });
  });

  it('a switched-on marketplace without an upload shows no data, not zeros', async () => {
    const keeta = byMarketplace(await summary(a, manager)).keeta!;
    expect(keeta).toMatchObject({ hasData: false, noData: 4, stock: 0, price: 0, total: 0, listed: 0, lastUploadAt: null, stale: false });
    expect((await allRows(a, manager, 'marketplaceId=keeta', 50)).map(r => r.status)).toEqual(['no_data', 'no_data', 'no_data', 'no_data']);
  });

  it('every summary count equals a direct recount from the stored rows, for both references', async () => {
    for (const reference of ['marketplace', 'erp'] as const) {
      const m = byMarketplace(await summary(a, manager, reference));
      for (const id of ['talabat', 'snoonu', 'keeta']) expect(pick(m[id]!)).toEqual(await recount(a, id, reference));
    }
  });

  it('the rows endpoint agrees with the summary and sorts urgent first', async () => {
    for (const reference of ['marketplace', 'erp'] as const) {
      const m = byMarketplace(await summary(a, manager, reference));
      for (const id of ['talabat', 'snoonu']) {
        expect((await allRows(a, manager, `marketplaceId=${id}&type=stock&reference=${reference}`)).length).toBe(m[id]!.stock);
        expect((await allRows(a, manager, `marketplaceId=${id}&type=price&reference=${reference}`)).length).toBe(m[id]!.price);
        expect((await allRows(a, manager, `marketplaceId=${id}&type=all&reference=${reference}`)).length).toBe(4);
      }
    }
    const talabat = await allRows(a, manager, 'marketplaceId=talabat&reference=marketplace', 1);
    // urgent first; rows of equal urgency follow in product id order
    expect(talabat.slice(0, 2).map(r => [r.barcode, r.status, r.stockIssue, r.priceMismatch])).toEqual([
      [B, 'mismatch', 'available_but_out_of_stock', true],
      [C, 'mismatch', 'unavailable_but_in_stock', false],
    ]);
    expect(talabat.slice(2).map(r => [r.barcode, r.status]).sort()).toEqual([[A, 'in_sync'], [D, 'not_listed']]);
    const laban = talabat.find(r => r.barcode === A)!;
    expect(laban).toMatchObject({
      nameEn: 'Laban', status: 'in_sync', expectedPrice: 11, marketplacePrice: 11, marketplacePriceSource: 'default', erpPrice: 10, actualPrice: 11,
      erpAvailable: true, actualAvailable: true, priceMismatchVsErp: true, priceMismatchVsMarketplace: false,
    });
    const asErp = (await allRows(a, manager, 'marketplaceId=talabat&reference=erp', 50)).find(r => r.barcode === A)!;
    expect(asErp).toMatchObject({ status: 'mismatch', priceMismatch: true, expectedPrice: 10 });
    expect((await allRows(a, manager, 'marketplaceId=talabat&status=not_listed', 50)).map(r => r.barcode)).toEqual([D]);
  });

  it('uses the store\'s comparison reference when none is asked for', async () => {
    expect((await summary(a, manager)).reference).toBe('marketplace');
    expect((await h.request('PUT', '/api/pricing/settings', a, manager, { compareReferenceDefault: 'erp' })).statusCode).toBe(200);
    await recon.drain();
    expect((await summary(a, manager)).reference).toBe('erp');
    expect((await h.request('GET', '/api/recon/rows?marketplaceId=talabat', a, manager)).json().data.reference).toBe('erp');
    expect((await h.request('PUT', '/api/pricing/settings', a, manager, { compareReferenceDefault: 'marketplace' })).statusCode).toBe(200);
    await recon.drain();
  });

  it('validates queries strictly', async () => {
    for (const q of ['/api/recon/summary?reference=cost', '/api/recon/summary?x=1', '/api/recon/rows', '/api/recon/rows?marketplaceId=amazon',
      '/api/recon/rows?marketplaceId=talabat&type=new', '/api/recon/rows?marketplaceId=talabat&limit=500', '/api/recon/rows?marketplaceId=talabat&cursor=nope']) {
      expect((await h.request('GET', q, a, manager)).statusCode).toBe(400);
    }
  });
});

describe('triggers', () => {
  it('a pricing change recomputes the rows', async () => {
    const before = recon.runs;
    expect((await h.request('PUT', '/api/pricing/settings', a, manager, { defaultRule: { mode: 'same' } })).statusCode).toBe(200);
    await recon.drain();
    expect(recon.runs).toBe(before + 1);
    // Marketplace price is now the ERP price: Laban on Talabat (11) mismatches, Snoonu (10) is in sync
    const m = byMarketplace(await summary(a, manager, 'marketplace'));
    expect(m.talabat).toMatchObject({ price: 2 });
    expect(m.snoonu).toMatchObject({ price: 0 });
    expect((await h.fixture.prisma.reconRow.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'talabat', productId: await productId(a, A) } })).marketplacePrice?.toNumber()).toBe(10);
    expect((await h.request('PUT', '/api/pricing/settings', a, manager, { defaultRule: { mode: 'percent', value: 10 } })).statusCode).toBe(200);
    await recon.drain();
  });

  it('a product offer recomputes the resolved price and its source', async () => {
    const id = await productId(a, A);
    expect((await h.request('PUT', `/api/products/${id}/offer`, a, manager, { price: 9 })).statusCode).toBe(200);
    await recon.drain();
    const row = await h.fixture.prisma.reconRow.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'snoonu', productId: id } });
    expect([row.marketplacePrice?.toNumber(), row.marketplacePriceSource, row.status]).toEqual([9, 'offer', 'mismatch']);
    expect((await h.request('DELETE', `/api/products/${id}/offer`, a, manager)).statusCode).toBe(200);
    await recon.drain();
  });

  it('a status change, an activation and an apply each ask for a recompute', async () => {
    const start = recon.calls.length;
    const d = await productId(a, D);
    expect((await h.request('PATCH', `/api/products/${d}`, a, manager, { status: 'inactive' })).statusCode).toBe(200);
    await recon.drain();
    expect(recon.calls.slice(start).map(c => c.reason)).toEqual(['product.status']);
    // inactive and unlisted: in sync, no longer "not listed"
    expect((await h.fixture.prisma.reconRow.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'talabat', productId: d } })).status).toBe('in_sync');
    // back to active without the readiness check (it has no Arabic name or category), as the first import made it
    await h.fixture.prisma.product.update({ where: { id: d }, data: { status: 'active' } });

    // a second ERP import makes 'new' products; activating one asks for a recompute
    await applyFile(a, manager, 'erp', [erpHeader, [A, 'Laban', 10, 5], [B, 'Juice', 4, 0], [C, 'Water', 1, 10], [D, 'Bread', 2, 3], ['6281000000059', 'Dates', 7, 9]], erpFields);
    expect(recon.calls.at(-1)).toEqual({ tenantId: a.id, reason: 'upload.applied' });
    const dates = await productId(a, '6281000000059');
    expect((await h.fixture.prisma.reconRow.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'talabat', productId: dates } })).status).toBe('new');
    expect(byMarketplace(await summary(a, manager)).talabat).toMatchObject({ newCount: 1 });
    await h.fixture.prisma.product.update({ where: { id: dates }, data: { nameAr: 'تمر', categoryId: (await h.fixture.prisma.category.create({ data: { tenantId: a.id, nameEn: 'Pantry' } })).id } });
    expect((await h.request('POST', '/api/products/activate', a, manager, { ids: [dates] })).json().data.activated).toBe(1);
    await recon.drain();
    expect(recon.calls.at(-1)).toEqual({ tenantId: a.id, reason: 'product.activated' });
    expect((await h.fixture.prisma.reconRow.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'talabat', productId: dates } })).status).toBe('not_listed');
  });

  it('a product dropped from a full ERP file but still listed is missing_from_erp', async () => {
    await applyFile(a, manager, 'erp', [erpHeader, [A, 'Laban', 10, 5], [C, 'Water', 1, 10], [D, 'Bread', 2, 3], ['6281000000059', 'Dates', 7, 9]], erpFields);
    const row = await h.fixture.prisma.reconRow.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'talabat', productId: await productId(a, B) } });
    expect([row.status, row.statusVsErp, row.stockIssue]).toEqual(['missing_from_erp', 'missing_from_erp', 'available_but_out_of_stock']);
    expect(byMarketplace(await summary(a, manager))).toMatchObject({ talabat: { missingFromErp: 1 }, snoonu: { missingFromErp: 0 } });
    // the most urgent row comes first
    expect((await allRows(a, manager, 'marketplaceId=talabat', 50))[0]).toMatchObject({ barcode: B, stockIssue: 'available_but_out_of_stock' });
  });

  it('POST /api/recon/recompute queues a run for pricing.edit; Analyst 403, anonymous 401', async () => {
    const before = recon.runs;
    const r = await h.request('POST', '/api/recon/recompute', a, manager);
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual({ queued: true });
    await recon.drain();
    expect(recon.runs).toBe(before + 1);
    expect(recon.calls.at(-1)).toEqual({ tenantId: a.id, reason: 'manual' });
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'recon.recompute_requested' } })).toBe(1);
    expect((await h.request('POST', '/api/recon/recompute', a, analyst)).statusCode).toBe(403);
    expect((await h.request('POST', '/api/recon/recompute', a)).statusCode).toBe(401);
    expect(recon.runs).toBe(before + 1);
  });

  it('read endpoints: Analyst may read (recon.view); anonymous may not', async () => {
    expect((await h.request('GET', '/api/recon/summary', a, analyst)).statusCode).toBe(200);
    expect((await h.request('GET', '/api/recon/rows?marketplaceId=talabat', a, analyst)).statusCode).toBe(200);
    expect((await h.request('GET', '/api/recon/summary', a)).statusCode).toBe(401);
    expect((await h.request('GET', '/api/recon/rows?marketplaceId=talabat', a)).statusCode).toBe(401);
  });
});

describe('coalescing, idempotency and failure', () => {
  it('many triggers in a burst collapse into one run', async () => {
    const before = recon.runs;
    for (let i = 0; i < 25; i++) await recon.enqueueRecon(a.id, 'manual');
    await recon.drain();
    expect(recon.runs).toBe(before + 1);
  });

  it('triggers during a run give exactly one more run, so no change is missed', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let first = true;
    const runs: number[] = [];
    recon.handler = async job => {
      runs.push(Date.now());
      if (first) { first = false; await gate; }
      return recomputeRecon({ database: h.fixture.database }, job);
    };
    try {
      await recon.enqueueRecon(a.id, 'manual');
      while (!runs.length) await new Promise(r => setTimeout(r, 2));
      for (let i = 0; i < 10; i++) await recon.enqueueRecon(a.id, 'manual');
      release();
      await recon.drain();
      expect(runs).toHaveLength(2);
    } finally {
      recon.handler = job => recomputeRecon({ database: h.fixture.database }, job);
    }
  });

  it('a repeated run rewrites nothing', async () => {
    await recomputeRecon({ database: h.fixture.database }, { tenantId: a.id, reason: 'manual' });
    const again = await recomputeRecon({ database: h.fixture.database }, { tenantId: a.id, reason: 'manual' });
    expect(again).toMatchObject({ inserted: 0, updated: 0, removed: 0, marketplaces: 3, products: 5, rows: 15, summaries: 6 });
  });

  it('a failed run keeps the previous rows and summaries and records a safe failure summary', async () => {
    const rowsBefore = await h.fixture.prisma.reconRow.findMany({ where: { tenantId: a.id }, orderBy: [{ marketplaceId: 'asc' }, { productId: 'asc' }] });
    const summariesBefore = await h.fixture.prisma.reconSummary.findMany({ where: { tenantId: a.id }, orderBy: [{ marketplaceId: 'asc' }, { reference: 'asc' }] });
    // a price change the failed run would have written (straight to the database: no queued run races the mock)
    const rule = await h.fixture.prisma.productPriceRule.create({ data: { tenantId: a.id, productId: await productId(a, A), mode: 'fixed', value: 99 } });
    const spy = jest.spyOn(ReconRepository.prototype, 'writeSummaries').mockRejectedValueOnce(new Error('boom near "6281000000011"'));
    const warned: object[] = [];
    try {
      await expect(recomputeRecon({ database: h.fixture.database, log: { info: () => undefined, warn: o => { warned.push(o); } } }, { tenantId: a.id, reason: 'manual' })).rejects.toThrow('boom');
    } finally { spy.mockRestore(); }
    expect(await h.fixture.prisma.reconRow.findMany({ where: { tenantId: a.id }, orderBy: [{ marketplaceId: 'asc' }, { productId: 'asc' }] })).toEqual(rowsBefore);
    expect(await h.fixture.prisma.reconSummary.findMany({ where: { tenantId: a.id }, orderBy: [{ marketplaceId: 'asc' }, { reference: 'asc' }] })).toEqual(summariesBefore);
    const failed = await h.fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.id, action: 'recon.failed' }, orderBy: { createdAt: 'desc' } });
    expect(failed.details).toMatchObject({ reason: 'manual', phase: 'summaries', errorType: 'Error', message: 'boom near' });
    expect(JSON.stringify(failed.details) + JSON.stringify(warned)).not.toContain('6281000000011');
    // the retry succeeds and writes the change
    await recomputeRecon({ database: h.fixture.database }, { tenantId: a.id, reason: 'manual' });
    expect((await h.fixture.prisma.reconRow.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'talabat', productId: await productId(a, A) } })).marketplacePrice?.toNumber()).toBe(99);
    await h.fixture.prisma.productPriceRule.delete({ where: { id: rule.id } });
    await recomputeRecon({ database: h.fixture.database }, { tenantId: a.id, reason: 'manual' });
  });

  it('switching a marketplace off removes its rows and summaries', async () => {
    await h.fixture.prisma.tenantMarketplace.update({ where: { tenantId_marketplaceId: { tenantId: a.id, marketplaceId: 'keeta' } }, data: { enabled: false } });
    const r = await recomputeRecon({ database: h.fixture.database }, { tenantId: a.id, reason: 'manual' });
    expect(r).toMatchObject({ removed: 5, inserted: 0, summaries: 4 });
    expect(await h.fixture.prisma.reconRow.count({ where: { tenantId: a.id, marketplaceId: 'keeta' } })).toBe(0);
    expect((await summary(a, manager)).marketplaces.map(m => m.marketplaceId)).toEqual(['talabat', 'snoonu']);
  });
});

describe('stale', () => {
  it('is stale once the latest applied upload is older than staleHours, on read and in the stored row', async () => {
    await h.fixture.prisma.tenantSettings.update({ where: { tenantId: a.id }, data: { staleHours: 1 } });
    await h.fixture.prisma.upload.updateMany({ where: { tenantId: a.id, source: 'snoonu' }, data: { appliedAt: new Date(Date.now() - 2 * 3_600_000) } });
    // read time: the stored last upload is still recent until the next run
    expect(byMarketplace(await summary(a, manager)).snoonu).toMatchObject({ stale: false });
    await recomputeRecon({ database: h.fixture.database }, { tenantId: a.id, reason: 'manual' });
    expect(byMarketplace(await summary(a, manager))).toMatchObject({ snoonu: { stale: true }, talabat: { stale: false } });
    expect((await h.fixture.prisma.reconSummary.findFirstOrThrow({ where: { tenantId: a.id, marketplaceId: 'snoonu', reference: 'erp' } })).stale).toBe(true);
    // a longer setting is honoured on read, without a run
    await h.fixture.prisma.tenantSettings.update({ where: { tenantId: a.id }, data: { staleHours: 24 } });
    expect(byMarketplace(await summary(a, manager)).snoonu).toMatchObject({ stale: false });
  });
});

describe('tenant isolation', () => {
  it('each store sees and computes only its own rows', async () => {
    await applyFile(b, managerB, 'erp', [erpHeader, [A, 'Other Laban', 3, 1]], erpFields);
    await applyFile(b, managerB, 'talabat', [talabatHeader, ['T-A', A, 'Other Laban', 3, 'TRUE']], talabatFields);
    const sb = await summary(b, managerB);
    expect(sb.marketplaces.map(m => m.marketplaceId)).toEqual(['talabat']);
    expect(pick(byMarketplace(sb).talabat!)).toEqual({ stock: 0, price: 0, total: 0, listed: 1, notListed: 0, noData: 0, missingFromErp: 0, newCount: 0 });
    const rowsB = await allRows(b, managerB, 'marketplaceId=talabat', 50);
    expect(rowsB.map(r => r.nameEn)).toEqual(['Other Laban']);
    expect(await h.fixture.prisma.reconRow.count({ where: { tenantId: b.id } })).toBe(1);
    // store A's results are untouched by store B's runs
    expect(byMarketplace(await summary(a, manager)).talabat).toMatchObject({ listed: 3 });
    // a cursor from one store does not reach another store's rows
    const page = (await h.request('GET', '/api/recon/rows?marketplaceId=talabat&limit=1', a, manager)).json().data;
    const other = await h.request('GET', `/api/recon/rows?marketplaceId=talabat&limit=50&cursor=${page.nextCursor}`, b, managerB);
    expect(other.json().data.items.every((r: { nameEn: string }) => r.nameEn === 'Other Laban')).toBe(true);
    // a manager of store A cannot use store B's host with A's session
    expect((await h.request('GET', '/api/recon/summary', b, manager)).statusCode).toBe(401);
  });

  it('is documented: summary, rows and recompute', () => {
    expect(Object.keys(h.api.spec.paths)).toEqual(expect.arrayContaining(['/api/recon/summary', '/api/recon/rows', '/api/recon/recompute']));
  });
});
