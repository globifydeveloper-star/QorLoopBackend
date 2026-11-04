import { describe, expect, it } from '@jest/globals';
import { DEFAULT_READINESS_RULES, isReady, missingDetails, READINESS_REASONS } from '../products/readiness.js';

const cat = '11111111-1111-4111-8111-111111111111';
const sub = '22222222-2222-4222-8222-222222222222';
const bare = { nameAr: null, categoryId: null, subcategoryId: null };
const required = { requireArabicName: true, requireCategory: true, requireSubcategory: false };

describe('product readiness', () => {
  it('by default needs no Arabic name, category or subcategory (owner decision 2026-11-04)', () => {
    expect(DEFAULT_READINESS_RULES).toEqual({ requireArabicName: false, requireCategory: false, requireSubcategory: false });
    expect(Object.isFrozen(DEFAULT_READINESS_RULES)).toBe(true);
    expect(isReady(bare)).toEqual({ ready: true, missing: [] });
    expect(isReady({ nameAr: '   ', categoryId: null, subcategoryId: null }, DEFAULT_READINESS_RULES)).toEqual({ ready: true, missing: [] });
  });
  it('turned back on, lists every missing field in a fixed order', () => {
    expect(isReady(bare, required).missing).toEqual(['nameAr', 'category']);
    expect(isReady({ nameAr: 'حليب', categoryId: null, subcategoryId: null }, required).missing).toEqual(['category']);
    expect(isReady({ nameAr: 'حليب', categoryId: cat, subcategoryId: null }, required)).toEqual({ ready: true, missing: [] });
  });
  it('treats a blank Arabic name as missing when it is required', () => {
    expect(isReady({ nameAr: '   ', categoryId: cat, subcategoryId: null }, required)).toEqual({ ready: false, missing: ['nameAr'] });
  });
  it('follows the rules it is given', () => {
    const strict = { ...required, requireSubcategory: true };
    expect(isReady({ nameAr: 'حليب', categoryId: cat, subcategoryId: null }, strict).missing).toEqual(['subcategory']);
    expect(isReady({ nameAr: 'حليب', categoryId: cat, subcategoryId: sub }, strict).ready).toBe(true);
    expect(isReady(bare, { requireArabicName: false, requireCategory: true, requireSubcategory: false }).missing).toEqual(['category']);
  });
  it('has a plain reason for every gap', () => {
    expect(READINESS_REASONS).toEqual({ nameAr: 'Arabic name missing', category: 'Category missing', subcategory: 'Subcategory missing' });
  });
});

describe('missing details (non-blocking)', () => {
  it('reports a missing or blank Arabic name and a missing category whatever the rules', () => {
    expect(missingDetails(bare)).toEqual({ arabicNameMissing: true, categoryMissing: true });
    expect(missingDetails({ nameAr: '  ', categoryId: cat })).toEqual({ arabicNameMissing: true, categoryMissing: false });
    expect(missingDetails({ nameAr: 'حليب', categoryId: null })).toEqual({ arabicNameMissing: false, categoryMissing: true });
    expect(missingDetails({ nameAr: 'حليب', categoryId: cat })).toEqual({ arabicNameMissing: false, categoryMissing: false });
  });
});
