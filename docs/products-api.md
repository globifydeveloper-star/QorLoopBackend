# BACKEND contract: catalogue product list with marketplace values

All responses use the standard envelope: `{ data }` on success, `{ error: { code, message, details? }, requestId }` on
failure. Authentication is the normal web session. Permission `products.view` (all four roles); nothing else changes.

## `GET /api/products`

Query (strict, unknown keys give a 400):

| Parameter | Type | Notes |
| --- | --- | --- |
| `q` | string, at most 200 | English name (contains), barcode (normalised, prefix) or SKU (exact) |
| `tab` | `all` \| `active` \| `inactive` \| `new` \| `missing` | default `all` |
| `categoryId`, `subcategoryId` | uuid | |
| `limit` | 1..200 | default 50 |
| `cursor` | string | `nextCursor` of the previous page |
| `marketplaceId` | `talabat` \| `snoonu` \| `rafeeq` \| `keeta` | **new.** Must be enabled for the store, else 400 `details: [{ path: 'marketplaceId', message: '<Name> is not enabled for this store' }]` |
| `marketplaceStatus` | `mismatch` \| `in_sync` \| `not_in_file` | **new.** Only with `marketplaceId`, else 400 `details[].path = 'marketplaceStatus'` |
| `compareMarketplaceId` | `talabat` \| `snoonu` \| `rafeeq` \| `keeta` | **new.** A second marketplace next to `marketplaceId`: adds `compareMarketplace`. Only with `marketplaceId` and another marketplace, and it must be enabled; else 400 `details[].path = 'compareMarketplaceId'` |
| `marketplacesDiffer` | `any` \| `price` \| `availability` | **new.** Only with `compareMarketplaceId`, else 400. See "Two marketplaces side by side" |

"Enabled" is the rule the recon uses: a switch row in Settings decides; without one, an applied upload of that
marketplace enables it.

Ordering (English name, then id), keyset paging, tab counts, cost visibility and `marketplacePrice` (with
`pricing.view`) are unchanged. `marketplaceStatus` narrows the items **and the tab counts**, like the search and
category filters.

```ts
data = {
  items: Array<Product & { marketplace?: MarketplaceValues }>,   // marketplace only when marketplaceId is given
  nextCursor: string | null,
  counts: { all: number, active: number, inactive: number, new: number, missing: number },
}

type MarketplaceValues = {
  marketplaceId: 'talabat' | 'snoonu' | 'rafeeq' | 'keeta',
  reference: 'marketplace' | 'erp',      // the comparison used (the store's default, as in the recon reports)
  available: boolean | null,             // in the marketplace file; null when not in the file
  price: string | null,                  // QAR with 3 decimals, e.g. "12.500"; null when not in the file
  inFile: boolean,
  comparison: 'in_sync' | 'mismatch' | 'not_in_file' | 'not_applicable',
  stockIssue: 'available_but_out_of_stock' | 'unavailable_but_in_stock' | null,
  priceIssue: 'marketplace_price_higher' | 'marketplace_price_lower' | null,
  sourceUploadedAt: string | null,       // ISO time the marketplace file was uploaded; null when not in the file,
                                         // or for a listing saved before upload ids were recorded
}
```

**Where the values come from.**

- The file values come from the product's listing on that marketplace. With several marketplace product IDs on one
  product, the one written last wins, as in the recon: newest `updated_at`, then `marketplace_product_id`.
- `sourceUploadedAt` is the creation time of that listing's upload.
- `comparison`, `stockIssue` and `priceIssue` come from the stored recon row, using the reference's columns.
  `priceIssue` is the reference's price flag (beyond the price tolerance) with its direction.

**`comparison`:**

| Value | When |
| --- | --- |
| `not_applicable` | the marketplace has no applied upload yet |
| `not_in_file` | the product has no listing on that marketplace |
| `in_sync` / `mismatch` | the recon status of the reference |
| `mismatch` | also `missing_from_erp` while still listed as available (a stock issue) |
| `not_applicable` | a new product; `missing_from_erp` without an issue; a listing not recomputed yet |

The issues are null whenever `comparison` is `not_in_file` or `not_applicable`.

**`marketplaceStatus`** selects exactly the products whose `comparison` has that value. A marketplace without an
applied upload matches nothing.

**Two marketplaces side by side.** With `compareMarketplaceId`, each item also has `compareMarketplace`: the same
object as `marketplace`, for the second marketplace (its own file values and comparison against the catalogue).
`marketplacesDiffer` then keeps only the products where the two marketplaces' winning listings (the comparison's pick:
newest, then marketplace product id) differ, compared with each other, not with the catalogue:

| Value | A product is kept when |
| --- | --- |
| `price` | the two prices differ (exact, in fils), or it is listed on only one of them |
| `availability` | the two availabilities differ, or it is listed on only one of them |
| `any` | either |

Products listed on neither are left out, and so is everything when either marketplace has no applied upload. Like
`marketplaceStatus` (which still applies to `marketplaceId` only), it narrows the items **and the tab counts**, and
pages with the usual cursor. The differing ids come from one statement (`differingIdsSql`: a `DISTINCT ON` winner per
matched product on each side, full-joined); the page's values for the second marketplace are one more statement.

```
GET /api/products?marketplaceId=talabat&compareMarketplaceId=snoonu&marketplacesDiffer=price
```

**Freshness.** The file values are live. The comparison is from the last recompute, so right after an upload it can lag
by one recompute (open gap G37).

**Later additions.** `marketplace` is an object: further fields (for example the planned export value, ADR 018
proposal) will be added beside these without changing them. Clients must ignore unknown fields.

Example:

```json
GET /api/products?marketplaceId=talabat&marketplaceStatus=mismatch&limit=1
{ "data": {
  "items": [{ "id": "…", "barcode": "6281000000028", "nameEn": "Juice", "…": "…",
    "marketplace": { "marketplaceId": "talabat", "reference": "marketplace", "available": true, "price": "4.000",
      "inFile": true, "comparison": "mismatch", "stockIssue": "available_but_out_of_stock",
      "priceIssue": "marketplace_price_lower", "sourceUploadedAt": "2026-11-08T10:00:00.000Z" } }],
  "nextCursor": "…",
  "counts": { "all": 2, "active": 2, "inactive": 0, "new": 0, "missing": 0 } } }
```

**Performance.**

- The filter is two indexed `EXISTS` conditions: listings `(tenant_id, marketplace_id, product_id)` and recon_rows
  `(tenant_id, product_id, marketplace_id)`.
- The page's values come from one statement for all of the page's IDs (lateral listing winner, uploads primary key,
  recon_rows unique key), never one per row.
- Timings at 25,000 products: `products.performance.test.ts`, real PostgreSQL only.

Read-only check: `scripts/dev/catalogue-marketplace-check.ps1`.
