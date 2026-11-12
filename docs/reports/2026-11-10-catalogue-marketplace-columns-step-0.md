# Catalogue product list: marketplace columns. Step 0 inspection and plan

Date: 10 November 2026. Baseline `main` at `18f8740`. Branch `feature/catalogue-marketplace-columns`.
**No schema change or migration is needed.** Documentation only in this step.

## Findings

- **List endpoint.** `GET /api/products` (`apps/api/src/products/products.controller.ts`, `products.service.ts::list`).
  - Permission `products.view`.
  - Strict Zod query `productListQuery` (`q`, `tab`, `categoryId`, `subcategoryId`, `limit` 1..200 default 50,
    `cursor`).
  - Keyset paging on `(name_en, id)`, never an OFFSET. Tab counts come from one grouped query over the same search
    and category filter.
  - Per page, a fixed number of extra reads, never one per row: stock edits, and pricing inputs when the role has
    `pricing.view`.
- **Repository.** `packages/db/src/products.ts::ProductRepository`. Every query adds `tenant_id`. `where(f)` is shared
  by `list` and `counts`. `pricingWhere` already filters by `listings: { some/none: { marketplaceId } }` and
  `reconRows: { some: ... }` (bulk price change), so these relation filters are already used in production.
- **Listings.** `listings` is unique on `(tenant_id, marketplace_id, marketplace_product_id)`, indexed on
  `(tenant_id, marketplace_id, product_id)`. Its `upload_id` is nullable with no foreign key, and is set on every
  upsert. Several listing IDs can match one product. Recon uses the winner
  `DISTINCT ON (marketplace_id, product_id) ORDER BY updated_at DESC, marketplace_product_id`
  (`packages/db/src/recon.ts::listings`); the generated-file reads use the same rule.
- **Recon rows.** `recon_rows` is unique on `(tenant_id, product_id, marketplace_id)`, with indexes
  `(tenant_id, marketplace_id, status)` and `(tenant_id, marketplace_id, status_vs_erp)`. It stores
  `actual_price`/`actual_available` (the listing values at recompute), `status`/`status_vs_erp`,
  `stock_issue`/`stock_issue_vs_erp`, `price_mismatch_vs_marketplace`/`_vs_erp`, and
  `marketplace_price`/`erp_price`.
  - `recon.ts::rows` joins `recon_rows` to `products` and `catalogue_stock_edits`.
  - The reference is the request's, else the pricing setting `compareReferenceDefault` (`recon.service.ts::referenceFor`).
- **Statuses.** Recon statuses are `in_sync | mismatch | not_listed | missing_from_erp | new | no_data`. Stock issue
  labels are `available_but_out_of_stock | unavailable_but_in_stock`. There is **no price issue label** today, only
  the boolean `priceMismatch`.
- **Enabled marketplaces.** `pricing.data.ts::enabledMarketplaceIds` (core `enabledMarketplaces`): an explicit
  `tenant_marketplaces` row decides; with no row, an applied upload enables it. Bulk pricing and inline pricing reject
  a disabled marketplace with 400 `details[{ path: 'marketplaceId' }]`.
- **CI.** `.github/workflows/ci.yml` runs on `push` to `main` and on `pull_request` to `main` only. **Pushing a feature
  branch does not start GitHub Actions**; a pull request (or a trigger change) is needed. The real-PostgreSQL
  performance suites are skipped in CI (`TEST_DATABASE_URL` unset); CI runs PGlite only.

## Plan

**Query.** Optional `marketplaceId` (one of the four marketplaces; must be enabled for the store, else 400) and
`marketplaceStatus=mismatch|in_sync|not_in_file`. `marketplaceStatus` without `marketplaceId` gives a 400.

**Response.** Without `marketplaceId` the response is unchanged. With it, every item gets:

```ts
marketplace: {
  marketplaceId: 'talabat'|'snoonu'|'rafeeq'|'keeta',
  reference: 'marketplace'|'erp',     // which comparison the status and issues use (tenant default)
  available: boolean|null,            // the winning listing; null when not in the file
  price: string|null,                 // listing price, 3 decimals, e.g. "12.500"; null when not in the file
  inFile: boolean,
  comparison: 'in_sync'|'mismatch'|'not_in_file'|'not_applicable',
  stockIssue: 'available_but_out_of_stock'|'unavailable_but_in_stock'|null,
  priceIssue: 'marketplace_price_higher'|'marketplace_price_lower'|null,
  sourceUploadedAt: string|null       // uploads.created_at of the listing's upload_id; null for a legacy listing
}
```

`reference` is an addition to the requested shape, so the UI knows which comparison the status and issues used.

**Comparison** (pure, `packages/core/src/products/marketplace-view.ts`):

1. No applied upload for the marketplace: `not_applicable`.
2. Not in the file (no listing): `not_in_file`.
3. In the file but no recon row yet (recompute pending): `not_applicable`.
4. Recon `in_sync`: `in_sync`. Recon `mismatch`: `mismatch`.
5. `missing_from_erp` with a stock issue (still listed and available): `mismatch`.
6. Anything else (`new`, `not_listed` or `missing_from_erp` without an issue): `not_applicable`.

Issues are shown only when the product is in the file and has a recon row. `priceIssue` uses the reference's price
flag; the direction compares the stored actual price with the reference's expected price.

**Filter.** It mirrors the pure rule in SQL through Prisma relation filters inside `ProductRepository.where()`, so the
list and the tab counts both apply it. Keyset paging and order are unchanged.

| `marketplaceStatus` | Products selected |
| --- | --- |
| `in_sync` | a listing on the marketplace AND recon status `in_sync` |
| `mismatch` | a listing AND (status `mismatch` OR (`missing_from_erp` AND stock issue not null)) |
| `not_in_file` | no listing on the marketplace |

The columns are those of the reference. A marketplace with no applied upload matches nothing.

**Values for the page.** One raw query for the page's product IDs: `unnest(ids)`, then `LEFT JOIN LATERAL` the
winning listing (same order as recon), then `LEFT JOIN uploads`, then `LEFT JOIN recon_rows`. Every join is
tenant-scoped, and the indexes used are listings `(tenant, marketplace, product)`, the uploads primary key and the
recon_rows unique key. That is one extra statement per request, not one per row.

**Freshness.** File facts (inFile, available, price, sourceUploadedAt) come from the live listing; comparison and
issues come from the stored recon row. Just after an upload, before the recompute has run, they can lag by one
recompute, as `GET /api/recon/rows` already does with catalogue stock.

**Extensibility.** `marketplace` is an object. The export-value work (`feature/marketplace-export-values`, ADR 018
proposal) can add an `export` sub-object later without changing these fields. Nothing depends on that branch.

**Tests.**

- Pure: the comparison table, the price issue direction, and nulls when not in the file.
- PGlite integration:
  - responses with and without `marketplaceId`, with the exact keys;
  - each filter, and the filter without `marketplaceId`;
  - products not in the file; a legacy listing with null `upload_id`; duplicate listings (the winner);
  - the ERP reference default;
  - a disabled marketplace and a marketplace with no upload;
  - tenant isolation; pagination across pages with the filter; tab counts with the filter; analyst read;
  - an index-usable plan of the page query (seq scan off).
- An end-to-end check on the real recon pipeline fixture.
- The real-PostgreSQL 25,000-product timing and EXPLAIN go in `products.performance.test.ts`; that suite is skipped
  in CI.

**Docs.** `docs/products-api.md` (new) and `docs/open-gaps.md`, plus `scripts/dev/catalogue-marketplace-check.ps1`
(read-only).
