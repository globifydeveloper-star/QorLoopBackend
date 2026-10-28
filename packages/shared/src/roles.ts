export const ROLES = ['owner', 'admin', 'catalogue_manager', 'analyst'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  catalogue_manager: 'Catalogue Manager',
  analyst: 'Analyst',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
