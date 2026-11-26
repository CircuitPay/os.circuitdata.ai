# Contract: the Data app's Home, basic mapping and Browse

`packages/gatekeeper-retail/app/`. React + Kumo inside the sandboxed app frame. Load the
`frontend-conventions` skill before changing it. Existing components are reused, not copied.

## App shell (`App.tsx`)

- Tabs: **Home**, **Browse**, Imports, Templates, Coverage, Sources, Settings (Overview is
  replaced by Home). Panels still mount on first visit and stay mounted.
- App-level navigation state lets one panel send the member to another:
  - `openImport(importId)` → Imports tab showing that import;
  - `openRun(runId)` → Imports tab showing that run's report;
  - `browse({ table, runId?, sourceId? })` → Browse tab on that table with that filter.
  `ImportsPage` takes an optional `request` prop (`{ kind: "import" | "run", id, seq }`) that opens
  the view when `seq` changes.

## Home (`home/HomePage.tsx`)

Loads `getOverview()`, `getBrowseCatalog()` and `listRuns({ limit: 5 })` together.

- **Empty** (no orders and no staged imports): heading "Get your sales data in", one sentence on
  what to upload (a POS export with one row per order or per item sold; Toast, Square and Shopify
  exports are recognised), primary **Upload a CSV**, and a secondary link to Sources ("or connect
  Square or Stripe").
- **With data**: a summary card per table (label, row count, link to Browse it), "Sales from
  <from> to <to>" with "complete through <date>" when that is earlier, the five most recent runs
  (file names or source, status, rows written, **View rows** for a succeeded import, which calls
  `browse({ table: "orders", runId })`), and actions **Upload a CSV** (primary) and **Browse data**.
- Below either: the existing overview content (storage meter and warning, administrator failures,
  sources table), moved from `OverviewPage` unchanged.
- **Upload a CSV** (`home/uploadCsv.ts`): target = the CSV source with the newest succeeded import
  run, else `{ newSourceLabel: "CSV uploads" }`; calls `pickCsvFiles(host, target)`; on a staged
  import calls `openImport(importId)`; on cancel does nothing; on error shows the message.
- Staged imports still waiting for a mapping are listed above the summary with **Continue**.

## Basic mapping (`imports/BasicMapping.tsx`, shown first in `ImportView`)

Props: `staged: StagedImport`, `mapping: MappingDocument`, `onChange(mapping)`, `runs: RunSummary[]`
(for the re-upload notice). Pure helpers in `imports/basicFields.ts` (Node-testable):

```ts
export type RowLevel = "order" | "item";
export function rowLevelOf(mapping: MappingDocument): RowLevel;                // item when any line_items.* target is mapped
export function setRowLevel(mapping: MappingDocument, level: RowLevel): MappingDocument;  // order: drops line_items.* targets
export type BasicField = "orderKey" | "date" | "total" | "item" | "quantity" | "price";
export function basicFields(level: RowLevel): { field: BasicField; label: string; required: boolean }[];
export function columnOfField(mapping: MappingDocument, field: BasicField): ColumnRef | null;
export function setFieldColumn(mapping: MappingDocument, field: BasicField, column: ColumnRef | null, files: StagedImportFile[]): MappingDocument;
export function previouslyImported(staged: StagedImport, runs: RunSummary[]): { runId: number; at: string } | null;
```

- `date` maps the column to `orders.business_date` (transform `date`) when every non-empty sample
  value has no time part, else `orders.opened_at` (transform `datetime`), replacing whichever of
  `orders.business_date`/`opened_at`/`closed_at` the field held.
- `orderKey` sets `mapping.orderKey`; choosing "None: each row is one order" sets it to null and
  sets `fingerprint` to the mapped date and total (order level) or date, item and quantity paths.
- `total` → `orders.total_amount` (transform `money`); `item` → `line_items.name`; `quantity` →
  `line_items.quantity` (transform `quantity`); `price` → `line_items.unit_price_amount` (transform
  `money`). All through the existing `assignColumn` so a column feeds one target.
- UI: "Each row is one" segmented choice (order / item sold); one labelled `Select` per field
  listing the file's columns (with each column's first sample value) plus "Not in this file";
  required fields not yet matched are marked "Needed"; timezone, currency (3 letters) and date
  format inputs with the detected values; a live list of what is still needed
  (`missingRequirements`); **Preview** (enabled when nothing is missing); **More options** toggles
  the existing parsing settings, file samples and full `MappingEditor` (same `mapping` state);
  **Ask the agent** as today. The re-upload notice shows above when `previouslyImported` is set.
- A file whose staging failed (unreadable, empty, too large) already surfaces the server's error
  where the pick was made; nothing changes there.

## Run report link (`imports/RunReport.tsx`)

A succeeded import run (not undone) shows **View the imported rows** →
`browse({ table: "orders", runId })` (or `line_items` when it wrote no orders), with the note "Rows
last written by this import."

## Browse (`browse/BrowsePage.tsx`, `browse/RowGrid.tsx`, `browse/RowDetailView.tsx`)

- Loads `getBrowseCatalog()`. Left (or top, on narrow screens): the tables with label, count and
  description; empty tables show "No rows yet".
- A table view: heading, filter bar (date from/to for dated tables; "Rows from" select: all, each
  source, each of the 20 most recent succeeded imports by file name and date; search box when the
  table supports it, applied on Enter or after a pause), the grid and paging.
- Grid: Kumo `Table` with a `caption` naming the table and filters, column headers from the
  schema's names with a description tooltip, money via `formatMoney` with the row's currency,
  dates/timestamps readable, booleans as Yes/No, JSON as a short summary, nulls as "–", long text
  truncated with the full value in a `title`. Each row's first cell is a button opening the detail.
- Paging: Previous / Next and "201–300 of 4,812", announced in an `aria-live="polite"` region.
- `narrowedTo` shows a notice: "This table is large, so it opens on <range>. Choose dates to see
  others."
- Masked customers show a notice: "Names, emails and phone numbers are hidden. An administrator can
  show them in Settings."
- Row detail: a dialog or panel with every field (label, value, description), each related table
  as a small grid whose rows open their own detail, and "From <source> · import #<run> · <file>,
  row <n>" when known. Back returns focus to the row that opened it. A row that no longer exists
  shows the error and returns to the table.
- Read-only: no control edits or deletes rows.

## Tests (jsdom, colocated, the app's existing harness)

- `home/HomePage.test.tsx`: empty and with-data states; Upload a CSV calls `pickTenantFiles` with
  the derived target and opens the import; View rows calls browse with the run id.
- `imports/basicFields.test.ts` (Node): every helper, including date vs datetime detection,
  order-level fingerprint, switching levels drops line targets, and that a file with common POS
  headers proposed by the deterministic mapping yields no missing requirements.
- `imports/BasicMapping.test.tsx`: Preview disabled until required fields are matched; picking a
  column enables it; More options keeps the choices; the re-upload notice.
- `browse/BrowsePage.test.tsx`: table list counts; filters reach `browseRows` as values; paging
  text and announcements; narrowed notice; masked notice; detail opens and shows related rows and
  origin; a removed row returns to the table with the message.
- `App.test.tsx`: tabs are Home, Browse, Imports, Templates, Coverage, Sources, Settings, and every
  pre-existing tab still renders (SC-009).
