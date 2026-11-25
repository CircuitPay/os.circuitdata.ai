# Contract: the Dashboard gadget (`format.dashboard`)

`packages/bundled-blueprints/blueprints/workspace-dashboard/`. Built on the `data`, `sync` and `ui`
libraries. Every public method of `Gadget` is callable by the iframe and by the agent
(`env.<NAME>.rpc.<method>`); `files/README.md` documents the agent-facing ones.

## `blueprint.json`

```json
{
  "blueprintId": "format.dashboard",
  "title": "Workspace Dashboards",
  "description": "Use for live figures, charts and tables computed from the organization's retail data (sales, orders, products, customers, inventory) that should stay current. Each tile runs a saved query; viewers filter by date and location.",
  "agentHint": "Use for figures, charts or summaries of the organization's retail data that should stay current. Not for hand-entered tables (use a Sheet) or dated deliverables (use a Report).",
  "output": { "id": "dashboard", "noun": "Dashboard", "plural": "Dashboards", "icon": "chartBar" },
  "author": { "type": "user", "name": "Circuit", "id": "formats@circuitdata.ai" },
  "revision": 1,
  "created": "2026-11-25T00:00:00.000Z",
  "version": 1,
  "lastUpdated": "2026-11-25T00:00:00.000Z",
  "bindings": {
    "RETAIL_DATA": {
      "title": "Retail data",
      "description": "Your organization's sales, products, customers and inventory. Connected automatically when your organization has turned Data on.",
      "type": "ambient",
      "vendorId": "retail"
    }
  }
}
```

## Files

```
files/README.md          agent-facing API and rules
files/client.ts          the UI (legacy entry: globals gadget, RpcTarget)
files/server.ts          Gadget (Durable Object) and ExportHandler
files/lib/protocol.ts    types shared by both sides
files/lib/starter.ts     the "Sales overview" starter tiles
files/lib/layout.ts      grid placement: clamp, collide, first free slot
__tests__/server.test.ts, layout.test.ts, client.test.ts
```

## Stored state (Durable Object key-value storage)

| Key | Value |
|---|---|
| `meta` | `{ revision, title, freshnessMinutes, defaultFilters: FilterValues, tileOrder: string[], lastModified }` |
| `t:<tileId>` | `Tile` |
| `r:<tileId>` | `{ entries: { key: string; outcome: QueryOutcome }[] }`, default-filter entry first, at most 9 |
| `status` | the last `DataStatus` and when it was read |
| `undo` | `{ past: Snapshot[]; future: Snapshot[] }`, each at most 50 |

```ts
type Tile = {
  id: string;                 // 8 lowercase alphanumerics
  version: number;
  title: string;              // 1..120 characters
  visual: VisualSpec;
  /** Absent for a text tile. */
  query?: SavedQuery;
  /** Which shared filters reach the query. Default: every filter the query can react to. */
  uses: FilterName[];
  layout: { x: number; y: number; w: number; h: number };   // 12-column grid; w 2..12, h 2..12
};
type Snapshot = { meta: Meta; tiles: Tile[] };
```

Limits: at most 40 tiles; title ≤ 200 characters; `freshnessMinutes` 1–1440 (default 15).

Starter content is created the first time `meta` is read and absent: title "Sales overview",
default filters `{ dateRange: { preset: "last30" }, locations: [] }`, and these tiles:

| Tile | Visual | Query |
|---|---|---|
| Net sales | kpi | metric `net_sales`, compare |
| Orders | kpi | metric `orders`, compare |
| Average order value | kpi | metric `average_order_value`, compare |
| Refunds | kpi | metric `refunds`, compare |
| Sales by day | line | metric `net_sales` by `day` |
| Top products | bar, sort value desc, limit 10 | metric `net_sales` by `product` |
| Sales by location | bar | metric `net_sales` by `location` |

## Data access modes

Computed on every call from `this.env`:

| `env.GADGET` | `env.RETAIL_DATA` | Mode | Behaviour |
|---|---|---|---|
| present | present | `live` | reads allowed |
| present | absent | `off` | `r:*` and `status` are deleted on first detection; no results returned |
| absent | — | `snapshot` | stored results served as they are; no reads, no writes |

A connection-gone error from any read switches the call to `off` handling.

## RPC

All mutations run in the `MutationQueue`, bump `meta.revision`, push an undo snapshot and
broadcast `changed`. Bad input throws a plain-language `Error`. In `snapshot` mode every mutating
method throws `This is a read-only copy of the dashboard.`

### For the UI

```ts
subscribe(callback: SubscriberCallbacks, client?: { clientId?: string }): Promise<Opened>;
open(): Promise<Opened>;
runTiles(args: { ids?: string[]; filters?: FilterValues; force?: boolean }): Promise<RunResult>;
undo(): Promise<Changed | null>;
redo(): Promise<Changed | null>;

type Opened = {
  meta: Meta; tiles: Tile[];
  data: DataStatus & { mode: "live" | "off" | "snapshot"; anchor?: string };
  /** Cached outcomes for the default filters, by tile id. */
  results: Record<string, QueryOutcome>;
  resolved?: ResolvedFilters;         // the default filters resolved against today's anchor
  canUndo: boolean; canRedo: boolean;
};
type RunResult = { resolved: ResolvedFilters; results: Record<string, QueryOutcome>; data: Opened["data"] };
interface SubscriberCallbacks {
  changed(event: Changed): unknown;     // { revision, meta, tiles, canUndo, canRedo, senderId? }
  results(event: { results: Record<string, QueryOutcome>; resolved: ResolvedFilters }): unknown;   // default filters only
}
```

- `subscribe`/`open` read the data status when the stored one is older than the freshness setting
  (or absent), never run tile queries themselves, and return whatever is cached.
- `runTiles` resolves `filters` (default: `meta.defaultFilters`) against the anchor, runs the named
  tiles (default: all with a query) with at most 4 in flight, and returns their outcomes. A tile
  whose cached outcome for the same resolved filters is younger than the freshness setting is not
  re-run unless `force`. A tile ignores a filter it does not list in `uses`, so changing that
  filter never re-runs it. Outcomes are cached; outcomes for the default filters are also
  broadcast as `results`. A tile's failure is that tile's outcome; it never fails the call.
- Filter values chosen by a viewer live in the viewer's page. They reach the server only as the
  `filters` argument of `runTiles`, are validated by `validateFilters`, and reach queries only
  through `runSavedQuery`'s bound parameters.

### For the agent (and the UI's edit mode)

| Method | Notes |
|---|---|
| `describeData()` | `{ data: DataStatus, tables, metrics, limits }` from `RetailData.describe()`, for writing queries. Throws a plain message when data is off. |
| `getDashboard()` | `{ meta, tiles, results }` (cached outcomes for the default filters). |
| `addTile({ title, visual, query?, uses?, layout? })` | Returns `{ tileId, revision }`. Without `layout` the tile takes the first free slot of its default size (kpi 3×2, charts 6×4, table 6×5, text 6×3). Validates with the library's validators. Runs nothing; call `runTiles` or `previewQuery`. |
| `updateTile({ id, title?, visual?, query?, uses?, layout? })` | Returns `{ revision, before, after }` (the tile before and after), so a query change can be shown and undone. Drops the tile's cached results when `query` or `uses` changed. |
| `removeTile({ id })` | Returns `{ revision }`. |
| `setLayout({ tiles: [{ id, x, y, w, h }] })` | Moves and resizes; clamps to the grid and pushes overlapped tiles down. |
| `setTitle({ title })`, `setDefaultFilters({ filters })`, `setFreshness({ minutes })` | Return `{ revision }`. |
| `previewQuery({ query, visual?, filters? })` | Runs a query without saving it and returns the outcome. |
| `runTiles(...)` | As above. |
| `undo()`, `redo()` | Shared history of structure changes (not of results). |

### Export

`ExportHandler.getExportFormats()` returns PDF in browser mode
(`{ id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" }`)
and CSV in server mode (`{ id: "csv", … ".csv" }`): one section per tile with a query, from cached
default-filter results, values as displayed, formula-leading text prefixed with `'`.

## UI behaviour (`client.ts`)

- **Header**: title, date-range control (the presets, plus a custom from/to pair), location
  multi-select (hidden with fewer than two locations), Refresh, "Updated <age>", Edit, Undo/Redo
  (edit mode).
- **Opening**: draws cached results at once with their age; then calls `runTiles()` for the
  default filters, which re-runs only stale tiles. While a tile runs it keeps its previous picture
  and shows a busy indicator (`aria-busy`).
- **Filters**: changing one calls `runTiles({ ids: <tiles that use it>, filters })`; other tiles
  are untouched. The selection is kept in the page only.
- **Tile**: title, visual, notes (truncated, partial, per-currency, incomplete period), a details
  disclosure (query text or metric and grouping, period, last ran, rows, duration) and "show as
  table". A failed tile shows the plain error and **Fix with agent**, which reveals and copies a
  request naming the dashboard, the tile and the error.
- **States**: `off` → "Retail data is not turned on for this organization. An administrator can
  turn it on under Connectors → Data." `empty` → "No sales data yet. Import a CSV or connect a
  source in Data, then refresh." `snapshot` → a "Read-only copy" badge; filters and Refresh are
  disabled. No grid of broken tiles in the `off` and `empty` states.
- **Incomplete period**: when the resolved `to` is after `completeThrough`, tiles that use the
  date range show "Data is complete through <date>".
- **Edit mode**: drag a tile by its header to move and by its corner to resize, snapping to the
  12-column grid; arrow keys move the focused tile and Shift+arrow keys resize it; a visual-type
  select lists `compatibleVisuals` for the tile's last result; rename; delete. Each change calls
  the matching RPC. Query text is read-only here: "Ask the agent to change this query".
- **Live updates**: `changed` replaces structure; `results` updates tiles when the viewer is on
  the default filters.
- **Export / print**: with `gadgetExportFormatId` set, or under `@media print`, the header controls
  are hidden, tiles flow in two columns, the light palette is forced, and the as-of time and
  filter summary are printed under the title. The module's top-level `await` resolves only after
  cached results are drawn.
- **Accessibility**: every control is a real button, select or input with a label; tiles are
  `section`s labelled by their title; charts are `role="img"` with the library's summary; focus is
  kept on the tile after a move or resize; status changes go to an `aria-live="polite"` region.

## Tests

| File | Proves |
|---|---|
| `server.test.ts` | starter content; add/update/remove/layout and their validation; `updateTile` returns before and after; undo and redo restore structure; `runTiles` re-runs only stale tiles and only tiles that use a changed filter; a failing tile does not fail the others; filter values with quotes and SQL reach the fake reader only as parameters; a write query is refused before the reader is called; off mode purges and withholds cached results; snapshot mode serves stored results and refuses mutations and reads; connection-gone switches to off; caps on tiles and cached entries |
| `layout.test.ts` | clamping, collision push-down, first free slot |
| `client.test.ts` (jsdom) | cached results render before any run; a filter change calls `runTiles` with only the tiles that use it; off and empty states show their message and no tiles; a failed tile shows the error and the hand-off text; charts carry `role="img"` and a summary; export mode hides controls |
