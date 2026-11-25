# Dashboard — live figures, charts and tables from the organization's retail data

A grid of tiles. Each tile draws the result of one **saved query** against the organization's retail dataset (sales, orders, products, customers, inventory), which reaches this gadget as `env.RETAIL_DATA` with no setup. Viewers filter by date range and location; results are cached and refreshed when they are older than the dashboard's freshness setting. Exports to PDF and CSV.

## How agents should edit this dashboard (read this first)

The dashboard's content is data in the gadget's storage: its tiles, their queries and their layout. **Never edit the gadget's code to change its content.** Use the methods below.

1. **Call `describeData()` before writing any query.** It returns the tables and columns that exist, the standard metrics, the date range the dataset covers and its limits. Do not guess table or column names.
2. **Standard figures use `{ kind: "metric" }`, never hand-written SQL.** Net sales, gross sales, discounts, refunds, tax, tips, orders, average order value, units sold, gross margin and repeat customer rate each have one shared definition (`net_sales`, `gross_sales`, `discounts`, `refunds`, `tax`, `tips`, `orders`, `average_order_value`, `units_sold`, `gross_margin`, `repeat_customer_rate`), so the number matches the same figure in every other dashboard and report.
3. **Write SQL only for what no metric covers**, and follow the query rules below.
4. **Test, save, run.** `previewQuery` runs a query without saving it; then `addTile` or `updateTile`; then `runTiles` so the people watching see the result. `addTile` and `updateTile` run nothing by themselves.
5. **Read before changing.** `getDashboard()` lists the tiles with their ids, queries and last results. Change one tile with `updateTile`; do not remove and re-add it.
6. **A failed tile is that tile's result, not an exception.** After `runTiles` or `previewQuery`, check each outcome for `error` and fix the query it explains.

**Reaching this gadget.** In `executeCode` a gadget is `env.<NAME>`, where `<NAME>` is the binding name the workspace gave it, derived from the gadget's title (e.g. `SALES_OVERVIEW`, or `GADGET` when none could be made). Read it from the chat's binding list rather than guessing. The methods below are on its `.rpc` stub (`env.<NAME>.rpc.getDashboard()`), and `env.<NAME>.exports` exports it as a file. The examples call it `MY_DASHBOARD`.

Example: add a headline figure and a chart from standard metrics, then show them.

```js
const dashboard = env.MY_DASHBOARD.rpc; // the binding's name varies: see above
const { data, metrics } = await dashboard.describeData();
// data.dateRange says which dates have data; metrics lists every standard figure.

const units = await dashboard.addTile({
  title: "Units sold",
  visual: { type: "kpi" },
  query: { kind: "metric", metric: "units_sold", compare: true },
});
const byCategory = await dashboard.addTile({
  title: "Net sales by category",
  visual: { type: "bar", sort: { by: "value", dir: "desc" }, limit: 12 },
  query: { kind: "metric", metric: "net_sales", groupBy: ["category"] },
});
const { results } = await dashboard.runTiles({ ids: [units.tileId, byCategory.tileId] });
for (const [id, outcome] of Object.entries(results)) {
  if (outcome.error) console.log(id, "failed:", outcome.error);
}
```

Example: a figure no metric covers, written as SQL, tested first.

```js
const dashboard = env.MY_DASHBOARD.rpc;
const query = {
  kind: "sql",
  sql: `SELECT business_date, currency, SUM(net_amount) AS net_amount
        FROM daily_sales
        WHERE business_date BETWEEN :from AND :to
          AND location_id IN (:locations)
          AND net_amount >= :floor
        GROUP BY business_date, currency
        ORDER BY business_date`,
  params: { floor: 50000 }, // money is minor units: 50000 is 500.00
};
const outcome = await dashboard.previewQuery({ query, visual: { type: "line" } });
if (outcome.error) throw new Error(outcome.error); // read the explanation, fix the query, preview again
const { tileId } = await dashboard.addTile({ title: "Days above 500 in net sales", visual: { type: "line" }, query });
await dashboard.runTiles({ ids: [tileId] });
```

Take the table and column names from `describeData()`; the ones above are an illustration.

Example: change a tile's query. The reply holds the tile before and after, so the change can be shown to the member; `undo()` reverses it.

```js
const dashboard = env.MY_DASHBOARD.rpc;
const { tiles } = await dashboard.getDashboard();
const tile = tiles.find((t) => t.title === "Net sales");
const { before, after } = await dashboard.updateTile({
  id: tile.id,
  title: "Net sales by location",
  visual: { type: "bar" },
  query: { kind: "metric", metric: "net_sales", groupBy: ["location"] },
});
await dashboard.runTiles({ ids: [tile.id] });
```

## Query rules

A saved query is one of two kinds.

**Metric**: `{ kind: "metric", metric, groupBy?, compare? }`

- `metric` is a name from `describeData().metrics`.
- `groupBy` holds up to three of `day`, `week`, `month`, `location`, `channel`, `product`, `category`, with at most one of the time grains. `product` and `category` are not available for order-level metrics (`orders`, `average_order_value`, `tips`, `service_charges`, `repeat_customer_rate`).
- `compare: true` also computes the period of equal length just before, which a `kpi` shows as a change.
- Result columns: the `groupBy` keys in order (`location` and `product` as names), then `currency` for money metrics, then `value`. A product breakdown is sorted by value, largest first, and cut to 10 rows unless the visual sets its own `sort` and `limit`.

**SQL**: `{ kind: "sql", sql, params? }`

- One `SELECT` or `WITH` statement, SQLite dialect, over the tables in `describeData()`. Anything else is refused when the tile is saved and is never run.
- Use the **named parameters** `:from` and `:to` (business dates, `YYYY-MM-DD`, inclusive) and `:locations` (use it as `location_id IN (:locations)`; it stands for the selected locations, or all of them when none is selected). A viewer's filter choice reaches the query only through these.
- **Filter large tables by `business_date`** (`WHERE business_date BETWEEN :from AND :to`), or read the `daily_*` summary tables. The dataset refuses a query that would scan a large table with no date filter.
- Your own values go in `params` and are named in the text the same way: `params: { floor: 50000 }` with `:floor`. Names are lowercase letters, digits and underscores, and not `from`, `to` or `locations`. Never build SQL text out of values.
- **Money is integer minor units beside a currency column** (1299 with `USD` is 12.99). Select the currency column with every amount, and never add amounts in different currencies together. An alias ending in `_amount` is shown as money when the result has a `currency` column.
- At most 8,000 characters of SQL, 20 `params`, 100 bound values in all. A result keeps at most 500 rows and 100 KB; a tile that hits the cap says so. Aggregate in the query rather than returning rows to count.

## Tile API

Every change runs in the gadget's mutation queue, bumps the dashboard's `revision`, is pushed to the shared undo history and is broadcast to every open copy of the dashboard. Bad input throws a plain-language error. In a read-only copy (a view-only share) every changing method throws `This is a read-only copy of the dashboard.`

| Method | Notes |
| --- | --- |
| `describeData()` | `{ data, tables, metrics, limits }`. `data` is `{ status: "ok", dateRange, completeThrough, personalDataMasked, locations: [{ id, name }], anchor }`, or `{ status: "empty" }` when the dataset has no orders yet. `anchor` is the date presets count back from: the earlier of today and the last date with data. Throws when retail data is off. |
| `getDashboard()` | `{ meta, tiles, results }`. `meta` is `{ revision, title, freshnessMinutes, defaultFilters, tileOrder, lastModified }`; each tile is `{ id, version, title, visual, query?, uses, layout }`; `results` maps tile ids to their cached outcome for the default filters. |
| `addTile({ title, visual, query?, uses?, layout? })` | Returns `{ tileId, revision }`. `title` is 1 to 120 characters. Without `layout` the tile takes the first free place for its default size (kpi 3×2, charts 6×4, table 6×5, text 6×3). At most 40 tiles. Runs nothing. |
| `updateTile({ id, title?, visual?, query?, uses?, layout? })` | Returns `{ revision, before, after }`. Only the fields given change. The tile's cached results are dropped when `query`, `uses` or the visual's `sort` or `limit` changed; changing only the visual's type, or the title, keeps them and needs no run. Giving a new `query` without `uses` resets `uses` to every filter the new query reads. |
| `removeTile({ id })` | Returns `{ revision }`. |
| `setLayout({ tiles: [{ id, x, y, w, h }] })` | Moves and resizes. The grid has 12 columns; `w` and `h` are 2 to 12. Values are clamped to the grid, and a tile that another now covers moves down. Returns `{ revision }`. |
| `setTitle({ title })` | 1 to 200 characters. Returns `{ revision }`. |
| `setDefaultFilters({ filters })` | The filters a viewer starts on: `{ dateRange, locations }`. `dateRange` is `{ preset }` with `last7`, `last30`, `last90`, `thisMonth`, `lastMonth` or `thisYear`, or `{ from, to }`. `locations` is a list of location ids; empty means every location. Returns `{ revision }`. |
| `setFreshness({ minutes })` | How old a cached result may be before it is run again: 1 to 1440, 15 by default. Returns `{ revision }`. |
| `previewQuery({ query, visual?, filters? })` | Runs a query without saving it and returns its outcome. `filters` defaults to the dashboard's default filters; the visual's `sort` and `limit` apply. |
| `runTiles({ ids?, filters?, force? })` | Returns `{ resolved, results, data }`. Runs the named tiles (all by default) under `filters` (the default filters by default) and returns each one's outcome by tile id. A tile whose cached outcome for the same filters is younger than the freshness setting is not run again unless `force: true`. |
| `undo()`, `redo()` | Step the shared history of structure changes. Return the dashboard as it now stands, or `null` when there is nothing to step to. Results are not part of the history. |

**Visuals** (`visual`): `{ type, x?, y?, series?, sort?, limit?, text? }`.

- `type`: `kpi` (one value, with the change from the previous period when the query has `compare`), `line`, `area`, `bar`, `stackedBar`, `table`, or `text`.
- `x`, `y` (a list) and `series` name result columns. Leave them out and they are inferred: the first date or text column is `x`, numeric and money columns are `y`, a second text column is `series`.
- `sort: { by, dir }` and `limit` (1 to 500) are applied to the result's rows when the tile runs.
- A `text` tile has no query: `{ type: "text", text }` with headings (`#` to `###`), paragraphs, `**bold**`, `*italic*` and `-` lists, up to 20,000 characters.

**Filters a tile uses** (`uses`): a list of `"dateRange"` and `"locations"`. By default a tile uses every filter its query can react to: both for a metric, and for SQL the ones whose parameters appear in its text. A tile ignores a filter it does not list: it keeps the dashboard's default value for it, and a viewer changing that filter does not re-run it.

**Outcomes.** A result is `{ columns, rows, truncated, previous?, partial?, costCoverage?, period, ranAt, durationMs, rowCount }`: `columns` are `{ name, type, currencyColumn? }`, `rows` are arrays in column order, `previous` holds the earlier period's rows when `compare` was asked, and `partial` with `costCoverage` marks a gross margin that covers only the units with a known cost. A failure is `{ error, ranAt, durationMs, period }`; tell them apart by `error`.

## What people see

- The header holds the date-range and location filters, Refresh, the age of the results and Edit. A viewer's filter choice stays in their own page: it is never stored and never moves anyone else's.
- Each tile shows its title, its visual, notes (a result cut at the cap, a partial margin, amounts kept apart by currency, a period the data does not yet fully cover) and a Details disclosure with its query, period, last run, row count and duration. Every chart can be shown as a table.
- A failed tile shows the dataset's explanation and **Fix with agent**, which gives the member a request to paste into the chat naming the dashboard, the tile and the error.
- In Edit mode a person moves and resizes tiles (by dragging, or with the arrow keys and Shift with the arrow keys), changes a tile's visual type among those that fit its result, renames and deletes tiles, and can undo. Queries are changed through the agent.
- When retail data is off for the organization the dashboard says so, shows no results and keeps none cached. When the dataset has no orders yet it says that instead.

## Data model

- `meta`: revision, title, freshness setting, default filters, tile order.
- `t:<tileId>`: one tile.
- `r:<tileId>`: the tile's cached outcomes: the one for the default filters first, then up to 8 recent ones for other filter values. Dropped when the tile's query changes; all deleted when the gadget finds retail data is off.
- `status`: the dataset's status (date coverage, locations) and when it was read.
- `undo`: up to 50 earlier and 50 later snapshots of the structure.

## Export formats

- **PDF** (browser): the dashboard as it prints, from cached results for the default filters: no controls, tiles in two columns, light palette, with the as-of time and the filters under the title.
- **CSV**: one section per tile with a query, from cached results for the default filters: a line with the tile's title and period, a header line, then the rows as the tile shows them. UTF-8 with BOM, CRLF. Text that would start a formula in a spreadsheet (a leading `=`, `+`, `-`, `@`, tab or CR) is written with a leading `'`, so opening the file runs nothing.

An export reads nothing from the dataset. Run the tiles first (`runTiles()`) when the export should hold fresh numbers.

## Limitations

- The dataset is the only data source. A tile cannot read a sheet, a file or another gadget.
- Presets count back from the last date with data, so "last 30 days" stays full when the latest import is a few days old.
- A view-only share is a frozen copy: it shows the results it was shared with and cannot filter or refresh.
- Turning retail data off takes effect when the workspace is next opened.

## Code map

The gadget is `client.js` (the page) and `server.js` (the Durable Object and exports). Both are self-contained bundles: each inlined module starts with a `// lib/<name>.ts` comment.

- `server.js` — the `Gadget` Durable Object: storage, the data access modes (live, off, read-only copy), `subscribe`/`open`, `runTiles` with the result cache, the tile API above, undo history, and `ExportHandler`; inlined are `lib/starter.ts` (the "Sales overview" starter tiles), `lib/layout.ts` (grid placement), the `data` library's server side (saved-query validation, named-parameter compiler, date presets, running and caps) and the `sync` library's mutation queue and subscriber registry.
- `client.js` — the whole page, with the element builder from the `ui` library, the subscriber from `sync`, and the `data` library's charts, tables, formatters and styles inlined. Numbered sections indexed at the top of the file.
