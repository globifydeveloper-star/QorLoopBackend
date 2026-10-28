import type { Role } from './roles';

/**
 * THE one permission map (plan task A5). The API guard and the web app both read it.
 *
 * DOCUMENTATION GAP (docs/open-gaps.md, G1): the repository documents the four roles only in prose
 * (docs/01-product-overview.md). There is no per-action matrix. This map is a PROVISIONAL reading of
 * that prose and must be confirmed with Globify/the client:
 *  - Owner: everything in the tenant.
 *  - Admin: everything except managing the Owner and security policy.
 *  - Catalogue Manager: upload, fix, activate, price, generate files; no user or tenant settings.
 *  - Analyst: read-only; export only if tenant setting analystCanExport is on.
 * Changing a cell here changes server enforcement everywhere; nothing else hard-codes roles.
 */
export const PERMISSIONS = [
  'products.view',
  'products.edit',
  'products.activate',
  'categories.manage',
  'pricing.view',
  'pricing.edit',
  'pricing.bulk',
  'uploads.view',
  'uploads.upload',
  'uploads.apply',
  'uploads.discard',
  'uploads.map',
  'recon.view',
  'reports.view',
  'reports.export',
  'files.view',
  'files.preview',
  'files.generate',
  'files.download',
  'settings.view',
  'settings.edit',
  'settings.security',
  'marketplaces.edit',
  'team.view',
  'team.invite',
  'team.manage_roles',
  'team.remove',
  'activity.view',
  'onboarding.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const operator: Permission[] = [
  'products.view', 'products.edit', 'products.activate', 'categories.manage',
  'pricing.view', 'pricing.edit', 'pricing.bulk',
  'uploads.view', 'uploads.upload', 'uploads.apply', 'uploads.discard', 'uploads.map',
  'recon.view', 'reports.view', 'reports.export',
  'files.view', 'files.preview', 'files.generate', 'files.download',
  'settings.view', 'team.view', 'activity.view',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: [
    ...operator,
    'settings.edit', 'marketplaces.edit',
    'team.invite', 'team.manage_roles', 'team.remove',
    'onboarding.manage',
  ],
  catalogue_manager: operator,
  analyst: [
    'products.view', 'pricing.view', 'uploads.view', 'recon.view',
    'reports.view', 'reports.export', 'files.view', 'files.download',
    'settings.view', 'team.view', 'activity.view',
  ],
};

export interface PermissionContext {
  /** Tenant setting; Analysts export only when the Owner allows it. */
  analystCanExport?: boolean;
}

const ANALYST_EXPORT_GATED: ReadonlySet<Permission> = new Set(['reports.export', 'files.download']);

export function hasPermission(role: Role, permission: Permission, ctx: PermissionContext = {}): boolean {
  if (role === 'analyst' && ANALYST_EXPORT_GATED.has(permission) && ctx.analystCanExport === false) {
    return false;
  }
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: Role, ctx: PermissionContext = {}): Permission[] {
  return PERMISSIONS.filter((p) => hasPermission(role, p, ctx));
}

/**
 * Team rules that sit on top of the map.
 *  - Only an Owner can grant the Owner role (an Admin cannot, plan A4).
 *  - Only an Owner can change or remove an Owner ("Admin: everything except ... managing the Owner").
 *  Gap G2: whether a tenant may have several Owners is not documented; we allow it, but the
 *  last remaining Owner can never be demoted or removed (enforced in the team service).
 */
export function canAssignRole(actor: Role, newRole: Role): boolean {
  if (!hasPermission(actor, 'team.manage_roles') && !hasPermission(actor, 'team.invite')) return false;
  if (newRole === 'owner') return actor === 'owner';
  return true;
}

export function canManageMember(actor: Role, memberCurrentRole: Role): boolean {
  if (memberCurrentRole === 'owner') return actor === 'owner';
  return hasPermission(actor, 'team.manage_roles');
}

/** Owners must always use MFA; other roles only when the tenant policy says so (plan A3). */
export function isMfaRequired(role: Role, mfaRequiredForAll: boolean): boolean {
  return role === 'owner' || mfaRequiredForAll;
}
