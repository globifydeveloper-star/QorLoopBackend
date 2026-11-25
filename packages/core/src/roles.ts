export type Role = 'owner' | 'admin' | 'catalogue_manager' | 'analyst';

export const ROLES: Role[] = ['owner', 'admin', 'catalogue_manager', 'analyst'];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  catalogue_manager: 'Catalogue Manager',
  analyst: 'Analyst'
};

export type Permission =
  | 'products.view'
  | 'products.edit'
  | 'products.activate'
  /** Block or unblock products (old or seasonal; migration 202611170001). */
  | 'products.block'
  | 'categories.manage'
  | 'pricing.view'
  | 'pricing.edit'
  | 'pricing.bulk'
  | 'uploads.view'
  | 'uploads.upload'
  | 'uploads.apply'
  | 'uploads.discard'
  | 'uploads.map'
  | 'recon.view'
  | 'reports.view'
  | 'reports.export'
  | 'files.view'
  | 'files.preview'
  | 'files.generate'
  | 'files.download'
  | 'settings.view'
  | 'settings.edit'
  | 'settings.security'
  | 'team.view'
  | 'team.invite'
  | 'team.manage_roles'
  | 'team.remove'
  | 'marketplaces.edit'
  | 'activity.view'
  /** Edit the catalogue stock and resolve stock conflicts (ADR 017). */
  | 'catalogue.stock_edit'
  /** Set or remove a product's export values for one marketplace (availability, price; owner decision B). */
  | 'marketplace.values_edit'
  /** Delete all of the store's business data from the app (ADR 022). Owner only. */
  | 'store.reset';

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [
    'products.view', 'products.edit', 'products.activate', 'products.block', 'categories.manage', 'catalogue.stock_edit', 'marketplace.values_edit',
    'pricing.view', 'pricing.edit', 'pricing.bulk',
    'uploads.view', 'uploads.upload', 'uploads.apply', 'uploads.discard', 'uploads.map',
    'recon.view', 'reports.view', 'reports.export',
    'files.view', 'files.preview', 'files.generate', 'files.download',
    'settings.view', 'settings.edit', 'settings.security',
    'team.view', 'team.invite', 'team.manage_roles', 'team.remove',
    'marketplaces.edit', 'activity.view', 'store.reset'
  ],
  admin: [
    'products.view', 'products.edit', 'products.activate', 'products.block', 'categories.manage', 'catalogue.stock_edit', 'marketplace.values_edit',
    'pricing.view', 'pricing.edit', 'pricing.bulk',
    'uploads.view', 'uploads.upload', 'uploads.apply', 'uploads.discard', 'uploads.map',
    'recon.view', 'reports.view', 'reports.export',
    'files.view', 'files.preview', 'files.generate', 'files.download',
    'settings.view', 'settings.edit',
    'team.view', 'team.invite', 'team.manage_roles', 'team.remove',
    'marketplaces.edit', 'activity.view'
  ],
  catalogue_manager: [
    'products.view', 'products.edit', 'products.activate', 'products.block', 'categories.manage', 'catalogue.stock_edit', 'marketplace.values_edit',
    'pricing.view', 'pricing.edit', 'pricing.bulk',
    'uploads.view', 'uploads.upload', 'uploads.apply', 'uploads.discard', 'uploads.map',
    'recon.view', 'reports.view', 'reports.export',
    'files.view', 'files.preview', 'files.generate', 'files.download',
    'settings.view', 'team.view', 'activity.view'
  ],
  analyst: [
    'products.view', 'pricing.view', 'uploads.view', 'recon.view',
    'reports.view', 'reports.export', 'files.view', 'files.download',
    'settings.view', 'team.view', 'activity.view'
  ]
};

export function hasPermission(role: Role, permission: Permission, analystCanExport = true): boolean {
  if (role === 'analyst' && permission === 'reports.export' && !analystCanExport) {
    return false;
  }
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
