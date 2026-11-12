import { describe, it, expect } from '@jest/globals';
import { hasPermission, ROLE_PERMISSIONS, ROLES } from '../roles.js';

describe('Role-Based Access Control (RBAC) Matrix', () => {
  it('recognizes all 4 standard roles', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'catalogue_manager', 'analyst']);
  });

  it('Owner has all permissions including security and team management', () => {
    const ownerPerms = ROLE_PERMISSIONS.owner;
    expect(ownerPerms).toContain('settings.security');
    expect(ownerPerms).toContain('team.manage_roles');
    expect(ownerPerms).toContain('uploads.apply');
    expect(ownerPerms).toContain('pricing.bulk');
    expect(hasPermission('owner', 'settings.security')).toBe(true);
  });

  it('Admin has all permissions except settings.security', () => {
    expect(hasPermission('admin', 'team.invite')).toBe(true);
    expect(hasPermission('admin', 'settings.security')).toBe(false);
  });

  it('Catalogue Manager can manage catalogue, pricing, and uploads, but not team or security', () => {
    expect(hasPermission('catalogue_manager', 'products.edit')).toBe(true);
    expect(hasPermission('catalogue_manager', 'uploads.apply')).toBe(true);
    expect(hasPermission('catalogue_manager', 'pricing.edit')).toBe(true);
    expect(hasPermission('catalogue_manager', 'team.invite')).toBe(false);
    expect(hasPermission('catalogue_manager', 'settings.security')).toBe(false);
  });

  it('Analyst has read-only access to view and export reports', () => {
    expect(hasPermission('analyst', 'products.view')).toBe(true);
    expect(hasPermission('analyst', 'products.edit')).toBe(false);
    expect(hasPermission('analyst', 'uploads.apply')).toBe(false);
    expect(hasPermission('analyst', 'reports.view')).toBe(true);
  });

  it('respects the dynamic analystCanExport setting', () => {
    expect(hasPermission('analyst', 'reports.export', true)).toBe(true);
    expect(hasPermission('analyst', 'reports.export', false)).toBe(false);
  });
});


describe('catalogue.stock_edit (ADR 017)', () => {
  it('Owner, Admin and Catalogue Manager may edit the catalogue stock; Analyst may not', () => {
    expect(hasPermission('owner', 'catalogue.stock_edit')).toBe(true);
    expect(hasPermission('admin', 'catalogue.stock_edit')).toBe(true);
    expect(hasPermission('catalogue_manager', 'catalogue.stock_edit')).toBe(true);
    expect(hasPermission('analyst', 'catalogue.stock_edit')).toBe(false);
  });
});

describe('marketplace.values_edit (owner decision B)', () => {
  it('Owner, Admin and Catalogue Manager may set export values; the Analyst reads only', () => {
    expect(hasPermission('owner', 'marketplace.values_edit')).toBe(true);
    expect(hasPermission('admin', 'marketplace.values_edit')).toBe(true);
    expect(hasPermission('catalogue_manager', 'marketplace.values_edit')).toBe(true);
    expect(hasPermission('analyst', 'marketplace.values_edit')).toBe(false);
    expect(hasPermission('analyst', 'recon.view')).toBe(true);
  });
});
