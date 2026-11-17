# BACKEND contract: bulk offers and offer fields (offers v1, step 5)

All responses use the standard envelope: `{ data }` on success, `{ error: { code, message, details? }, requestId }` on
failure. Mutations need the trusted Origin and `X-CSRF-Token`, as everywhere.

**Dates.** The API takes and returns ISO instants. The UI shows Qatar calendar dates (UTC+3, no daylight saving) and sends:

- a start day D as `D T00:00:00.000+03:00`;
- an end day E as `E T23:59:59.999+03:00` (the whole end day counts).

The API accepts any ISO instant with an offset (`Z` included). Responses are UTC (`…Z`); convert them back to Qatar dates for display. There is no percentage input.

```ts
type OfferState = 'scheduled' | 'active' | 'ended';   // ended = validUntil < now (derived, never stored)
type OfferView  = { price: number; validFrom: string | null; validUntil: string | null; state: OfferState };
```

## `POST /api/pricing/offers/bulk/preview`

Permission `pricing.bulk`. It writes nothing. The body limit is **128 KB** on these routes (other routes keep 32 KB), so 500 rows with both dates fit.

```ts
// request (strict: unknown keys → 400)
{
  items: Array<{                       // 1..500
    productId: string;                 // uuid
    price: number;                     // any number; range and decimals are judged per row (invalid_price)
    validFrom?: string | null;         // ISO instant with offset; absent/null = from now
    validUntil?: string | null;        // ISO instant with offset; absent/null → row rejected (end_required)
  }>;
}
```

A **400 for the whole request** comes from: no `items`, 0 or more than 500 items, a non-uuid `productId`, a non-number `price`, a date without an offset or that is not ISO, or an unknown key (e.g. `percent`).

```ts
// response data
{
  items: Array<{
    index: number;                     // position in the request
    productId: string;
    nameEn: string | null; barcode: string | null;            // null when not_found
    outcome: 'set' | 'unchanged' | 'rejected';
    reason: null | 'duplicate_row' | 'not_found' | 'product_not_active' | 'invalid_price'
                 | 'end_required' | 'end_before_start' | 'already_ended' | 'price_not_below_normal';
    message: string | null;            // e.g. "The offer price must be below the normal price (QAR 4.000)"
    warnings: Array<
      | { code: 'replaces_offer'; offer: OfferView }                     // the offer being replaced
      | { code: 'export_value_outranks'; marketplaceIds: string[] }      // pending/pinned export price wins there
    >;                                 // only on set rows
    normalPrice: number | null;        // price without the offer, no per-marketplace step; null when not_found
    normalPrices?: Record<string, number>;   // only with per-marketplace rules on: per enabled marketplace
    lowestNormalPrice: number | null;  // the offer must be strictly below this
    currentOffer: OfferView | null;
    offer: { price: number; validFrom: string | null; validUntil: string | null } | null; // written (set) / standing (unchanged)
  }>;
  totals: {
    items: number; set: number; unchanged: number; rejected: number;   // items = set + unchanged + rejected
    warnings: { replaces_offer: number; export_value_outranks: number };
    rejectedReasons: Array<{ reason: string; count: number; message: string }>;
  };
  limit: 500;
  previewToken: string;                // 64 hex; send it with apply
}
```

**Row rules**, checked in this order; the first that fails is the reason:

1. `duplicate_row`: the same product appears in more than one row. **All** of its rows are rejected.
2. `not_found`: no such product in this store.
3. `product_not_active`: the product is new or inactive.
4. `invalid_price`: the price is not more than 0 and at most 100,000, or has more than 3 decimals.
5. `end_required`: no `validUntil`.
6. `end_before_start`: `validUntil ≤ validFrom`.
7. `already_ended`: `validUntil` is before now.
8. `price_not_below_normal`: the price is at or above the **lowest** normal price across the enabled marketplaces.

A row that passes is **`unchanged`** when the product's offer has the same price and the same start and end, to the millisecond. Otherwise it is **`set`**. A set row carries `replaces_offer` when the product already had an offer, including one with the same price and different dates.

## `POST /api/pricing/offers/bulk/apply`

Permission `pricing.bulk`.

```ts
// request: the preview body plus
{ items: [...], idempotencyKey: string /* 8-100 of [A-Za-z0-9_-]; a UUID */, previewToken?: string }

// response data
{
  operationId: string;      // the 'pricing.offers_bulk_set' audit event
  replayed: boolean;        // true: this key was already applied; nothing written again
  appliedAt: string;
  totals: { ...same as preview };
  created: number;          // set rows whose product had no offer
  replaced: number;         // set rows that replaced an offer
  rejected: Array<{ index: number; productId: string; reason: string; message: string }>;   // reported, not written
}
```

How apply behaves:

- It runs in one transaction. It re-plans from current data and never reuses the preview.
- It writes **only the set rows**. Rejected rows do not fail the request.
- It records **one** audit event and queues **one** recompute (only when something was set).
- Errors:
  - `409` when `previewToken` no longer matches. Preview again.
  - `409` when the same `idempotencyKey` comes with a different body.
- The same key with the same body (within 24 h) returns the first result with `replayed: true`.

In the activity log, the event's summary is "Bulk offer set on N products". In a product's history, it shows as "Product offer set by a bulk operation", with `offerPrice`, `offerStart` and `offerEnd` before and after.

## Offer fields on lists

**`GET /api/products`** rows. These fields need `pricing.view`, the same as the existing `marketplacePrice`:

```ts
marketplacePrice: { price: number; source: string };  // existing: the resolved price (offer included)
normalPrice: number;                                   // new: the price without the offer (no per-marketplace step)
offer: OfferView | null;                               // new: the product's offer in any state
```

**`GET /api/marketplace-values/review`** items, and `GET /api/marketplace-values/:marketplaceId/products/:productId`: `catalogue` gains these fields:

```ts
normalPrice: number | null;   // live: the price on THIS marketplace without the offer (per-marketplace step included)
offer: OfferView | null;      // live: the product's offer in any state
```

`catalogue.price` and `catalogue.priceSource` are still the stored comparison values. During an active offer they are the offer price and `'offer'`.

## Not yet

- **Bulk remove** comes next: `POST /api/pricing/offers/bulk-remove/preview|apply` with `{ productIds }`.
- **Step 1:** a recompute exactly when an offer starts or ends, and the ERP reference comparing against the offer price. Until then, an offer that starts later changes the comparison only at the next recompute.
- **Step 2:** the migration (one offer per product enforced by the database, `source = 'bulk'`), after the owner approves it.
