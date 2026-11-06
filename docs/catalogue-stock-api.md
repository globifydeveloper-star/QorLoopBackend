# BACKEND contract: ERP change review and catalogue stock

All responses use the standard envelope: `{ data }` on success, `{ error: { code, message, details? }, requestId }` on failure. Authentication is the normal web session, and every `PUT`, `POST` and `DELETE` needs the `X-CSRF-Token` header. Decisions are in [ADR 017](decisions/017-erp-changes-catalogue-stock.md).

**Permissions:**

| Action | Permission | Roles |
| --- | --- | --- |
| Read the change list | `uploads.view` | all four roles |
| Read stock and conflicts | `products.view` | all four roles |
| Edit stock, resolve conflicts | `catalogue.stock_edit` | Owner, Admin, Catalogue Manager |

**Errors:**

- 404: the product or upload is unknown, or belongs to another store.
- 409: a stale `expected` value or `previewToken`, or an idempotency key reused with another body.
- 400: validation failed (`details[].path`).

## Shared shapes

```ts
type StockSource = 'erp' | 'owner';
type StockView = {
  erpStock: number;
  catalogueStock: number;        // what recon and generated files use: the owner value while an edit exists, else the ERP stock
  source: StockSource;
  conflict: null | { ownerStock: number; erpStock: number; erpStockAtEdit: number; inEffect: 'owner' | 'erp' }; // inEffect is 'owner' (D1)
};
type ProductStock = StockView & {
  productId: string;
  edit: null | {
    stock: number; erpStockAtEdit: number; state: 'active' | 'conflict'; reason: string | null;
    setBy: { id: string; name: string }; setAt: string; updatedAt: string;   // ISO UTC, millisecond precision
  };
};
type Applied = { operationId: string; replayed: boolean; appliedAt: string };  // operationId = the audit event id
```

## Change review

### GET /api/uploads/:id/changes

Query parameters:

| Parameter | Values | Default |
| --- | --- | --- |
| `kind` | `new \| price \| cost \| stock \| name \| active \| missing \| returned \| other \| all` | `all` |
| `conflict` | `true \| false` | none |
| `page` | 1 or more | 1 |
| `pageSize` | 1–200 | 50 |

- Applied ERP uploads only: a marketplace upload is 400, and an upload that isn't applied is 409 (its proposal is under `/review`).
- `kind=cost` is 400 for roles without `pricing.edit`. For those roles, cost rows are left out of the rows and `counts`.

```ts
type Response = { data: {
  upload: Upload;                       // as GET /api/uploads/:id
  changesRecorded: boolean;             // false: applied before ADR 017 (no rows exist)
  kind: string; conflictOnly: boolean; page: number; pageSize: number; total: number;
  counts: { all: number; new: number; price: number; cost?: number; stock: number; name: number; active: number;
            missing: number; returned: number; other: number; stockConflicts: number };
  rows: {
    productId: string; barcode: string;
    rowNumber: number | null;           // file row; null for missing
    kind: 'new' | 'price' | 'cost' | 'stock' | 'name' | 'active' | 'missing' | 'returned' | 'other';
    field: 'erpPrice' | 'costPrice' | 'erpStock' | 'nameEn' | 'erpActive' | 'inLatestErpFile' | 'sku' | 'brand' | 'erpCategory' | 'nameAr' | null; // null for new
    old: string | number | boolean | null; new: string | number | boolean | null;
    stockConflict: boolean;             // this stock change met an owner-edited catalogue stock
    product: { nameEn: string; nameAr: string | null; status: 'new' | 'active' | 'inactive' };
    fixedPriceRule: boolean | null;     // price rows: true = the product's fixed price rule still applies (D6)
    catalogueStock: StockView | null;   // stock rows: the catalogue stock now
  }[];                                  // file order; missing products last
} };
```

The review summary of an ERP upload (`GET /api/uploads/:id`, `summary`) also has:

- `nameChanges`, `costChanges` (only when the cost column is mapped) and `stockConflicts` (predicted);
- `priceChanges`, now compared at 3 decimals;
- after apply, `applied: { changesRecorded, changes, stockConflicts, stockEditsCleared }`.

Staged review rows carry `parsed.change.stockConflict: true` when a conflict is predicted.

## Stock conflicts

### GET /api/catalogue/stock/conflicts?page&pageSize

```ts
type Response = { data: {
  inEffect: 'owner' | 'erp'; page: number; pageSize: number; total: number;
  rows: { productId: string; barcode: string; nameEn: string; nameAr: string | null; status: string;
          erpStock: number; ownerStock: number; erpStockAtEdit: number; catalogueStock: number;
          reason: string | null; setBy: { id: string; name: string }; setAt: string;
          conflictUploadId: string; conflictAt: string; updatedAt: string }[];   // newest conflict first
} };
```

### GET /api/catalogue/stock/conflicts/count

Returns `{ data: { count: number } }`, the dashboard badge "N stock conflicts". The same number is `stockConflicts` in `GET /api/recon/summary`.

## One product

### GET /api/products/:id/stock

Returns `{ data: ProductStock }`.

### PUT /api/products/:id/stock

Body: `{ stock: int 0..2147483647, reason?: string (max 500), expected: { erpStock, catalogueStock } }`.

- `expected` is the stock as last shown: 409 when either value moved.
- Setting the ERP's own value removes the edit, so the catalogue follows the ERP again.
- On an open conflict, setting the owner's own value is "keep mine".
- Returns `{ data: ProductStock & { changed: boolean } }`. `changed: false` means it already had this value; nothing is written.

### DELETE /api/products/:id/stock?expectedErpStock&expectedCatalogueStock

Goes back to the ERP stock. Returns `{ data: ProductStock & { changed: boolean } }`.

### POST /api/products/:id/stock/resolve

Body: `{ choice: 'erp' | 'keep', expected: { erpStock, ownerStock } }`.

- `erp` removes the edit; `keep` keeps the owner value and re-bases it on the current ERP stock.
- 409 when there is no open conflict, or when either value moved.
- Returns `{ data: ProductStock }`.

The product list and detail (`GET /api/products`, `GET /api/products/:id`) also have `catalogueStock`, `catalogueStockSource` and `stockConflict`.

## Bulk

### POST /api/catalogue/stock/bulk/preview and /apply

```ts
type Body = {
  selection: { productIds: string[] /* 1-500 */ } | { filter: { q?: string; categoryId?: string; subcategoryId?: string } }; // filter: any status, at most 5,000
  action: { mode: 'set'; stock: number } | { mode: 'erp' };
  reason?: string;
  // apply only:
  idempotencyKey: string;   // 8-100 of [A-Za-z0-9_-]
  previewToken?: string;    // from the preview; 409 when the re-planned writes differ
};
type Counts = { selected: number; willChange: number; unchanged: number; notFound: number; sets: number; clears: number };
type Preview = { data: Counts & { selection: object; action: object; reason: string | null; limit: 5000; previewToken: string;
  rows: { productId: string; nameEn: string; barcode: string; status: string; erpStock: number; op: 'set' | 'clear';
          old: { stock: number; source: StockSource; state: 'active' | 'conflict' | null }; new: { stock: number; source: StockSource } }[] } }; // first 10
type Apply = { data: Applied & Counts };
```

- A selection over 5,000 products is 400.
- The same key and body returns the first result with `replayed: true`. The same key with another body is 409.

### POST /api/catalogue/stock/conflicts/resolve/preview and /apply

```ts
type Body = {
  selection: { productIds: string[] /* 1-500 */ } | { all: true };  // all: every open conflict, at most 5,000
  choice: 'erp' | 'keep';
  idempotencyKey: string; previewToken?: string;  // apply only
};
type Counts = { selected: number; willResolve: number; notInConflict: number; notFound: number };
type Preview = { data: Counts & { selection: object; choice: string; limit: 5000; previewToken: string;
  rows: { productId: string; nameEn: string; barcode: string; choice: string; ownerStock: number; erpStock: number;
          erpStockAtEdit: number; catalogueStockAfter: number }[] } };
type Apply = { data: Applied & Counts };
```

## Recon

`GET /api/recon/rows` items also have:

- `catalogueStock`, `catalogueStockSource` and `stockConflict`, next to `erpStock`;
- `catalogueAvailable`, next to `erpAvailable`;
- `stockIssueVsCatalogue` and `stockIssueVsErp`.

`stockIssue`, the `type=stock` filter and the urgency order now follow the requested reference. `GET /api/recon/summary` also has `stockConflicts`, and its `stock` count follows the reference.

## Read-only checks (PowerShell 5.1)

`scripts/dev/catalogue-stock-check.ps1` signs in at hidden local prompts and never prints credentials, cookies or tokens. Apart from signing in and out, it sends GET requests only. It needs the migration applied.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev/catalogue-stock-check.ps1
powershell -ExecutionPolicy Bypass -File scripts/dev/catalogue-stock-check.ps1 -Marketplace snoonu
```

It prints:

- the latest applied ERP upload's change counts and its first 10 change rows;
- the review summary counts;
- the open conflicts with both values;
- the first stock issues on the marketplace, with ERP stock and catalogue stock side by side.

It fails if `recon/summary.stockConflicts` disagrees with the conflict count, and ends with `PASS: catalogue stock endpoints answered (read-only).`. Before the migration, the first new endpoint answers 500 and the script stops there.
