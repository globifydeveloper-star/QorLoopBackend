import { normalizeBarcode } from '../barcode';

describe('normalizeBarcode', () => {
  it.each([
    ['6281007012345', '6281007012345'],
    ['06281007012345', '6281007012345'], // Talabat GTIN-14 equals the 13-digit EAN
    [6281007012345, '6281007012345'],
    ['6281007012345.0', '6281007012345'],
    ['  6281007012345 ', '6281007012345'],
    ['6281-0070-12345', '6281007012345'],
    ['', ''],
    [null, ''],
    [undefined, ''],
    ['abc', ''],
  ])('%s -> %s', (input, out) => expect(normalizeBarcode(input)).toBe(out));
});
