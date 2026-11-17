import { describe, expect, it } from '@jest/globals';
import {
  ENDED_OFFERS_NOT_RESTORED, PRODUCT_BLOCKED_MESSAGE, PRODUCT_BLOCK_REASONS, blockSignature, planBlock, planUnblock,
} from '../products/blocking.js';
import { buildErpReview, buildMarketplaceReview, type CatalogProduct } from '../upload/review.js';
import type { ErpRow, MarketplaceRow } from '../upload/validate.js';
import { BULK_BLOCK_REASONS, bulkBlockMessage } from '../price-change.js';
import { BULK_OFFER_REJECT_REASONS, BULK_OFFER_REMOVE_SKIP_REASONS, bulkOfferRejectMessage, bulkOfferRemoveSkipMessage } from '../bulk-offers.js';
import { activityGroup, presentActivity } from '../activity.js';
import { hasPermission } from '../roles.js';

describe('planBlock / planUnblock', () => {
  const selected = [{ id: 'a', isBlocked: false }, { id: 'b', isBlocked: true }, { id: 'c', isBlocked: false }];
  it('blocks the not yet blocked; counts the already blocked and the ids not found', () => {
    expect(planBlock(selected, 4)).toEqual({ toBlock: ['a', 'c'], alreadyBlocked: 1, notFound: 1 });
  });
  it('unblocks the blocked only', () => {
    expect(planUnblock(selected, 3)).toEqual({ toUnblock: ['b'], notBlocked: 2, notFound: 0 });
  });
  it('signs the products, the offers and the reason, in any order', () => {
    expect(blockSignature(['b', 'a'], ['o2', 'o1'], 'old')).toBe(blockSignature(['a', 'b'], ['o1', 'o2'], 'old'));
    expect(blockSignature(['a'], [], 'old')).not.toBe(blockSignature(['a'], [], 'seasonal'));
    expect(blockSignature(['a'], [], 'old')).not.toBe(blockSignature(['a'], ['o1'], 'old'));
  });
  it('has three reasons and says that ended offers are not restored', () => {
    expect(PRODUCT_BLOCK_REASONS).toEqual(['old', 'seasonal', 'other']);
    expect(ENDED_OFFERS_NOT_RESTORED).toMatch(/not restored/);
  });
});

describe('reviews: a blocked product is never a change', () => {
  const products: CatalogProduct[] = [
    { id: 'p1', normalizedBarcode: '111', sku: 'S1', nameEn: 'One', erpPrice: 10, erpStock: 5, inLatestErpFile: true },
    { id: 'p2', normalizedBarcode: '222', sku: 'S2', nameEn: 'Two', erpPrice: 20, erpStock: 0, inLatestErpFile: true, isBlocked: true },
    { id: 'p3', normalizedBarcode: '333', sku: null, nameEn: 'Three', erpPrice: 30, erpStock: 1, inLatestErpFile: true, isBlocked: true },
  ];
  const erp = (rowNumber: number, barcode: string, price: number, stock: number): ErpRow => ({ rowNumber, barcode, nameEn: 'Renamed', price, stock, active: true });
  it('ERP: no price, stock or name change, not missing, counted as blockedProducts', () => {
    const r = buildErpReview([erp(2, '111', 11, 5), erp(3, '222', 25, 9)], 2, [], products, 'full');
    expect(r.summary).toMatchObject({ matched: 2, newProducts: 0, priceChanges: 1, stockChanges: 0, nameChanges: 1, missingFromFile: 0, blockedProducts: 1 });
    expect(r.rows.find(x => x.productId === 'p2')).toMatchObject({ changeType: 'none', isBlocked: true });
    expect(r.missing).toEqual([]); // p3 is blocked: not "missing from the file"
  });
  it('marketplace: no price or availability change, never missing', () => {
    const row = (rowNumber: number, id: string, barcode: string, price: number): MarketplaceRow => ({ rowNumber, marketplaceProductId: id, barcodes: [barcode], name: 'x', price, available: true });
    const listings = [{ productId: 'p2', marketplaceProductId: 'M2', price: 20, available: false }, { productId: 'p3', marketplaceProductId: 'M3', price: 30, available: true }];
    const r = buildMarketplaceReview([row(2, 'M1', '111', 10), row(3, 'M2', '222', 99)], 2, [], products, listings, 'full');
    expect(r.summary).toMatchObject({ matched: 2, priceChanges: 1, stockChanges: 1, unmatched: 0, missingFromFile: 0, blockedProducts: 1 });
    expect(r.rows.find(x => x.productId === 'p2')).toMatchObject({ changeType: 'none', isBlocked: true });
  });
});

describe('bulk price and bulk offers: product_blocked', () => {
  it('is a reason of each, with the same message', () => {
    expect(BULK_BLOCK_REASONS).toContain('product_blocked');
    expect(BULK_OFFER_REJECT_REASONS).toContain('product_blocked');
    expect(BULK_OFFER_REMOVE_SKIP_REASONS).toContain('product_blocked');
    expect(bulkBlockMessage('product_blocked', 'talabat')).toBe(PRODUCT_BLOCKED_MESSAGE);
    expect(bulkOfferRejectMessage('product_blocked')).toBe(PRODUCT_BLOCKED_MESSAGE);
    expect(bulkOfferRemoveSkipMessage('product_blocked')).toBe(PRODUCT_BLOCKED_MESSAGE);
  });
});

describe('activity and permission', () => {
  it('presents block events in the catalogue group', () => {
    expect(activityGroup('product.blocked', {})).toBe('catalogue');
    expect(presentActivity('product.blocked', { reason: 'seasonal', offersEnded: [{ price: 1 }] })).toMatchObject({
      type: 'product.blocked', summary: 'Product blocked (seasonal); its active offer was ended', beforeAfter: [{ field: 'blocked', before: false, after: true }],
    });
    expect(presentActivity('product.unblocked', { reason: 'old' }).summary).toMatch(/not restored/);
    expect(presentActivity('products.blocked', { blocked: 3, offersEnded: 1 }).summary).toBe('3 products blocked, 1 active offers ended');
    expect(presentActivity('products.unblocked', { unblocked: 2 }).summary).toBe('2 products unblocked');
  });
  it('products.block: owner, admin and catalogue manager; not the analyst', () => {
    expect(['owner', 'admin', 'catalogue_manager', 'analyst'].map(r => hasPermission(r as never, 'products.block'))).toEqual([true, true, true, false]);
  });
});
