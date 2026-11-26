# Contract: browsing methods on the Data app capability

`packages/gatekeeper-retail`. Added to `RetailAppClient` (`src/app-api-types.ts`), implemented by
`RetailAppApi` (`src/app-ui.ts`, `@validateRpc()`), backed by new `RetailDataset` methods
(`src/dataset/dataset-do.ts`) and a new module `src/dataset/browse.ts`. This is the member-facing
app capability, not the agent's `RETAIL_DATA` session: `src/types.d.ts` does not change.

## Types (`src/app-api-types.ts`)

```ts
/** Tables the Data area browses. */
export type BrowseTable =
  | "orders" | "line_items" | "transactions" | "products" | "customers" | "locations" | "inventory";

/** A column as the browser shows it (same types as the binding's RetailColumn). */
export type BrowseColumn = {
  name: string;
  type: "integer" | "real" | "text" | "boolean" | "json" | "timestamp" | "date" | "money";
  /** For money: the column in the same row holding the ISO 4217 code. */
  currencyColumn?: string;
  personal?: boolean;
  description?: string;
};

/** One browsable table. */
export type BrowseTableInfo = {
  name: BrowseTable;
  label: string;                 // "Orders", "Line items", "Payments", ...
  description: string;
  /** Exact row count, deleted rows excluded. */
  rows: number;
  /** The column date ranges filter on, or null (products, customers, locations, inventory). */
  dateColumn: "business_date" | null;
  /** Whether `search` applies, and what it searches, for the placeholder text. */
  search: { columns: string[]; label: string } | null;
  /** Columns the grid shows, in order. */
  gridColumns: BrowseColumn[];
};

export type BrowseCatalog = {
  tables: BrowseTableInfo[];
  /** Earliest and latest business date with orders, or null when there are none. */
  dateRange: { from: string; to: string } | null;
  completeThrough: string | null;
  personalDataMasked: boolean;
  /** Sources rows can be narrowed to. */
  sources: { id: number; kind: SourceKind; label: string }[];
};

export type BrowseQuery = {
  /** 0-based row offset; a multiple of 100. Default 0. */
  offset?: number;
  /** Inclusive business dates "YYYY-MM-DD"; only for tables with a dateColumn. */
  from?: string;
  to?: string;
  /** Rows last written by this run (an import's run id). */
  runId?: number;
  sourceId?: number;
  /** Substring to find in the table's search columns; 1-100 characters. */
  search?: string;
};

export type BrowsePage = {
  table: BrowseTable;
  columns: BrowseColumn[];       // the table's gridColumns
  /** Each row: `id` first, then the grid columns' values in order. */
  rows: { id: number; values: (string | number | boolean | null)[] }[];
  offset: number;
  /** Rows matching the query (all pages). */
  total: number;
  pageSize: 100;
  /** Set when the server narrowed an unfiltered query on a large table (FR-024). */
  narrowedTo: { from: string; to: string } | null;
};

export type RowDetail = {
  table: BrowseTable;
  id: number;
  /** Every column of the public view, with its value. */
  fields: { column: BrowseColumn; value: string | number | boolean | null }[];
  related: {
    table: BrowseTable;
    label: string;               // "Line items", "Payments", "Order", "Product", ...
    columns: BrowseColumn[];     // the related table's gridColumns
    rows: { id: number; values: (string | number | boolean | null)[] }[];
    /** True when more than 50 matched. */
    truncated: boolean;
  }[];
  /** Where the row came from; null when lineage cannot be read. */
  origin: RowLineage | null;
};
```

## Methods (`RetailAppClient`)

```ts
/** The browsable tables with exact row counts, the date range, and the sources to filter by. */
getBrowseCatalog(): Promise<BrowseCatalog>;

/** One page of a table's rows, newest first. Refuses an unknown table or an invalid query. */
browseRows(table: BrowseTable, query?: BrowseQuery): Promise<BrowsePage>;

/** One row with every field, its related rows and its origin. Throws "This row no longer exists." */
getRowDetail(table: BrowseTable, id: number): Promise<RowDetail>;
```

`RetailAppApi` calls `await this.#member()` before each (membership re-read per call, as every
other member method), then the dataset DO with `this.#datasetId`. No observation is recorded.

## Per-table definitions (`src/dataset/browse.ts`)

A frozen `BROWSE_TABLES: Record<BrowseTable, Definition>`; nothing else names a table or column in
browse SQL.

| Table (view) | Label | Date column | Order | Search | Grid columns |
| --- | --- | --- | --- | --- | --- |
| orders | Orders | business_date | business_date DESC, id DESC | order_number | business_date, order_number, location_id, status, channel, total_amount, currency, customer_id |
| line_items | Line items | business_date | business_date DESC, id DESC | name | business_date, order_id, name, quantity, unit_price_amount, net_amount, currency |
| transactions | Payments | business_date | business_date DESC, id DESC | — | business_date, order_id, kind, tender, amount, currency, status |
| products | Products | — | id DESC | name, sku | name, variant_name, sku, category, price_amount, currency, is_active |
| customers | Customers | — | id DESC | first_name, last_name, email | first_name, last_name, email, phone, created_at |
| locations | Locations | — | id DESC | name | name, kind, timezone, currency, address_city |
| inventory | Inventory | — | id DESC | — | product_id, location_id, quantity_on_hand, state, as_of |

Column types and descriptions come from `PUBLIC_TABLES` (`schema.ts`), never restated.

## SQL rules

- `SELECT id, <grid columns> FROM <view> WHERE deleted_at IS NULL [AND <date> BETWEEN ? AND ?] [AND run_id = ?] [AND source_id = ?] [AND (<col> LIKE ? ESCAPE '\' OR …)] ORDER BY <order> LIMIT 100 OFFSET ?`, and the same `WHERE` for `SELECT COUNT(*)`.
- Search binds `%<escaped>%`, escaping `\`, `%` and `_`, compared case-insensitively.
- Validation, each a plain `Error`: unknown table; `offset` not a non-negative multiple of 100 or above 1,000,000; `from`/`to` not real dates, reversed, or given for a table with no date column; `search` empty or over 100 characters, or given for a table without search; `runId`/`sourceId` not positive integers.
- Large tables: when the table's row estimate exceeds the scan limit and the query has a date column but no `from`/`to`, `runId` or `sourceId`, the server uses the last 30 days ending at the dataset's latest business date and returns them as `narrowedTo`.
- Logged: `browse.rows` with table, row count, total and duration; never values, search text or ids.

## Related rows and origin

Per `research.md` R9, each related query is a fixed definition (`<table>.<column> = ?`, newest
first, `LIMIT 51` to detect `truncated`). Origin is `readLineage(sql, table, id)`; a thrown lineage
error yields `origin: null`.

## Schema migration (`src/dataset/schema.ts`)

A second `SCHEMA_MIGRATIONS` entry creating `store_<t>_run ON store_<t> (run_id)` and
`store_<t>_source ON store_<t> (source_id)` for orders, line_items, transactions, products,
customers, locations and inventory.

## Tests (`__tests__/browse.test.ts`, workerd)

Over a dataset loaded through ingest:

- paging is stable and covers every row exactly once; `total` matches the filtered count;
- date range, `runId` (rows of one of two imports), `sourceId` and search each narrow correctly; an undone import's rows are gone;
- hostile search and filter values (`%`, `_`, `'`, `"; DROP TABLE store_orders; --`, `') OR 1=1 --`) match only literally and leave every table intact;
- an unknown table, a column name passed as a table, bad offsets and dates are refused;
- customers are masked unless the setting is on;
- a table over the scan limit with no filter returns `narrowedTo` and only rows in it;
- row detail returns every field, the related rows of an order (line items and payments) and the origin's file and row;
- a deleted id throws "This row no longer exists.";
- the catalog's counts equal `COUNT(*)` of each view without deleted rows.
