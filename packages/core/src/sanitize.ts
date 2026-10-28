/** Spreadsheet formula injection guard for any user- or file-supplied text written to a generated file. */
export function escapeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
