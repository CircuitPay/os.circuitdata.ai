# Quickstart: validating the retail data layer

Each scenario maps to a user story or success criterion in `spec.md`. The interfaces are in
`contracts/`, and the tables and rules are in `data-model.md`.

## Prerequisites

- `pnpm install`, then `pnpm configs:generate` (new worker `gatekeeper-retail` with the `RETAIL_RAW` R2 binding).
- A Clerk-enabled dev deployment (`docs/clerk-signin.md`), with two organizations (A and B) and in A
  one administrator and one member. `pnpm dev-server` binds `GATEKEEPER_RETAIL` automatically.
- For Square: a Square developer sandbox application. Set `SQUARE_CLIENT_ID`,
  `SQUARE_CLIENT_SECRET` and `SQUARE_WEBHOOK_SIGNATURE_KEY` in `packages/gatekeeper-retail/.dev.vars`,
  register the redirect `{PUBLIC_BASE_URL}/gatekeeper/retail/oauth/square`, and point the webhook
  subscription at `/gatekeeper/retail/webhooks/square` (a tunnel is needed locally).
- Fixtures under `packages/gatekeeper-retail/__tests__/fixtures/`:
  - a one-row-per-line-item CSV with a known total;
  - the same sales as a Square sandbox seed;
  - a Toast export set with one file missing, and a second set for the next day that repeats an edited check;
  - a Shopify export;
  - a malformed CSV (`;` delimiter, windows-1252, quoted newline, header on row 3, footer total row).

## Automated

```sh
pnpm --filter @gadgets/gatekeeper-retail test:run          # workerd + node projects
pnpm --filter @gadgets/workshop-backend test:integration -- tenant-gatekeepers
pnpm --filter @gadgets/workshop-frontend test:run -- SandboxedGatekeeperApp ConnectHandoff
pnpm configs:check
UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts   # then review the golden diff
node --test scripts/preview/staging-config.test.ts
pnpm lint
```

What the retail suites must show:

| Area | Expected |
|---|---|
| Guarded SQL (US3.2, SC-008) | Each of these is refused and leaves the row counts and `sqlite_schema` unchanged: `SELECT 1; DELETE FROM orders`, `WITH x AS (SELECT 1) DELETE FROM orders`, `UPDATE … RETURNING`, `PRAGMA …`, `ATTACH`, `SELECT * FROM store_orders`, `SELECT * FROM pragma_table_info('orders')`, `WITH RECURSIVE`, and an unlisted function. A full scan of `line_items` above the row limit is refused with the rollup suggestion. |
| Idempotency (SC-004) | Importing the same file twice, re-running a sync over the same pages, and an overlapping export leave the row counts unchanged and update rows in place. |
| Money and metrics (FR-014/015, SC-002) | Refund, void, split-tender, tax-inclusive, zero-decimal currency and multi-currency fixtures give the expected `net_sales`, `orders`, `units_sold` and `refunds` per business date. No metric sums two currencies. |
| Business date | An order at 01:30 local time with a 04:00 cutoff lands on the previous day, and DST days are correct. |
| Undo (FR-011) | Undo restores the pre-images. Undo after a later overlapping import is refused and names that run. |
| Rebuild (US5) | A wrong mapping (tips → discount) is corrected and re-applied: the rows change and the row count stays the same. |
| Isolation (SC-007) | Across three datasets, no query, lineage, coverage or import reaches another dataset's rows or raw objects. A collaborator from another tenant is refused by `addObserver`. |
| Kernel seam | All the invariants in `contracts/kernel-seam.md` (enable by a non-admin refused, demoted admin refused on the next call, organization B never sees A's capsule, a member leaving keeps the dataset, `organization.deleted` revokes, `user.deleted` erases the personal directory). |

## Load test (SC-006, SC-006a) — build task 1

Generate a synthetic dataset of 10 locations × 3 years (≈ 3M orders, 15M line items, 4.5M
transactions) into a local `RetailDataset` with the batch-ingest path. Record:

- `sql.databaseSize`, which must stay at or below 7.5 GB (25% headroom)
- ingest throughput (rows per CPU-second)
- standard metrics over one year for one location, which must be under 2 s
- standard metrics over 3 years for 10 locations, which must be under 5 s
- a typical guarded `run()` per table

If the size or time check fails, implement the split by location (research R3) before any connector
work.

## Manual scenarios

1. **Enable (FR-002a)**: as A's member, the Connectors page shows "Data" as administrator-only. As
   A's administrator, enable it. "Data" now appears in the nav for both. In a new workspace, a chat
   can call `RETAIL_DATA.describe()`. Organization B sees nothing.
2. **CSV import (US2, SC-003)**:
   1. As the member, open Data → Import → pick from Files (or upload) the line-item CSV.
   2. Columns, a sample and a proposed mapping appear, with missing required fields called out.
   3. Click "Ask the agent": a chat opens with the prompt, and the agent calls `pendingImports()`
      then `proposeImportMapping()`. Back in Data, the suggestion is shown.
   4. Preview: compare the totals with the fixture's known total. Import, then save as a template.
   5. Import next month's file: the template is offered, and the import takes one step and under a minute.
3. **Toast set (US2.8–9)**: upload the set with `PaymentDetails` missing. It is refused before
   preview, naming the file. Add the file and import. Then import the next day's set: the edited
   check is updated, not duplicated.
4. **Malformed CSV (Edge)**: the sniffed encoding, delimiter, header row and footer are shown and can
   be overridden. Nothing is mis-parsed silently.
5. **Undo (US2.7)**: undo the first import. Rows and rollups return to their earlier state, and the report shows "undone".
6. **Square (US1, SC-001, SC-005)**:
   1. As the administrator, Connect Square. The consent screen lists only read permissions.
   2. Pick locations. Progress by table appears. Leave and come back: progress continues.
   3. The last 30 days arrive within 10 minutes.
   4. Create a sandbox order: it appears within 15 minutes, and within seconds once webhooks are reachable.
   5. Refund it: a refund transaction is added, and the order is not duplicated.
7. **Failure (US1.4)**: revoke the app in Square. The source shows "needs reconnect" with the time of
   its last successful sync, and the data stays. Reconnect: sync resumes.
8. **Handoff threat**: as B's administrator, start Connect Square and copy the popup URL. Open it in
   A's administrator's browser and authorize. A's handoff page reports the connection could not be
   completed, and B's dataset gains no connection.
9. **Read-only (US3.2)**: in chat, ask the agent to delete orders through `RETAIL_DATA.run`. It is refused.
10. **PII (US3.5)**: `SELECT email FROM customers` returns masked values. The administrator turns on
    unmasked access, and the same query returns real values. The member cannot change the setting.
11. **Coverage and lineage (US4)**: import a CSV with a missing Tuesday. Coverage flags it.
    `lineage('orders', id)` names the source, the run, the file and the row.
12. **Disconnect (US1.5)**: disconnect Square with "delete data". Its rows, rollups and raw objects
    are gone, and CSV data is untouched.
13. **Erasure (FR-022)**: delete organization A in Clerk. The dataset, the R2 prefix, the
    connections and the webhook routes are removed. B is unaffected.
