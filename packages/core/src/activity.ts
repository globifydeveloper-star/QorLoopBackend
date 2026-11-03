/** Safe presentation of stored events. Never copy arbitrary details into an API response. */
export const ACTIVITY_GROUPS = ['price', 'stock_uploads', 'catalogue', 'team_security'] as const;
export type ActivityGroup = typeof ACTIVITY_GROUPS[number];
export const GROUP_ACTIONS: Record<ActivityGroup, readonly string[]> = {
  price: ['pricing.settings_changed', 'pricing.marketplace_rule_set', 'pricing.marketplace_rule_deleted', 'pricing.category_rule_set',
    'pricing.category_rule_deleted', 'pricing.prices_adopted', 'pricing.bulk_applied', 'product.price_rule_set', 'product.price_rule_deleted', 'product.offer_set', 'product.offer_deleted'],
  stock_uploads: ['upload.created', 'upload.rejected', 'upload.queued', 'upload.mapping_confirmed', 'upload.apply_requested', 'upload.discarded',
    'upload.needs_mapping', 'upload.reviewed', 'upload.failed', 'upload.applied', 'upload.apply_failed', 'recon.recompute_requested', 'recon.failed', 'file.generated', 'file.generation_failed'],
  catalogue: ['products.activated', 'category.created', 'category.updated', 'category.deleted', 'category.assigned_from_erp'],
  team_security: ['settings.changed', 'store.provisioned', 'invitation.created', 'invitation.accepted', 'invitation.resent', 'invitation.revoked',
    'team.role_changed', 'team.member_deactivated', 'auth.login_failed', 'auth.password_verified', 'auth.logout', 'auth.password_reset_requested',
    'auth.password_reset', 'auth.mfa_setup_started', 'auth.mfa_failed', 'auth.mfa_enrolled', 'auth.mfa_verified', 'auth.recovery_failed', 'auth.recovery_used'],
};
export const PRICE_FIELDS = ['erpPrice', 'costPrice'] as const;
export const STOCK_FIELDS = ['erpStock', 'erpActive', 'inLatestErpFile'] as const;
export const HISTORY_NOTICE = 'Upload entries are store-wide summaries and do not prove this product changed. Earlier marketplace price and availability changes were not recorded per product. Historical coverage may also omit newly adopted price rules. No audit retention policy is configured.';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const text = (v: unknown) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : null;
export const activityUuid = (v: unknown): string | null => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v) ? v : null;
type SafeValue = string | number | boolean | null | { [key: string]: string | number | boolean | null };
export type BeforeAfter = { field: string; before: SafeValue; after: SafeValue };
const scalar = (v: unknown): SafeValue => typeof v === 'boolean' ? v : typeof v === 'number' ? number(v) : text(v);
function rule(v: unknown): SafeValue {
  if (v == null) return null;
  const r = object(v);
  if (r.mode === 'same') return { mode: 'same' };
  return ['percent', 'amount', 'fixed'].includes(String(r.mode)) && number(r.value) !== null ? { mode: String(r.mode), value: number(r.value) } : null;
}
const role = (v: unknown) => ['owner', 'admin', 'catalogue_manager', 'analyst'].includes(String(v)) ? String(v) : null;
const fields: Record<string, string> = {
  nameAr: 'Arabic name', nameEn: 'English name', sku: 'SKU', brand: 'Brand', size: 'Size', erpCategory: 'ERP category',
  categoryId: 'Category', subcategoryId: 'Subcategory', status: 'Product status', erpPrice: 'ERP price', costPrice: 'Cost price',
  erpStock: 'ERP stock', erpActive: 'ERP active status', inLatestErpFile: 'Presence in latest ERP file',
};
export function activityGroup(action: string, details: unknown): ActivityGroup {
  if (action === 'product.field_changed') {
    const field = String(object(details).field);
    return (PRICE_FIELDS as readonly string[]).includes(field) ? 'price' : (STOCK_FIELDS as readonly string[]).includes(field) ? 'stock_uploads' : 'catalogue';
  }
  return ACTIVITY_GROUPS.find(group => GROUP_ACTIONS[group].includes(action)) ?? 'catalogue';
}

/** No secrets or internal failure messages are used, even for malformed or future event payloads. */
export function presentActivity(action: string, details: unknown, options: { productId?: string; canViewCosts?: boolean } = {}) {
  const d = object(details), beforeAfter: BeforeAfter[] = [];
  const change = (field: string, before: SafeValue, after: SafeValue) => { beforeAfter.push({ field, before, after }); };
  let summary = 'Activity recorded';
  if (action === 'product.field_changed') {
    const field = typeof d.field === 'string' ? d.field : '';
    summary = fields[field] ? `${fields[field]} changed` : 'Product details changed';
    if (fields[field] && (field !== 'costPrice' || options.canViewCosts)) change(field, scalar(d.old), scalar(d.new));
  } else if (action === 'product.price_rule_set' || action === 'product.price_rule_deleted') {
    summary = action.endsWith('_set') ? 'Product price rule changed' : 'Product price rule removed';
    change('rule', rule(d.old), rule(d.new));
    if (number(d.oldPrice) !== null || number(d.newPrice) !== null) change('price', number(d.oldPrice), number(d.newPrice));
  } else if (action === 'pricing.bulk_applied') {
    const count = number(object(d.result).willChange);
    summary = count === null ? 'Bulk price change applied' : `Bulk price change applied to ${count} products`;
    if (options.productId && Array.isArray(d.changes) && Array.isArray(d.changeColumns) &&
      d.changeColumns.join(',') === 'productId,oldMode,oldValue,newMode,newValue,oldPrice,newPrice') {
      const row = d.changes.find((c: unknown) => Array.isArray(c) && c[0] === options.productId) as unknown[] | undefined;
      if (row?.length === 7) {
        summary = 'Product price changed by a bulk operation';
        change('rule', row[1] === null ? null : rule({ mode: row[1], value: row[2] }), row[3] === null ? null : rule({ mode: row[3], value: row[4] }));
        change('price', number(row[5]), number(row[6]));
      }
    }
  } else if (action === 'settings.changed') {
    const allowed = ['profile.name', 'priceTolerance', 'stockThreshold', 'staleHours', 'mfaRequiredForAll', 'analystCanExport'];
    summary = 'Store settings changed';
    if (typeof d.field === 'string' && allowed.includes(d.field)) change(d.field, scalar(d.old), scalar(d.new));
  } else if (action === 'pricing.settings_changed') {
    summary = 'Pricing settings changed';
    if (d.field === 'defaultRule') change('defaultRule', rule(d.old), rule(d.new));
    if (['rounding', 'perMarketplaceEnabled', 'compareReferenceDefault'].includes(String(d.field))) change(String(d.field), scalar(d.old), scalar(d.new));
  } else if (/^pricing\.(marketplace|category)_rule_(set|deleted)$/.test(action)) {
    summary = `${action.includes('marketplace') ? 'Marketplace' : 'Category'} price rule ${action.endsWith('_set') ? 'changed' : 'removed'}`;
    change('rule', rule(d.old), rule(d.new));
  } else if (action === 'product.offer_set' || action === 'product.offer_deleted') {
    summary = action.endsWith('_set') ? 'Product offer changed' : 'Product offer removed';
    change('offerPrice', number(object(d.old).price), number(object(d.new).price));
  } else if (action === 'team.role_changed') {
    summary = 'Team member role changed'; change('role', role(d.from), role(d.to));
  } else {
    const summaries: Record<string, string> = {
      'upload.created': 'Upload started', 'upload.rejected': 'Upload rejected', 'upload.queued': 'Upload queued for processing',
      'upload.mapping_confirmed': 'Upload column mapping confirmed', 'upload.apply_requested': 'Upload apply requested',
      'upload.discarded': 'Upload discarded', 'upload.needs_mapping': 'Upload needs column mapping', 'upload.reviewed': 'Upload ready for review',
      'upload.failed': 'Upload processing failed', 'upload.applied': 'Upload applied to the store', 'upload.apply_failed': 'Upload apply failed',
      'pricing.prices_adopted': 'Marketplace prices adopted', 'products.activated': 'Products activated',
      'category.created': 'Category created', 'category.updated': 'Category changed', 'category.deleted': 'Category deleted',
      'category.assigned_from_erp': 'Category assigned from ERP categories', 'store.provisioned': 'Store provisioned',
      'invitation.created': 'Team invitation created', 'invitation.accepted': 'Team invitation accepted', 'invitation.resent': 'Team invitation resent',
      'invitation.revoked': 'Team invitation revoked', 'team.member_deactivated': 'Team member removed',
      'auth.login_failed': 'Sign-in failed', 'auth.password_verified': 'Sign-in password verified', 'auth.logout': 'Signed out',
      'auth.password_reset_requested': 'Password reset requested', 'auth.password_reset': 'Password reset completed',
      'auth.mfa_setup_started': 'Two-step verification setup started', 'auth.mfa_failed': 'Two-step verification failed',
      'auth.mfa_enrolled': 'Two-step verification enabled', 'auth.mfa_verified': 'Two-step verification completed',
      'auth.recovery_failed': 'Recovery-code verification failed', 'auth.recovery_used': 'Recovery code used',
      'recon.recompute_requested': 'Reconciliation requested', 'recon.failed': 'Reconciliation failed',
      'file.generated': 'Marketplace file generated', 'file.generation_failed': 'Marketplace file generation failed',
    };
    summary = summaries[action] ?? summary;
  }
  const known = action === 'product.field_changed' || ACTIVITY_GROUPS.some(g => GROUP_ACTIONS[g].includes(action));
  return { type: known ? action : 'unknown', group: activityGroup(action, details), summary, beforeAfter };
}
