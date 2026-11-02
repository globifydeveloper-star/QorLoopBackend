# Bulk price changes and inline price edit (P2)

Date: 2026-11-02

## Context

After adopting marketplace prices (ADR 010), the catalogue manager still needs to change prices by hand: one product
from a list row (inline), or many at once ("+5 % on Dairy", "match Talabat for every price mismatch"). Both must use
the existing pricing engine and storage, be audited, and trigger the reconciliation like every other pricing edit.

## Decisions

### Storage: the product's own rule, which applies on every marketplace

- Both features write `product_price_rules` (one row per product, no marketplace column). In the rule order
  (`offer > product > subcategory > category > marketplace > default`) the product rule outranks the per-marketplace
  rule, so **a product rule sets the price on every marketplace**. The marketplace named in a request is the one that
  is validated (enabled for the store), priced (its chain, including the per-marketplace step), compared and, for
  `match_marketplace`, matched. Answers show the effect on the other enabled marketplaces (`marketplaces` inline,
  `otherMarketplaces` in bulk).
- A real per-marketplace product price would need a new step in the rule order (open question Q9) reading the unused
  `marketplace_price_rules.product_id`; no migration, but an engine, recon and generated-files change. Not built: open
  gap G13.

### Inline edit

- `PUT /api/pricing/products/:id` (`pricing.edit`), body `{marketplaceId, mode: fixed|percent, value, expectedRuleUpdatedAt?}`.
  fixed: 0 < value <= 100,000 QAR, 3 decimals. percent (over the ERP price, rounded by the tenant step): -90..1000.
- `DELETE /api/pricing/products/:id?marketplaceId=&expectedRuleUpdatedAt=`: removes the product rule; with no rule it
  answers `changed: false` (a repeated click is not an error, unlike `DELETE /api/products/:id/price-rule`).
- Refused: product not found or another store's (404); product not `active` (400); marketplace not enabled (400); a
  valid offer decides the price now, so the rule would not show (400, `path: offer`); resolved price <= 0, or above
  100,000 for a set (400).
- Optimistic concurrency on the rule version: `expectedRuleUpdatedAt` = `rule.updatedAt` last seen (`null` = "I saw no
  rule", omitted = no check, like `expectedUpdatedAt` on products); a different current rule is 409. Writes run under
  the tenant row lock (`Database.run`), so the check and the write cannot interleave.
- Audit `product.price_rule_set` / `product.price_rule_deleted` with `via: 'pricing.inline'`, the marketplace and the
  old and new price; one recon recompute (`product.price_rule`) after commit when the rule changed.
- The existing `PUT/DELETE /api/products/:id/price-rule` are unchanged (no marketplace, any status, any mode).

### Bulk change

- `POST /api/pricing/bulk/preview` and `/apply` (`pricing.bulk`, which Owner, Admin and Catalogue Manager already
  hold; no new permission or role). Strict Zod `bulkPricePreview` / `bulkPriceApply`.
- **Selection**: `{productIds}` (at most 500: the API's 32 KB body limit; unknown and other-store ids count as blocked
  `not_found`, inactive ones as `not_active`), or `{filter}` over **active** products: `q` (the product list's search),
  `categoryId`, `subcategoryId`, `listed` (on the operation's marketplace or not), `reconStatus` (`price_mismatch` or a
  recon status of the stored row on that marketplace) with `reference` (default: the tenant's comparison reference).
  The recon filter reads the stored rows, i.e. as of the last recompute.
- **Limit: 5,000 selected products per change** (`BULK_PRICE_LIMIT`); more is 400 in preview and apply, with the count.
- **Actions**: `set_fixed {price}`; `increase_percent|decrease_percent {percent, rounding}` (0 < percent <= 1000, or
  <= 90 for a decrease); `increase_amount|decrease_amount {amount, rounding}` (0 < amount <= 100,000);
  `match_marketplace` (ADR 010's planner, fixed mode, replacing rules: the same skips and engine verification);
  `match_erp` (remove the product rule).
- **Relative changes start from the resolved price on the operation's marketplace and are stored as a fixed rule**:
  the computed price is final. `rounding` none | 0.05 | 0.25: `price x (100000 +/- percent x 1000) / 100000` in
  integer fils, BigInt, rounded **once** to the step, halves up; `none` keeps whole fils (0.001 QAR).
- **`match_erp` removes the rule, as specified**: the price then follows the category, per-marketplace and default rules.
  It equals the raw ERP price only when that chain is `same`; the preview shows the real new price. A `same` product rule
  would pin the ERP price exactly; say if that is wanted instead.
- **Outcome per product** (pure, `packages/core/src/price-change.ts`): blocked (`not_found`, `not_active`,
  `offer_active`, adoption's `no_listing` / `non_positive_listing_price` / `non_positive_erp_price` / `unverifiable`,
  `price_not_positive`, `price_too_high`), unchanged (already this exact rule; `match_erp` without a rule; a relative
  change the rounding cancels), or a change. `selected = willChange + unchanged + blocked`.
- **Preview writes nothing.** It returns the counts, `blockedReasons` with plain messages, `otherMarketplaces`, the
  largest increase and decrease, the first 10 changes in list order (product, marketplace, old resolved price, new price,
  old and new rule) and `previewToken` = sha256 of the planned writes.
- **Apply never trusts the preview**: one transaction under the tenant row lock (60 s limit) that
  1. looks up the idempotency key; the same key and request answers the stored result with `replayed: true` and writes
     nothing; the same key with another request is 409;
  2. re-plans from current data; a given `previewToken` that differs from the re-planned writes is 409;
  3. writes set-based: `INSERT ... SELECT FROM unnest(...) ON CONFLICT DO UPDATE` (5,000 per statement, existing
     `upsertProductRules`) and one `DELETE ... product_id = ANY($uuid[])`;
  4. records ONE `pricing.bulk_applied` audit event holding the key, the request hash, the token, the operation, the
     result and every change as compact rows (`changeColumns`: productId, oldMode, oldValue, newMode, newValue,
     oldPrice, newPrice). That is enough to revert one operation exactly. No per-product events.
  After commit, one coalesced recon recompute (new reason `pricing.bulk`) when anything changed. An apply that changes
  nothing still writes its event, so its key is remembered, but queues no recompute.
- **Idempotency without a new table**: the key lives in the event's `details`; the lookup is bounded to the last 24 h so
  it stays on the `(tenant_id, created_at)` index. The tenant row lock serialises a double click, so the second request
  sees the first one's committed event. Keys are per store.

## Not measured

No timings on real PostgreSQL yet. The work per apply is bounded by the limit: at most 5,000 rule writes, against
23,000 in 3-6 s for adoption (ADR 010).
