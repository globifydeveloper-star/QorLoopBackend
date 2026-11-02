import ExcelJS from 'exceljs';
import type { FileReconRow } from '../../generated-files.js';

// Headers and types inspected from D:/Qorloop-test/Talabat.xlsx and snoonu.xlsx (not marketplace docs).
export const talabatHeaders = ['sku', 'name', 'price', 'active', 'maximumSalesQuantity', 'isWeighted', 'baseWeight', 'baseWeightUnit', 'pricePerBaseUnit',
  'barcode 1', 'barcode 2', 'barcode 3', 'barcode 4', 'barcode 5', 'barcode 6', 'barcode 7', 'category 1', 'category 2', 'category 3', 'category 4'];
export const talabatMapping = { marketplaceProductId: 'sku', name: 'name', price: 'price', available: 'active', barcode1: 'barcode 1' };
export const snoonuHeaders = ['Barcode(UniqueIdentifier)', 'Product Name (En)(Update)',
  'Availability for Shaklaan Food Center Gharrafat Al Rayyan(Update)', 'Price For Branch Shaklaan Food Center Gharrafat Al Rayyan(Update)'];
export const snoonuMapping = { barcode1: snoonuHeaders[0], name: snoonuHeaders[1], available: snoonuHeaders[2], price: snoonuHeaders[3] };
export const barcodes = ['6281000000011', '6281000000028', '6281000000035', '6281000000042'];
export const talabatRows = [
  ['T0', 'Milk', '1.75', true, 8, false, null, 'kg', null, barcodes[0], '', null, null, null, null, null, 'Dairy'],
  ['T1', 'Fruit', '3.00', false, null, false, null, null, null, barcodes[1], '006281000000028', null, null, null, null, null, 'Fresh'],
  ['T2', 'Bread', '4.00', true, null, false, null, null, null, barcodes[2], null, null, null, null, null, null, 'Bakery'],
  ['T3', 'Missing ERP', '5.00', true, null, false, null, null, null, barcodes[3], null, null, null, null, null, null, 'Other'],
];
export const snoonuRows = talabatRows.map((row, i) => [barcodes[i], row[1], row[3] ? 'True' : 'False', row[2]]);

export function fixtureRecon(snoonu = false): FileReconRow[] {
  return Array.from({ length: 6 }, (_, i) => ({
    productId: `p${i}`, name: String(talabatRows[i]?.[1] ?? 'Not in source'), marketplaceProductId: snoonu ? barcodes[i] ?? '999' : `T${i}`,
    erpPrice: [2, 3, 4, 5, 9, 9][i], marketplacePrice: [2.5, 3.3, 4, 5, 9.5, 9][i], erpAvailable: i === 1 || i === 2,
    actualPrice: i === 5 ? null : [1.75, 3, 4, 5, 8][i], stockIssue: [0, 1, 3].includes(i) ? 'available_but_out_of_stock' : null,
    priceMismatchVsErp: i === 0 || i === 4, priceMismatchVsMarketplace: i === 0 || i === 1 || i === 4,
    status: i === 3 ? 'missing_from_erp' : i === 5 ? 'not_listed' : i === 2 ? 'in_sync' : 'mismatch',
  }));
}

export async function marketplaceWorkbook(headers: string[], rows: unknown[][], preamble = false) {
  const wb = new ExcelJS.Workbook();
  const hidden = wb.addWorksheet('Internal', { state: 'hidden' });
  hidden.addRow(['Do not use', 'Availability']); hidden.addRow(['x', 500]);
  wb.addWorksheet('Blank');
  const ws = wb.addWorksheet('Marketplace');
  if (preamble) ws.addRow(['Export from marketplace']);
  ws.addRow(headers);
  rows.forEach(row => ws.addRow(row));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
