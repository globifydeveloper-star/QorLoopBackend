# Offers (promotions): how an active offer flows today, and what must change

Date: 11 November 2026, branch `feature/marketplace-export-values` after Step 3. **Report only: nothing about offers is built or changed here.** It is meant to plan the Offers work.

The client runs promotions: a promo price with a start and an end date, an automatic return to the normal price, and before/after price columns in the marketplace sheets.

## 1. Today, step by step

**Storage and API.** `product_offers` has `price`, `valid_from` and `valid_until`; either date is optional.

- `PUT /api/pricing/products/:id/offer` replaces the product's offer. One offer per product; an offer that has already ended is refused. It queues a recompute (`'product.offer'`).
- An offer is **per product, for every marketplace**. There is no per-marketplace offer.
- While an offer decides the price, a product rule edit is refused ("A current offer sets this price").

**Price resolution** (`packages/core/src/pricing.ts`, `resolveMarketplacePrice`).

- The offer is step 1 of the rule chain: a valid offer beats the product rule, the category rules, the per-marketplace rule and the default.
- Valid means `validFrom <= now <= validUntil`, inclusive, either end optional. With several valid offers, the one that started last wins.
- The price is the offer price exactly, with no rounding step, and the source is `offer`.

**Comparison** (`packages/core/src/recon/status.ts`), against the price the recompute resolved at its own `now`:

| Value | Meaning |
| --- | --- |
| `marketplace_price` (stored) | the resolved price: the **offer price** while the offer was valid at the last recompute, with `marketplace_price_source = 'offer'` |
| `price_mismatch_vs_marketplace` | the listing against that price |
| `price_mismatch_vs_erp` | the listing against **`products.erp_price`**: the ERP's normal price |

**Review** (`GET /api/marketplace-values/review`): `rulePrice` and `catalogue.price` are the stored `marketplace_price`, `catalogue.priceSource` is `offer` during an offer, and `to_fix` follows `price_mismatch_vs_marketplace`.

**Generated files:**

| File | Price written |
| --- | --- |
| Marketplace reference | stored `marketplace_price` (the offer price during an offer) |
| ERP reference | stored `erp_price` (the normal price) |
| Either, with an export value in effect (Step 3) | the export value, which outranks the offer (decided earlier) |

Unmapped columns are copied unchanged from the source marketplace file.

**Marketplace files.** The mapping has **one** price field (`price`, plus `available`). A second promo, before or after column is not mapped, not stored in `listings` and not compared. In the generated file it keeps whatever the source file had.

## 2. What goes wrong during a promotion today

1. **No recompute at the start or end of an offer.** Recomputes run only on triggers: uploads, edits, settings. The `'sweep'` reason exists but nothing queues it.
   - An offer set in advance is `scheduled` at that recompute, so the stored expected price stays normal when the offer starts.
   - After it ends, the stored price stays the offer price until some other change triggers a recompute.
   - Review, the dashboard and **the generated file** keep the old price in both cases. There is **no automatic return to normal**.
2. **The ERP reference raises false mismatches.** During the offer the listing shows the promo price, but the ERP reference compares it with the ERP's normal price. Every promoted product is a price mismatch (`price_mismatch_vs_erp`, `status_vs_erp`, the ERP summary), and an ERP-reference price file would write the normal price over the promo.
3. **Before/after columns.** If the marketplace sheet keeps the normal price in its `price` column and the promo price in another column, then:
   - Qorloop compares the normal price with the offer price, a false mismatch against the catalogue;
   - the file writes the offer price into the normal-price column;
   - the promo column is left as it was.

   If `price` is mapped to the promo column instead, the normal price is never checked, and the end of the promo is invisible.
4. **No per-marketplace promotions.** An offer applies to every enabled marketplace.

## 3. What must change so the offer price is the expected price, and the ERP price never raises a false mismatch

| # | Change | Schema | Notes |
| --- | --- | --- | --- |
| O1 | **Recompute at offer boundaries.** Queue a recompute at each `valid_from` and just after each `valid_until`, through delayed BullMQ jobs per tenant (their own job ids; the per-tenant deduplication must not swallow them), or through a periodic `'sweep'` that recomputes tenants whose offers started or ended since `computed_at`. | no | Fixes the expected price, Review, the dashboard and the files at both ends. The `exportToken` then changes too, so a file made just before the boundary cannot be stored after it. |
| O2 | **ERP reference during an offer.** Compare the listing with the offer price while an offer is valid, instead of the ERP price, and write the offer price in ERP-reference files during the offer. `erp_price` stays stored and shown. | no | A rule change in `reconcile` (target = offer price when the resolved source is `offer`) and in `fileValues`. It needs an owner decision, because it changes what "ERP reference" means during a promotion. |
| O3 | **Promo columns in marketplace files.** New mapping fields (for example `originalPrice` / `promoPrice`, and promo start/end where the sheet has them). Store them on `listings`; compare the promo column with the offer price and the normal column with the normal rule price; write both in generated files, plus dates where supported. | **yes** (new listing columns) | Needs real Talabat and Snoonu promo sheets (G4) and a migration approval. |
| O4 | **Per-marketplace offers**, if promotions differ per marketplace. | **yes** (`marketplace_id` on offers) | Owner decision. |
| O5 | **Export values versus offers.** Today a pending export price outranks an active offer, and a fix-once value clears only on a matching upload. With O1, a value set before a promo keeps winning during it. Decide whether an offer start should warn on, or clear, pending price values. | no | Owner decision. |
| O6 | **Time zone.** Offer dates are instants (ISO with an offset). The UI must send Qatar-time boundaries (+03:00). `valid_until` is inclusive. | no | Documented in the Offers API. |

Minimum for "offer price is the expected price, and no false ERP mismatch": **O1 and O2**, with no schema change. Before/after sheet columns need **O3** (schema and real sample files).
