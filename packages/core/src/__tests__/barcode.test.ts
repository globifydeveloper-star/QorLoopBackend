import { describe, it, expect } from '@jest/globals';
import { normalizeBarcode } from '../barcode.js';

describe('GTIN / Barcode Normalization', () => {
  it('pads numeric barcodes up to 14 digits (GTIN-14)', () => {
    expect(normalizeBarcode('12345678')).toBe('00000012345678');
    expect(normalizeBarcode('6291041000123')).toBe('06291041000123'); // EAN-13
    expect(normalizeBarcode('12345678901234')).toBe('12345678901234'); // Full 14
  });

  it('strips non-numeric characters and spaces', () => {
    expect(normalizeBarcode(' 123-456 78 ')).toBe('00000012345678');
    expect(normalizeBarcode('BAR-998811')).toBe('00000000998811');
  });

  it('handles null, undefined, and empty string', () => {
    expect(normalizeBarcode(null)).toBe('');
    expect(normalizeBarcode(undefined)).toBe('');
    expect(normalizeBarcode('')).toBe('');
    expect(normalizeBarcode('   ')).toBe('');
  });

  it('preserves longer than 14 digit strings as raw cleaned digits', () => {
    const longDigits = '12345678901234567';
    expect(normalizeBarcode(longDigits)).toBe(longDigits);
  });
});

