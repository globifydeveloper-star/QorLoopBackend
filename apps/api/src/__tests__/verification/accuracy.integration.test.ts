import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHarness, type Harness } from '../harness.js';
import { processUpload } from '../../../../worker/src/process-upload.js';
import { applyUpload } from '../../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../../worker/src/recompute-recon.js';
import { generateFile } from '../../../../worker/src/generate-file.js';
import { DATASETS, REJECTION_DATASETS, ISOLATION_MARKER, largeDataset, type Dataset } from './datasets.js';
import { computeExpected, expectedFile, MARKETPLACES, ERP_FIELD_HEADER, type ExpectedDataset, type MarketplaceId } from './expected.js';
import { pipeline, type DatasetRun, type GeneratedOutcome } from './pipeline.js';
import { type Check, summarise, failures } from './metrics.js';
import * as ref from './reference.js';

/**
 * Step 4: every golden dataset through the real pipeline, compared with the reference calculator (documented rules).
 *
 * Attribution: each disagreement is re-judged against the reference with ONE observed behaviour switched on
 * (reference.ts REF_CONFIG). A disagreement that disappears is attributed to that finding; the per-feature tests fail on any
 * disagreement no finding explains. Headline metrics always use the documented rules.
 * Writes .cache/verification/accuracy.json for the report.
 */
let h: Harness;
let p: ReturnType<typeof pipeline>;
const checks: Check[] = [];
const runs: Record<string, { ds: Dataset; run: DatasetRun; files: Map<string, GeneratedOutcome> }> = {};
const KINDS: ref.FileKind[] = ['price', 'stock', 'stock_price'];
const SCOPES = ['mismatches', 'all'] as const;
const PROBLEM_STATUSES = new Set(['mismatch', 'missing_from_erp', 'not_listed']);
const FIELD_OF_HEADER = Object.fromEntries(Object.entries(ERP_FIELD_HEADER).map(([f, hd]) => [hd.toLowerCase(), f]));
/** Findings with their reference switch (see the report). */
export const FINDINGS: Record<string, Partial<typeof ref.REF_CONFIG>> = {
  'BUG-1 prices kept to 2 decimals': { moneyStepFils: 10 },
  'BUG-2 date-formatted barcode cells (G11)': { dateCellsAsDates: true },
  'GAP-1 ERP price 0 rejected': { zeroPriceIsError: true },
  'GAP-2 negative stock stored as 0': { negativeStockClamped: true },
};
const LARGE_N = Number(process.env.VERIFY_LARGE_N ?? 5_000);

beforeAll(async () => {
  h = await createHarness();
  p = pipeline(h);
  h.queue.handler = job => processUpload(p.deps(), job).then(() => undefined);
  h.queue.applyHandler = job => applyUpload({ ...p.deps(), recon: h.recon }, job).then(() => undefined);
  h.recon.handler = job => recomputeRecon(p.deps(), job);
  h.generatedFiles.handler = job => generateFile(p.deps(), job);
}, 120_000);

const attributions = new Map<Check, string>();
afterAll(async () => {
  mkdirSync('.cache/verification', { recursive: true });
  const failed = failures(checks).map(c => ({ ...c, explainedBy: attributions.get(c) ?? 'UNEXPLAINED' }));
  const byFinding: Record<string, number> = {};
  for (const f of failed) byFinding[f.explainedBy] = (byFinding[f.explainedBy] ?? 0) + 1;
  const golden = checks.filter(c => !c.dataset.startsWith('large-'));
  const large = checks.filter(c => c.dataset.startsWith('large-'));
  writeFileSync('.cache/verification/accuracy.json', JSON.stringify({ at: new Date().toISOString(), largeN: LARGE_N, metrics: summarise(checks),
    metricsGolden: summarise(golden), metricsLarge: summarise(large), byFinding,
    failures: failed, timings: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.run.timings])) }, null, 1));
  await h?.recon.drain();
  await h?.close();
});

/** Generates every file a dataset can have, once; the comparisons (and their variants) read these outcomes. */
async function generateAll(run: DatasetRun, mps: MarketplaceId[]) {
  const files = new Map<string, GeneratedOutcome>();
  for (const mp of mps) {
    if (run.market[mp]?.status !== 'applied') continue;
    for (const kind of KINDS) for (const scope of SCOPES) files.set(`${mp}/${kind}/${scope}`, await p.generate(run.store, run.manager, mp, kind, scope));
  }
  return files;
}

function compare(out: Check[], ds: Dataset, run: DatasetRun, e: ExpectedDataset, files: Map<string, GeneratedOutcome>) {
  const add = (c: Omit<Check, 'dataset'>) => out.push({ ...c, dataset: ds.name });
  // ERP rows
  for (const which of ['erp1', 'erp2'] as const) {
    const v = e[which]; const u = run[which];
    if (!v || !u) continue;
    const rows = which === 'erp1' ? ds.erp : ds.erp2!;
    const actualByRow = new Map<number, Set<string>>();
    for (const err of u.errors) actualByRow.set(err.row, new Set([...(actualByRow.get(err.row) ?? []), FIELD_OF_HEADER[(err.column ?? '').toLowerCase()] ?? err.column ?? '?']));
    rows.forEach((r, i) => {
      const row = i + 2;
      const expectedFields = [...new Set(v.errors.filter(x => x.row === row).map(x => x.field))].sort();
      const actualFields = [...(actualByRow.get(row) ?? [])].sort();
      add({ feature: 'erp-row-validation', caseId: `${which} row ${row}`, expectedProblem: expectedFields.length > 0, actualProblem: actualFields.length > 0, expected: expectedFields, actual: actualFields });
      if (which !== 'erp1') return;
      const exp = v.products.find(x => x.row === row)?.barcode ?? null;
      const product = run.products.find(x => x.nameEn === String(r[1] ?? '').trim());
      add({ feature: 'barcode-normalisation', caseId: `row ${row} ${JSON.stringify(r[0])}`, expectedProblem: expectedFields.includes('barcode'), actualProblem: actualFields.includes('barcode'),
        expected: exp, actual: actualFields.length ? null : product?.normalizedBarcode ?? null });
    });
  }
  // catalogue
  const actualProducts = new Map(run.products.map(x => [x.normalizedBarcode, x]));
  for (const [barcode, x] of e.products) {
    const a = actualProducts.get(barcode);
    add({ feature: 'catalogue-fields', caseId: barcode, expectedProblem: null, actualProblem: null,
      expected: { status: x.status, priceFils: x.priceFils, stock: x.stock, erpActive: x.erpActive, inLatestErpFile: x.inLatestErpFile, blocked: x.blocked },
      actual: a ? { status: a.status, priceFils: Math.round(Number(a.erpPrice) * 1000), stock: a.erpStock, erpActive: a.erpActive, inLatestErpFile: a.inLatestErpFile, blocked: a.blockedAt !== null } : null });
    add({ feature: 'names', caseId: barcode, expectedProblem: null, actualProblem: null, expected: { en: x.nameEn, ar: x.nameAr }, actual: a ? { en: a.nameEn, ar: a.nameAr } : null });
  }
  for (const a of run.products) if (!e.products.has(a.normalizedBarcode)) add({ feature: 'catalogue-fields', caseId: `unexpected product ${a.normalizedBarcode}`, expectedProblem: false, actualProblem: true, expected: null, actual: a.nameEn });
  // marketplace rows and matching
  for (const mp of MARKETPLACES) {
    const m = e.market[mp]; const u = run.market[mp];
    if (!m || !u) continue;
    const expRows = new Set(m.validation.errors.map(x => x.row)); const actRows = new Set(u.errors.map(x => x.row));
    (mp === 'talabat' ? ds.talabat! : ds.snoonu!).forEach((_, i) => add({ feature: 'marketplace-row-validation', caseId: `${mp} row ${i + 2}`, expectedProblem: expRows.has(i + 2), actualProblem: actRows.has(i + 2), expected: expRows.has(i + 2), actual: actRows.has(i + 2) }));
    for (const l of m.listings) {
      const key = mp === 'talabat' ? l.id : ref.refBarcode(l.id);
      const a = run.listings.find(x => x.marketplaceId === mp && (mp === 'talabat' ? x.marketplaceProductId === key : ref.refBarcode(x.marketplaceProductId) === key));
      const actual = a ? a.barcode ?? 'unmatched' : 'no listing stored';
      add({ feature: 'matching', caseId: `${mp} ${l.id}`, expectedProblem: l.match === 'unmatched' || l.match === 'ambiguous', actualProblem: actual === 'unmatched' || actual === 'no listing stored', expected: l.match, actual });
    }
  }
  // recon rows
  const key = (b: string, mp: string) => `${b}|${mp}`;
  const actual = new Map(run.recon.map(r => [key(r.barcode, r.marketplaceId), r]));
  const expected = new Map(e.recon.map(r => [key(r.productKey, r.marketplaceId), r]));
  const blocked = new Set([...e.products.values()].filter(x => x.blocked).map(x => x.barcode));
  for (const [k, r] of expected) {
    const a = actual.get(k);
    add({ feature: 'recon-row-present', caseId: k, expectedProblem: true, actualProblem: Boolean(a), expected: true, actual: Boolean(a) });
    if (!a) continue;
    add({ feature: 'recon-status', caseId: k, expectedProblem: PROBLEM_STATUSES.has(r.status), actualProblem: PROBLEM_STATUSES.has(a.status), expected: r.status, actual: a.status });
    // GAP-3: the product names the subcategory step 'subcategory'; BR 5.1 lists it under 'category'. Compared as one source.
    add({ feature: 'expected-price', caseId: k, expectedProblem: null, actualProblem: null, expected: { fils: r.expectedFils, source: r.source }, actual: { fils: a.marketplacePrice, source: a.source === 'subcategory' ? 'category' : a.source } });
    if (r.status === 'no_data' || r.status === 'new') continue;
    add({ feature: 'availability', caseId: k, expectedProblem: null, actualProblem: null, expected: r.shouldBeAvailable, actual: a.catalogueAvailable });
    add({ feature: 'stock-issue', caseId: k, expectedProblem: r.stockIssue !== null, actualProblem: a.stockIssue !== null, expected: r.stockIssue, actual: a.stockIssue });
    if (r.actualFils !== null && r.status !== 'missing_from_erp') add({ feature: 'price-mismatch', caseId: k, expectedProblem: r.priceMismatch, actualProblem: a.priceMismatch,
      expected: { mismatch: r.priceMismatch, listed: r.actualFils }, actual: { mismatch: a.priceMismatch, listed: a.actualPrice } });
  }
  for (const [k, a] of actual) if (!expected.has(k)) add({ feature: blocked.has(a.barcode) ? 'blocked-ignored' : 'recon-row-present', caseId: `unexpected ${k}`, expectedProblem: false, actualProblem: true, expected: null, actual: a.status });
  for (const b of blocked) for (const mp of Object.keys(e.market)) add({ feature: 'blocked-ignored', caseId: `${b}|${mp} no recon row`, expectedProblem: false, actualProblem: actual.has(key(b, mp)), expected: false, actual: actual.has(key(b, mp)) });
  // stale and summary counts
  for (const mp of Object.keys(e.market) as MarketplaceId[]) {
    const s = run.summary.find(x => x.marketplaceId === mp);
    add({ feature: 'stale', caseId: mp, expectedProblem: e.stale[mp] ?? false, actualProblem: s?.stale ?? null, expected: e.stale[mp] ?? false, actual: s?.stale ?? null });
    const rows = e.recon.filter(r => r.marketplaceId === mp);
    const exp = { stock: rows.filter(r => r.stockIssue).length, price: rows.filter(r => r.priceMismatch && r.status !== 'missing_from_erp').length,
      notListed: rows.filter(r => r.status === 'not_listed').length, missingFromErp: rows.filter(r => r.status === 'missing_from_erp').length, newCount: rows.filter(r => r.status === 'new').length };
    add({ feature: 'summary-counts', caseId: mp, expectedProblem: null, actualProblem: null, expected: { ...exp, total: exp.stock + exp.price },
      actual: s ? { stock: s.stock, price: s.price, notListed: s.notListed, missingFromErp: s.missingFromErp, newCount: s.newCount, total: s.total } : null });
  }
  // generated files
  for (const [caseId, got] of files) {
    const [mp, kind, scope] = caseId.split('/') as [MarketplaceId, ref.FileKind, 'mismatches' | 'all'];
    const want = expectedFile(e, mp, kind, scope);
    const idOf = (row: unknown[]) => (mp === 'talabat' ? String(row[0] ?? '').trim() : ref.refBarcode(row[0]));
    const wantOutcome = want.blocked ? 'blocked' : want.empty ? 'nothing to update' : 'file';
    const gotOutcome = got.previewStatus === 200 ? 'file' : /nothing to update/i.test(got.previewMessage ?? '') ? 'nothing to update' : 'blocked';
    add({ feature: 'file-blocking', caseId, expectedProblem: wantOutcome !== 'file', actualProblem: gotOutcome !== 'file', expected: wantOutcome, actual: gotOutcome });
    if (wantOutcome !== 'file' || gotOutcome !== 'file') continue;
    add({ feature: 'file-header', caseId, expectedProblem: null, actualProblem: null, expected: want.header, actual: got.header });
    const wantIds = want.rows.map(idOf); const gotIds = got.rows.map(idOf);
    add({ feature: 'file-row-order', caseId, expectedProblem: null, actualProblem: null, expected: wantIds, actual: gotIds });
    for (const id of new Set([...wantIds, ...gotIds])) {
      const w = want.rows.filter(r => idOf(r) === id); const g = got.rows.filter(r => idOf(r) === id);
      add({ feature: 'file-rows', caseId: `${caseId} ${id}`, expectedProblem: w.length > 0, actualProblem: g.length > 0, expected: w.length, actual: g.length });
      if (w.length && g.length) add({ feature: 'file-values', caseId: `${caseId} ${id}`, expectedProblem: null, actualProblem: null, expected: w, actual: g });
    }
    for (const b of [...e.products.values()].filter(x => x.blocked)) {
      const listing = e.market[mp]!.listings.find(l => l.match === b.barcode);
      if (!listing) continue;
      const listedId = mp === 'talabat' ? listing.id : ref.refBarcode(listing.id);
      add({ feature: 'blocked-ignored', caseId: `${caseId} ${b.barcode} not in file`, expectedProblem: false, actualProblem: gotIds.includes(listedId), expected: false, actual: gotIds.includes(listedId) });
    }
  }
}

function withConfig<T>(over: Partial<typeof ref.REF_CONFIG>, fn: () => T): T {
  Object.assign(ref.REF_CONFIG, ref.DOCUMENTED_CONFIG, over);
  try { return fn(); } finally { Object.assign(ref.REF_CONFIG, ref.DOCUMENTED_CONFIG); }
}

/** Compares with the documented rules, then attributes each disagreement to the single finding that removes it. */
function judge(ds: Dataset, run: DatasetRun, files: Map<string, GeneratedOutcome>) {
  const primary: Check[] = [];
  compare(primary, ds, run, computeExpected(ds, run.now, run.enabledWithoutFile), files);
  checks.push(...primary);
  const failed = failures(primary);
  if (!failed.length) return;
  const id = (c: Check) => `${c.feature}|${c.caseId}`;
  const resolvedBy = (over: Partial<typeof ref.REF_CONFIG>) => {
    const variant: Check[] = [];
    withConfig(over, () => compare(variant, ds, run, computeExpected(ds, run.now, run.enabledWithoutFile), files));
    const stillFailing = new Set(failures(variant).map(id));
    return (c: Check) => !stillFailing.has(id(c));
  };
  const singles = Object.entries(FINDINGS).map(([name, over]) => [name, resolvedBy(over)] as const);
  const combined = resolvedBy(Object.assign({}, ...Object.values(FINDINGS)));
  for (const c of failed) {
    const names = singles.filter(([, ok]) => ok(c)).map(([n]) => n);
    attributions.set(c, names.length ? names.join(' + ') : combined(c) ? 'combination of findings' : 'UNEXPLAINED');
  }
}

describe('Step 4: accuracy of the real pipeline against the reference calculator', () => {
  for (const ds of DATASETS) {
    it(`runs ${ds.name} through upload, apply, recon and generated files`, async () => {
      const run = await p.run(ds);
      const files = await generateAll(run, MARKETPLACES.filter(mp => ds[mp]));
      runs[ds.name] = { ds, run, files };
      judge(ds, run, files);
    }, 300_000);
  }

  it(`runs a ${LARGE_N.toLocaleString('en')}-product store (VERIFY_LARGE_N) through the same pipeline`, async () => {
    const ds = largeDataset(LARGE_N);
    const run = await p.run(ds);
    const t0 = Date.now();
    const files = await generateAll(run, ['talabat']);
    run.timings.generateAll6 = Date.now() - t0;
    runs[ds.name] = { ds, run, files };
    judge(ds, run, files);
  }, 1_800_000);

  it('round trip: applying each generated stock_price/mismatches file leaves no problem on the rows it fixed', async () => {
    for (const { ds, run, files } of Object.values(runs)) {
      const e = computeExpected(ds, run.now, run.enabledWithoutFile);
      for (const mp of MARKETPLACES) {
        const got = files.get(`${mp}/stock_price/mismatches`);
        if (!got || got.previewStatus !== 200) continue;
        const want = expectedFile(e, mp, 'stock_price', 'mismatches');
        const idOf = (row: unknown[]) => (mp === 'talabat' ? String(row[0] ?? '').trim() : ref.refBarcode(row[0]));
        const after = await p.roundTrip(run, mp, e.market[mp]!.sourceRows, e.market[mp]!.identifiers, got, idOf);
        for (const productKey of want.selectedKeys) {
          const r = after.recon.find(x => x.barcode === productKey && x.marketplaceId === mp);
          const remaining = r ? [r.priceMismatch && r.status !== 'missing_from_erp' ? 'price' : null, r.stockIssue].filter(Boolean) : ['no recon row'];
          checks.push({ feature: 'round-trip', dataset: ds.name, caseId: `${mp} ${productKey}`, expectedProblem: false, actualProblem: remaining.length > 0, expected: [], actual: remaining });
        }
      }
    }
  }, 1_800_000);

  for (const ds of REJECTION_DATASETS) {
    it(`${ds.name}: rejection decision and message`, async () => {
      const run = await p.run(ds);
      const e = computeExpected(ds, run.now);
      const invalid = new Set(e.erp1.errors.map(x => x.row)).size;
      const mention = `${invalid} of ${e.erp1.rowsRead}`;
      checks.push({ feature: 'upload-rejection', dataset: ds.name, caseId: 'erp', expectedProblem: e.erp1.rejected, actualProblem: run.erp1.status === 'rejected',
        expected: e.erp1.rejected ? { status: 'rejected', message: `mentions "${mention}" rows invalid` } : { status: 'applied' },
        actual: run.erp1.status === 'rejected' ? { status: 'rejected', message: run.erp1.errorMessage?.includes(mention) ? `mentions "${mention}" rows invalid` : run.erp1.errorMessage } : { status: run.erp1.status } });
      if (e.erp1.rejected) checks.push({ feature: 'upload-rejection', dataset: ds.name, caseId: 'no partial data', expectedProblem: false, actualProblem: run.products.length > 0, expected: 0, actual: run.products.length });
      else checks.push({ feature: 'upload-rejection', dataset: ds.name, caseId: 'invalid rows skipped and listed', expectedProblem: null, actualProblem: null,
        expected: { products: e.erp1.products.length, errorRows: invalid }, actual: { products: run.products.length, errorRows: new Set(run.erp1.errors.map(x => x.row)).size } });
    }, 120_000);
  }

  it('tenant isolation: the twin tenant\'s rows never appear in the first tenant\'s data', () => {
    const a = runs.presence!.run; const b = runs['presence-twin']!.run;
    const bIds = new Set(b.products.map(x => x.id));
    const leak = { products: a.products.some(x => bIds.has(x.id) || x.nameEn.includes(ISOLATION_MARKER)), recon: a.recon.some(r => r.actualPrice === 1110 || r.marketplacePrice === 77000) };
    for (const [caseId, v] of Object.entries(leak)) checks.push({ feature: 'tenant-isolation', dataset: 'presence', caseId, expectedProblem: false, actualProblem: v, expected: false, actual: v });
  });

  // One assertion per feature, after every dataset ran: every disagreement must be explained by a listed finding.
  const FEATURES = ['erp-row-validation', 'barcode-normalisation', 'catalogue-fields', 'names', 'marketplace-row-validation', 'matching', 'recon-row-present', 'recon-status',
    'expected-price', 'availability', 'stock-issue', 'price-mismatch', 'blocked-ignored', 'stale', 'summary-counts', 'file-blocking', 'file-header', 'file-row-order',
    'file-rows', 'file-values', 'round-trip', 'upload-rejection', 'tenant-isolation'];
  for (const feature of FEATURES) {
    it(`${feature}: every disagreement with the reference is a listed finding`, () => {
      const unexplained = failures(checks, feature).filter(c => !attributions.has(c) || attributions.get(c) === 'UNEXPLAINED');
      expect(unexplained.map(c => `${c.dataset} ${c.caseId}: expected ${JSON.stringify(c.expected)} got ${JSON.stringify(c.actual)}`)).toEqual([]);
    });
  }
});

// ───────────── the findings, one failing test each (it.failing: passes while the bug is present; flip to it() once fixed) ─────────────
describe('Findings (it.failing = the bug is still present)', () => {
  const recon = (dataset: string, barcode: string, mp = 'talabat') => runs[dataset]!.run.recon.find(r => r.barcode === barcode && r.marketplaceId === mp);
  const product = (dataset: string, barcode: string) => runs[dataset]!.run.products.find(x => x.normalizedBarcode === barcode);

  it.failing('BUG-1: a Talabat price 1 fils outside the 0.050 tolerance (10.051 vs 10.000) is a price mismatch', () => {
    expect(recon('prices', '6281000000203')).toMatchObject({ actualPrice: 10051, priceMismatch: true, status: 'mismatch' });
  });
  it.failing('BUG-1: an ERP selling price of 12345.678 is stored and compared as 12345.678', () => {
    expect(Number(product('prices', '6281000000208')!.erpPrice)).toBe(12345.678);
  });
  it.failing('BUG-1: rounding "exact" keeps whole fils (5.500 x 1.05 = 5.775) in the stored expected price and in the generated file', () => {
    expect(recon('rules', '6281000000301')!.marketplacePrice).toBe(5775);
    const file = runs.rules!.files.get('talabat/price/mismatches')!;
    expect(file.rows.find(r => r[0] === 'R301')![2]).toBe('5.775');
  });
  it.failing('BUG-1: a generated file never writes 100000.000 for an ERP price of 99999.999 with rule "same"', () => {
    expect(runs.prices!.files.get('talabat/price/all')!.rows.find(r => r[0] === 'P207')![2]).toBe('99999.999');
  });
  it.failing('BUG-2 (open gap G11): a barcode in a date-formatted cell keeps its digits (45000 is not 20230315000000000)', () => {
    expect(product('barcodes', '20230315000000000')).toBeUndefined();
    expect(product('barcodes', '45000')).toBeDefined();
  });
  it.failing('BUG-2 (open gap G11): a 13-digit barcode in a date-formatted cell is read, not rejected as empty', () => {
    expect(product('barcodes', '6281000000011')).toBeDefined();
  });
});
