/**
 * Golden datasets for the full-verification suite. Pure synthetic data: no real product, customer or secret.
 * Every dataset is plain rows plus the setup a user would do (rules, offers, blocks, settings). The expected answer is
 * computed from the rows by the independent reference calculator (`expected.ts`), never by product code.
 */
import ExcelJS from 'exceljs';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** A cell: a plain value, or a number shown with a date format (how Excel stores a barcode typed into a date column). */
export type Cell = string | number | boolean | null | { date: number };

export const ERP_HEADERS = ['Barcode', 'Item Name', 'Arabic Name', 'Sale Price', 'Qty', 'Active', 'Category', 'SKU'] as const;
export const ERP_MAPPING = { barcode: 'Barcode', nameEn: 'Item Name', nameAr: 'Arabic Name', price: 'Sale Price', stock: 'Qty', active: 'Active', category: 'Category', sku: 'SKU' };
export type ErpRow = [barcode: Cell, nameEn: Cell, nameAr: Cell, price: Cell, stock: Cell, active: Cell, category: Cell, sku: Cell];

// Talabat columns and cell types as in ADR 011 / docs 5.8 (sku is the marketplace product id; barcode 1 is 14-digit zero-padded).
export const TALABAT_HEADERS = ['sku', 'name', 'price', 'active', 'maximumSalesQuantity', 'isWeighted', 'baseWeight', 'baseWeightUnit', 'pricePerBaseUnit',
  'barcode 1', 'barcode 2', 'barcode 3', 'category 1'];
export const TALABAT_MAPPING = { marketplaceProductId: 'sku', name: 'name', price: 'price', available: 'active', barcode1: 'barcode 1', barcode2: 'barcode 2', barcode3: 'barcode 3' };
export type TalabatRow = { sku: string; name: string; price: Cell; active: Cell; barcode1: Cell; barcode2?: Cell; barcode3?: Cell; category?: string };

// Snoonu names the availability and price columns after the branch (docs/reports/2026-11-04-templates-step-0-inspection.md).
export const SNOONU_BRANCH = 'Verification Branch Al Sadd';
export const SNOONU_HEADERS = ['Barcode(UniqueIdentifier)', 'Product Name (En)(Update)', `Availability for ${SNOONU_BRANCH}(Update)`, `Price For Branch ${SNOONU_BRANCH}(Update)`];
export const SNOONU_MAPPING = { barcode1: SNOONU_HEADERS[0]!, name: SNOONU_HEADERS[1]!, available: SNOONU_HEADERS[2]!, price: SNOONU_HEADERS[3]! };
export type SnoonuRow = { barcode: Cell; name: string; available: Cell; price: Cell };

export type RuleSpec = { mode: 'same' } | { mode: 'percent' | 'amount' | 'fixed'; value: string };
export type Dataset = {
  name: string;
  slug: string;
  description: string;
  settings: { tolerance: string; threshold: number; staleHours: number };
  pricing?: {
    defaultRule?: RuleSpec; rounding?: 'exact' | '0.05' | '0.25' | '0.50';
    perMarketplace?: Record<string, RuleSpec & { rounding: 'exact' | '0.05' | '0.25' | '0.50' }>;
    categories?: Record<string, { rule?: RuleSpec; subcategories?: Record<string, RuleSpec | null> }>;
    /** barcode (normalised) -> [category, subcategory?] */
    assign?: Record<string, [string, string?]>;
    productRules?: Record<string, RuleSpec>;
    /** barcode -> offer, times relative to the run's "now" */
    offers?: Record<string, { price: string; fromMs: number | null; untilMs: number | null }>;
  };
  erp: ErpRow[];
  /** A second ERP file applied after the first (new products become status new; Arabic names are Qorloop-owned). */
  erp2?: ErpRow[];
  talabat?: TalabatRow[];
  snoonu?: SnoonuRow[];
  /** barcodes to block / make inactive after the ERP import (through the API) */
  block?: string[];
  inactive?: string[];
  /** hours since each marketplace's latest upload (stale checks) */
  uploadAgeHours?: Partial<Record<'talabat' | 'snoonu', number>>;
  /** this dataset's ERP file must be rejected */
  expectErpRejected?: boolean;
};

const ean = (n: number) => '62810' + String(n).padStart(8, '0');
const gtin14 = (b: string) => b.padStart(14, '0');
/** Valid ERP rows that keep a dataset's invalid share far below the 20% rejection limit. */
const fillers = (from: number, count: number, price: string, stock: number): ErpRow[] =>
  Array.from({ length: count }, (_, i) => erp(ean(from + i), `Filler ${from + i}`, price, stock));
const t = (sku: string, name: string, price: Cell, active: Cell, barcode1: Cell, extra: Partial<TalabatRow> = {}): TalabatRow => ({ sku, name, price, active, barcode1, ...extra });
const s = (barcode: Cell, name: string, available: Cell, price: Cell): SnoonuRow => ({ barcode, name, available, price });
const erp = (barcode: Cell, name: Cell, price: Cell, stock: Cell, extra: { ar?: Cell; active?: Cell; category?: Cell; sku?: Cell } = {}): ErpRow =>
  [barcode, name, extra.ar ?? null, price, stock, extra.active ?? null, extra.category ?? null, extra.sku ?? null];

// ───────────────── 1. barcodes: leading zeros, missing, SKU fallback, duplicates, date-formatted cells ─────────────────
const barcodes: Dataset = {
  name: 'barcodes', slug: 'vbarcodes', description: 'Barcode normalisation, missing barcodes, SKU fallback, duplicates, date-formatted cells',
  settings: { tolerance: '0', threshold: 0, staleHours: 12 },
  erp: [
    erp(ean(1), 'Plain EAN', '2.000', 10),
    erp('00' + ean(2), 'Leading zeros in ERP', '2.000', 10),
    erp(Number(ean(3)), 'Numeric cell', '2.000', 10),
    erp(ean(4) + '.0', 'Trailing .0', '2.000', 10),
    erp(` ${ean(5)} `, 'Spaces around', '2.000', 10),
    erp(null, 'Missing barcode', '2.000', 10),
    erp('', 'Empty barcode', '2.000', 10),
    erp(ean(1), 'Duplicate of Plain EAN', '3.000', 5),
    erp('0' + ean(2), 'Duplicate after normalisation', '3.000', 5),
    erp(ean(8), 'Has SKU only match', '2.000', 10, { sku: 'SKU-8' }),
    erp({ date: 45000 }, 'Barcode in a date cell (small number)', '2.000', 10),
    erp({ date: Number(ean(11)) }, 'Barcode in a date cell (13 digits)', '2.000', 10),
    erp(ean(12), 'Listed with barcode 3 only', '2.000', 10),
    erp(ean(13), 'Unlisted', '2.000', 10),
    erp(ean(14), 'Filler A', '2.000', 10), erp(ean(15), 'Filler B', '2.000', 10), erp(ean(16), 'Filler C', '2.000', 10),
    erp(ean(17), 'Filler D', '2.000', 10), erp(ean(18), 'Filler E', '2.000', 10), erp(ean(19), 'Filler F', '2.000', 10),
    ...fillers(20, 22, '2.000', 10),
  ],
  talabat: [
    t('T1', 'Plain EAN', '2.00', true, gtin14(ean(1))),
    t('T2', 'Leading zeros in ERP', '2.00', true, gtin14(ean(2))),
    t('T3', 'Numeric cell', '2.00', true, gtin14(ean(3))),
    t('T4', 'Trailing .0', '2.00', true, ean(4)),
    t('T5', 'Spaces around', '2.00', true, '000' + ean(5)),
    t('SKU-8', 'SKU fallback', '2.00', true, '0000000099999'),
    t('T12', 'Barcode 3 match', '2.00', true, '0000000099998', { barcode3: ean(12) }),
    t('T99', 'Not in ERP at all', '2.00', true, '0000000099997'),
    t('T1', 'Duplicate marketplace id', '9.00', false, gtin14(ean(1))),
    t('T14', 'Filler A', '2.00', true, gtin14(ean(14))), t('T15', 'Filler B', '2.00', true, gtin14(ean(15))),
    t('T16', 'Filler C', '2.00', true, gtin14(ean(16))), t('T17', 'Filler D', '2.00', true, gtin14(ean(17))),
  ],
};

// ───────────────── 2. ERP validation and stock threshold ─────────────────
const stock: Dataset = {
  name: 'stock', slug: 'vstock', description: 'Negative and zero stock, stock at / just above / just below the threshold, non-numeric values, inactive in ERP',
  settings: { tolerance: '0', threshold: 5, staleHours: 12 },
  erp: [
    erp(ean(101), 'Negative stock listed available', '1.000', -3),
    erp(ean(102), 'Zero stock listed available', '1.000', 0),
    erp(ean(103), 'At threshold listed available', '1.000', 5),
    erp(ean(104), 'Just above threshold listed unavailable', '1.000', 6),
    erp(ean(105), 'Just below threshold listed unavailable', '1.000', 4),
    erp(ean(106), 'Plenty listed available', '1.000', 100),
    erp(ean(107), 'Just above threshold listed available', '1.000', 6),
    erp(ean(108), 'ERP inactive listed available', '1.000', 50, { active: 'No' }),
    erp(ean(109), 'ERP inactive (false) listed unavailable', '1.000', 50, { active: false }),
    erp(ean(110), 'Stock as text', '1.000', '7'),
    erp(ean(111), 'Non-numeric stock', '1.000', 'lots'),
    erp(ean(112), 'Non-numeric price', 'abc', 10),
    erp(ean(113), 'Missing price', null, 10),
    erp(ean(114), null, '1.000', 10),
    erp(ean(115), 'Missing stock', '1.000', null),
    erp(ean(116), 'Quantity listing 0', '1.000', 50),
    erp(ean(117), 'Quantity listing 12', '1.000', 0),
    erp(ean(118), 'Snoonu yes', '1.000', 50), erp(ean(119), 'Snoonu no', '1.000', 50), erp(ean(120), 'Snoonu 1', '1.000', 50),
    erp(ean(121), 'Snoonu unreadable', '1.000', 50), ...fillers(122, 22, '1.000', 50),
  ],
  talabat: [
    t('S101', 'n', '1.00', true, gtin14(ean(101))), t('S102', 'n', '1.00', true, gtin14(ean(102))),
    t('S103', 'n', '1.00', true, gtin14(ean(103))), t('S104', 'n', '1.00', false, gtin14(ean(104))),
    t('S105', 'n', '1.00', false, gtin14(ean(105))), t('S106', 'n', '1.00', true, gtin14(ean(106))),
    t('S107', 'n', '1.00', true, gtin14(ean(107))), t('S108', 'n', '1.00', true, gtin14(ean(108))),
    t('S109', 'n', '1.00', false, gtin14(ean(109))), t('S110', 'n', '1.00', true, gtin14(ean(110))),
    t('S116', 'n', '1.00', true, gtin14(ean(116))), t('S117', 'n', '1.00', false, gtin14(ean(117))),
  ],
  snoonu: [
    s(ean(101), 'n', 'True', '1.00'), s(ean(103), 'n', 'True', '1.00'), s(ean(104), 'n', 'False', '1.00'),
    s(ean(116), 'n', 0, '1.00'), s(ean(117), 'n', 12, '1.00'), s(ean(118), 'n', 'Yes', '1.00'), s(ean(119), 'n', 'no', '1.00'),
    s(ean(120), 'n', 1, '1.00'), s(ean(121), 'n', 'maybe', '1.00'),
  ],
};

// ───────────────── 3. price tolerance in integer fils, rounding, large prices ─────────────────
const prices: Dataset = {
  name: 'prices', slug: 'vprices', description: 'Prices exactly at, just inside and just outside the tolerance; half-fils; large prices',
  settings: { tolerance: '0.050', threshold: 0, staleHours: 12 },
  erp: [
    erp(ean(201), 'At +tolerance', '10.000', 10), erp(ean(202), 'Inside +tolerance', '10.000', 10),
    erp(ean(203), 'Outside +tolerance', '10.000', 10), erp(ean(204), 'At -tolerance', '10.000', 10),
    erp(ean(205), 'Outside -tolerance', '10.000', 10), erp(ean(206), 'Exact', '10.000', 10),
    erp(ean(207), 'Large exact', '99999.999', 10), erp(ean(208), 'Large outside', '12345.678', 10),
    erp(ean(209), 'Four decimals in ERP', '2.0005', 10), erp(ean(210), 'Float noise 0.1+0.2', 0.1 + 0.2, 10),
    erp(ean(211), 'Price as number', 5.5, 10), erp(ean(212), 'Zero price', '0', 10),
    erp(ean(213), 'Snoonu numeric price', '4.250', 10), erp(ean(214), 'Snoonu 3 decimals', '4.255', 10),
  ],
  talabat: [
    t('P201', 'n', '10.05', true, gtin14(ean(201))), t('P202', 'n', '10.049', true, gtin14(ean(202))),
    t('P203', 'n', '10.051', true, gtin14(ean(203))), t('P204', 'n', '9.95', true, gtin14(ean(204))),
    t('P205', 'n', '9.949', true, gtin14(ean(205))), t('P206', 'n', '10.00', true, gtin14(ean(206))),
    t('P207', 'n', '99999.999', true, gtin14(ean(207))), t('P208', 'n', '12345.60', true, gtin14(ean(208))),
    t('P209', 'n', '2.001', true, gtin14(ean(209))), t('P210', 'n', '0.30', true, gtin14(ean(210))),
    t('P211', 'n', 5.5, true, gtin14(ean(211))), t('P212', 'n', '0.00', true, gtin14(ean(212))),
  ],
  snoonu: [s(ean(213), 'n', 'True', 4.2), s(ean(214), 'n', 'True', '4.30'), s(ean(206), 'n', 'True', '10.10')],
};

// ───────────────── 4. rule order: offer > product > subcategory > category > per-marketplace > default ─────────────────
const rules: Dataset = {
  name: 'rules', slug: 'vrules', description: 'Price rule order, modes, rounding steps, offers (active, expired, future)',
  settings: { tolerance: '0', threshold: 0, staleHours: 12 },
  pricing: {
    defaultRule: { mode: 'percent', value: '10' }, rounding: 'exact',
    perMarketplace: { talabat: { mode: 'amount', value: '0.5', rounding: '0.25' } },
    categories: { Dairy: { rule: { mode: 'amount', value: '1' }, subcategories: { Milk: { mode: 'percent', value: '5' }, Cheese: null } }, Bakery: {} },
    assign: { [ean(301)]: ['Dairy', 'Milk'], [ean(302)]: ['Dairy', 'Cheese'], [ean(303)]: ['Bakery'], [ean(304)]: ['Dairy', 'Milk'],
      [ean(305)]: ['Dairy'], [ean(306)]: ['Dairy', 'Milk'], [ean(307)]: ['Dairy', 'Milk'], [ean(308)]: ['Dairy', 'Milk'] },
    productRules: { [ean(304)]: { mode: 'fixed', value: '7.77' }, [ean(309)]: { mode: 'same' }, [ean(310)]: { mode: 'amount', value: '-0.25' } },
    offers: {
      [ean(306)]: { price: '1.250', fromMs: -DAY, untilMs: DAY },
      [ean(307)]: { price: '1.250', fromMs: -3 * DAY, untilMs: -DAY },
      [ean(308)]: { price: '1.250', fromMs: DAY, untilMs: 3 * DAY },
      [ean(311)]: { price: '0.900', fromMs: null, untilMs: null },
    },
  },
  erp: [
    erp(ean(301), 'Milk sub rule', '5.500', 10), erp(ean(302), 'Cheese no sub rule', '5.500', 10),
    erp(ean(303), 'Bakery no rules', '5.500', 10), erp(ean(304), 'Product fixed', '5.500', 10),
    erp(ean(305), 'Dairy category only', '5.500', 10), erp(ean(306), 'Active offer', '5.500', 10),
    erp(ean(307), 'Expired offer', '5.500', 10), erp(ean(308), 'Future offer', '5.500', 10),
    erp(ean(309), 'Product same', '5.500', 10), erp(ean(310), 'Product amount -0.25', '5.500', 10),
    erp(ean(311), 'Open-ended offer', '5.500', 10), erp(ean(312), 'Half fils percent', '1.005', 10),
    erp(ean(313), 'Large percent', '12345.678', 10), erp(ean(314), 'Uncategorised', '3.333', 10),
  ],
  // Talabat lists every product at its ERP price, so every expected price is visible as a mismatch with its value.
  talabat: [301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314].map(n => t('R' + n, 'n', '5.50', true, gtin14(ean(n)))),
  snoonu: [301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314].map(n => s(ean(n), 'n', 'True', '5.50')),
};

// ───────────────── 5. names: Arabic, empty Arabic, very long, special characters, formula-like ─────────────────
const longName = 'Very long product name '.repeat(20).trim();
const names: Dataset = {
  name: 'names', slug: 'vnames', description: 'Arabic names, empty Arabic names, very long names, special characters, formula-like text',
  settings: { tolerance: '0', threshold: 0, staleHours: 12 },
  erp: [
    erp(ean(401), 'Fresh Milk 1L', '6.000', 10, { ar: 'حليب طازج ١ لتر' }),
    erp(ean(402), 'No Arabic', '6.000', 10, { ar: '' }),
    erp(ean(403), longName, '6.000', 10, { ar: 'اسم طويل '.repeat(30).trim() }),
    erp(ean(404), 'Café "Crème" & <Co> ½ 100% ‏', '6.000', 10),
    erp(ean(405), '=1+2', '6.000', 10),
    erp(ean(406), '@SUM(A1)', '6.000', 10),
    erp(ean(407), 'Arabic later', '6.000', 10),
  ],
  erp2: [
    erp(ean(401), 'Fresh Milk 1L', '6.000', 10, { ar: 'اسم مختلف من ERP' }),
    erp(ean(402), 'No Arabic', '6.000', 10, { ar: '' }),
    erp(ean(403), longName, '6.000', 10, { ar: 'اسم طويل '.repeat(30).trim() }),
    erp(ean(404), 'Café "Crème" & <Co> ½ 100% ‏', '6.000', 10),
    erp(ean(405), '=1+2', '6.000', 10),
    erp(ean(406), '@SUM(A1)', '6.000', 10),
    erp(ean(407), 'Arabic later', '6.000', 10, { ar: 'عربي لاحقا' }),
    erp(ean(408), 'Second file new product', '6.000', 10, { ar: 'منتج جديد' }),
  ],
  talabat: [
    t('N401', 'حليب', '6.50', true, gtin14(ean(401))), t('N403', longName, '6.00', true, gtin14(ean(403))),
    t('N404', 'Café "Crème" & <Co>', '6.50', true, gtin14(ean(404))), t('N405', '=1+2', '6.50', true, gtin14(ean(405))),
    t('N406', '+cmd|calc', '6.50', true, gtin14(ean(406)), { category: '-2+3' }), t('N408', 'New', '6.50', true, gtin14(ean(408))),
  ],
};

// ───────────────── 6. presence: ERP only, marketplace only, both, blocked, inactive, missing from ERP, new ─────────────────
const presence: Dataset = {
  name: 'presence', slug: 'vpresence', description: 'Products only in the ERP, only on a marketplace, in both, blocked, inactive, missing from the ERP file, new',
  settings: { tolerance: '0', threshold: 0, staleHours: 12 },
  erp: [
    erp(ean(501), 'In both, in sync', '3.000', 10), erp(ean(502), 'ERP only (not listed)', '3.000', 10),
    erp(ean(503), 'Blocked, listed with issues', '3.000', 0), erp(ean(504), 'Inactive, listed available', '3.000', 10),
    erp(ean(505), 'Inactive, listed unavailable', '3.000', 10), erp(ean(506), 'Dropped from second file, listed available', '3.000', 10),
    erp(ean(507), 'Dropped from second file, listed unavailable', '3.000', 10), erp(ean(508), 'In both, price differs', '3.000', 10),
    erp(ean(509), 'Inactive, not listed', '3.000', 10), erp(ean(510), 'ERP-inactive, not listed', '3.000', 10, { active: 'No' }),
    erp(ean(511), 'Blocked, not listed', '3.000', 10),
  ],
  erp2: [
    erp(ean(501), 'In both, in sync', '3.000', 10), erp(ean(502), 'ERP only (not listed)', '3.000', 10),
    erp(ean(503), 'Blocked, listed with issues', '3.000', 0), erp(ean(504), 'Inactive, listed available', '3.000', 10),
    erp(ean(505), 'Inactive, listed unavailable', '3.000', 10), erp(ean(508), 'In both, price differs', '3.000', 10),
    erp(ean(509), 'Inactive, not listed', '3.000', 10), erp(ean(510), 'ERP-inactive, not listed', '3.000', 10, { active: 'No' }),
    erp(ean(511), 'Blocked, not listed', '3.000', 10), erp(ean(512), 'New in second file, listed', '3.000', 10),
    erp(ean(513), 'New in second file, not listed', '3.000', 10),
  ],
  block: [ean(503), ean(511)],
  inactive: [ean(504), ean(505), ean(509)],
  talabat: [
    t('E501', 'n', '3.00', true, gtin14(ean(501))), t('E503', 'n', '9.00', true, gtin14(ean(503))),
    t('E504', 'n', '3.00', true, gtin14(ean(504))), t('E505', 'n', '3.00', false, gtin14(ean(505))),
    t('E506', 'n', '3.00', true, gtin14(ean(506))), t('E507', 'n', '3.00', false, gtin14(ean(507))),
    t('E508', 'n', '3.25', true, gtin14(ean(508))), t('E512', 'n', '3.00', true, gtin14(ean(512))),
    t('E600', 'Marketplace only', '3.00', true, '0000000077777'),
  ],
  snoonu: [s(ean(501), 'n', 'True', '3.00'), s(ean(503), 'n', 'True', '1.00'), s('0000000077776', 'Marketplace only', 'True', '3.00')],
};

// ───────────────── 7. stale marketplace files ─────────────────
const stale: Dataset = {
  name: 'stale', slug: 'vstale', description: 'Talabat file older than stale_hours, Snoonu file just inside it',
  settings: { tolerance: '0', threshold: 0, staleHours: 12 },
  erp: [erp(ean(701), 'Stale check', '2.000', 10), erp(ean(702), 'Stale check 2', '2.000', 10)],
  talabat: [t('A701', 'n', '2.00', true, gtin14(ean(701)))],
  snoonu: [s(ean(702), 'n', 'True', '2.00')],
  uploadAgeHours: { talabat: 13, snoonu: 11 },
};

// ───────────────── 8. formats: Talabat active column, Snoonu branch availability, boolean spellings ─────────────────
const formats: Dataset = {
  name: 'formats', slug: 'vformats', description: 'Talabat (active column, numeric and text prices) and Snoonu ("Availability for <branch>(Update)") formats',
  settings: { tolerance: '0', threshold: 0, staleHours: 12 },
  pricing: { defaultRule: { mode: 'amount', value: '0.5' } },
  erp: [
    erp(ean(801), 'Talabat true wrong price', '2.000', 10), erp(ean(802), 'Talabat false in stock', '2.000', 10),
    erp(ean(803), 'Talabat true out of stock', '2.000', 0), erp(ean(804), 'Talabat in sync', '2.000', 10),
    erp(ean(805), 'Snoonu TRUE uppercase', '2.000', 0), erp(ean(806), 'Snoonu false lower', '2.000', 10),
    erp(ean(807), 'Snoonu Yes', '2.000', 0), erp(ean(808), 'Snoonu in sync', '2.000', 10),
    erp(ean(809), 'Snoonu 3 decimals price', '2.000', 10), erp(ean(810), 'Snoonu numeric price', '2.000', 10),
  ],
  talabat: [
    t('F801', 'Talabat true wrong price', '2.00', true, gtin14(ean(801))), t('F802', 'Talabat false in stock', '2.50', false, gtin14(ean(802))),
    t('F803', 'Talabat true out of stock', '2.50', true, gtin14(ean(803))), t('F804', 'Talabat in sync', '2.50', true, gtin14(ean(804))),
  ],
  snoonu: [
    s(ean(805), 'Snoonu TRUE uppercase', 'TRUE', '2.50'), s(ean(806), 'Snoonu false lower', 'false', '2.50'),
    s(ean(807), 'Snoonu Yes', 'Yes', '2.50'), s(ean(808), 'Snoonu in sync', 'True', '2.50'),
    s(ean(809), 'Snoonu 3 decimals price', 'True', '2.000'), s(ean(810), 'Snoonu numeric price', 'True', 2),
  ],
};

// ───────────────── 9. tenant isolation twin: same barcodes, different values ─────────────────
export const ISOLATION_MARKER = 'ZZ-OTHER-TENANT';
const twin: Dataset = {
  ...presence, name: 'presence-twin', slug: 'vtwin', description: 'Second tenant with the same barcodes and different names/prices (isolation)',
  erp: presence.erp.map(r => [r[0], `${ISOLATION_MARKER} ${r[1]}`, r[2], '77.000', 999, r[5], r[6], r[7]] as ErpRow),
  erp2: presence.erp2!.map(r => [r[0], `${ISOLATION_MARKER} ${r[1]}`, r[2], '77.000', 999, r[5], r[6], r[7]] as ErpRow),
  talabat: presence.talabat!.map(r => ({ ...r, name: ISOLATION_MARKER, price: '1.11' })),
  snoonu: presence.snoonu!.map(r => ({ ...r, name: ISOLATION_MARKER, price: '1.11' })),
};

export const DATASETS: Dataset[] = [barcodes, stock, prices, rules, names, presence, stale, formats, twin];

// ───────────────── rejection datasets (ERP file only) ─────────────────
const goodRow = (i: number): ErpRow => erp(ean(9000 + i), `Row ${i}`, '1.000', 1);
const badRow = (i: number): ErpRow => erp(ean(9000 + i), `Row ${i}`, 'not a price', 1);
export const REJECTION_DATASETS: Dataset[] = [
  { name: 'invalid-21-percent', slug: 'vreject21', description: '100 rows, 21 invalid: more than 20%, must be rejected',
    settings: { tolerance: '0', threshold: 0, staleHours: 12 }, expectErpRejected: true,
    erp: Array.from({ length: 100 }, (_, i) => (i < 21 ? badRow(i) : goodRow(i))) },
  { name: 'invalid-20-percent', slug: 'vreject20', description: '100 rows, exactly 20 invalid: accepted, the invalid rows are skipped',
    settings: { tolerance: '0', threshold: 0, staleHours: 12 },
    erp: Array.from({ length: 100 }, (_, i) => (i < 20 ? badRow(i) : goodRow(i))) },
];

/** Synthetic large store: n products, every 7th price off on Talabat, every 11th out of stock, every 13th not listed. */
export function largeDataset(n: number): Dataset {
  const rows: ErpRow[] = []; const talabat: TalabatRow[] = [];
  for (let i = 0; i < n; i++) {
    const barcode = '7' + String(i).padStart(12, '0');
    rows.push(erp(barcode, `Large product ${i}`, ((i % 500) + 1).toFixed(3), i % 11 === 0 ? 0 : 20, { ar: i % 3 ? 'منتج' : null }));
    if (i % 13 !== 0) talabat.push(t('L' + i, `Large product ${i}`, (((i % 500) + 1) + (i % 7 === 0 ? 0.25 : 0)).toFixed(2), true, gtin14(barcode)));
  }
  return { name: `large-${n}`, slug: `vlarge${n}`, description: `${n.toLocaleString('en')} products, Talabat listing`,
    settings: { tolerance: '0', threshold: 0, staleHours: 12 }, erp: rows, talabat };
}

// ───────────────── file writers ─────────────────
function put(ws: ExcelJS.Worksheet, rowIndex: number, values: Cell[]) {
  const row = ws.getRow(rowIndex);
  values.forEach((v, i) => {
    const cell = row.getCell(i + 1);
    if (v !== null && typeof v === 'object' && 'date' in v) { cell.value = v.date; cell.numFmt = 'dd/mm/yyyy'; }
    else if (v !== null) cell.value = v;
  });
  row.commit();
}
export async function workbook(headers: readonly string[], rows: Cell[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  put(ws, 1, [...headers]);
  rows.forEach((r, i) => put(ws, i + 2, r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
export const erpFile = (rows: ErpRow[]) => workbook(ERP_HEADERS, rows);
export const talabatCells = (r: TalabatRow): Cell[] => [r.sku, r.name, r.price, r.active, null, false, null, null, null, r.barcode1, r.barcode2 ?? null, r.barcode3 ?? null, r.category ?? null];
export const talabatFile = (rows: TalabatRow[]) => workbook(TALABAT_HEADERS, rows.map(talabatCells));
export const snoonuCells = (r: SnoonuRow): Cell[] => [r.barcode, r.name, r.available, r.price];
export const snoonuFile = (rows: SnoonuRow[]) => workbook(SNOONU_HEADERS, rows.map(snoonuCells));
