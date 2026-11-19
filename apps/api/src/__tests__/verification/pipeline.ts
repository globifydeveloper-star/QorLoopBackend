/**
 * Drives the REAL pipeline for a golden dataset: upload -> mapping -> review -> apply -> Qorloop edits -> recon -> generated
 * files, through the API (Nest app, inline queues, embedded or real PostgreSQL) and the worker functions the queues call.
 * Setup that has no single-step API with past dates (offers that already ended, upload ages) writes the same rows the
 * product reads, through Prisma. Nothing here computes an expected answer.
 */
import { expect } from '@jest/globals';
import ExcelJS from 'exceljs';
import type { Harness, Session, Store } from '../harness.js';
import { recomputeRecon } from '../../../../worker/src/recompute-recon.js';
import {
  type Dataset, type Cell, ERP_MAPPING, TALABAT_MAPPING, SNOONU_MAPPING, TALABAT_HEADERS, SNOONU_HEADERS, erpFile, talabatFile, snoonuFile, workbook,
} from './datasets.js';
import type { MarketplaceId } from './expected.js';

export type UploadResult = { id: string; status: string; errorMessage: string | null; errors: { row: number; column: string | null; value: string | null; reason: string }[]; ms: { process: number; apply: number } };
export type GeneratedOutcome = { previewStatus: number; previewMessage: string | null; preview: Record<string, unknown> | null; header: unknown[]; rows: unknown[][]; ms: number };
export type DatasetRun = {
  store: Store; manager: Session; now: Date;
  erp1: UploadResult; erp2?: UploadResult; market: Partial<Record<MarketplaceId, UploadResult>>;
  products: Awaited<ReturnType<typeof readProducts>>;
  listings: { marketplaceId: string; marketplaceProductId: string; barcode: string | null }[];
  recon: { barcode: string; marketplaceId: string; status: string; marketplacePrice: number | null; source: string | null; actualPrice: number | null;
    catalogueAvailable: boolean | null; erpAvailable: boolean | null; priceMismatch: boolean; priceMismatchVsErp: boolean; stockIssue: string | null }[];
  summary: { marketplaceId: string; stale: boolean; stock: number; price: number; total: number; notListed: number; missingFromErp: number; newCount: number; noData: number }[];
  enabledWithoutFile: MarketplaceId[];
  timings: Record<string, number>;
};

export const fils = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? null : Math.round(Number(d.toString()) * 1000));

export function pipeline(h: Harness) {
  const deps = () => ({ database: h.fixture.database, storage: h.storage });

  async function allErrors(store: Store, who: Session, id: string) {
    const out: UploadResult['errors'] = [];
    for (let page = 1; page < 1000; page++) {
      const r = await h.request('GET', `/api/uploads/${id}/errors?page=${page}`, store, who);
      expect(r.statusCode).toBe(200);
      const d = r.json().data;
      out.push(...d.errors);
      if (!d.errors.length || out.length >= d.total) break;
    }
    return out;
  }

  /** Create, store the bytes, complete, map when asked. Stops at needs_review / rejected / failed. */
  async function upload(store: Store, who: Session, source: string, data: Buffer, fields: Record<string, string>, fileName = `${source}.xlsx`, contains: 'full' | 'partial' = 'full') {
    const t0 = Date.now();
    const created = await h.request('POST', '/api/uploads', store, who, { source, fileName, size: data.length, contains });
    if (created.statusCode !== 200) return { id: '', status: `http_${created.statusCode}`, errorMessage: created.json().error?.message ?? null, errors: [], ms: { process: 0, apply: 0 } } as UploadResult;
    const id = created.json().data.id as string;
    const record = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } });
    await h.storage.put(record.storageKey, data);
    expect((await h.request('POST', `/api/uploads/${id}/complete`, store, who)).statusCode).toBe(200);
    let status = (await h.request('GET', `/api/uploads/${id}`, store, who)).json().data;
    if (status.status === 'needs_mapping') {
      const m = await h.request('POST', `/api/uploads/${id}/mapping`, store, who, { fields });
      expect([m.statusCode, m.body.slice(0, 300)]).toEqual([200, expect.any(String)]);
      status = (await h.request('GET', `/api/uploads/${id}`, store, who)).json().data;
    }
    const processMs = Date.now() - t0;
    return { id, status: status.status, errorMessage: status.errorMessage ?? null, errors: await allErrors(store, who, id), ms: { process: processMs, apply: 0 } } as UploadResult;
  }

  async function apply(store: Store, who: Session, u: UploadResult) {
    if (u.status !== 'needs_review') return u;
    const t0 = Date.now();
    const r = await h.request('POST', `/api/uploads/${u.id}/apply`, store, who);
    expect([r.statusCode, r.body.slice(0, 300)]).toEqual([200, expect.any(String)]);
    await h.recon.drain();
    const after = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: u.id } });
    return { ...u, status: after.status, ms: { ...u.ms, apply: Date.now() - t0 } };
  }

  async function readProducts(tenantId: string) {
    return h.fixture.prisma.product.findMany({ where: { tenantId }, orderBy: { normalizedBarcode: 'asc' } });
  }

  async function setupPricing(ds: Dataset, store: Store, now: Date) {
    const p = ds.pricing;
    const prisma = h.fixture.prisma;
    const tenantId = store.id;
    const ruleData = (r: { mode: string; value?: string }) => ({ mode: r.mode, value: r.mode === 'same' ? 0 : Number(r.value) });
    if (p?.defaultRule || p?.rounding || p?.perMarketplace) {
      const data = { ...(p.defaultRule ? { defaultRuleMode: p.defaultRule.mode, defaultRuleValue: ruleData(p.defaultRule).value } : {}),
        rounding: p.rounding ?? 'exact', perMarketplaceEnabled: Boolean(p.perMarketplace) };
      await prisma.pricingSettings.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
    }
    for (const [mp, r] of Object.entries(p?.perMarketplace ?? {})) {
      await prisma.marketplacePriceRule.create({ data: { tenantId, marketplaceId: mp, productId: null, ...ruleData(r), rounding: r.rounding } });
    }
    const ids: Record<string, string> = {};
    for (const [cat, def] of Object.entries(p?.categories ?? {})) {
      const c = await prisma.category.create({ data: { tenantId, nameEn: cat } });
      ids[cat] = c.id;
      if (def.rule) await prisma.categoryPriceRule.create({ data: { tenantId, categoryId: c.id, subcategoryId: null, ...ruleData(def.rule) } });
      for (const [sub, r] of Object.entries(def.subcategories ?? {})) {
        const sc = await prisma.category.create({ data: { tenantId, nameEn: sub, parentId: c.id } });
        ids[`${cat}/${sub}`] = sc.id;
        if (r) await prisma.categoryPriceRule.create({ data: { tenantId, categoryId: c.id, subcategoryId: sc.id, ...ruleData(r) } });
      }
    }
    const product = (barcode: string) => prisma.product.findUniqueOrThrow({ where: { tenantId_normalizedBarcode: { tenantId, normalizedBarcode: barcode } } });
    for (const [barcode, [cat, sub]] of Object.entries(p?.assign ?? {})) {
      await prisma.product.update({ where: { id: (await product(barcode)).id }, data: { categoryId: ids[cat], subcategoryId: sub ? ids[`${cat}/${sub}`] : null } });
    }
    for (const [barcode, r] of Object.entries(p?.productRules ?? {})) {
      await prisma.productPriceRule.create({ data: { tenantId, productId: (await product(barcode)).id, ...ruleData(r) } });
    }
    for (const [barcode, o] of Object.entries(p?.offers ?? {})) {
      await prisma.productOffer.create({ data: { tenantId, productId: (await product(barcode)).id, price: Number(o.price),
        validFrom: o.fromMs === null ? null : new Date(now.getTime() + o.fromMs), validUntil: o.untilMs === null ? null : new Date(now.getTime() + o.untilMs) } });
    }
  }

  async function edits(ds: Dataset, store: Store, who: Session) {
    const prisma = h.fixture.prisma;
    const idOf = async (barcode: string) => (await prisma.product.findUnique({ where: { tenantId_normalizedBarcode: { tenantId: store.id, normalizedBarcode: barcode } } }))?.id;
    if (ds.block?.length) {
      const productIds = (await Promise.all(ds.block.map(idOf))).filter(Boolean);
      const preview = await h.request('POST', '/api/products/block/preview', store, who, { productIds, reason: 'old' });
      expect(preview.statusCode).toBe(200);
      const blocked = await h.request('POST', '/api/products/block', store, who, { productIds, reason: 'old', previewToken: preview.json().data.previewToken });
      expect([blocked.statusCode, blocked.body.slice(0, 200)]).toEqual([200, expect.any(String)]);
    }
    for (const barcode of ds.inactive ?? []) {
      const id = await idOf(barcode);
      if (!id) continue;
      const r = await h.request('PATCH', `/api/products/${id}`, store, who, { status: 'inactive' });
      expect([r.statusCode, r.body.slice(0, 200)]).toEqual([200, expect.any(String)]);
    }
    await h.recon.drain();
  }

  async function readRecon(tenantId: string): Promise<DatasetRun['recon']> {
    const rows = await h.fixture.prisma.reconRow.findMany({ where: { tenantId }, include: { product: { select: { normalizedBarcode: true } } } });
    return rows.map(r => ({ barcode: r.product.normalizedBarcode, marketplaceId: r.marketplaceId, status: r.status, marketplacePrice: fils(r.marketplacePrice),
      source: r.marketplacePriceSource, actualPrice: fils(r.actualPrice), catalogueAvailable: r.catalogueAvailable, erpAvailable: r.erpAvailable,
      priceMismatch: r.priceMismatchVsMarketplace, priceMismatchVsErp: r.priceMismatchVsErp, stockIssue: r.stockIssue }));
  }

  async function run(ds: Dataset, existing?: { store: Store; manager: Session }): Promise<DatasetRun> {
    const timings: Record<string, number> = {};
    const store = existing?.store ?? await h.createOwner(ds.slug);
    const manager = existing?.manager ?? await h.member(store, 'catalogue_manager');
    const now = new Date();
    const prisma = h.fixture.prisma;
    const settings = { priceTolerance: Number(ds.settings.tolerance), stockThreshold: ds.settings.threshold, staleHours: ds.settings.staleHours };
    await prisma.tenantSettings.upsert({ where: { tenantId: store.id }, create: { tenantId: store.id, ...settings }, update: settings });

    let erp1 = await upload(store, manager, 'erp', await erpFile(ds.erp), ERP_MAPPING);
    erp1 = await apply(store, manager, erp1);
    timings.erpProcess = erp1.ms.process; timings.erpApply = erp1.ms.apply;
    const result: DatasetRun = { store, manager, now, erp1, market: {}, products: [], listings: [], recon: [], summary: [], enabledWithoutFile: [], timings };
    if (erp1.status !== 'applied') { result.products = await readProducts(store.id); return result; }

    await edits(ds, store, manager);
    if (ds.erp2) result.erp2 = await apply(store, manager, await upload(store, manager, 'erp', await erpFile(ds.erp2), ERP_MAPPING, 'erp-second.xlsx'));
    await setupPricing(ds, store, now);
    if (ds.talabat) result.market.talabat = await apply(store, manager, await upload(store, manager, 'talabat', await talabatFile(ds.talabat), TALABAT_MAPPING));
    if (ds.snoonu) result.market.snoonu = await apply(store, manager, await upload(store, manager, 'snoonu', await snoonuFile(ds.snoonu), SNOONU_MAPPING));
    timings.marketProcess = Object.values(result.market).reduce((s, u) => s + u!.ms.process, 0);
    timings.marketApply = Object.values(result.market).reduce((s, u) => s + u!.ms.apply, 0);
    for (const [mp, hours] of Object.entries(ds.uploadAgeHours ?? {})) {
      const u = result.market[mp as MarketplaceId];
      if (!u) continue;
      const at = new Date(now.getTime() - (hours as number) * 3_600_000);
      await prisma.upload.update({ where: { id: u.id }, data: { createdAt: at, appliedAt: at } });
    }
    const t0 = Date.now();
    await recomputeRecon(deps(), { tenantId: store.id, reason: 'manual' });
    timings.recon = Date.now() - t0;
    return refresh(result);
  }

  async function refresh(result: DatasetRun) {
    const { store, manager } = result;
    result.products = await readProducts(store.id);
    const listings = await h.fixture.prisma.listing.findMany({ where: { tenantId: store.id }, include: { product: { select: { normalizedBarcode: true } } } });
    result.listings = listings.map(l => ({ marketplaceId: l.marketplaceId, marketplaceProductId: l.marketplaceProductId, barcode: l.product?.normalizedBarcode ?? null }));
    result.recon = await readRecon(store.id);
    const summary = await h.request('GET', '/api/recon/summary?reference=marketplace', store, manager);
    expect(summary.statusCode).toBe(200);
    result.summary = summary.json().data.marketplaces;
    const enabled = await h.fixture.prisma.tenantMarketplace.findMany({ where: { tenantId: store.id, enabled: true } });
    result.enabledWithoutFile = enabled.map(e => e.marketplaceId as MarketplaceId).filter(m => ['talabat', 'snoonu'].includes(m) && !result.market[m]);
    return result;
  }

  async function readXlsx(buffer: Buffer, columns: number) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const rows: unknown[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const values: unknown[] = [];
      for (let c = 1; c <= columns; c++) {
        let v = row.getCell(c).value as unknown;
        if (v && typeof v === 'object' && 'richText' in v) v = (v as { richText: { text: string }[] }).richText.map(x => x.text).join('');
        if (v && typeof v === 'object' && 'result' in v) v = (v as { result: unknown }).result;
        values.push(v === undefined || v === '' ? null : v);
      }
      rows.push(values);
    }
    return rows;
  }

  async function generate(store: Store, who: Session, marketplaceId: MarketplaceId, kind: string, scope: string): Promise<GeneratedOutcome> {
    const t0 = Date.now();
    const body = { marketplaceId, kind, scope, reference: 'marketplace' };
    const preview = await h.request('POST', '/api/generated-files/preview', store, who, body);
    const columns = marketplaceId === 'talabat' ? TALABAT_HEADERS.length : SNOONU_HEADERS.length;
    if (preview.statusCode !== 200) return { previewStatus: preview.statusCode, previewMessage: preview.json().error?.message ?? null, preview: null, header: [], rows: [], ms: Date.now() - t0 };
    const p = preview.json().data;
    const queued = await h.request('POST', '/api/generated-files', store, who, { ...body, exportToken: p.exportToken });
    expect([queued.statusCode, queued.body.slice(0, 300)]).toEqual([202, expect.any(String)]);
    const job = (await h.request('GET', `/api/generated-files/jobs/${queued.json().data.jobId}`, store, who)).json().data;
    expect([job.state, job.message ?? null]).toEqual(['done', null]);
    const file = await h.fixture.prisma.generatedFile.findUniqueOrThrow({ where: { id: job.fileId } });
    const all = await readXlsx(h.storage.objects.get(file.storageKey)!, columns);
    return { previewStatus: 200, previewMessage: null, preview: p, header: all[0] ?? [], rows: all.slice(1), ms: Date.now() - t0 };
  }

  /** Round trip: the source file with the generated rows' cells in place, uploaded as a fresh full snapshot. */
  async function roundTrip(result: DatasetRun, mp: MarketplaceId, sourceRows: Cell[][], identifiers: string[], output: GeneratedOutcome, id: (row: unknown[]) => string) {
    const byId = new Map(output.rows.map(r => [id(r), r]));
    const unquote = (v: unknown) => (typeof v === 'string' && v.startsWith('\'') ? v.slice(1) : v);
    const rows = sourceRows.map((src, i) => {
      const generated = byId.get(identifiers[i]!);
      return (generated ? generated.map(unquote) : src.map(c => (c !== null && typeof c === 'object' ? c.date : c))) as Cell[];
    });
    const headers = mp === 'talabat' ? TALABAT_HEADERS : SNOONU_HEADERS;
    const u = await apply(result.store, result.manager, await upload(result.store, result.manager, mp, await workbook(headers, rows), mp === 'talabat' ? TALABAT_MAPPING : SNOONU_MAPPING, `${mp}-roundtrip.xlsx`));
    await recomputeRecon(deps(), { tenantId: result.store.id, reason: 'manual' });
    return { upload: u, recon: await readRecon(result.store.id) };
  }

  return { run, refresh, upload, apply, generate, roundTrip, readRecon, readProducts, allErrors, deps };
}
