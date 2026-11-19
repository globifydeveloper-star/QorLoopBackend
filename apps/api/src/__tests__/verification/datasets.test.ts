import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATASETS, REJECTION_DATASETS, largeDataset } from './datasets.js';
import { computeExpected, expectedFile, MARKETPLACES, type ExpectedDataset } from './expected.js';
import * as ref from './reference.js';

/**
 * Golden expected outputs, computed by the reference calculator and stored under ./expected.
 * UPDATE_GOLDEN=1 rewrites them; otherwise the stored files must equal a fresh computation (guards both drift and edits).
 * Offer windows and upload ages are relative to "now", so the stored answer does not depend on the run date.
 */
const DIR = 'apps/api/src/__tests__/verification/expected';
const KINDS: ref.FileKind[] = ['price', 'stock', 'stock_price'];

export function serialise(e: ExpectedDataset) {
  const files: Record<string, unknown> = {};
  for (const mp of MARKETPLACES) if (e.market[mp]) for (const kind of KINDS) for (const scope of ['mismatches', 'all'] as const) files[`${mp}/${kind}/${scope}`] = expectedFile(e, mp, kind, scope);
  return {
    name: e.name,
    settings: e.settings,
    erp1: { rowsRead: e.erp1.rowsRead, rejected: e.erp1.rejected, errors: e.erp1.errors, accepted: e.erp1.products.map(p => p.barcode) },
    erp2: e.erp2 && { rowsRead: e.erp2.rowsRead, rejected: e.erp2.rejected, errors: e.erp2.errors, accepted: e.erp2.products.map(p => p.barcode) },
    products: [...e.products.values()].map(p => ({ barcode: p.barcode, nameEn: p.nameEn, nameAr: p.nameAr, status: p.status, blocked: p.blocked, priceFils: p.priceFils,
      stock: p.stock, erpActive: p.erpActive, inLatestErpFile: p.inLatestErpFile })),
    market: Object.fromEntries(Object.entries(e.market).map(([mp, m]) => [mp, { rejected: m!.validation.rejected, errors: m!.validation.errors,
      listings: m!.listings.map(l => ({ row: l.row, id: l.id, priceFils: l.priceFils, available: l.available, match: l.match })) }])),
    recon: e.recon.map(r => ({ product: r.productKey, marketplace: r.marketplaceId, status: r.status, expectedFils: r.expectedFils, source: r.source,
      actualFils: r.actualFils, shouldBeAvailable: r.shouldBeAvailable, priceMismatch: r.priceMismatch, stockIssue: r.stockIssue })),
    stale: e.stale,
    files,
  };
}

const NOW = new Date('2026-11-19T09:00:00Z');

describe('golden datasets: expected outputs from the reference calculator', () => {
  for (const ds of [...DATASETS, ...REJECTION_DATASETS]) {
    it(`${ds.name}: stored expected output equals the reference`, () => {
      const fresh = JSON.parse(JSON.stringify(serialise(computeExpected(ds, NOW))));
      const path = `${DIR}/${ds.name}.json`;
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(path, JSON.stringify(fresh, null, 1) + '\n');
      }
      expect(fresh).toEqual(JSON.parse(readFileSync(path, 'utf8')));
    });
  }

  it('covers every case the verification brief lists', () => {
    const all = Object.fromEntries(DATASETS.map(d => [d.name, computeExpected(d, NOW)]));
    const reasons = (e: ExpectedDataset) => e.erp1.errors.map(x => `${x.field}:${x.reason}`);
    // barcodes
    expect(reasons(all.barcodes!)).toEqual(expect.arrayContaining(['barcode:missing', 'barcode:duplicate']));
    expect(all.barcodes!.market.talabat!.listings.some(l => l.id === 'SKU-8' && l.match === '6281000000008')).toBe(true); // SKU fallback
    expect(all.barcodes!.products.has('45000')).toBe(true); // date-formatted cell, value kept
    // stock and validation
    const stock = all.stock!.recon.filter(r => r.marketplaceId === 'talabat');
    expect(stock.map(r => r.stockIssue)).toEqual(expect.arrayContaining(['available_but_out_of_stock', 'unavailable_but_in_stock', null]));
    expect(reasons(all.stock!)).toEqual(expect.arrayContaining(['stock:not_numeric', 'price:not_numeric', 'price:missing', 'nameEn:missing', 'stock:missing']));
    // prices: at, inside and outside the tolerance
    const p = (n: string) => all.prices!.recon.find(r => r.productKey === n && r.marketplaceId === 'talabat')!;
    expect([p('6281000000201').priceMismatch, p('6281000000202').priceMismatch, p('6281000000203').priceMismatch]).toEqual([false, false, true]);
    // rules: every source appears
    expect(new Set(all.rules!.recon.map(r => r.source))).toEqual(new Set(['offer', 'product', 'category', 'marketplace', 'default']));
    // presence
    const statuses = new Set(all.presence!.recon.map(r => r.status));
    for (const s of ['in_sync', 'not_listed', 'mismatch', 'missing_from_erp', 'new']) expect(statuses.has(s as ref.ReconStatus)).toBe(true);
    expect(all.presence!.recon.some(r => r.productKey === '6281000000503')).toBe(false); // blocked: no row
    // stale
    expect(all.stale!.stale).toEqual({ talabat: true, snoonu: false });
    // rejection
    expect(REJECTION_DATASETS.map(d => computeExpected(d, NOW).erp1.rejected)).toEqual([true, false]);
  });

  it('large dataset reference counts (50,000 products)', () => {
    const e = computeExpected(largeDataset(50_000), NOW);
    const t = e.recon.filter(r => r.marketplaceId === 'talabat');
    const counts = { rows: t.length, notListed: t.filter(r => r.status === 'not_listed').length, price: t.filter(r => r.priceMismatch).length,
      stock: t.filter(r => r.stockIssue).length, inSync: t.filter(r => r.status === 'in_sync').length };
    const path = `${DIR}/large-50000.counts.json`;
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) writeFileSync(path, JSON.stringify(counts, null, 1) + '\n');
    expect(counts).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });
});
