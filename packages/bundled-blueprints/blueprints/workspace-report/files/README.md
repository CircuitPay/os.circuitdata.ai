# Report — a written document whose numbers are frozen as of a date

A report is an ordered list of sections: headings, narrative text, and data blocks (a single value, a chart or a table, each driven by a saved query over the organization's retail data). **Generating** runs every data block and stores an **edition**: a copy of every section as it was, each block's rows, the as-of time and the period. An edition never changes afterwards. Regenerating makes a new edition; earlier ones stay readable. The page shows the current text with the latest edition's results, or any earlier edition exactly as it was. Exports to PDF and Markdown.

This deployment has no slide or presentation format. When someone asks for a deck, say so and offer a report instead.

## How agents should work on this report (read this first)

1. **Read before you write.** `getReport()` returns the sections, the period and whether an edition exists. `describeData()` returns the dataset's tables, columns, standard metrics, date coverage and limits. Call `describeData()` before writing any query.
2. **Standard figures use a metric, never SQL.** Net sales, gross sales, discounts, refunds, tax, tips, orders, average order value, units sold, gross margin and repeat customer rate are `{ kind: "metric", metric: "net_sales", ... }`. That is what makes a number here match the same number on every dashboard and report.
3. **Numbers in text come only from an edition.** Call `generate()`, then `readEdition()`, and write narrative ONLY from the figures `readEdition()` returns. Do not compute, estimate or remember figures, and do not query the dataset yourself to fill in a sentence.
4. **After regenerating, re-read.** `generate()` returns `review`: the text sections that state a number while a block's numbers changed. Call `readEdition()` again, then either rewrite each flagged section (`updateSection`) or, when its figures still hold, confirm it with `markReviewed({ ids })`. Never leave a flag you have not checked.
5. **Change only what was asked.** One `updateSection` per section; do not rewrite text a person wrote to restyle it.
6. **Set the letterhead once** with `setLetterhead` (name, logo, accent colour) when the person gives it. It prints at the top of every PDF. Leave it alone otherwise.

**Reaching this gadget.** In `executeCode` a gadget is `env.<NAME>`, where `<NAME>` is the binding name the workspace gave it, derived from the gadget's title (e.g. `MONTHLY_SALES_REPORT`, or `GADGET` when none could be made). Read it from the chat's binding list rather than guessing. The methods below are on its `.rpc` stub (`env.<NAME>.rpc.getReport()`), and `env.<NAME>.exports` exports it as a file. The examples call it `MY_REPORT`.

Example: add a block, generate, and write the summary from the edition's figures.

```js
const report = env.MY_REPORT.rpc; // the binding's name varies: see above
const { tables, metrics } = await report.describeData();
const { sections } = await report.getReport();

await report.addSection({
  section: {
    kind: "data",
    title: "Units sold by category",
    visual: { type: "bar" },
    query: { kind: "metric", metric: "units_sold", groupBy: ["category"] },
    width: "half",
  },
});

const { edition, review, failed } = await report.generate();
const read = await report.readEdition();
// Each data block carries its columns and rows: block.outcome.columns, block.outcome.rows.
const netSales = read.blocks.find((block) => block.kind === "data" && block.title === "Net sales");
console.log(JSON.stringify(netSales.outcome));

const summary = sections.find((section) => section.kind === "text");
await report.updateSection({ id: summary.id, text: "Net sales for the month were ... (write this from the rows printed above)." });
```

## Data

Every read goes through the report's `RETAIL_DATA` binding, which is connected automatically when the organization has turned Data on. The report holds no credentials and has no other way to reach data. When the binding is absent, `getReport()` shows no editions, `readEdition()`, `describeData()`, `previewQuery()` and `generate()` throw a message saying data is off, and nothing is deleted: editions are shown again when the data is turned back on. Headings and text can still be edited.

### Saved queries

A data section's `query` is one of two kinds.

```js
// A standard metric, optionally broken down and compared with the period just before.
{ kind: "metric", metric: "net_sales", groupBy: ["day"], compare: true }

// One read-only SELECT or WITH statement with named parameters.
{
  kind: "sql",
  sql: "SELECT channel, COUNT(*) AS orders FROM orders WHERE business_date BETWEEN :from AND :to AND location_id IN (:locations) AND total_amount >= :minimum GROUP BY channel",
  params: { minimum: 5000 },
}
```

- `metric` is a name from `describeData().metrics`. `groupBy` takes up to three of `day`, `week`, `month`, `location`, `channel`, `product`, `category`, with at most one of the three time grains. `compare: true` also computes the period of equal length just before; use it for single values.
- SQL rules: one statement that starts with `SELECT` or `WITH`; at most 8,000 characters; only the tables in `describeData().tables`. Anything that writes, several statements, and `PRAGMA` are refused when the section is saved.
- SQL takes values only through named parameters: `:from` and `:to` are the report period's business dates, `:locations` expands to the selected location ids (every location when none is selected), and any other `:name` must be declared in `params` (up to 20; names are lowercase letters, digits and underscores; `from`, `to` and `locations` are taken). Never write a date, a location id or any other value into the SQL text.
- Money columns are whole minor units (1299 is 12.99) next to a currency column. Amounts in different currencies are never added together.
- A large table needs a date filter (`business_date BETWEEN :from AND :to`); the dataset refuses the scan otherwise. Prefer the `daily_*` tables for totals.
- A result keeps at most 500 rows and 100 KB; past that it is cut and marked truncated.

`previewQuery({ query, visual?, period? })` runs a query without saving it and returns its outcome: `{ columns, rows, truncated, period, ranAt, durationMs, rowCount }`, or `{ error, ... }` with the dataset's explanation. Use it to check a query before adding a section.

### Visuals

`visual` is `{ type, x?, y?, series?, sort?, limit? }`. `type` is `kpi` (a single value, with the change on the previous period when the query compares), `line`, `area`, `bar`, `stackedBar` or `table`. `x`, `y` and `series` name result columns and are inferred when left out. `sort: { by, dir }` and `limit` (1 to 500) are applied to the rows before they are stored. A product breakdown defaults to the ten largest.

## API

Every change runs in the Durable Object's mutation queue, bumps the report's `revision` and is broadcast to every open page. Bad input throws a plain-language error. In a view-only copy every change throws `This is a read-only copy of the report.`

| Method | Notes |
| --- | --- |
| `describeData()` | `{ data, tables, metrics, limits }`. `data` is `{ status: "ok", dateRange, completeThrough, personalDataMasked, locations }`. Throws when data is off or the dataset is empty. |
| `getReport()` | `{ meta, sections, latestEdition, review, stale }`. `meta` has `title`, `period`, `locations`, `letterhead`, `editions` (newest first) and `revision`. `review` lists text sections to check against the latest edition; `stale` lists data sections added or changed since it. |
| `readEdition({ id? })` | The edition (the latest by default): `{ id, asOf, period, title, letterhead, completeThrough, blocks, fingerprints, pinned, createdBy }`. Each data block has `outcome`: its `columns` and `rows` (and `previous.rows` when it compares), or `error`. Throws when nothing has been generated yet. |
| `addSection({ section, after? })` | `section` is `{ kind: "heading", level?: 1\|2\|3, text }`, `{ kind: "text", text }` or `{ kind: "data", title, visual, query, width?: "full"\|"half"\|"third" }`. `after` is the id of the section to insert after (`null` for first; left out for last). Returns `{ sectionId, revision }`. At most 60 sections. |
| `updateSection({ id, ...fields })` | Fields of the section's kind: `level`, `text` (heading); `text` (text); `title`, `visual`, `query`, `width` (data). Returns `{ revision, before, after }`, so a query change can be shown. Changing a text section's `text` records that it was written against the latest edition, which clears its review flag. |
| `removeSection({ id })` | Returns `{ revision }`. |
| `moveSection({ id, after })` | Moves the section after another (`null` for first). Returns `{ revision }`. |
| `setTitle({ title })` | Up to 200 characters. Returns `{ revision }`. |
| `setPeriod({ period, locations? })` | `period` is `{ preset }` with `last7`, `last30`, `last90`, `thisMonth`, `lastMonth` or `thisYear`, or `{ from, to }` as `YYYY-MM-DD` business dates under three years apart. `locations` is a list of location ids from `describeData().data.locations`; empty means every location. Takes effect at the next `generate()`. |
| `setLetterhead({ letterhead })` | `{ name?, logo?, accent? }` replaces the letterhead. `name` up to 120 characters; `accent` as `#rrggbb`; `logo` a `data:image/png`, `data:image/jpeg` or `data:image/svg+xml` URL in base64 of at most 200 KB. |
| `markReviewed({ ids })` | Clears the review flag of those text sections. |
| `generate({ createdBy? })` | Resolves the period, runs every data section and stores a new edition. Returns `{ edition, review, failed }`: `failed` lists data sections whose query failed, each stored with its error; the edition is still produced. Throws when data is off or empty, when the report has no data section, or when all 24 editions are pinned. |
| `pinEdition({ id, pinned })` | A pinned edition is never removed to make room. Returns `{ revision }`. |
| `deleteEdition({ id })` | Removes an edition for good. Only on a person's explicit request. Returns `{ revision }`. |
| `previewQuery({ query, visual?, period? })` | Runs without saving (see above). |
| `undo()`, `redo()` | Step through changes to sections, title and period. Editions and the letterhead are not part of the history. |

**Text** is Markdown-lite: `#`, `##` and `###` headings, paragraphs, `**bold**`, `*italic*`, `- ` list items and line breaks. Everything else is shown as written: no links, images or HTML. A text section holds up to 20,000 characters. Use heading sections for the report's own structure.

**Periods.** A preset is counted back from the earlier of today and the dataset's last business date. `lastMonth`, the starter's period, is the most recent complete month. Each edition records the dates it resolved to in `period`. When the period ends after `completeThrough`, the page says the later days may be missing; say the same in the narrative.

**Editions.** A report keeps 24. Generating a 25th removes the oldest edition that is not pinned; when all 24 are pinned, `generate()` refuses until one is unpinned. Tell the person before generating when the report is at its limit.

## Regenerating on a schedule

The report can regenerate itself through the workspace's Scheduled Tasks binding. Registering creates a disabled hook: the person must enable it before it runs.

1. Ask the person for their time zone (an IANA name such as `America/Chicago`). Never guess it.
2. Register from `executeCode`:

```js
import { restore } from "cloudflare:workers";

export default async function (self, env, ctx) {
  // A persistent stub for the report's own regeneration. `monthly: "first"` makes the weekly
  // rule below run only in the first seven days of a month: the first Monday of each month.
  // Leave `monthly` out for every week.
  const hook = await env.MY_REPORT.rpc[restore]({ type: "regenerate", monthly: "first" });
  const scheduleId = await env.SCHEDULER.calendarAt(
    { timeZone: "America/Chicago", freq: "weekly", byDay: ["MO"], hour: 8, minute: 0 },
    hook,
    { title: "Regenerate the monthly sales report", description: "Generates a new edition on the first Monday of each month at 8:00." },
  );
  console.log("Schedule registered:", scheduleId);
}
```

3. Tell the person to enable the hook: on the "Hook" card in the chat, or under Hooks in the report's Connections tab. Nothing runs until they do.

Each firing generates one edition (`createdBy: "schedule"`); a retried firing does not generate a second one. A firing while data is off or empty, or while all 24 editions are pinned, produces nothing. The scheduler has daily, weekly and hourly rules and no monthly one, which is why a monthly schedule is a weekly rule with `monthly: "first"`.

## Export formats

- **PDF** (browser): the latest edition as the page shows it, from stored results: letterhead, title and as-of line, then the sections, in the light palette with no controls. Nothing is read from the dataset to print.
- **Markdown** (`.md`): the same content as text: headings and text as written, each data block as a table of the values as displayed.

Both need an edition. With data off, or before the first `generate()`, the Markdown export says so.

## Data model

- `meta`: revision, title, period, locations, letterhead, section order and a summary of every edition (`id`, `asOf`, `period`, `pinned`, `createdBy`).
- `s:<id>`: one section. A text section's `reviewedEdition` is the edition it was last written or confirmed against.
- `e:<id>`: one edition, written once. Only `deleteEdition` and the 24-edition limit remove one.
- `status`: the dataset's last known state. `undo`: up to 50 steps each way. `runs`: the last 50 schedule runs handled.

Publishing this report as a blueprint carries its code and the starter sections only: never its sections, editions or letterhead.

## Code map

The gadget is `client.js` (the page) and `server.js` (the Durable Object and exports). Both are self-contained bundles: each inlined module starts with a `// lib/<name>.ts` comment.

- `server.js` — the `Gadget` Durable Object (storage, data access modes, the API above, generation, `[restore]` and the schedule hook) and `ExportHandler`; inlined are `lib/editions.ts` (building an edition, fingerprints, the review and stale rules, retention), `lib/starter.ts` (the starter sections), the `data` library's server side (saved queries, named parameters, periods, running) and the `sync` library's mutation queue and subscriber registry.
- `client.js` — the whole page: header and edition picker, the letterhead and sections, data blocks drawn by the `data` library's chart and table builders, in-place editing, live updates, and the print layout.
