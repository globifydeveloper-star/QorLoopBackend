import { describe, expect, it } from '@jest/globals';
import {
  marketplaceValuesPlanSignature, planCopyFromMarketplace,
  type CopyAction, type CopyTarget, type SourceListing, type StoredField, type StoredOverride,
} from '../marketplace-values.js';

const T0 = new Date('2026-11-12T08:00:00.000Z');
const field = <V>(value: V, extra: Partial<StoredField<V>> = {}): StoredField<V> =>
  ({ value, state: 'pending', persistent: false, setById: 'u1', setAt: T0, reason: null, clearedAt: null, ...extra });
const override = (o: Partial<StoredOverride> = {}): StoredOverride => ({ id: 'o1', version: 3, availability: null, price: null, ...o });
const active = { status: 'active', erpActive: true, inLatestErpFile: true };
/** Listed on A, catalogue: available, 10 QAR, no export value. */
const target = (t: Partial<CopyTarget> = {}): CopyTarget =>
  ({ productId: 'p1', listed: true, product: active, override: null, catalogue: { available: true, price: 10 }, ...t });
const listing = (l: Partial<SourceListing> = {}): SourceListing => ({ available: false, price: 12.5, uploadId: 'latest', fileName: 'b.xlsx', ...l });
const action = (a: Partial<CopyAction> = {}): CopyAction => ({ type: 'copy_from_marketplace', sourceMarketplaceId: 'snoonu', fields: ['availability', 'price'], ...a });
const plan = (targets: CopyTarget[], source: Record<string, SourceListing>, a: Partial<CopyAction> = {}, notFound = 0, reason: string | null = 'Copied from Snoonu') =>
  planCopyFromMarketplace(targets, notFound, new Map(Object.entries(source)), 'latest', action(a), reason);

describe('copy from marketplace', () => {
  it('price only, availability only and both take B\'s listing values as fix-once export values', () => {
    const src = { p1: listing() };
    expect(plan([target()], src, { fields: ['price'] }).changes).toEqual([{ productId: 'p1', overrideId: null, version: null, fields: [
      { field: 'price', op: 'set', before: null, after: { value: 12.5, state: 'pending', persistent: false, reason: 'Copied from Snoonu' } },
    ] }]);
    expect(plan([target()], src, { fields: ['availability'] }).changes[0]!.fields).toEqual([
      { field: 'availability', op: 'set', before: null, after: { value: false, state: 'pending', persistent: false, reason: 'Copied from Snoonu' } },
    ]);
    const both = plan([target()], src);
    expect(both.changes[0]!.fields.map(f => [f.field, f.after.value])).toEqual([['availability', false], ['price', 12.5]]);
    expect(plan([target()], src, { persistent: true }).changes[0]!.fields.every(f => f.after.persistent)).toBe(true);
  });

  it('a field is unchanged when A\'s next file already writes B\'s value (pending value, else the catalogue)', () => {
    const same = plan([target()], { p1: listing({ available: true, price: 10.0001 }) });
    expect(same).toMatchObject({ changes: [], unchanged: 1 });
    // a pending fix-once value equal to B: unchanged; one that differs is replaced (version read kept for the token)
    expect(plan([target({ override: override({ price: field(12.5) }) })], { p1: listing({ available: true }) })).toMatchObject({ changes: [], unchanged: 1 });
    const replaced = plan([target({ override: override({ price: field(11) }) })], { p1: listing({ available: true }) });
    expect(replaced.changes[0]).toMatchObject({ overrideId: 'o1', version: 3, fields: [{ field: 'price', before: { value: 11 }, after: { value: 12.5 } }] });
    // a cleared value follows the catalogue: compared with the catalogue
    expect(plan([target({ override: override({ price: field(12.5, { state: 'cleared', clearedAt: T0 }) }) })], { p1: listing({ available: true }) }).changes).toHaveLength(1);
    // no stored comparison yet: always written
    expect(plan([target({ catalogue: null })], { p1: listing({ available: true, price: 10 }) }).changes[0]!.fields).toHaveLength(2);
  });

  it('a product not on B, or B\'s price outside the allowed range, writes nothing', () => {
    const p = plan([target(), target({ productId: 'p2' }), target({ productId: 'p3' })], { p2: listing({ price: 0 }), p3: listing({ price: 0 }) }, { fields: ['price'] });
    expect(p.changes).toEqual([]);
    expect(p.copy.notOnSource).toEqual({ not_on_source: 1, source_price_invalid: 2 });
    // availability can still be copied when the price cannot
    const mixed = plan([target()], { p1: listing({ price: 100_001 }) });
    expect(mixed.changes[0]!.fields.map(f => f.field)).toEqual(['availability']);
  });

  it('blocked on A exactly as bulk set, availability "No" included; unknown ids are not_found', () => {
    const p = plan([
      target({ listed: false }), target({ productId: 'p2', product: { ...active, status: 'inactive' } }),
      target({ productId: 'p3', product: { ...active, erpActive: false } }), target({ productId: 'p4', product: { ...active, inLatestErpFile: false } }),
    ], { p1: listing(), p2: listing(), p3: listing(), p4: listing() }, { fields: ['availability'] }, 2);
    expect(p.changes).toEqual([]);
    expect(p.blocked).toEqual({ not_listed: 1, inactive: 1, erp_inactive: 1, missing_from_erp: 1, not_found: 2 });
  });

  it('pins on A are kept unless replacePins; a replaced pin stays pinned', () => {
    const t = target({ override: override({ price: field(11, { persistent: true }), availability: field(true, { persistent: true }) }) });
    const kept = plan([t], { p1: listing() });
    expect(kept).toMatchObject({ changes: [], unchanged: 0, copy: { pinnedKept: 1 } });
    const replaced = plan([t], { p1: listing() }, { replacePins: true });
    expect(replaced.changes[0]!.fields.map(f => [f.field, f.after.value, f.after.persistent])).toEqual([['availability', false, true], ['price', 12.5, true]]);
    // a pin already equal to B is simply unchanged
    expect(plan([target({ override: override({ price: field(12.5, { persistent: true }) }) })], { p1: listing({ available: true }) })).toMatchObject({ unchanged: 1, copy: { pinnedKept: 0 } });
    // one field pinned, the other copied: a change, not kept
    const half = plan([target({ override: override({ price: field(11, { persistent: true }) }) })], { p1: listing() });
    expect(half).toMatchObject({ copy: { pinnedKept: 0 }, changes: [{ fields: [{ field: 'availability' }] }] });
  });

  it('counts changed products whose value comes from an older B file', () => {
    const p = plan([target(), target({ productId: 'p2' })], { p1: listing({ uploadId: 'older' }), p2: listing() });
    expect(p.copy.fromOlderFile).toBe(1);
  });

  it('the signature covers the source, its latest file and the new counts', () => {
    const t = [target()];
    const a = marketplaceValuesPlanSignature(plan(t, { p1: listing() }));
    expect(marketplaceValuesPlanSignature(plan(t, { p1: listing() }))).toBe(a);
    expect(marketplaceValuesPlanSignature(planCopyFromMarketplace(t, 0, new Map([['p1', listing()]]), 'newer', action(), 'Copied from Snoonu'))).not.toBe(a);
    expect(marketplaceValuesPlanSignature(plan(t, { p1: listing() }, { sourceMarketplaceId: 'keeta' }))).not.toBe(a);
    expect(marketplaceValuesPlanSignature(plan(t, {}))).not.toBe(marketplaceValuesPlanSignature(plan(t, { p1: listing({ available: true, price: 10 }) })));
  });
});
