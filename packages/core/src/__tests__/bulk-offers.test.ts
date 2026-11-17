import { describe, expect, it } from '@jest/globals';
import type { PricingSettingsSnapshot } from '../pricing.js';
import {
  BULK_OFFER_REJECT_REASONS, bulkOfferRejectMessage, bulkOfferRemoveSignature, bulkOfferRemoveTotals, bulkOfferSignature, bulkOfferTotals,
  normalPrices, offerViewState, planBulkOfferRemoval, planBulkOffers,
  type BulkOfferContext, type BulkOfferItem, type BulkOfferProduct, type StoredOffer,
} from '../bulk-offers.js';

const now = new Date('2026-11-17T09:00:00.000Z');
const start = '2026-11-20T00:00:00.000+03:00';
const end = '2026-11-30T23:59:59.999+03:00';
const settings: PricingSettingsSnapshot = { defaultRule: { mode: 'same', value: 0 }, rounding: 'exact' };
const ctx = (over: Partial<BulkOfferContext> = {}): BulkOfferContext =>
  ({ settings, categoryRules: [], enabled: ['talabat', 'snoonu'], exportPrices: new Map(), now, ...over });
const product = (id: string, erpPrice: number, over: Partial<BulkOfferProduct> = {}): BulkOfferProduct =>
  ({ id, status: 'active', pricing: { erpPrice }, offers: [], ...over });
const products = (...ps: BulkOfferProduct[]) => new Map(ps.map(p => [p.id, p]));
const item = (productId: string, price: number, over: Partial<BulkOfferItem> = {}): BulkOfferItem =>
  ({ productId, price, validFrom: start, validUntil: end, ...over });
const reasons = (items: BulkOfferItem[], ps: Map<string, BulkOfferProduct>, c = ctx()) => planBulkOffers(items, ps, c).rows.map(r => r.reason);

describe('planBulkOffers', () => {
  it('sets a valid row with the normal price and no warnings', () => {
    const plan = planBulkOffers([item('p1', 8.5)], products(product('p1', 10)), ctx());
    expect(plan.rows).toEqual([expect.objectContaining({
      index: 0, productId: 'p1', outcome: 'set', reason: null, message: null, warnings: [], normalPrice: 10, lowestNormalPrice: 10, currentOffer: null,
      offer: { price: 8.5, validFrom: new Date(start), validUntil: new Date(end) }, previous: null,
    })]);
    expect(plan.rows[0]).not.toHaveProperty('normalPrices');
    expect(plan.sets.map(r => r.productId)).toEqual(['p1']);
  });

  it('rejects each rule with its own reason, first failing rule wins', () => {
    const ps = products(product('p1', 10), product('p2', 10, { status: 'inactive' }), product('p3', 10, { status: 'new' }), product('p4', 10));
    expect(reasons([
      item('p1', 5), item('p1', 6), // duplicate_row on both rows
      item('missing', 5),
      item('p2', 5), item('p3', 5),
    ], ps)).toEqual(['duplicate_row', 'duplicate_row', 'not_found', 'product_not_active', 'product_not_active']);
    for (const price of [0, -1, 100_000.001, 1.2345, Number.NaN]) expect(reasons([item('p4', price)], ps)).toEqual(['invalid_price']);
    expect(reasons([item('p4', 5, { validUntil: null })], ps)).toEqual(['end_required']);
    expect(reasons([item('p4', 5, { validUntil: undefined })], ps)).toEqual(['end_required']);
    expect(reasons([item('p4', 5, { validFrom: end, validUntil: end })], ps)).toEqual(['end_before_start']);
    expect(reasons([item('p4', 5, { validFrom: end, validUntil: start })], ps)).toEqual(['end_before_start']);
    expect(reasons([item('p4', 5, { validFrom: null, validUntil: '2026-11-17T08:59:59.999Z' })], ps)).toEqual(['already_ended']);
    expect(reasons([item('p4', 10)], ps)).toEqual(['price_not_below_normal']);
    expect(reasons([item('p4', 12)], ps)).toEqual(['price_not_below_normal']);
    // an invalid price is reported before a missing end (the documented order)
    expect(reasons([item('p4', 0, { validUntil: null })], ps)).toEqual(['invalid_price']);
  });

  it('accepts 100,000 exactly, 3 decimals, an open start and an end exactly now', () => {
    const ps = products(product('p1', 200_000), product('p2', 10));
    expect(reasons([item('p1', 100_000), item('p2', 9.999, { validFrom: null, validUntil: now.toISOString() })], ps)).toEqual([null, null]);
  });

  it('compares with the LOWEST normal price across the enabled marketplaces when per-marketplace rules are on', () => {
    const perMarketplace: PricingSettingsSnapshot = {
      ...settings, perMarketplaceEnabled: true,
      marketplaceRules: { talabat: { mode: 'percent', value: 20, rounding: 'exact' }, snoonu: { mode: 'amount', value: -1, rounding: 'exact' } },
    };
    const c = ctx({ settings: perMarketplace });
    const ps = products(product('p1', 10));
    const [row] = planBulkOffers([item('p1', 9)], ps, c).rows;
    expect(row).toEqual(expect.objectContaining({
      outcome: 'rejected', reason: 'price_not_below_normal', normalPrice: 10, normalPrices: { talabat: 12, snoonu: 9 }, lowestNormalPrice: 9,
      message: 'The offer price must be below the normal price (QAR 9.000)',
    }));
    expect(planBulkOffers([item('p1', 8.999)], ps, c).rows[0]!.outcome).toBe('set');
    // only enabled marketplaces count: with Snoonu off, Talabat's 12 is the lowest
    expect(planBulkOffers([item('p1', 11)], ps, ctx({ settings: perMarketplace, enabled: ['talabat'] })).rows[0]!.outcome).toBe('set');
  });

  it('uses the plain normal price when no marketplace is enabled', () => {
    expect(normalPrices({ erpPrice: 7 }, { ...ctx(), enabled: [] })).toEqual({ normalPrice: 7, lowest: 7 });
  });

  it('ignores the current offer when computing the normal price', () => {
    const current: StoredOffer = { price: 6, validFrom: null, validUntil: new Date('2026-12-31T00:00:00Z') };
    const [row] = planBulkOffers([item('p1', 7)], products(product('p1', 10, { pricing: { erpPrice: 10, offers: [current] }, offers: [current] })), ctx()).rows;
    expect(row).toEqual(expect.objectContaining({ outcome: 'set', normalPrice: 10 }));
  });

  it('same price and same dates is unchanged; same price with other dates is set with replaces_offer', () => {
    const current: StoredOffer = { price: 8.5, validFrom: new Date(start), validUntil: new Date(end) };
    const ps = products(product('p1', 10, { offers: [current] }));
    const unchanged = planBulkOffers([item('p1', 8.5)], ps, ctx());
    expect(unchanged.rows[0]).toEqual(expect.objectContaining({
      outcome: 'unchanged', warnings: [], previous: null,
      currentOffer: { price: 8.5, validFrom: new Date(start).toISOString(), validUntil: new Date(end).toISOString(), state: 'scheduled' },
    }));
    expect(unchanged.sets).toEqual([]);
    // the same instant written with another offset is the same date
    expect(planBulkOffers([item('p1', 8.5, { validFrom: '2026-11-19T21:00:00.000Z' })], ps, ctx()).rows[0]!.outcome).toBe('unchanged');
    const moved = planBulkOffers([item('p1', 8.5, { validUntil: '2026-12-01T23:59:59.999+03:00' })], ps, ctx()).rows[0]!;
    expect(moved).toEqual(expect.objectContaining({
      outcome: 'set', previous: current,
      warnings: [{ code: 'replaces_offer', message: 'Replaces the current offer (QAR 8.500, until 2026-11-30)', offer: { price: 8.5, validFrom: new Date(start).toISOString(), validUntil: new Date(end).toISOString(), state: 'scheduled' } }],
    }));
  });

  it('a product with legacy duplicate offers is never unchanged', () => {
    const current: StoredOffer = { price: 8.5, validFrom: new Date(start), validUntil: new Date(end) };
    const [row] = planBulkOffers([item('p1', 8.5)], products(product('p1', 10, { offers: [current, current] })), ctx()).rows;
    expect(row!.outcome).toBe('set');
  });

  it('warns once per enabled marketplace where a pending price export value outranks the offer', () => {
    const exportPrices = new Map([['p1', ['talabat', 'snoonu', 'keeta'] as const], ['p2', ['keeta'] as const]]);
    const plan = planBulkOffers([item('p1', 5), item('p2', 5)], products(product('p1', 10), product('p2', 10)), ctx({ exportPrices: exportPrices as never }));
    expect(plan.rows.map(r => r.warnings)).toEqual([[
      { code: 'export_value_outranks', marketplaceId: 'talabat', message: 'A pending Talabat export price stays in place and outranks the offer on Talabat' },
      { code: 'export_value_outranks', marketplaceId: 'snoonu', message: 'A pending Snoonu export price stays in place and outranks the offer on Snoonu' },
    ], []]);
    // the totals count products, not warnings
    expect(bulkOfferTotals(plan).warnings.export_value_outranks).toBe(1);
  });

  it('Qatar day boundaries: an end of today is valid, an end of yesterday has already ended', () => {
    // now is 2026-11-17 12:00 in Qatar
    const ps = products(product('p1', 10));
    expect(reasons([item('p1', 5, { validFrom: null, validUntil: '2026-11-17T23:59:59.999+03:00' })], ps)).toEqual([null]);
    expect(reasons([item('p1', 5, { validFrom: '2026-11-17T00:00:00.000+03:00', validUntil: '2026-11-17T23:59:59.999+03:00' })], ps)).toEqual([null]);
    expect(reasons([item('p1', 5, { validFrom: null, validUntil: '2026-11-16T23:59:59.999+03:00' })], ps)).toEqual(['already_ended']);
    // a start in the past is fine (the offer runs from then): only the end matters
    expect(reasons([item('p1', 5, { validFrom: '2026-11-01T00:00:00.000+03:00', validUntil: end })], ps)).toEqual([null]);
  });

  it('totals, rejected reasons and the signature of the writes', () => {
    const current: StoredOffer = { price: 8.5, validFrom: new Date(start), validUntil: new Date(end) };
    const ps = products(product('p1', 10), product('p2', 10, { offers: [current] }), product('p3', 10, { offers: [{ ...current, price: 9 }] }));
    const plan = planBulkOffers([item('p1', 5), item('p2', 8.5), item('p3', 7), item('nope', 1), item('p1', 0.5)], ps, ctx());
    expect(bulkOfferTotals(plan)).toEqual({
      items: 5, set: 1, unchanged: 1, rejected: 3, warnings: { replaces_offer: 1, export_value_outranks: 0 },
      rejectedReasons: [
        { reason: 'duplicate_row', count: 2, message: bulkOfferRejectMessage('duplicate_row') },
        { reason: 'not_found', count: 1, message: bulkOfferRejectMessage('not_found') },
      ],
    });
    const sig = bulkOfferSignature(plan.sets);
    expect(sig).toBe(`p3|7000|${new Date(start).getTime()}|${new Date(end).getTime()}`);
    // the order of the request does not change the signature; another price does
    const a = planBulkOffers([item('p1', 5), item('p3', 7)], ps, ctx());
    const b = planBulkOffers([item('p3', 7), item('p1', 5)], ps, ctx());
    expect(bulkOfferSignature(a.sets)).toBe(bulkOfferSignature(b.sets));
    expect(bulkOfferSignature(planBulkOffers([item('p3', 7.001)], ps, ctx()).sets)).not.toBe(bulkOfferSignature(planBulkOffers([item('p3', 7)], ps, ctx()).sets));
  });

  it('has a message for every reason', () => {
    for (const r of BULK_OFFER_REJECT_REASONS) expect(bulkOfferRejectMessage(r).length).toBeGreaterThan(10);
  });
});

describe('offerViewState', () => {
  it('maps valid / expired to active / ended', () => {
    expect(offerViewState({ validFrom: new Date(start), validUntil: new Date(end) }, now)).toBe('scheduled');
    expect(offerViewState({ validFrom: null, validUntil: new Date(end) }, now)).toBe('active');
    expect(offerViewState({ validFrom: null, validUntil: new Date('2026-11-01T00:00:00Z') }, now)).toBe('ended');
    expect(offerViewState({ validFrom: null, validUntil: null }, now)).toBe('active');
  });
});

describe('planBulkOfferRemoval', () => {
  it('removes any offer state, skips products without one or not found, counts duplicate ids once', () => {
    const ended: StoredOffer = { price: 5, validFrom: null, validUntil: new Date('2026-11-01T00:00:00Z') };
    const scheduled: StoredOffer = { price: 6, validFrom: new Date(start), validUntil: new Date(end) };
    const ps = products(product('p1', 10, { offers: [ended] }), product('p2', 10, { offers: [scheduled], status: 'inactive' }), product('p3', 8));
    const plan = planBulkOfferRemoval(['p1', 'p2', 'p3', 'nope', 'p1'], ps, ctx());
    expect(plan.rows.map(r => [r.productId, r.outcome, r.reason])).toEqual([
      ['p1', 'remove', null], ['p2', 'remove', null], ['p3', 'skipped', 'no_offer'], ['nope', 'skipped', 'not_found'],
    ]);
    expect(plan.rows[0]).toEqual(expect.objectContaining({ normalPrice: 10, currentOffer: expect.objectContaining({ state: 'ended' }), previous: ended }));
    expect(plan.rows[2]!.normalPrice).toBe(8);
    expect(bulkOfferRemoveTotals(plan)).toEqual({
      products: 4, remove: 2, skipped: 2,
      skippedReasons: [{ reason: 'not_found', count: 1, message: 'No product with this id in this store' }, { reason: 'no_offer', count: 1, message: 'This product has no offer' }],
    });
    // the signature follows the offers being removed
    const moved = products(product('p1', 10, { offers: [{ ...ended, price: 4 }] }));
    expect(bulkOfferRemoveSignature(planBulkOfferRemoval(['p1'], moved, ctx()).removes))
      .not.toBe(bulkOfferRemoveSignature(planBulkOfferRemoval(['p1'], ps, ctx()).removes));
  });
});
