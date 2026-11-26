# Contract: the `data` gadget library

`packages/bundled-blueprints/libraries/data/`, imported as
`@gadgets/bundled-blueprints/libraries/data/server` and `.../data/client`. Platform-only code: no
npm, es2022, readable when inlined. Everything in `src/` is pure (no DOM in server modules, no
`cloudflare:workers` anywhere) so each module runs under Node in its tests.

```
libraries/data/
  server.ts          re-exports from src/retail.ts, src/model.ts, src/params.ts, src/period.ts, src/run.ts
  client.ts          re-exports from src/model.ts (types), src/format.ts, src/chart.ts, src/table.ts, src/styles.ts, src/period.ts
  src/retail.ts      the RetailData types the gadget sees (copied from gatekeeper-retail/src/types.d.ts)
  src/model.ts       SavedQuery, FilterValues, QueryResult, VisualSpec and their validators
  src/params.ts      named-parameter compiler for SQL queries
  src/period.ts      date presets and ranges
  src/run.ts         runSavedQuery, readDataStatus, label resolution, caps
  src/format.ts      money, number, date and percent formatting
  src/chart.ts       SVG builders and text summaries
  src/table.ts       HTML table builder
  src/styles.ts      DATA_STYLES (CSS string, light and dark, print)
  __tests__/*.test.ts
  README.md
```

## Types (`src/retail.ts`, `src/model.ts`)

`src/retail.ts` holds a verbatim copy of these declarations from
`packages/gatekeeper-retail/src/types.d.ts`, minus the `RpcTarget` import: `RetailTable`,
`RetailColumnType`, `RetailColumn`, `RetailTableDescription`, `RetailMetricName`,
`RetailMetricDefinition`, `RetailDatasetDescription`, `RetailQueryResult`, `RetailMetricQuery`,
`RetailMetricResult`, and

```ts
/** The part of the RETAIL_DATA binding the data formats call. */
export interface RetailReader {
  describe(): Promise<RetailDatasetDescription>;
  run(sql: string, params?: Scalar[], options?: { maxRows?: number; maxBytes?: number }): Promise<RetailQueryResult>;
  metric(name: RetailMetricName, query: RetailMetricQuery): Promise<RetailMetricResult>;
}
export type Scalar = string | number | boolean | null;
```

A test (`__tests__/retail-types.test.ts`, Node) reads both files and fails when the copied
declarations drift from the gatekeeper's.

```ts
export type MetricGroup = "day" | "week" | "month" | "location" | "channel" | "product" | "category";

export type SavedQuery =
  | {
      kind: "metric";
      metric: RetailMetricName;
      groupBy?: MetricGroup[];
      /** Also compute the same metric over the period of equal length just before `from`. */
      compare?: boolean;
    }
  | {
      kind: "sql";
      /** One SELECT or WITH statement with named parameters (`:from`, `:to`, `:locations`, declared literals). */
      sql: string;
      /** Literal values for the query's own named parameters. Names are [a-z][a-z0-9_]*, not from/to/locations. */
      params?: Record<string, Scalar>;
    };

/** Which shared filters a tile or block listens to. */
export type FilterName = "dateRange" | "locations";

export type DatePreset = "last7" | "last30" | "last90" | "thisMonth" | "lastMonth" | "thisYear";
export type DateRangeFilter = { preset: DatePreset } | { from: string; to: string };   // business dates YYYY-MM-DD

export type FilterValues = {
  dateRange: DateRangeFilter;
  /** Location ids; empty means every location. */
  locations: number[];
};

export type ResolvedFilters = { from: string; to: string; locations: number[] };

export type ResultColumn = { name: string; type: RetailColumnType; currencyColumn?: string; label?: string };

export type QueryResult = {
  columns: ResultColumn[];
  rows: Scalar[][];
  /** True when rows were cut at the cap (by the dataset or by this library). */
  truncated: boolean;
  /** Present when `compare` was asked: the previous period's rows, same columns. */
  previous?: { from: string; to: string; rows: Scalar[][] };
  /** gross_margin only. */
  partial?: boolean;
  costCoverage?: number;
  period: { from: string; to: string };
  ranAt: number;        // epoch ms
  durationMs: number;
  rowCount: number;
};

export type QueryFailure = { error: string; ranAt: number; durationMs: number; period: { from: string; to: string } };
export type QueryOutcome = QueryResult | QueryFailure;

export type VisualType = "kpi" | "line" | "area" | "bar" | "stackedBar" | "table" | "text";

export type VisualSpec = {
  type: VisualType;
  /** Column names in the result. Absent roles are inferred (see inferRoles). */
  x?: string;
  y?: string[];
  series?: string;
  /** Sort rows by a column before drawing, then keep the first `limit`. */
  sort?: { by: string; dir: "asc" | "desc" };
  limit?: number;         // 1..500
  /** For "text": Markdown-lite body shown as written (no query). */
  text?: string;
};
```

Validators (`validateSavedQuery(value): SavedQuery`, `validateVisual(value): VisualSpec`,
`validateFilters(value): FilterValues`) return a clean copy or throw an `Error` whose message names
the bad field in plain language. Limits: SQL text ≤ 8,000 characters; ≤ 20 literal params;
`groupBy` ≤ 3 with at most one time grain; `limit` 1–500; text ≤ 20,000 characters.

## Named parameters (`src/params.ts`)

```ts
export function compileSql(
  sql: string,
  filters: ResolvedFilters,
  literals: Record<string, Scalar>,
  allLocationIds: number[],
): { sql: string; params: Scalar[] };
```

- Tokenizes `sql`, leaving `'…'`, `"…"`, `` `…` ``, `[…]`, `-- …` and `/* … */` untouched, and
  replaces each `:name` elsewhere with placeholders. `::` and `:` followed by a non-letter are not
  parameters.
- `:from` and `:to` → `?` bound to the business dates. `:locations` → `?, ?, …` bound to
  `filters.locations`, or to `allLocationIds` when the selection is empty; when both are empty it
  binds a single `NULL`. A literal name → `?` bound to its value.
- Throws for: an unknown name (`This query uses :x, which is not defined.`), more than 100 bound
  values (the dataset's limit), text that after leading whitespace and comments does not start
  with `SELECT` or `WITH` (`Only read queries can be saved.`), or a `;` followed by anything but
  whitespace and comments.
- Only `?`, `,` and spaces are ever inserted into the text.

`usesFilter(query: SavedQuery, name: FilterName): boolean` reports whether a query can react to a
filter (metric queries react to both; SQL queries to the names present in their text).

## Periods (`src/period.ts`)

```ts
/** The date a preset counts back from: the earlier of today (UTC) and the dataset's last business date. */
export function anchorDate(todayIso: string, datasetTo: string | null): string;
export function resolveRange(filter: DateRangeFilter, anchor: string): { from: string; to: string };
export function previousRange(range: { from: string; to: string }): { from: string; to: string };
export function describeRange(range: { from: string; to: string }): string;   // "1–31 Oct 2026"
export const DATE_PRESETS: { id: DatePreset; label: string }[];
```

- `last7/30/90`: the N days ending at the anchor, inclusive. `thisMonth`: first of the anchor's
  month to the anchor. `lastMonth`: the anchor's whole month when the anchor is its last day,
  otherwise the whole month before. `thisYear`: 1 January to the anchor.
- An explicit range is validated (`from <= to`, both real dates, at most 3 years apart).
- `previousRange` is the same number of days ending the day before `from`.
- All arithmetic is on calendar dates in UTC; no time zones are involved.

## Running (`src/run.ts`)

```ts
export type DataStatus =
  | { status: "ok"; dateRange: { from: string; to: string }; completeThrough: string | null;
      personalDataMasked: boolean; locations: { id: number; name: string }[] }
  | { status: "empty" }          // enabled, no orders yet
  | { status: "off" }            // no binding
  | { status: "error"; error: string };

export function readDataStatus(retail: RetailReader | undefined): Promise<DataStatus>;

export function runSavedQuery(
  retail: RetailReader,
  query: SavedQuery,
  visual: Pick<VisualSpec, "sort" | "limit">,
  filters: ResolvedFilters,
  context: { locations: { id: number; name: string }[]; now?: () => number },
): Promise<QueryOutcome>;

export function isConnectionGone(error: unknown): boolean;
export function plainError(error: unknown): string;

export const MAX_RESULT_ROWS = 500;
export const MAX_RESULT_BYTES = 100_000;
```

- `readDataStatus`: `undefined` → `off`. Otherwise `describe()`; `dateRange === null` → `empty`;
  then one `run("SELECT id, name FROM locations ORDER BY name", [], { maxRows: 500 })` for the
  location list. A thrown connection-gone error → `off`; any other → `error` with `plainError`.
- `runSavedQuery`, metric kind: `retail.metric(name, { from, to, groupBy, locationIds })`
  (`locationIds` omitted when the selection is empty). With `compare`, a second call over
  `previousRange`. Then label resolution: a `location_id` column becomes `location` (text) from
  `context.locations` (`Location <id>` when unknown); a `product_id` column becomes `product`
  after `sort` and `limit` are applied (default for a product grouping: value descending, limit
  10), by one `run("SELECT id, name, variant_name FROM products WHERE id IN (?, …)")`; a null
  product id reads `Unlinked items`.
- `runSavedQuery`, sql kind: `compileSql`, then `retail.run(sql, params, { maxRows:
  MAX_RESULT_ROWS })`. `sort`/`limit` apply to the returned rows.
- Rows beyond `MAX_RESULT_ROWS`, or beyond `MAX_RESULT_BYTES` once serialized, are dropped and
  `truncated` set.
- Never throws for a query problem: a refusal or failure returns a `QueryFailure` whose `error` is
  `plainError(error)` (the dataset's own explanation, with any stack or internal prefix removed,
  at most 500 characters). It rethrows only a connection-gone error, so the caller can switch to
  "off".
- `isConnectionGone` matches the kernel's messages for a removed connection (`"has been removed"`,
  `"no such gatekeeper"`, `"no longer connected"`), case-insensitively.

## Formatting (`src/format.ts`)

```ts
export function formatValue(value: Scalar, column: ResultColumn, row: Scalar[], columns: ResultColumn[], locale?: string): string;
export function formatMoney(minorUnits: number, currency: string, locale?: string): string;   // exact minor-unit digits from Intl
export function formatCompact(value: number, locale?: string): string;                         // axis ticks
export function formatDate(iso: string, locale?: string): string;
export function formatAge(ranAt: number, now: number): string;                                 // "just now", "5 min ago", "2 h ago", "3 days ago"
export function percentChange(current: number, previous: number): number | null;               // null when previous is 0
```

`money` columns are integer minor units next to their `currencyColumn`. `real` values that are
ratios (metric `repeat_customer_rate`) are shown as percentages by the caller passing a column
with `label: "%"`.

## Charts (`src/chart.ts`, `src/table.ts`)

```ts
export type Roles = { x: string | null; y: string[]; series: string | null; currency: string | null };
export function inferRoles(columns: ResultColumn[], visual: VisualSpec): Roles;
export function compatibleVisuals(columns: ResultColumn[], rowCount: number): VisualType[];

export type Rendered = {
  /** Markup for the tile body: an <svg role="img" aria-label="…">, a KPI block or a table. */
  html: string;
  /** One or two sentences a screen reader hears instead of the picture. */
  summary: string;
  /** Short notes to show under the visual: "Showing the first 500 rows", "Partial: covers 82% of units", "Amounts are shown per currency". */
  notes: string[];
};

export function renderVisual(result: QueryResult, visual: VisualSpec, size: { width: number; height: number }, locale?: string): Rendered;
export function renderTable(result: QueryResult, options?: { maxRows?: number }, locale?: string): string;
export function renderMarkdownLite(text: string): string;
export function escapeHtml(text: string): string;
```

- `inferRoles`: `x` is the first date/text column that is not a currency column; `y` every numeric
  or money column not used as `x`; `series` a second text column when present; `currency` the
  column named by a money column's `currencyColumn`.
- More than one distinct currency: the currency becomes the series (grouped, never stacked), KPI
  shows one line per currency, and the note "Amounts in different currencies are not added
  together" is added. Nothing is ever summed across currencies.
- `kpi`: the single value (first row, first `y`), and with `previous` the change as a signed
  percentage with an up/down word in the summary ("Net sales $12,340.00, up 8.2% on the previous
  31 days").
- `line`/`area`/`bar`/`stackedBar`: axes with at most 6 y ticks and at most 8 x labels, a legend
  when there is more than one series, at most 12 series ("top 11 + Other" by total). Colours come
  from CSS variables `--data-series-1` … `--data-series-12`, so they follow the theme.
- `table`: `<table>` with a `<caption class="sr-only">`, right-aligned numeric columns, at most
  `maxRows` (default 100) with a "showing first N of M" row.
- `renderMarkdownLite`: headings (`#`–`###`), paragraphs, `**bold**`, `*italic*`, `-` lists and
  line breaks; every other character is escaped. No links, images or raw HTML.
- Every string that reaches markup goes through `escapeHtml`; result values never reach an
  attribute unescaped.
- Output is deterministic for the same input and locale.

## Styles (`src/styles.ts`)

`DATA_STYLES`: one CSS string defining `--data-*` variables for light, dark
(`@media screen and (prefers-color-scheme: dark)` on `:root:not(.document-export)`) and print, and
the classes the builders emit (`.data-kpi`, `.data-chart`, `.data-table`, `.data-note`,
`.sr-only`). It contains an `@media print` block.

## Tests (Node unless noted)

| File | Proves |
|---|---|
| `params.test.ts` | hostile filter and literal values (`'; DROP TABLE orders;--`, `1) OR (1=1`, quotes, `?`, `:from`) arrive only as bound values and the emitted text is byte-identical to the benign case; names inside strings and comments are untouched; unknown names, write statements, `PRAGMA`, stacked statements and over-100 params are refused |
| `period.test.ts` | every preset at month and year boundaries and leap day; anchor before today; previous range length |
| `run.test.ts` | metric and sql kinds call the reader with the right arguments; compare makes two calls; label resolution; caps and `truncated`; failures become `QueryFailure`; connection-gone rethrows; `readDataStatus` for off, empty, ok and error |
| `chart.test.ts` | roles inference; each visual type's markup has `role="img"` and a non-empty summary; multi-currency never stacks or sums; markup escapes `<script>` in labels; top-N + Other |
| `format.test.ts` | minor units for USD, JPY and KWD; age strings; percent change with a zero base |
| `retail-types.test.ts` | the copied declarations match the gatekeeper's |
