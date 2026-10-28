/**
 * Barcode normalisation (docs/05-business-rules.md 5.5): trim, strip a trailing ".0" (Excel numbers),
 * strip leading zeros. Talabat pads to 14 digits (GTIN-14), which then equals the 13-digit EAN.
 * Non-digit characters are removed. Returns '' when nothing usable is left.
 */
export function normalizeBarcode(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let s = typeof raw === 'number' ? (Number.isInteger(raw) ? raw.toFixed(0) : String(raw)) : String(raw);
  s = s.trim().replace(/\.0+$/, '');
  s = s.replace(/[^0-9]/g, '');
  return s.replace(/^0+/, '');
}
