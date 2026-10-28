import type { UploadSource } from '@qorloop/shared';

export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  /** lower-case header hints used for the automatic mapping suggestion */
  hints: string[];
}

/** Qorloop fields a user can map (docs/05 5.6). Marketplace availability OR quantity is accepted. */
export const ERP_FIELDS: readonly FieldDef[] = [
  { key: 'barcode', label: 'Barcode', required: true, hints: ['barcode', 'ean', 'upc', 'gtin'] },
  { key: 'nameEn', label: 'Product name (English)', required: true, hints: ['name', 'item', 'product name', 'description'] },
  { key: 'nameAr', label: 'Product name (Arabic)', required: false, hints: ['arabic', 'name ar', 'name_ar'] },
  { key: 'price', label: 'Selling price (QAR)', required: true, hints: ['sale price', 'selling price', 'price', 'retail'] },
  { key: 'cost', label: 'Cost price (QAR)', required: false, hints: ['cost'] },
  { key: 'stock', label: 'Stock quantity', required: true, hints: ['quantity', 'qty', 'stock', 'available qty'] },
  { key: 'active', label: 'Active', required: false, hints: ['active', 'status', 'enabled'] },
  { key: 'category', label: 'Category', required: false, hints: ['category', 'tag 1', 'department'] },
  { key: 'brand', label: 'Brand', required: false, hints: ['brand'] },
  { key: 'sku', label: 'SKU', required: false, hints: ['sku', 'item code', 'item id'] },
];

export const MARKETPLACE_FIELDS: readonly FieldDef[] = [
  { key: 'marketplaceProductId', label: 'Marketplace product ID', required: true, hints: ['sku', 'item id', 'item code', 'product id', 'id'] },
  { key: 'barcode1', label: 'Barcode', required: true, hints: ['barcode 1', 'barcode', 'ean', 'gtin'] },
  { key: 'barcode2', label: 'Barcode 2', required: false, hints: ['barcode 2'] },
  { key: 'barcode3', label: 'Barcode 3', required: false, hints: ['barcode 3'] },
  { key: 'name', label: 'Product name', required: false, hints: ['name', 'product name', 'title'] },
  { key: 'price', label: 'Price (QAR)', required: true, hints: ['price', 'selling price', 'sale price'] },
  { key: 'available', label: 'Availability (True/False) or stock quantity', required: true, hints: ['availability', 'available', 'in stock', 'active', 'status', 'stock'] },
];

export function fieldsFor(source: UploadSource | string): readonly FieldDef[] {
  return source === 'erp' ? ERP_FIELDS : MARKETPLACE_FIELDS;
}
