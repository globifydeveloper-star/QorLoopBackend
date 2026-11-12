import { describe, expect, it } from '@jest/globals';
import {
  EXPORT_STATES, acknowledgedFields, countExportStates, marketplaceValuesPlanSignature, planMarketplaceValues, reviewRow,
  type PlanTarget, type ReviewInput, type StoredField, type StoredOverride,
} from '../marketplace-values.js';

const T0 = new Date('2026-11-11T08:00:00.000Z');
const field = <V>(value: V, extra: Partial<StoredField<V>> = {}): StoredField<V> =>
  ({ value, state: 'pending', persistent: false, setById: 'u1', setAt: T0, reason: null, clearedAt: null, ...extra });
const override = (o: Partial<StoredOverride> = {}): StoredOverride => ({ id: 'o1', version: 1, availability: null, price: null, ...o });
const active = { status: 'active', erpActive: true, inLatestErpFile: true };

/** Listed, in sync with the catalogue (available, 10 QAR), no export value. */
const base = (i: Partial<ReviewInput> = {}): ReviewInput => ({
  product: active, marketplaceEnabled: true, reconStatus: 'in_sync',
  catalogue: { available: true, price: 10 }, catalogueDiffers: { availability: false, price: false },
  current: { available: true, price: 10 }, priceTolerance: 0.5, override: null, ...i,
});

describe('Review row states (catalogue is the source of truth)', () => {
  it('in sync, and to fix when the marketplace differs from the catalogue', () => {
    expect(reviewRow(base())).toMatchObject({ exportState: 'in_sync', exportStateLabel: null, needsChange: false,
      export: { available: true, price: 10, availabilitySource: 'catalogue', priceSource: 'catalogue' } });
    const r = reviewRow(base({ current: { available: false, price: 12 }, catalogueDiffers: { availability: true, price: true }, reconStatus: 'mismatch' }));
    expect(r).toMatchObject({ exportState: 'to_fix', needsChange: true, fields: { availability: { state: 'to_fix' }, price: { state: 'to_fix' } },
      export: { available: true, price: 10 } });
    expect(r.exportStateLabel).toContain('writes the catalogue value');
  });

  it('a pending value waits for export and is what the file writes, on this marketplace only', () => {
    const r = reviewRow(base({ override: override({ availability: field(false), price: field(12.5) }) }));
    expect(r).toMatchObject({ exportState: 'waiting_for_export', exportStateLabel: 'Adjusted, waiting for export', needsChange: true,
      export: { available: false, price: 12.5, availabilitySource: 'override', priceSource: 'override' }, rulePrice: 10, differsFromRulePrice: true });
    // a value equal to the listing is still an instruction until a later matching upload clears it
    expect(reviewRow(base({ override: override({ price: field(10) }) }))).toMatchObject({ exportState: 'waiting_for_export', differsFromRulePrice: false });
  });

  it('a pin the marketplace shows is pinned (price within the tolerance); otherwise it waits', () => {
    const pin = (price: number, current: number) => reviewRow(base({ current: { available: true, price: current }, override: override({ price: field(price, { persistent: true }) }) }));
    expect(pin(12, 12.4)).toMatchObject({ exportState: 'pinned', exportStateLabel: 'Pinned', needsChange: false });
    expect(pin(12, 12.6)).toMatchObject({ exportState: 'waiting_for_export', exportStateLabel: 'Pinned, waiting for export' });
    const pinnedNo = reviewRow(base({ current: { available: false, price: 10 }, catalogueDiffers: { availability: true, price: false },
      override: override({ availability: field(false, { persistent: true }) }) }));
    expect(pinnedNo).toMatchObject({ exportState: 'pinned', fields: { availability: { state: 'pinned' }, price: { state: 'in_sync' } } });
  });

  it('blocked with a plain reason; "no" can always be written, "yes" never for an ineligible product', () => {
    const yes = override({ availability: field(true) });
    expect(reviewRow(base({ product: { ...active, erpActive: false }, override: yes }))).toMatchObject({
      exportState: 'blocked', blockedReason: 'erp_inactive', blockedReasonLabel: 'Inactive in the ERP',
      exportStateLabel: 'Adjusted, cannot be exported: Inactive in the ERP', export: { available: true, availabilitySource: 'catalogue' }, needsChange: true });
    expect(reviewRow(base({ product: { ...active, inLatestErpFile: false }, override: override({ availability: field(false) }) }))).toMatchObject({ exportState: 'waiting_for_export' });
    expect(reviewRow(base({ product: { ...active, status: 'inactive' }, override: override({ price: field(9) }) }))).toMatchObject({ blockedReason: 'inactive', export: { price: 10 } });
    expect(reviewRow(base({ marketplaceEnabled: false, override: yes }))).toMatchObject({ blockedReason: 'marketplace_disabled' });
    expect(reviewRow(base({ current: null, reconStatus: 'not_listed', override: yes }))).toMatchObject({ blockedReason: 'not_listed', export: { available: null, price: null } });
  });

  it('not exportable rows explain why; the owner order: to fix, waiting for export, blocked, pinned, in sync, not exportable', () => {
    expect(reviewRow(base({ current: null, reconStatus: 'not_listed' }))).toMatchObject({ exportState: 'not_exportable', notExportableReason: 'not_listed', needsChange: false });
    expect(reviewRow(base({ current: null, reconStatus: 'no_data' }))).toMatchObject({ notExportableReason: 'no_data', exportStateLabel: 'No file from this marketplace yet' });
    expect(reviewRow(base({ product: { ...active, status: 'new' }, reconStatus: 'new' }))).toMatchObject({ notExportableReason: 'new_product' });
    expect(reviewRow(base({ catalogueDiffers: { availability: true, price: false }, current: { available: false, price: 10 }, override: override({ price: field(11) }) })).exportState).toBe('to_fix'); // to fix outranks waiting
    expect(reviewRow(base({ product: { ...active, erpActive: false }, override: override({ availability: field(true), price: field(11) }) })).exportState).toBe('blocked');
    expect(EXPORT_STATES).toEqual(['to_fix', 'waiting_for_export', 'blocked', 'pinned', 'in_sync', 'not_exportable']);
    // waiting outranks blocked: availability waits ("no" needs only a listing), price is blocked (ERP inactive)
    expect(reviewRow(base({ product: { ...active, erpActive: false }, override: override({ availability: field(false), price: field(11) }) })).exportState).toBe('waiting_for_export');
    // a blocked field shows its reason on the field even when the row is in a more urgent state
    const mixed = reviewRow(base({ product: { ...active, erpActive: false }, catalogueDiffers: { availability: true, price: false }, current: { available: true, price: 10 }, override: override({ price: field(11) }) }));
    expect(mixed).toMatchObject({ exportState: 'to_fix', blockedReason: null, fields: { price: { state: 'blocked', blockedReason: 'erp_inactive' } } });
  });

  it('a cleared value follows the catalogue again', () => {
    const cleared = override({ price: field(12, { state: 'cleared', clearedAt: T0 }) });
    expect(reviewRow(base({ override: cleared }))).toMatchObject({ exportState: 'in_sync', export: { price: 10, priceSource: 'catalogue' }, differsFromRulePrice: false });
  });

  it('counts per marketplace', () => {
    expect(countExportStates(['to_fix', 'to_fix', 'blocked', 'pinned', 'in_sync', 'waiting_for_export', 'not_exportable']))
      .toEqual({ toFix: 2, waitingForExport: 1, pinned: 1, blocked: 1 });
  });
});

describe('planning set and use catalogue value', () => {
  const target = (t: Partial<PlanTarget> = {}): PlanTarget => ({ productId: 'p1', listed: true, product: active, override: null, ...t });

  it('sets fields independently, blocks ineligible products and counts unknown ids', () => {
    const plan = planMarketplaceValues([
      target(), target({ productId: 'p2', listed: false }), target({ productId: 'p3', product: { ...active, status: 'inactive' } }),
    ], 2, { type: 'set', values: { price: { value: 12 } } }, 'promo');
    expect(plan.changes).toEqual([{ productId: 'p1', overrideId: null, version: null, fields: [
      { field: 'price', op: 'set', before: null, after: { value: 12, state: 'pending', persistent: false, reason: 'promo' } },
    ] }]);
    expect(plan.blocked).toEqual({ not_listed: 1, inactive: 1, erp_inactive: 0, missing_from_erp: 0, not_found: 2 });
  });

  it('same value, pin and reason is unchanged; a pin change alone is a change', () => {
    const o = override({ price: field(12) });
    expect(planMarketplaceValues([target({ override: o })], 0, { type: 'set', values: { price: { value: 12.0001 } } }, null).unchanged).toBe(1);
    const pin = planMarketplaceValues([target({ override: o })], 0, { type: 'set', values: { price: { value: 12, persistent: true } } }, null);
    expect(pin.changes[0]?.fields[0]).toMatchObject({ op: 'set', after: { persistent: true } });
  });

  it('use catalogue value clears only pending fields, for any owned product', () => {
    const o = override({ availability: field(false), price: field(12, { state: 'cleared', clearedAt: T0 }) });
    const plan = planMarketplaceValues([target({ listed: false, override: o }), target({ productId: 'p2' })], 0, { type: 'use_catalogue', fields: ['availability', 'price'] }, null);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ productId: 'p1', overrideId: 'o1', version: 1, fields: [{ field: 'availability', op: 'clear', after: { state: 'cleared' } }] });
    expect(plan.unchanged).toBe(1);
  });

  it('the signature changes with any write, version or outcome', () => {
    const t = target({ override: override({ price: field(12) }) });
    const a = marketplaceValuesPlanSignature(planMarketplaceValues([t], 0, { type: 'set', values: { price: { value: 13 } } }, null));
    expect(marketplaceValuesPlanSignature(planMarketplaceValues([t], 0, { type: 'set', values: { price: { value: 13 } } }, null))).toBe(a);
    expect(marketplaceValuesPlanSignature(planMarketplaceValues([t], 0, { type: 'set', values: { price: { value: 14 } } }, null))).not.toBe(a);
    expect(marketplaceValuesPlanSignature(planMarketplaceValues([{ ...t, override: { ...t.override!, version: 2 } }], 0, { type: 'set', values: { price: { value: 13 } } }, null))).not.toBe(a);
    expect(marketplaceValuesPlanSignature(planMarketplaceValues([t], 1, { type: 'set', values: { price: { value: 13 } } }, null))).not.toBe(a);
  });
});

describe('a later marketplace upload clears fix-once values only', () => {
  const later = new Date(T0.getTime() + 1);
  const o = override({ availability: field(false), price: field(12.5) });
  it('clears each matching field, exactly, from an upload created after the value was set', () => {
    expect(acknowledgedFields({ override: o, uploadCreatedAt: later, incoming: [{ available: false, price: 12.5 }], retained: [{ available: false, price: 12.5 }] }))
      .toEqual(['availability', 'price']);
    expect(acknowledgedFields({ override: o, uploadCreatedAt: later, incoming: [{ available: false, price: 12.6 }], retained: [{ available: false, price: 12.6 }] }))
      .toEqual(['availability']);
  });
  it('never on the same millisecond, without evidence, with a disagreeing listing, or for a pin', () => {
    const shown = [{ available: false, price: 12.5 }];
    expect(acknowledgedFields({ override: o, uploadCreatedAt: T0, incoming: shown, retained: shown })).toEqual([]);
    expect(acknowledgedFields({ override: o, uploadCreatedAt: later, incoming: [], retained: shown })).toEqual([]);
    expect(acknowledgedFields({ override: o, uploadCreatedAt: later, incoming: shown, retained: [...shown, { available: true, price: 12.5 }] })).toEqual(['price']);
    const pinned = override({ price: field(12.5, { persistent: true }) });
    expect(acknowledgedFields({ override: pinned, uploadCreatedAt: later, incoming: shown, retained: shown })).toEqual([]);
  });
});
