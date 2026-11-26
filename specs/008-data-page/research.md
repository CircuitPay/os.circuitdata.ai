# Research: Data Page (Upload, Map and Browse Retail Data)

Phase 0 of `plan.md`. Everything marked *read* was read in the code on 2026-11-25.

Abbreviations: `WF` = `packages/workshop-frontend`, `GR` = `packages/gatekeeper-retail`.

## What exists today (read)

- **Navigation.** `WF/src/components/AppShell/Sidebar.tsx` and `WF/src/components/Header.tsx` list
  fixed items, then every entry of `useGatekeeperApps()` (`AuthenticatedApi.listGatekeeperApps()`),
  linking to `/gatekeepers/$appId/$`. The retail vendor's account declares
  `providesUi: { title: "Data", icon }` (`GR/src/vendor.ts`), and the kernel lists a tenant-held app
  only while the tenant has it enabled. So "Data" appears only after enabling.
- **Enabling.** `AuthenticatedApi.getTenantGatekeepersApi()` returns null without Clerk, otherwise a
  capability whose `list()` gives `{ vendorId, title, enabled, mode, mayManage }` per tenant-scoped
  vendor and whose `enable(vendorId)` re-checks the caller's role on the call
  (`WF/src/features/tenant-gatekeepers/TenantGatekeepersSection.tsx`, spec 006 kernel seam). A
  personal tenant's owner may manage.
- **Hosting.** `WF/src/GatekeeperAppPage.tsx` fetches `getGatekeeperApp(appId)` and renders
  `SandboxedGatekeeperApp` with an app-local `path`.
- **The Data app** (`GR/app/`, React + Kumo, single-file build) has tabs Overview, Imports,
  Templates, Coverage, Sources, Settings (`App.tsx`). It reaches the dataset through
  `RetailAppClient` (`GR/src/app-api-types.ts`), implemented by `RetailAppApi` (`GR/src/app-ui.ts`),
  which re-reads `TenantAccess.current()` on every call.
- **Import flow.** Imports tab → "Import CSV" dialog (choose an existing or new source) →
  `host.pickTenantFiles` (Files picker with upload) → `ImportView`: template matches, the agent,
  parsing settings, file samples, the full `MappingEditor` (one row per column), Preview
  (`PreviewReport`), `StartImportForm`, then `RunReport` with undo. `missingRequirements()`
  (`GR/app/imports/mapping.ts`) states what the mapping lacks.
- **Rows.** Nothing in the app lists canonical rows. The dataset DO (`GR/src/dataset/dataset-do.ts`)
  offers `describe()` (table row estimates by `MAX(rowid)`, date range, completeness), guarded
  caller SQL (`query`), metrics, coverage and `lineage(table, id)`.
- **Schema.** Public views over `store_*` tables carry lineage columns (`id`, `source_id`,
  `source_record_id`, `run_id` = the run that last wrote the row, `mapping_version`, timestamps). The
  `customers` view is recreated masked or unmasked by the administrator's setting. Indexes exist on
  `business_date` (orders, line items, transactions, refund items) and on `order_id`, but not on
  `run_id` or `source_id`. Schema changes are appended migrations (`SCHEMA_MIGRATIONS`, applied by
  `#open()`).

## R1. Where the Data page lives

**Decision**: a Workshop route `/data/$` owned by the Workshop frontend. It shows the
"unavailable", "not turned on" (administrator / member) states itself, with **Turn on Data** calling
`TenantGatekeepersApi.enable()`. Once Data is on it hosts the existing Data app
(`GatekeeperAppPage`, vendor `retail`) in the same place. `/gatekeepers/retail/*` redirects to
`/data/*`, and the dynamic app list in the navigation skips `retail`, so Data appears exactly once.

**Rationale**: the states before enabling cannot live in the gatekeeper's app, because the kernel
mints its frame only once the tenant has enabled it. Every capability needed already exists, so the
feature needs **no kernel change**. The administrator check stays the kernel's, made on the call
(FR-003).

**Alternatives**: a kernel change listing disabled tenant apps in `listGatekeeperApps()` (rejected:
widens the kernel for a navigation detail); a second Workshop-native Data page beside the app
(rejected: two places that manage data, spec assumption "one page").

**Consequence**: the Workshop names the vendor id `retail` in one constant. This is a deliberate
product decision in a permanent fork (constitution, Fork Status): Data is a first-class part of this
product, not one of many optional gatekeepers.

## R2. Showing Data in the navigation

**Decision**: a hook `useDataArea()` reads `getTenantGatekeepersApi()?.list()` and returns the
retail entry (or null). The Sidebar and the Header show **Data** at a fixed position (after
Outputs) whenever the entry exists, regardless of `enabled`. It refetches when the authenticated
session changes (organization switch) and after enabling.

**Rationale**: `list()` is cheap, tenant-scoped and already re-checked per call. Null without
Clerk keeps Data hidden there (spec assumption "organizations only").

## R3. The basic mapping

**Decision**: a "basic" panel in the import view, shown first, with one column picker per field the
import needs, built over the same `MappingDocument` the full editor edits:

| Field | Mapping effect | Required |
| --- | --- | --- |
| Each row is one… (order / item sold) | item level when any `line_items.*` target is mapped | — |
| Order identifier | `orderKey`; "None: each row is one order" sets `orderKey: null` and a fingerprint | when item level |
| Date (or date and time) | the column feeds `orders.opened_at` (datetime) or `orders.business_date` (date), by the sample's shape | yes |
| Order total | `orders.total_amount` | when order level |
| Item | `line_items.name` | when item level |
| Quantity | `line_items.quantity` | when item level |
| Price | `line_items.unit_price_amount` | no |
| Timezone, currency, date format | `settings` | yes (prefilled) |

Preview is enabled exactly when `missingRequirements()` returns nothing. **More options** reveals
the existing parsing settings, file samples and full `MappingEditor` over the same state, so
nothing is lost switching (FR-013). **Ask the agent** stays.

**Rationale**: these are spec 006's required fields; the deterministic proposer already fills most
of them from common headers, so a typical file goes straight to Preview (SC-002).

## R4. Starting an upload in one step

**Decision**: **Upload a CSV** picks files immediately (`host.pickTenantFiles`) into a default
target: the CSV source most recently imported into, else a new source named "CSV uploads". The
existing "Import CSV" dialog with an explicit source choice stays on the Imports tab.

**Rationale**: the source choice is a grouping detail most first imports do not need (SC-001).

## R5. Re-uploading the same file

**Decision**: when a staged file's name and size equal a file of a succeeded, not-undone import,
the basic panel shows "This file looks like one imported on <date>. Importing it again updates
those rows rather than adding new ones." Computed in the app from `listRuns()`.

**Rationale**: spec edge case; idempotency is spec 006's, so a warning is all that is needed, and
it needs no server change. A content hash would be exact but the raw store keeps none today.

## R6. Browsing rows

**Decision**: three `RetailAppClient` methods (contract `contracts/data-app-api.md`):
`getBrowseCatalog()`, `browseRows(table, query)`, `getRowDetail(table, id)`. The dataset DO builds
the SQL itself from fixed per-table definitions (allowed tables, grid columns, order, date column,
search columns, related rows). Every value from the caller is a bound parameter; table and column
names come only from those definitions. Reads go through the public views, so customers are
masked exactly as for the agent (FR-022).

**Rationale**: the caller never supplies SQL, so the guard for agent SQL is not needed and cannot
be bypassed (FR-023). These are a member's own reads through the app capability, which already
re-checks membership per call; they are not agent observations (FR-028), as the existing
`getLineage` is not.

**Alternatives**: route browsing through the guarded `query()` with SQL written in the browser
(rejected: the browser would be authoring SQL, and the guard's scan refusal would surface as an
error instead of a sensible default view).

## R7. Paging and large tables

**Decision**: 100 rows per page, offset paging, stable order: tables with a date column order by
that date descending then `id` descending; the rest by `id` descending. Each page returns the
filtered total. When a dated table holds more rows than the scan limit (`RETAIL_SCAN_ROW_LIMIT`,
default 250,000) and the query has no date range and no import or source filter, the server
narrows to the last 30 days of the dataset's range and returns `narrowedTo` so the page says so
(FR-024). A new schema migration adds indexes on `run_id` and `source_id` for the seven browsable
tables, so narrowing by import or source does not scan.

**Rationale**: offset paging gives "201–300 of 4,812" directly; within a filtered range the offset
cost is small. Indexes make the import filter (the main path from a report) cheap.

## R8. "Rows from this import"

**Decision**: narrowing by import filters `run_id = <import run>`. A row's `run_id` is the run that
last wrote it, so a row a later import updated shows under the later import. The UI says "rows last
written by this import". Undoing an import restores pre-images, so its rows disappear or revert
(spec US3 scenario 10).

## R9. Row detail

**Decision**: every view column; related rows one step away, at most 50 each:

| Table | Related |
| --- | --- |
| orders | line items, transactions (by `order_id`); its location; its customer |
| line_items | its order; its product |
| transactions | its order |
| customers | their orders (newest first) |
| products | its parent product |
| inventory | its product; its location |
| locations | — |

Origin through the existing `readLineage()` (source, run, file and row number).

## R10. The Data home

**Decision**: the Overview tab becomes **Home**: states "empty" (lead with **Upload a CSV** and the
accepted files) and "with data" (row counts per table from the browse catalog, the dates covered,
the five most recent imports, **Upload a CSV** and **Browse data**), followed by the existing
overview content (storage, failures, sources). Tabs become Home, Browse, Imports, Templates,
Coverage, Sources, Settings. App-level state routes between them (opening an import from Home, rows
from a report).

**Rationale**: keeps every existing feature reachable (FR-005, SC-009) without a second app.

## R11. Pointers from elsewhere (FR-006)

**Decision**: the Dashboard and Report formats' "not turned on" text says "An administrator can
turn it on from Data in the navigation." (was "under Connectors → Data"). The Connectors page's
enable control stays.

## R12. Verification without a live organization

Local `pnpm dev-server` has no Clerk, so Data is hidden there by design. Verification uses: the
retail workerd test pool (real dataset DO and import loop), the Data app's jsdom tests, the
Workshop's jsdom tests with a scripted `TenantGatekeepersApi`, and a browser run of the built Data
app against a scripted `RetailAppClient`.
