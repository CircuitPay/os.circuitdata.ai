# `data` — saved queries over the retail dataset, and how their results are drawn

The Dashboard and Report blueprints do the same thing in two shapes: each holds saved queries
against the organization's retail dataset, runs them through the `RETAIL_DATA` binding with the
viewer's filters, keeps the results, and shows them as a figure, a chart or a table. This library
is that once: what a saved query is, how filter values reach it, how its result is capped and
labelled, and how a result becomes markup. It knows nothing about tiles, sections, editions or
storage; a gadget keeps those.

The design record is `specs/007-data-output-formats/` (`contracts/data-library.md` is this
library's contract).

## Server (`@gadgets/bundled-blueprints/libraries/data/server`)

- **Dataset types** -- `RetailReader` is the part of `env.RETAIL_DATA` the formats call
  (`describe`, `run`, `metric`), typed structurally so a test can script it. `Scalar` is a result
  cell or a bound value. The `Retail*` types are a word-for-word copy of the declarations in
  `packages/gatekeeper-retail/src/types.d.ts`, which a blueprint cannot import.
- **Model** -- `SavedQuery` (a standard metric with an optional breakdown and comparison, or SQL
  with named parameters), `VisualSpec`, `FilterValues`, `ResolvedFilters`, `QueryResult`,
  `QueryFailure`, `QueryOutcome` (a failure is the one with `error`), `ResultColumn`.
  `validateSavedQuery`, `validateVisual`, `validateFilters` and `validateDateRange` return a clean
  copy or throw an `Error` that names the bad field in plain language. Limits: SQL text 8,000
  characters, 20 literal parameters, three breakdowns with at most one of day, week and month, a
  visual limit of 1 to 500 rows, 20,000 characters of text, 50 selected locations.
  `validateSavedQuery` also dry-runs `compileSql`, so a query that is not a read, has a second
  statement or uses an undefined name is refused when it is saved.
- **`compileSql(sql, filters, literals, allLocationIds)`** -- turns `:from`, `:to`, `:locations`
  and the query's own literals into `?` placeholders and the positional values they bind.
  `usesFilter(query, name)` says whether a query can react to a shared filter.
- **Periods** -- `anchorDate(today, datasetTo)` is the date presets count back from: the earlier of
  today and the dataset's last business date. `resolveRange(filter, anchor)` turns a preset or an
  explicit range into business dates, `previousRange(range)` is the period of equal length just
  before, `describeRange(range)` writes `1–31 Oct 2026`, and `DATE_PRESETS` lists the presets with
  their labels. `isIsoDate`, `addDays` and `daysInRange` are the arithmetic underneath.
- **`runSavedQuery(retail, query, visual, filters, context)`** -- runs one saved query and returns
  a `QueryOutcome`. A metric query calls `retail.metric` (a second time over the previous period
  with `compare`), names its locations from `context.locations` and its products with a read of
  `products`, and marks a ratio so it is shown as a percentage. A SQL query is compiled and run
  with the row cap. The visual's `sort` and `limit` apply to the rows.
- **`readDataStatus(retail)`** -- `off` with no binding, `empty` for a dataset with no orders,
  otherwise `ok` with the date range, the complete-through date, whether personal data is masked,
  and the locations by name.
- **`isConnectionGone(error)`**, **`plainError(error)`** -- whether an error means the connection
  was removed, and an error as one sentence of at most 500 characters with no stack.
- **Formatting** -- the same functions the client entry exports, for a server-side export that
  writes values as they are displayed.

The entry imports nothing from `cloudflare:workers` and touches no DOM.

## Client (`@gadgets/bundled-blueprints/libraries/data/client`)

- **`renderVisual(result, visual, size, locale?)`** -- returns `{ html, summary, notes }`. `html`
  is a KPI block, an `<svg>` chart (line, area, bar, stacked bar), the table or the text block;
  `summary` is the sentence a screen reader hears instead of the picture (plain text: set it as
  text, never as markup); `notes` are short lines to show underneath, such as
  `Showing the first 500 rows` or `Partial: covers 82% of units`.
- **`inferRoles(columns, visual)`**, **`compatibleVisuals(columns, rowCount)`** -- which column is
  the category, the values and the series, and which visual types a result can take.
- **`renderTable(result, options?, locale?)`** -- the table on its own: a caption for screen
  readers, numeric columns right-aligned, 100 rows unless `maxRows` says otherwise, and a row
  saying how many there are in all.
- **`renderMarkdownLite(text)`** -- `#` to `###` headings (written as `h3` to `h5`), paragraphs,
  `**bold**`, `*italic*`, `-` lists and line breaks. Everything else is escaped: no links, no
  images, no HTML. **`escapeHtml(text)`** is the escape every builder uses.
- **Formatting** -- `formatValue(value, column, row, columns, locale?)` for a cell,
  `formatMoney`, `formatMoneyCompact`, `formatCompact`, `formatPercent`, `formatDate`,
  `formatAge(ranAt, now)` (`just now`, `5 min ago`, `2 h ago`, `3 days ago`),
  `percentChange(current, previous)`, `currencyDigits`, `columnHeading`.
- **`DATA_STYLES`** -- one CSS string: the `--data-series-1` to `--data-series-12`, `--data-axis`,
  `--data-grid`, `--data-text` and `--data-muted` variables for light, dark and print, and the
  classes the builders emit (`.data-kpi`, `.data-chart`, `.data-table`, `.data-num`, `.data-note`,
  `.data-empty`, `.sr-only`). A gadget adds it to its own stylesheet.
- **Periods** -- `DATE_PRESETS`, `resolveRange`, `describeRange`, `anchorDate`, for a date-range
  control.
- The model and dataset types, `DataStatus`, and `validateVisual` / `validateFilters` for a page
  that checks its input before sending it.

Every builder returns a string and none touches `document`, so the same code draws in a page, in
a Durable Object's export and in a Node test. Nothing on this side compiles or runs a query.

## Rules

- **Values are bound, never written.** A saved SQL query names its inputs: `:from` and `:to` (the
  resolved business dates), `:locations` (one placeholder per selected location; every location
  when none is selected; a single NULL when there are none) and literals declared in `params`
  (names are `[a-z][a-z0-9_]*`). `compileSql` tokenizes the text, leaves strings, quoted
  identifiers and comments exactly as written, and replaces each name outside them. The only
  characters it can add are `?`, `,` and a space, so a filter value cannot change what a query
  means, whatever it contains. It refuses text that does not start with `SELECT` or `WITH`,
  anything after a semicolon, a name with no value, a bare `?`, and more than 100 bound values.
  The dataset's own guard remains the authority on what a read is.
- **Standard figures use metrics.** A `metric` query runs the dataset's shared definition, so
  "net sales" means the same on every dashboard and report. SQL is for what the metrics do not
  cover.
- **Results are capped.** A result keeps at most `MAX_RESULT_ROWS` (500) rows and
  `MAX_RESULT_BYTES` (100,000) bytes of rows once serialized, previous-period rows included;
  `truncated` says when rows were dropped, by the dataset or here. A product breakdown keeps its
  ten largest rows unless the visual sets a `sort` or a `limit`, and product names are read only
  for the rows that are kept.
- **A query problem is that query's outcome.** `runSavedQuery` returns a `QueryFailure` for a
  refusal or a failure, so one tile or block shows its error and the others are untouched. It
  throws only when the connection is gone, which is the gadget's cue to switch to its "off" state.
- **Currencies are never added together.** Money is integer minor units beside a currency code,
  scaled by the digits `Intl.NumberFormat` reports for that currency (2 for USD, 0 for JPY, 3 for
  KWD). When a result holds more than one currency the currency becomes the series, bars are
  drawn side by side instead of stacked, a KPI shows one line per currency, nothing is combined
  into "Other", and the visual carries the note `Amounts in different currencies are not added
  together`.
- **A chart has at most** six value ticks, eight category labels and twelve series: with more
  series the eleven largest are kept and the rest combined as "Other".
- **Colours come from the variables.** A chart writes `var(--data-series-N)` and the axis, grid
  and text variables, never a colour, so it follows the page's theme and prints light.
- **Everything that reaches markup is escaped**, including a chart's `aria-label`.
- **Output is deterministic** for the same input and locale. With no locale the formatters use
  `en-US`, the language the formats' own wording is written in, so a page, an export and a test
  agree; `formatDate` then writes `31 Oct 2026`.

## Tests

`__tests__/` runs in Node (`// @vitest-environment node`), one suite per module.
`params.test.ts` is the injection boundary's: for hostile filter and literal values the emitted
SQL is byte-identical to the text for harmless ones and the value appears only in the bound
array. `run.test.ts` drives `runSavedQuery` and `readDataStatus` with a scripted reader.
`retail-types.test.ts` reads `src/retail.ts` and the gatekeeper's `types.d.ts` and fails when a
copied declaration drifts.
