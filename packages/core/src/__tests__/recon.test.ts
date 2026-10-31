import { describe, expect, it } from '@jest/globals';
import {
  computeReconRows, countRows, diffReconRows, enabledMarketplaces, reconKey, reconSignature, erpAvailable, forReference, isStale, priceMismatch, reconcile, urgency,
  type ReconInput, type ReconProduct, type ReconSettings,
} from '../recon/index.js';
import type { PricingSettingsSnapshot } from '../pricing.js';

const settings: ReconSettings = { priceTolerance: 0, stockThreshold: 0 };
const product = (p: Partial<ReconProduct> = {}): ReconProduct => ({ status: 'active', erpActive: true, inLatestErpFile: true, erpStock: 5, erpPrice: 10, ...p });
/** Marketplace price 11 (e.g. ERP + 10%), listed at 11 and available: in sync against the Marketplace reference. */
const input = (i: Partial<ReconInput> = {}): ReconInput => ({
  product: product(), listing: { price: 11, available: true }, hasData: true, marketplacePrice: { price: 11, source: 'default' }, ...i,
});

describe('erpAvailable (rule 5.3)', () => {
  it('needs status active, ERP active, in the latest ERP file and stock above the threshold', () => {
    expect(erpAvailable(product(), 0)).toBe(true);
    expect(erpAvailable(product({ status: 'inactive' }), 0)).toBe(false);
    expect(erpAvailable(product({ status: 'new' }), 0)).toBe(false);
    expect(erpAvailable(product({ erpActive: false }), 0)).toBe(false);
    expect(erpAvailable(product({ inLatestErpFile: false }), 0)).toBe(false);
    expect(erpAvailable(product({ erpStock: 0 }), 0)).toBe(false);
  });
  it('stock must be strictly above the threshold', () => {
    expect(erpAvailable(product({ erpStock: 3 }), 3)).toBe(false);
    expect(erpAvailable(product({ erpStock: 4 }), 3)).toBe(true);
  });
});

describe('priceMismatch', () => {
  it('a difference of exactly the tolerance is in sync; more is a mismatch', () => {
    expect(priceMismatch(10.5, 10, 0.5)).toBe(false);
    expect(priceMismatch(10.51, 10, 0.5)).toBe(true);
    expect(priceMismatch(9.49, 10, 0.5)).toBe(true);
  });
  it('works in fils: float noise is never a mismatch', () => {
    expect(priceMismatch(0.1 + 0.2, 0.3, 0)).toBe(false);
    expect(priceMismatch(6.325, 5.5 * 1.15, 0)).toBe(false);
  });
});

describe('reconcile (rule 5.4, in order)', () => {
  it('1. an enabled marketplace without an applied upload is no_data, for both references, whatever the product', () => {
    for (const p of [product(), product({ status: 'new' }), product({ inLatestErpFile: false })]) {
      const r = reconcile(input({ product: p, hasData: false, listing: null }), settings);
      expect([r.status, r.statusVsErp, r.stockIssue, r.priceMismatchVsErp, r.priceMismatchVsMarketplace]).toEqual(['no_data', 'no_data', null, false, false]);
    }
  });
  it('1 wins over 2: a new product on a marketplace without data is no_data', () => {
    expect(reconcile(input({ product: product({ status: 'new' }), hasData: false }), settings).status).toBe('no_data');
  });
  it('2. a new product is new, even when listed with a wrong price and availability', () => {
    const r = reconcile(input({ product: product({ status: 'new', erpStock: 0 }), listing: { price: 99, available: true } }), settings);
    expect([r.status, r.statusVsErp, r.stockIssue, r.priceMismatchVsErp, r.priceMismatchVsMarketplace]).toEqual(['new', 'new', null, false, false]);
  });
  it('3. not listed: active, in the ERP file and ERP active is not_listed (even with no stock)', () => {
    const r = reconcile(input({ listing: null, product: product({ erpStock: 0 }) }), settings);
    expect([r.status, r.statusVsErp, r.actualPrice, r.actualAvailable]).toEqual(['not_listed', 'not_listed', null, null]);
  });
  it('3. not listed otherwise is in_sync (inactive, ERP inactive, or missing from the ERP file)', () => {
    for (const p of [product({ status: 'inactive' }), product({ erpActive: false }), product({ inLatestErpFile: false })]) {
      const r = reconcile(input({ listing: null, product: p }), settings);
      expect([r.status, r.statusVsErp, r.stockIssue]).toEqual(['in_sync', 'in_sync', null]);
    }
  });
  it('4. not in the latest ERP file but listed and available: missing_from_erp with available_but_out_of_stock', () => {
    const r = reconcile(input({ product: product({ inLatestErpFile: false }), listing: { price: 50, available: true } }), settings);
    expect([r.status, r.statusVsErp, r.stockIssue]).toEqual(['missing_from_erp', 'missing_from_erp', 'available_but_out_of_stock']);
    // the price is not compared for a product the ERP no longer has
    expect([r.priceMismatchVsErp, r.priceMismatchVsMarketplace]).toEqual([false, false]);
  });
  it('4. not in the latest ERP file, listed but unavailable: missing_from_erp without a stock issue', () => {
    const r = reconcile(input({ product: product({ inLatestErpFile: false }), listing: { price: 11, available: false } }), settings);
    expect([r.status, r.stockIssue]).toEqual(['missing_from_erp', null]);
  });
  it('5. everything matches: in_sync against the Marketplace price, but a mismatch against the ERP price', () => {
    const r = reconcile(input(), settings);
    expect([r.status, r.priceMismatchVsMarketplace]).toEqual(['in_sync', false]);
    expect([r.statusVsErp, r.priceMismatchVsErp]).toEqual(['mismatch', true]);
    expect(r.stockIssue).toBeNull();
  });
  it('5. listed at the ERP price: a mismatch against the Marketplace price only', () => {
    const r = reconcile(input({ listing: { price: 10, available: true } }), settings);
    expect([r.status, r.statusVsErp, r.priceMismatchVsMarketplace, r.priceMismatchVsErp]).toEqual(['mismatch', 'in_sync', true, false]);
  });
  it('5. ERP available but the listing is not: unavailable_but_in_stock, a mismatch for both references', () => {
    const r = reconcile(input({ listing: { price: 11, available: false } }), settings);
    expect([r.stockIssue, r.status, r.statusVsErp]).toEqual(['unavailable_but_in_stock', 'mismatch', 'mismatch']);
  });
  it('5. ERP not available (inactive, ERP inactive, at or below threshold) but listed available: available_but_out_of_stock', () => {
    for (const p of [product({ status: 'inactive' }), product({ erpActive: false }), product({ erpStock: 2 })]) {
      const r = reconcile(input({ product: p }), { ...settings, stockThreshold: 2 });
      expect([r.stockIssue, r.status, r.statusVsErp, r.erpAvailable]).toEqual(['available_but_out_of_stock', 'mismatch', 'mismatch', false]);
    }
  });
  it('5. both unavailable is no stock issue', () => {
    const r = reconcile(input({ product: product({ erpStock: 0 }), listing: { price: 11, available: false } }), settings);
    expect([r.stockIssue, r.status]).toEqual([null, 'in_sync']);
  });
  it('5. a stock issue and a price issue together: both flags set, status mismatch', () => {
    const r = reconcile(input({ listing: { price: 20, available: false } }), settings);
    expect([r.stockIssue, r.priceMismatchVsMarketplace, r.priceMismatchVsErp, r.status, r.statusVsErp]).toEqual(['unavailable_but_in_stock', true, true, 'mismatch', 'mismatch']);
  });
  it('5. the tolerance applies to both references', () => {
    const r = reconcile(input({ listing: { price: 10.5, available: true } }), { ...settings, priceTolerance: 0.5 });
    expect([r.priceMismatchVsErp, r.priceMismatchVsMarketplace, r.status, r.statusVsErp]).toEqual([false, false, 'in_sync', 'in_sync']);
  });
  it('stores the resolved price, its source and both actual values on every row', () => {
    const r = reconcile(input({ marketplacePrice: { price: 9.5, source: 'offer' } }), settings);
    expect(r).toMatchObject({ erpPrice: 10, marketplacePrice: 9.5, marketplacePriceSource: 'offer', actualPrice: 11, actualAvailable: true, erpAvailable: true });
  });
});

describe('forReference, counts and urgency', () => {
  it('total = stock + price; a product with both issues counts once in each', () => {
    const rows = [
      reconcile(input({ listing: { price: 20, available: false } }), settings), // stock + price (both refs)
      reconcile(input({ listing: { price: 10, available: true } }), settings), // price vs marketplace only
      reconcile(input({ listing: null }), settings), // not listed
      reconcile(input({ product: product({ status: 'new' }) }), settings), // new
      reconcile(input({ product: product({ inLatestErpFile: false }) }), settings), // missing, stock issue
      reconcile(input({ hasData: false }), settings), // no data
    ];
    expect(countRows(rows, 'marketplace')).toEqual({ stock: 2, price: 2, total: 4, listed: 5, notListed: 1, noData: 1, missingFromErp: 1, newCount: 1 });
    expect(countRows(rows, 'erp')).toEqual({ stock: 2, price: 1, total: 3, listed: 5, notListed: 1, noData: 1, missingFromErp: 1, newCount: 1 });
  });
  it('forReference picks the status and flag of the reference', () => {
    const r = reconcile(input(), settings);
    expect(forReference(r, 'marketplace')).toEqual({ status: 'in_sync', priceMismatch: false });
    expect(forReference(r, 'erp')).toEqual({ status: 'mismatch', priceMismatch: true });
  });
  it('available_but_out_of_stock is the most urgent, then unavailable_but_in_stock, then price', () => {
    expect([
      urgency({ stockIssue: null, priceMismatch: false }), urgency({ stockIssue: null, priceMismatch: true }),
      urgency({ stockIssue: 'unavailable_but_in_stock', priceMismatch: true }), urgency({ stockIssue: 'available_but_out_of_stock', priceMismatch: false }),
    ]).toEqual([3, 2, 1, 0]);
  });
});

describe('isStale', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  it('stale when the latest applied upload is older than staleHours; no upload is not stale', () => {
    expect(isStale(new Date('2026-10-31T00:00:00Z'), 12, now)).toBe(false);
    expect(isStale(new Date('2026-10-30T23:59:59Z'), 12, now)).toBe(true);
    expect(isStale(null, 12, now)).toBe(false);
  });
});

describe('enabledMarketplaces', () => {
  const all = ['talabat', 'snoonu', 'rafeeq', 'keeta'] as const;
  it('an explicit row decides; without a row a marketplace with an applied upload is enabled', () => {
    expect(enabledMarketplaces(all, [], new Set(['talabat', 'snoonu']))).toEqual([
      { marketplaceId: 'talabat', hasData: true }, { marketplaceId: 'snoonu', hasData: true },
    ]);
    expect(enabledMarketplaces(all, [{ marketplaceId: 'talabat', enabled: false }, { marketplaceId: 'keeta', enabled: true }], new Set(['talabat']))).toEqual([
      { marketplaceId: 'keeta', hasData: false },
    ]);
  });
});

describe('computeReconRows', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const pricing = (perMarketplaceEnabled: boolean): { snapshot: PricingSettingsSnapshot; categoryRules: [] } => ({
    snapshot: { defaultRule: { mode: 'percent', value: 10 }, rounding: 'exact', perMarketplaceEnabled, marketplaceRules: { snoonu: { mode: 'amount', value: 2, rounding: 'exact' } } },
    categoryRules: [],
  });
  const products = [{ id: 'p1', ...product(), pricing: { erpPrice: 10 } }, { id: 'p2', ...product({ status: 'new' }), pricing: { erpPrice: 10 } }];
  const marketplaces = [{ marketplaceId: 'talabat' as const, hasData: true }, { marketplaceId: 'snoonu' as const, hasData: true }, { marketplaceId: 'keeta' as const, hasData: false }];
  const listings = new Map([['talabat:p1', { price: 11, available: true }], ['snoonu:p1', { price: 12, available: true }]]);

  it('one row per product x marketplace, using the marketplace-agnostic price when per-marketplace pricing is off', () => {
    const rows = computeReconRows(products, marketplaces, listings, pricing(false), settings, now);
    expect(rows.map(r => [r.productId, r.marketplaceId, r.status, r.marketplacePrice, r.marketplacePriceSource])).toEqual([
      ['p1', 'talabat', 'in_sync', 11, 'default'], ['p1', 'snoonu', 'mismatch', 11, 'default'], ['p1', 'keeta', 'no_data', 11, 'default'],
      ['p2', 'talabat', 'new', 11, 'default'], ['p2', 'snoonu', 'new', 11, 'default'], ['p2', 'keeta', 'no_data', 11, 'default'],
    ]);
  });
  it('with per-marketplace pricing on, each marketplace gets its own resolved price', () => {
    const rows = computeReconRows(products.slice(0, 1), marketplaces.slice(0, 2), listings, pricing(true), settings, now);
    expect(rows.map(r => [r.marketplaceId, r.status, r.marketplacePrice, r.marketplacePriceSource])).toEqual([
      ['talabat', 'in_sync', 11, 'default'], ['snoonu', 'in_sync', 12, 'marketplace'],
    ]);
  });
});

describe('diffReconRows', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const pricing = { snapshot: { defaultRule: { mode: 'percent' as const, value: 10 }, rounding: 'exact' as const }, categoryRules: [] };
  const products = ['p1', 'p2', 'p3'].map(id => ({ id, ...product(), pricing: { erpPrice: 10 } }));
  const rows = (listings: Map<string, { price: number; available: boolean }>, ms = [{ marketplaceId: 'talabat' as const, hasData: true }]) =>
    computeReconRows(products, ms, listings, pricing, settings, now);
  const stored = (r: ReturnType<typeof rows>) => new Map(r.map(x => [reconKey(x), reconSignature(x)]));

  it('a repeat writes nothing; a changed listing updates one row; a new product inserts; a dropped marketplace removes', () => {
    const base = rows(new Map([['talabat:p1', { price: 11, available: true }]]));
    expect(diffReconRows(stored(base), base)).toEqual({ insert: [], update: [], remove: [] });
    // equal in fils is equal: float noise from a sum does not count as a change
    expect(diffReconRows(stored(base.map(r => ({ ...r, marketplacePrice: r.marketplacePrice + 1e-9 }))), base).update).toEqual([]);

    const changed = rows(new Map([['talabat:p1', { price: 12, available: true }]]));
    const d = diffReconRows(stored(base), changed);
    expect([d.insert.length, d.update.map(r => [r.productId, r.status]), d.remove]).toEqual([0, [['p1', 'mismatch']], []]);

    const withKeeta = rows(new Map(), [{ marketplaceId: 'talabat', hasData: true }, { marketplaceId: 'keeta', hasData: false }]);
    expect(diffReconRows(stored(withKeeta), rows(new Map())).remove).toEqual(['p1', 'p2', 'p3'].map(productId => ({ productId, marketplaceId: 'keeta' })));
    expect(diffReconRows(stored(rows(new Map()).slice(1)), rows(new Map())).insert.map(r => r.productId)).toEqual(['p1']);
  });
  it('the per-marketplace step is skipped only when an earlier step decides the price', () => {
    const snap = { defaultRule: { mode: 'same' as const, value: 0 }, rounding: 'exact' as const, perMarketplaceEnabled: true, marketplaceRules: { snoonu: { mode: 'amount' as const, value: 1, rounding: 'exact' as const } } };
    const ms = [{ marketplaceId: 'talabat' as const, hasData: true }, { marketplaceId: 'snoonu' as const, hasData: true }];
    const p = [{ id: 'p', ...product(), pricing: { erpPrice: 10 } }, { id: 'q', ...product(), pricing: { erpPrice: 10, productRule: { mode: 'fixed' as const, value: 7 } } }];
    expect(computeReconRows(p, ms, new Map(), { snapshot: snap, categoryRules: [] }, settings, now).map(r => [r.productId, r.marketplaceId, r.marketplacePrice, r.marketplacePriceSource])).toEqual([
      ['p', 'talabat', 10, 'default'], ['p', 'snoonu', 11, 'marketplace'], ['q', 'talabat', 7, 'product'], ['q', 'snoonu', 7, 'product'],
    ]);
  });
});

describe('reconSignature', () => {
  it('is the exact string the database builds for a stored row (ReconRepository.storedSignatures)', () => {
    const r = { ...reconcile(input({ listing: { price: 1.1, available: false } }), settings), productId: 'p', marketplaceId: 'talabat' as const };
    expect(reconSignature(r)).toBe('mismatch|mismatch|unavailable_but_in_stock|1|1|1|0|default|11000|10000|1100');
    const unlisted = { ...reconcile(input({ listing: null }), settings), productId: 'p', marketplaceId: 'talabat' as const };
    expect(reconSignature(unlisted)).toBe('not_listed|not_listed||0|0|1||default|11000|10000|');
  });
});
