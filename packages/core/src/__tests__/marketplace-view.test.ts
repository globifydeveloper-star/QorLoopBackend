import { describe, expect, it } from '@jest/globals';
import { marketplaceComparison, marketplaceView, priceIssueOf, type MarketplaceReconInput, type MarketplaceViewInput } from '../products/marketplace-view.js';

const recon = (o: Partial<MarketplaceReconInput> = {}): MarketplaceReconInput =>
  ({ status: 'in_sync', stockIssue: null, priceMismatch: false, actualPrice: 10, expectedPrice: 10, ...o });
const uploadedAt = new Date('2026-11-09T08:00:00.123Z');
const input = (o: Partial<MarketplaceViewInput> = {}): MarketplaceViewInput => ({
  marketplaceId: 'talabat', reference: 'marketplace', hasData: true,
  listing: { price: '10.000', available: true, uploadedAt }, recon: recon(), ...o,
});

describe('marketplaceComparison', () => {
  it('follows the documented order', () => {
    expect(marketplaceComparison(false, true, recon({ status: 'mismatch' }))).toBe('not_applicable');
    expect(marketplaceComparison(true, false, recon({ status: 'mismatch' }))).toBe('not_in_file');
    expect(marketplaceComparison(true, false, null)).toBe('not_in_file');
    expect(marketplaceComparison(true, true, null)).toBe('not_applicable');
    expect(marketplaceComparison(true, true, recon())).toBe('in_sync');
    expect(marketplaceComparison(true, true, recon({ status: 'mismatch' }))).toBe('mismatch');
  });
  it('missing_from_erp is a mismatch only while the listing is still available (a stock issue)', () => {
    expect(marketplaceComparison(true, true, recon({ status: 'missing_from_erp', stockIssue: 'available_but_out_of_stock' }))).toBe('mismatch');
    expect(marketplaceComparison(true, true, recon({ status: 'missing_from_erp' }))).toBe('not_applicable');
  });
  it('new, not_listed (listing newer than the recompute) and no_data are not compared', () => {
    for (const status of ['new', 'not_listed', 'no_data'] as const) expect(marketplaceComparison(true, true, recon({ status }))).toBe('not_applicable');
  });
});

describe('priceIssueOf', () => {
  it('gives the direction of a flagged difference, in fils', () => {
    expect(priceIssueOf(recon({ priceMismatch: true, actualPrice: 11, expectedPrice: 10 }))).toBe('marketplace_price_higher');
    expect(priceIssueOf(recon({ priceMismatch: true, actualPrice: 9.999, expectedPrice: 10 }))).toBe('marketplace_price_lower');
  });
  it('is null without the flag (inside the tolerance), without prices, or at the same fils', () => {
    expect(priceIssueOf(recon({ actualPrice: 11, expectedPrice: 10 }))).toBeNull();
    expect(priceIssueOf(recon({ priceMismatch: true, actualPrice: null }))).toBeNull();
    expect(priceIssueOf(recon({ priceMismatch: true, expectedPrice: null }))).toBeNull();
    expect(priceIssueOf(recon({ priceMismatch: true, actualPrice: 0.1 + 0.2, expectedPrice: 0.3 }))).toBeNull();
  });
});

describe('marketplaceView', () => {
  it('shows the listing, the comparison and the issues', () => {
    expect(marketplaceView(input({ recon: recon({ status: 'mismatch', stockIssue: 'unavailable_but_in_stock', priceMismatch: true, actualPrice: 12, expectedPrice: 10 }) }))).toEqual({
      marketplaceId: 'talabat', reference: 'marketplace', available: true, price: '10.000', inFile: true, comparison: 'mismatch',
      stockIssue: 'unavailable_but_in_stock', priceIssue: 'marketplace_price_higher', sourceUploadedAt: uploadedAt,
    });
  });
  it('is null everywhere a product is not in the file', () => {
    expect(marketplaceView(input({ listing: null, recon: recon({ status: 'not_listed' }) }))).toEqual({
      marketplaceId: 'talabat', reference: 'marketplace', available: null, price: null, inFile: false, comparison: 'not_in_file',
      stockIssue: null, priceIssue: null, sourceUploadedAt: null,
    });
  });
  it('without an applied upload nothing is in the file or compared', () => {
    expect(marketplaceView(input({ hasData: false }))).toMatchObject({ inFile: false, available: null, price: null, comparison: 'not_applicable' });
  });
  it('a listing without a recon row yet shows the file values but no issues', () => {
    expect(marketplaceView(input({ recon: null }))).toMatchObject({ inFile: true, available: true, comparison: 'not_applicable', stockIssue: null, priceIssue: null });
  });
  it('hides stale issues of a row that is not compared (new product)', () => {
    expect(marketplaceView(input({ recon: recon({ status: 'new', stockIssue: 'available_but_out_of_stock' }) }))).toMatchObject({ comparison: 'not_applicable', stockIssue: null });
  });
  it('a legacy listing without an upload has no source time', () => {
    expect(marketplaceView(input({ listing: { price: '1.500', available: false, uploadedAt: null } }))).toMatchObject({ inFile: true, sourceUploadedAt: null });
  });
});
