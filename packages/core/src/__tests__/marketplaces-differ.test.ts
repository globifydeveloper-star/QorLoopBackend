import { describe, expect, it } from '@jest/globals';
import { listingsDiffer } from '../products/marketplace-view.js';

const l = (price: number | string, available = true) => ({ price, available });

describe('listingsDiffer (the catalogue list\'s "marketplaces differ" rule)', () => {
  it('a product on only one marketplace differs on every choice; on neither, never', () => {
    for (const on of ['any', 'price', 'availability'] as const) {
      expect(listingsDiffer(l(5), null, on)).toBe(true);
      expect(listingsDiffer(null, l(5), on)).toBe(true);
      expect(listingsDiffer(null, null, on)).toBe(false);
    }
  });

  it('price compares exactly, in fils (numeric strings as stored)', () => {
    expect(listingsDiffer(l('6.250'), l(6.25), 'price')).toBe(false);
    expect(listingsDiffer(l('6.250'), l('6.251'), 'price')).toBe(true);
    expect(listingsDiffer(l(0.1 + 0.2), l(0.3), 'price')).toBe(false);
  });

  it('availability alone, price alone, or either', () => {
    const a = l(5, true); const b = l(5, false); const c = l(6, true);
    expect(listingsDiffer(a, b, 'availability')).toBe(true);
    expect(listingsDiffer(a, b, 'price')).toBe(false);
    expect(listingsDiffer(a, c, 'availability')).toBe(false);
    expect(listingsDiffer(a, c, 'price')).toBe(true);
    expect(listingsDiffer(a, b, 'any')).toBe(true);
    expect(listingsDiffer(a, c, 'any')).toBe(true);
    expect(listingsDiffer(a, l('5.000', true), 'any')).toBe(false);
  });
});
