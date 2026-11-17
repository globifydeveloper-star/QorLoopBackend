# Offers v1, Step 5 addendum (bulk offers with per-row values): Step 0 inspection

Date: 17 November 2026. Based on `main` at `d96ed44`. Branch `feature/offers-v1` (new; it did not exist locally or on origin).

**Report only.** No code, schema or migration has changed.

## 1. Where offers v1 stands (blocking finding)

Only the Step 0 docs (PR #6) reached `main`. **Steps 1 to 4 were never built**:

| Step 0 plan item | On `main` today |
| --- | --- |
| Migration `202611110001_offers_v1` (unique offer per product, `TIMESTAMPTZ(3)`, CHECKs, `source`/`set_by_id`, `catalogue_exports`, `offer_imports`) | **absent**; the last migration is `202611100001_marketplace_value_overrides` |
| Step 1: O1 boundary sweep, O2 (ERP reference uses the offer price) | absent |
| Step 2: `normalPrice` and `offer { price, validFrom, validUntil, state }` on the product list, product detail and Review | absent; the list has `marketplacePrice { price, source }` only, and Review has `catalogue.price/priceSource` |
| Step 3: catalogue export | absent |
| Step 4: offer upload (where the reason codes would live) | absent |
| `GET /api/pricing/active-offers` | **present** (merged in `41363f4`) |

The owner's order of work also put Steps 4 and 5 **after the 20 November test**.

**What Step 5 can still do without the migration.** Step 5 needs no schema of its own:

- **One offer per product** is still kept by the application. `replaceOffer` deletes and inserts, under the tenant row lock. Bulk apply does the same set-based: one `DELETE … WHERE product_id = ANY($ids)`, then one `createMany`.
- When the migration lands, bulk apply moves to `INSERT … ON CONFLICT (tenant_id, product_id) DO UPDATE` with `source = 'bulk'`.
- Until then, provenance lives only in the audit event.

## 2. What exists to reuse

- **Bulk price change.** `apps/api/src/pricing/bulk-pricing.ts` and `bulk-pricing.service.ts`:
  - plan inside the transaction, with `previewToken` = sha256 of the planned writes;
  - `requestHash` with canonical JSON, and the `idempotencyKey` looked up in `audit_events` within 24 h, under the tenant lock;
  - one event, then one `enqueueRecon` after commit.
  - `data.pricing.bulkOperation` is hard-wired to `action: 'pricing.bulk_applied'`. It gets an `action` parameter.
- **Single offer.** `PricingService.setOffer` refuses an ended offer and records `product.offer_set` with `{ old, new }`. The contract `productOffer` accepts ISO with an offset, a price `> 0`, `< 1e9` and 3 decimals, and `validUntil > validFrom`. It sets no end requirement and no "below normal" check.
- **Resolver** (`packages/core/src/pricing.ts`): `resolveMarketplacePrice(input, …, { marketplace, now })`. The normal price is the same call with `offers: []`.
- **Page inputs.** `productInputs(data, products)` makes 2 queries per page. `loadPricing(data)` runs once.
- **The O5 warning.** `marketplace_value_overrides` holds pending or pinned price export values per marketplace. It needs a read over the item IDs across the enabled marketplaces: one query.

## 3. A blocker in the request: body size

`apps/api/src/app.ts:110` sets `bodyLimit: 32 * 1024`.

One item with both dates is about 135 bytes:

```json
{"productId":"<uuid>","price":12.345,"validFrom":"2026-11-20T00:00:00.000+03:00","validUntil":"2026-11-30T23:59:59.999+03:00"}
```

500 items come to **about 68 KB, which is refused with a 413**. 230 items is the most that fits.

**Proposal.** Give only these two routes a route-level `bodyLimit` of 128 KB. Fastify supports a per-route limit, set through the route config. The global limit stays 32 KB.

## 4. Proposed endpoint shapes

Both routes are `POST`, with `pricing.bulk` permission, and give 200.

### Request (preview)

```ts
// POST /api/pricing/offers/bulk/preview
{
  items: Array<{
    productId: uuid,
    price: number,                 // > 0, ≤ 100,000, ≤ 3 decimals (checked per row, not by zod, so a bad row is reported, not a 400)
    validFrom?: string | null,     // ISO instant with offset; blank = from now (stored null, as the single API)
    validUntil: string | null,     // ISO instant with offset; required by the upload rules (null → end_required)
  }>                               // 1..500
}
```

The UI sends a start day D as `D T00:00:00.000+03:00` and an end day E as `E T23:59:59.999+03:00`.

- The API accepts any instant. It does not enforce midnight boundaries (**decision c**).
- There is no percentage field.

Shape errors give a 400 for the whole request: not an array, more than 500 items, a non-UUID `productId`, a non-ISO string, or unknown keys. Everything else is a per-row outcome.

### Response (preview)

```ts
{
  items: Array<{
    index: number,                  // position in the request
    productId: string,
    nameEn: string | null, barcode: string | null,   // null when not_found
    outcome: 'set' | 'unchanged' | 'rejected',
    reason: null | 'invalid_price' | 'price_not_below_normal' | 'end_required' | 'end_before_start'
                 | 'already_ended' | 'product_not_active' | 'not_found' | 'duplicate_row',
    message: string | null,         // e.g. "The offer must be below the normal price (QAR 12.500)"
    warnings: Array<
      | { code: 'replaces_offer', offer: OfferView }
      | { code: 'export_value_outranks', marketplaceIds: MarketplaceId[] }
    >,
    normalPrice: number | null,     // price without the offer; null when not_found
    normalPrices?: Partial<Record<MarketplaceId, number>>, // only when per-marketplace rules are on (decision a)
    currentOffer: OfferView | null,
    offer: { price, validFrom, validUntil } | null,        // what will be written (normalised ISO, ms), null when rejected
  }>,
  totals: { items, set, unchanged, rejected, warnings: { replaces_offer, export_value_outranks },
            rejectedReasons: Array<{ reason, message, count }> },
  limit: 500,
  previewToken: string,             // sha256 of the planned writes
}
// OfferView = { price: number, validFrom: string | null, validUntil: string | null, state: 'scheduled' | 'active' | 'ended' }
```

**Rule order per row.** The first rule that fails sets the reason:

1. `duplicate_row`: the same `productId` appears more than once. All of its rows are rejected.
2. `not_found`
3. `product_not_active`: the product is new or inactive.
4. `invalid_price`
5. `end_required`
6. `end_before_start`: `validUntil ≤ validFrom`.
7. `already_ended`: `validUntil < now`.
8. `price_not_below_normal`: `price ≥ normalPrice`.

A row that passes is `unchanged` when the current offer has the same price and the same dates to the millisecond. Otherwise it is `set`.

The warnings apply to `set` rows only.

### Apply

```ts
// POST /api/pricing/offers/bulk/apply
{ items: [...same...], previewToken?: string, idempotencyKey: string /* ^[A-Za-z0-9_-]{8,100}$ */ }
→ {
  operationId: uuid, replayed: boolean, appliedAt: string,
  totals: { ...same as preview },
  created: number,  // set rows where the product had no offer
  replaced: number, // set rows that replaced an offer
  rejected: Array<{ index, productId, reason, message }>,   // reported, not written
}
```

Apply runs **in one transaction under the tenant lock**:

1. Look up the idempotency key. The same key and body give the first result again, with `replayed: true`; a different body gives a 409.
2. Re-plan from current data.
3. A token mismatch gives a 409 ("Prices or offers changed since the preview").
4. Delete the `set` products' offers, then `createMany` the new ones.
5. Record **one** `pricing.offers_bulk_set` event: `{ idempotencyKey, requestHash, previewToken, result, changeColumns: ['productId','oldPrice','oldFrom','oldUntil','newPrice','newFrom','newUntil'], changes }`.

After commit, **one** `enqueueRecon(tenant, 'pricing.offers_bulk')` runs, and only when at least one row was set.

Rejected rows **do not** fail the apply. Apply with zero `set` rows writes nothing but still records the event, so a replay works.

Two follow-ups:

- the activity log groups `pricing.offers_bulk_set` under "price" and summarises it as "Bulk offer set on N products";
- the token covers the set rows' writes only. A change that only moves a row from rejected to set also changes the set writes, so the token catches it.

## 5. Product list rows and Review items (additive)

**Product list** (`GET /api/products`). The rows already carry `marketplacePrice` under `pricing.view`. They gain:

```ts
normalPrice: number,                     // resolver with offers removed, no marketplace step (same basis as marketplacePrice)
offer: OfferView | null,                 // the product's offer (the last one if legacy duplicates exist), any state
```

The cost is no extra query: `productInputs` already loads the page's offers.

**Review** (`GET /api/marketplace-values/review`). Each item's `catalogue` gains:

```ts
normalPrice: number,                     // this marketplace's price without the offer (marketplace step included)
offer: OfferView | null,
```

The cost is `loadPricing` plus `productInputs` for the page: 3 queries per page, whatever the page size.

**State names.** The new views use `scheduled | active | ended`. The existing `pricing.offer.state` on product detail keeps `valid | expired`, so nothing breaks.

## 6. Decisions needed

a. **Which normal price does `price_not_below_normal` use when per-marketplace rules are on?**
   - Recommended: reject when the price is at or above the **lowest** normal price among the enabled marketplaces, so the offer is a discount everywhere.
   - Return `normalPrice` (the plain chain) plus `normalPrices` per marketplace.
   - With the switch off, there is one normal price.

b. **Body limit.** Raise these two routes to 128 KB, or cap the items at 230?
   - Recommended: 128 KB on these routes only.

c. **Dates.**
   - Recommended: accept any ISO instant, as the single-offer API does, and document the Qatar 00:00 / 23:59:59.999 convention.
   - Alternative: reject instants that are not on those boundaries (stricter, but it makes the API Qatar-only).

d. **Bulk remove.** The original Step 5 also had `…/offers/bulk-remove/preview|apply`, and the addendum does not mention it. Keep it (with `{ productIds ≤ 500 }`), or drop it for now?

e. **Timing and base.** Build Step 5 now on `main`, without the migration (delete plus insert under the tenant lock, no `source = 'bulk'`)? Or wait for Steps 1 and 2 and the approved migration, as the order of work planned (Step 5 after the 20 November test)?
   - Recommended: build now, without schema. The Review/list `normalPrice` and `offer` fields are the Step 2 views, so they come with this step.
   - O1 (the boundary sweep) is still missing. A bulk offer that starts tomorrow changes the comparison only at the next recompute. The same is already true of the single-offer API.

f. **`unchanged` versus `replaces_offer`.** A row whose price matches the current offer but whose dates differ is `set`, with `replaces_offer`. Confirm.

## 7. Not verified

- No tests were run. This step has no code.
- The demo database was not queried, so it is unknown whether any product has duplicate offers today. Bulk apply deletes all of a product's offers before inserting, as `replaceOffer` does.
