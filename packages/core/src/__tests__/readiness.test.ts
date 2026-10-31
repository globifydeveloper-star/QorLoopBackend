import { describe, expect, it } from '@jest/globals';
import { DEFAULT_READINESS_RULES, isReady, READINESS_REASONS } from '../products/readiness.js';

const cat = '11111111-1111-4111-8111-111111111111';
const sub = '22222222-2222-4222-8222-222222222222';

describe('product readiness', () => {
  it('by default needs an Arabic name and a category, not a subcategory', () => {
    expect(DEFAULT_READINESS_RULES).toEqual({ requireArabicName: true, requireCategory: true, requireSubcategory: false });
    expect(isReady({ nameAr: 'حليب', categoryId: cat, subcategoryId: null })).toEqual({ ready: true, missing: [] });
  });
  it('lists every missing field in a fixed order', () => {
    expect(isReady({ nameAr: null, categoryId: null, subcategoryId: null }).missing).toEqual(['nameAr', 'category']);
    expect(isReady({ nameAr: 'حليب', categoryId: null, subcategoryId: null }).missing).toEqual(['category']);
  });
  it('treats a blank Arabic name as missing', () => {
    expect(isReady({ nameAr: '   ', categoryId: cat, subcategoryId: null })).toEqual({ ready: false, missing: ['nameAr'] });
  });
  it('follows the rules it is given', () => {
    const strict = { ...DEFAULT_READINESS_RULES, requireSubcategory: true };
    expect(isReady({ nameAr: 'حليب', categoryId: cat, subcategoryId: null }, strict).missing).toEqual(['subcategory']);
    expect(isReady({ nameAr: 'حليب', categoryId: cat, subcategoryId: sub }, strict).ready).toBe(true);
    expect(isReady({ nameAr: null, categoryId: null, subcategoryId: null }, { requireArabicName: false, requireCategory: false, requireSubcategory: false }).ready).toBe(true);
  });
  it('has a plain reason for every gap', () => {
    expect(READINESS_REASONS).toEqual({ nameAr: 'Arabic name missing', category: 'Category missing', subcategory: 'Subcategory missing' });
  });
});
