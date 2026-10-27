export function normalizeBarcode(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const cleaned = String(raw).trim().replace(/[^0-9]/g, '');
  if (!cleaned) return '';
  if (cleaned.length > 0 && cleaned.length <= 14) {
    return cleaned.padStart(14, '0');
  }
  return cleaned;
}
