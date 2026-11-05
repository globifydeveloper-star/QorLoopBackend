# BACKEND contract: Templates / file mapping

All responses use the standard envelope `{ data }` or `{ error: { code, message, details? }, requestId }`. Authentication is the normal web session. `PUT` needs the `X-CSRF-Token` header. Decisions: [ADR 016](decisions/016-templates-file-mapping.md).

## GET /api/templates

Permission `settings.view` (Owner, Admin, Catalogue Manager, Analyst). Read-only.

```ts
type Source = 'erp' | 'talabat' | 'snoonu' | 'rafeeq' | 'keeta';
type Response = { data: { items: TemplateSource[] } };   // always 5 items, in the order above

type TemplateSource = {
  source: Source;
  label: 'ERP' | 'Talabat' | 'Snoonu' | 'Rafeeq' | 'Keeta';
  status: 'set_up' | 'not_set_up';                      // set_up = at least one saved layout
  reason: string | null;                                 // plain text when not_set_up
  fields: { key: string; label: string; required: boolean }[]; // what Qorloop reads for this source
  layouts: Layout[];                                     // newest version of each saved name; most recently used first
  outgoing: Outgoing | null;                             // null for ERP (Qorloop never writes ERP files)
};

type Layout = {
  name: string;
  version: number;                // send as expectedVersion on PUT
  builtIn: boolean;               // shared reference layout (none are seeded today)
  editable: boolean;              // false for built-in layouts
  savedAt: string;                // ISO UTC, when this version was written
  lastUsedAt: string | null;      // newest upload read with any version of this layout
  usedByUploads: number;          // uploads read with any version (any status, including discarded)
  mapping: Record<string, string | null>; // every field key of the source -> header, null when unmapped
  mapped: string[];               // field keys with a header, in field order
  missingRequired: string[];      // normally []
  headers: string[] | null;       // columns of the last file read with this layout: the choices for an edit;
                                  // null when no such upload is on record (then headers are given by name)
};

type Outgoing = {
  status: 'ready' | 'not_ready';
  reason: string | null;
  basedOn: null | {               // the latest applied upload for this marketplace
    fileName: string;
    appliedAt: string | null;
    layout: { name: string; version: number; current: boolean } | null; // current=false: applied before the latest edit
  };
  columns: null | {
    matchBy: { field: 'marketplaceProductId' | 'barcode1'; header: string | null }; // product ID if mapped, else first barcode
    price: string | null;         // written by price and update files
    availability: string | null;  // written by stock and update files
  };
};
```

Fields per source:

| Source | Required fields | Optional fields |
| --- | --- | --- |
| ERP | barcode, nameEn, price, stock | nameAr, cost, active, category, brand, sku |
| Talabat | marketplaceProductId, barcode1, price, available | barcode2, barcode3, name |
| Snoonu, Rafeeq, Keeta | barcode1, price, available | marketplaceProductId, barcode2, barcode3, name |

Reasons when not set up:

- Rafeeq / Keeta: `No saved layout yet. Qorloop does not know the Rafeeq file format; upload a Rafeeq file and save its column mapping to set it up.`
- Others: `No saved layout yet. Upload a Talabat file and choose to save its column mapping.` (ERP reads "an ERP file").

Outgoing reasons:

- `No Rafeeq file has been applied yet. Apply one to generate Rafeeq files.`
- `The last applied Talabat file has no identifying, price or availability column mapped. Apply a Talabat file with those columns.`
- `The last applied Talabat file's columns no longer fit its mapping. Upload a fresh Talabat file.`

No storage keys, upload ids, layout ids or tenant ids are returned.

## PUT /api/templates/:source

Permission `settings.edit` (Owner, Admin). `:source` is one of the five sources.

```ts
type Request = {
  name: string;                    // the layout name from GET (1-100 characters)
  expectedVersion: number;         // the version from GET (integer >= 1)
  fields: Record<string, string | null>; // only the fields to change; null or '' unmaps an optional field; at least one key
};
type Response = { data: TemplateSource };  // the source's entry after the edit, same shape as in GET
```

Example: `PUT /api/templates/erp` `{ "name": "Shop ERP", "expectedVersion": 1, "fields": { "price": "Retail Price", "cost": null } }` returns 200 with that layout at version 2.

Rules:

- Fields left out keep their header.
- A new header must be a column of the last file read with this layout. The match ignores case and spaces, and Snoonu branch names; the file's own spelling is stored. With no file on record, the header is taken by name.
- Resending an unchanged header is always accepted. If nothing changes, the response is 200 and no version or audit event is written.
- The edit writes version + 1. Earlier versions, applied uploads, generated files and comparisons are unchanged, and no recompute is requested. Detection of future uploads uses the newest version only. Generated files follow the latest **applied** upload's own mapping until a file read with the new version is applied.
- Audit: `template.updated` `{ source, name, fromVersion, toVersion, changes: [{ field, old, new }] }`. In `GET /api/activity?eventType=stock_uploads` it reads "Upload file mapping changed", with `beforeAfter` per field.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Unknown source; body not as above (missing/extra keys, empty `fields`, key not a field name, header over 300 characters, version below 1). Mapping problems also return 400, each with `details[{ path: 'fields.<key>', message }]`. |
| 401 | `UNAUTHENTICATED` / `SESSION_EXPIRED` | Not signed in. |
| 403 | `FORBIDDEN` | Catalogue Manager or Analyst. |
| 403 | `CSRF_REQUIRED` / `MFA_REQUIRED` | As for every mutation. |
| 404 | `NOT_FOUND` | No layout of that name for this source in this store, including another store's layout and built-in layouts. |
| 409 | `CONFLICT` | `expectedVersion` is not the newest version. Reload and retry. |

The mapping-problem messages in `details` are:

- `Column "X" is not in the last ERP file`
- `Column "X" appears more than once in the last Snoonu file`
- `Barcode must be mapped`
- `Column "Barcode" is already mapped to Barcode; a column can only be mapped to one field`
- `ERP files have no field "colour"`

## Demo checks (PowerShell 5.1)

`scripts/dev/templates-check.ps1` signs in at hidden local prompts and never prints credentials, cookies or tokens.

- It runs `GET /api/templates` and prints each source's status, layouts, mapping and outgoing columns.
- It fails unless ERP, Talabat and Snoonu are `set_up`. Rafeeq and Keeta are reported as found.
- The only write is the optional `-ReversibleEdit`. It unmaps one optional mapped field of the first Talabat layout (`name`, `barcode2` or `barcode3`) and checks the response. A `finally` block then restores the original header with the new `expectedVersion` and checks that every field matches the original.

```powershell
# Read-only
powershell -ExecutionPolicy Bypass -File scripts/dev/templates-check.ps1
# Read-only plus one reverted edit (writes two versions and two template.updated events)
powershell -ExecutionPolicy Bypass -File scripts/dev/templates-check.ps1 -ReversibleEdit
```

Expected results:

- **Read-only run:** `PASS: ERP, Talabat and Snoonu layouts present.` Talabat and Snoonu `outgoing` show `ready` with their price/availability columns.
- **With `-ReversibleEdit`:** also `Reversible edit verified: talabat "<name>" v<N> -> v<N+1> -> v<N+2>, field <field> restored to "<header>".`

The revert leaves the layout's mapping as it was. Version numbers stay higher, and the two events remain in activity history. Between the edit and the revert (a few seconds), an upload reaching its detect step would read the edited version; run the check while nobody is uploading. The script logs out at the end with `POST /api/auth/logout`.
