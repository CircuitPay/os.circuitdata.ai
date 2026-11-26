# Quickstart: validating the Data page

Scenarios map to `spec.md`. Interfaces are in `contracts/`.

## Automated

```sh
pnpm --filter @gadgets/gatekeeper-retail test:run      # browse API (workerd), Data app (jsdom), helpers (node)
pnpm --filter @gadgets/workshop-frontend test:run      # Data entry, page states, navigation
pnpm --filter @gadgets/bundled-blueprints test:run     # reworded "not turned on" text
pnpm lint
```

| Area | Expected |
| --- | --- |
| Navigation (US1, FR-001) | Data listed once when the retail vendor is bound, whether enabled or not; absent without organizations. |
| Turning on (US1, FR-003, SC-008) | Only `mayManage` shows the button; the call is the kernel's, which re-checks the role. |
| Basic mapping (US2, SC-002) | Common POS headers need no change before Preview; a missing required field blocks Preview and names it. |
| Browse (US3, SC-003/004/006) | Paging covers every row once; import filter count equals the run's written count; hostile search text matches literally. |
| Reachability (US4, SC-009) | Every pre-existing tab renders. |

## Manual (Clerk-enabled instance with the retail gatekeeper)

1. **First visit as administrator**: Data is in the navigation; it shows "Turn on Data"; press it:
   the page becomes the Data app's Home, empty, leading with Upload a CSV.
2. **First visit as a member** in another organization that has not turned Data on: Data is listed;
   the page says an administrator must turn it on, with no button.
3. **Upload and map**: Upload a CSV → pick a POS export with one row per item (order id, date, item,
   quantity, price, total). The basic panel has every required field matched; Preview shows the
   order count and total of the file; Import; the report shows rows written.
4. **Missing field**: upload a file whose date column is named oddly: "Date" is marked Needed and
   Preview is disabled until a column is picked for it.
5. **More options**: open it, change a transform in the full editor, close it: the basic choices are
   unchanged.
6. **Browse**: from the report, View the imported rows: Orders narrowed to that import, count equal
   to the report's. Open an order: its line items, payments and the file and row it came from.
7. **Filters**: date range, "Rows from" a source, search products by SKU; type `'%_` and `") OR 1=1 --`
   into search: no rows unless they literally contain it.
8. **Masking**: Customers show masked names unless Settings allows them.
9. **Re-upload**: upload the same file again: the notice says it was imported before.
10. **Undo**: undo the import from its report: Browse shows its rows gone.
11. **Organization switch**: switch organization with Data open: the page shows the other
    organization's state and data only.
12. **Old link**: open `/gatekeepers/retail`: it lands on `/data`.

## Verification record (2026-11-25)

- **Automated**: `gatekeeper-retail` workerd suite 140 tests (13 new browse tests over real datasets and imports, a proposer test) and node/jsdom suite 61 (Home, basic mapping, Browse, App); `workshop-frontend` 2,333 tests with one failure, `TenantFilePicker.test.tsx`, which fails the same way on the commit this branch starts from; `bundled-blueprints` dashboard and report suites 176; `pnpm lint` with the workspace build.
- **Browser** (the built Data app, top-level, against a scripted `RetailAppClient` whose staged import's mapping came from the real proposer on a POS export with `Receipt #, Date, Store, Item, SKU, Category, Qty, Unit Price, Discount, Tax, Total`): empty Home → Upload a CSV → basic mapping with every field matched and the order identifier recognised → Preview → Start import → View the imported rows (Orders narrowed to the import, "101–200 of 236" paging announced) → hostile search text sent only as a value → row detail with line items and "october-sales.csv, row 14" → Home with data (counts, dates, recent run with View rows).
- **Found and fixed during the run**: headers such as `Receipt #`, `Check #` and `Ticket Number` were not recognised as order identifiers (proposer aliases added, with a test), and an item-level file with no order identifier now says each item would become its own order.

Not run: the Workshop's `/data` page against a live Clerk organization (covered by its jsdom tests; local `pnpm dev-server` has no organizations, so Data is hidden there by design), and manual scenarios 1–12 on a deployed instance.
