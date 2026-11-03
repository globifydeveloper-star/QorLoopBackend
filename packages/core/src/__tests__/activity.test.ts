import { describe, expect, it } from '@jest/globals';
import { activityGroup, presentActivity } from '../activity.js';

describe('safe activity summaries', () => {
  it('extracts only the requested product from a bulk change, with old/new rules and prices', () => {
    const d = { changeColumns: ['productId', 'oldMode', 'oldValue', 'newMode', 'newValue', 'oldPrice', 'newPrice'],
      changes: [['first', 'fixed', 5, 'percent', 10, 5, 5.5], ['second', null, null, 'fixed', 99, 8, 99]],
      result: { willChange: 2 }, idempotencyKey: 'private-key', token: 'private-token' };
    const product = presentActivity('pricing.bulk_applied', d, { productId: 'first' });
    expect(product).toMatchObject({ summary: 'Product price changed by a bulk operation', beforeAfter: [
      { field: 'rule', before: { mode: 'fixed', value: 5 }, after: { mode: 'percent', value: 10 } },
      { field: 'price', before: 5, after: 5.5 },
    ] });
    expect(JSON.stringify(product)).not.toMatch(/second|private|99/);
    expect(presentActivity('pricing.bulk_applied', d).summary).toBe('Bulk price change applied to 2 products');
  });
  it('hides cost before/after values from read-only pricing roles', () => {
    expect(presentActivity('product.field_changed', { field: 'costPrice', old: 1, new: 2 }).beforeAfter).toEqual([]);
    expect(presentActivity('product.field_changed', { field: 'costPrice', old: 1, new: 2 }, { canViewCosts: true }).beforeAfter).toHaveLength(1);
  });
  it('never presents arbitrary field names, nested secrets or raw failure messages', () => {
    const secret = { passwordHash: 'private-value', token: 'private-value', mfaSecret: 'private-value', ip: '192.0.2.1', message: 'private-value' };
    for (const action of ['unknown.private-value', 'upload.failed', 'auth.mfa_failed', 'product.field_changed', 'product.price_rule_set']) {
      const result = presentActivity(action, { ...secret, field: 'passwordHash', old: secret, new: secret });
      expect(JSON.stringify(result)).not.toMatch(/private-value|passwordHash|mfaSecret|192\.0\.2\.1/);
    }
  });
  it('handles malformed legacy payloads without throwing or coercing objects into values', () => {
    for (const details of [null, [], 'text', { changes: [null, []], changeColumns: [] }, { old: { mode: 'fixed', value: 'secret' } }]) {
      expect(() => presentActivity('pricing.bulk_applied', details, { productId: 'first' })).not.toThrow();
      expect(presentActivity('product.price_rule_set', details).beforeAfter[0].before).toBeNull();
    }
  });
  it('groups ERP stock/price changes separately from catalogue edits', () => {
    expect(activityGroup('product.field_changed', { field: 'erpPrice' })).toBe('price');
    expect(activityGroup('product.field_changed', { field: 'erpStock' })).toBe('stock_uploads');
    expect(activityGroup('product.field_changed', { field: 'nameAr' })).toBe('catalogue');
    expect(activityGroup('auth.password_reset', {})).toBe('team_security');
  });
  it('presents price-rule deletion, status activation and role changes in plain English', () => {
    expect(presentActivity('product.price_rule_deleted', { old: { mode: 'fixed', value: 3, token: 'secret' } }).beforeAfter)
      .toEqual([{ field: 'rule', before: { mode: 'fixed', value: 3 }, after: null }]);
    expect(presentActivity('product.field_changed', { field: 'status', old: 'new', new: 'active' }).beforeAfter)
      .toEqual([{ field: 'status', before: 'new', after: 'active' }]);
    expect(presentActivity('team.role_changed', { from: 'analyst', to: 'admin' }).beforeAfter)
      .toEqual([{ field: 'role', before: 'analyst', after: 'admin' }]);
  });
});
