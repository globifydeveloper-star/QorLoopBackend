# Adopting marketplace prices (P2)

Date: 2026-11-02

## Context

Real data: marketplace prices differ from ERP prices for ~97% of matched products, with no single markup (~+43% under
2 QAR down to ~+17% over 100 QAR, rounded to 0.25), and Talabat and Snoonu agree for 98.2% of products. Without a way to
adopt today's prices, the reconciliation shows ~13,000 price mismatches on day one.

## Decisions

- **Two endpoints, one body.** `POST /api/pricing/adopt/preview` and `/apply` (pricing.edit, CSRF like every POST, strict
  Zod `adoptPrices`): `sourceMarketplaceId`, `mode` fixed | percent (default fixed), `onlyWithoutRule` (default true),
  `scope` `{all: true}` | `{categoryId, subcategoryId?}` (a top-level category of this store and one of its own subcategories).
- **The recon's own inputs.** The plan reads `ReconRepository.products()` and `.listings()` (one latest listing per product
  and marketplace, the same `DISTINCT ON` the recon uses), the pricing snapshot and the recon tolerance, so the adopted price
  is exactly what the recon compares against. The planning is a pure function, `packages/core/src/price-adoption.ts`.
- **Rules.** fixed: value = listing price. percent: value = (listing - erp) x 100 / erp in integer fils, rounded to 3
  decimals. Every rule is verified with `resolveMarketplacePrice` for the source marketplace: the resolved price must equal
  the listing price in fils (no tolerance). A percent rule that misses because of the tenant rounding step, or that falls
  outside the product-rule contract's -90..1000 %, becomes fixed and is counted (`fallbacks.rounding`, `fallbacks.range`).
- **Skips, in this order:** `no_listing`, `non_positive_erp_price`, `non_positive_listing_price`, `has_rule` and
  `has_offer` (only with onlyWithoutRule; any offer row, even expired), `offer_active` (a valid offer outranks the product
  rule, so no rule could set the price; offers are never changed), `unchanged` (the product already has this exact rule),
  `unverifiable` (the engine disagrees even with fixed; not reachable with the current rule order).
- **Conflicts** are adopted products listed on another marketplace at a price further than the recon tolerance from the
  adopted one: those rows will show as mismatches there. Counted per product and per marketplace, with 20 examples.
- **Apply is one transaction under the tenant row lock**, planned inside it. Rules are written with
  `INSERT ... SELECT FROM unnest(...) ON CONFLICT DO UPDATE`, 5,000 per statement, 4 bind parameters each, millisecond
  timestamps. Audit: one `pricing.prices_adopted` summary event, plus `product.price_rule_set` (with `via: 'pricing.adopt'`)
  only for products whose different own rule was replaced. One recon recompute (`pricing.adopt`) is queued after commit.
- **A run that adopts nothing writes nothing**: no summary event and no recompute, like every other unchanged pricing edit.
  A second identical run adopts 0 (every product now has its rule, or has the same rule).
- **Transaction limit 60 s** for apply (requests keep 20 s): 23,000 rule writes took 3-4 s on a laptop PostgreSQL 18.
- Every product in scope counts, whatever its status (a new or inactive product's rule is harmless and ready when it is
  activated). A product already in sync still gets its rule: adoption pins today's price.

## Measurements (25,000 products, 23,000 adopted, local PostgreSQL 18 on a laptop, through the API under jest)

| Call | Time |
|---|---|
| Preview (median of 3) | 1.0-1.7 s |
| Apply (first) | 3.3-5.7 s |
| Apply again (adopts 0) | 0.7-1.0 s |

Loading the inputs is ~0.9 s. Under jest's VM the planner itself takes ~0.9 s; the same code compiled and run on plain
Node takes ~0.17 s for 25,000 products.
