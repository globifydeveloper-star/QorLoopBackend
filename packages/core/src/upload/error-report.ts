import ExcelJS from 'exceljs';

/** The worker stores at most this many row errors per upload (MAX_STORED_ERRORS in process-upload.ts). */
export const MAX_STORED_ERRORS = 5000;

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ReportError {
  row: number;
  column: string | null;
  value: string | null;
  reason: string;
}

export interface ErrorReportInput {
  fileName: string;
  source: string;
  /** all row errors in the file; may exceed errors.length when the stored list was cut off */
  total: number;
  errors: ReportError[];
  /** true when the real total is unknown but may be higher than `total` */
  mayHaveMore?: boolean;
}

const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * Text that Excel, LibreOffice or Sheets could treat as a formula once the user edits or re-saves the
 * file (OWASP CSV injection) gets a leading single quote. Plain numbers such as "-2" stay as they are.
 * Cells are also always written as strings.
 */
export function safeCell(v: string | null | undefined): string {
  const s = v ?? '';
  return /^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

/** "Daily stock (v2).csv" -> "Dailystockv2-errors.xlsx". Only [A-Za-z0-9._-] survive; never empty. */
export function errorReportFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[.-]+/, '').slice(0, 100);
  return `${base || 'upload'}-errors.xlsx`;
}

/** Workbook with a "Summary" sheet and a "Row errors" sheet (Row, Column, Value, Problem). */
export async function buildErrorWorkbook(input: ErrorReportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 18 }, { width: 60 }];
  summary.addRow(['File', safeCell(input.fileName)]);
  summary.addRow(['Source', safeCell(input.source)]);
  summary.addRow(['Total errors', input.total]);
  if (input.errors.length < input.total) {
    summary.addRow(['Note', `Showing the first ${input.errors.length} of ${input.total} errors`]);
  } else if (input.mayHaveMore) {
    summary.addRow(['Note', `Showing the first ${input.errors.length} errors; the file may have more`]);
  }
  summary.getColumn(1).font = { bold: true };

  const sheet = wb.addWorksheet('Row errors');
  sheet.columns = [
    { header: 'Row', width: 8 },
    { header: 'Column', width: 30 },
    { header: 'Value', width: 40 },
    { header: 'Problem', width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const e of input.errors) sheet.addRow([e.row, safeCell(e.column), safeCell(e.value), safeCell(e.reason)]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
