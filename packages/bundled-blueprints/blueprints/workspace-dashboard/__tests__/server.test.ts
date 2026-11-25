// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QueryOutcome,
  QueryResult,
  RetailDatasetDescription,
  RetailMetricName,
  RetailMetricQuery,
  RetailMetricResult,
  RetailQueryResult,
  RetailReader,
  SavedQuery,
  Scalar,
} from "@gadgets/bundled-blueprints/libraries/data/server";
import { overlaps } from "../files/lib/layout.ts";
import type { Changed, ResultsEvent, StoredResults, Tile } from "../files/lib/protocol.ts";
import { ExportHandler, Gadget } from "../files/server.ts";

// Durable Object storage in memory: just the calls the gadget makes, with values copied in and out
// as the real storage serializes them.
class MemoryStorage {
  map = new Map<string, unknown>();
  // The runtime's get, put and delete take at most 128 keys.
  static check(keys: unknown[]) { if (keys.length > 128) throw new Error("Too many keys in one storage call"); }
  async get(key: string | string[]): Promise<unknown> {
    if (!Array.isArray(key)) return structuredClone(this.map.get(key));
    MemoryStorage.check(key);
    return new Map(key.filter((k) => this.map.has(k)).map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    MemoryStorage.check(entries);
    for (const [k, v] of entries) this.map.set(k, structuredClone(v));
  }
  async delete(key: string | string[]): Promise<number> {
    if (Array.isArray(key)) MemoryStorage.check(key);
    return (Array.isArray(key) ? key : [key]).filter((k) => this.map.delete(k)).length;
  }
  async list({ prefix = "", limit }: { prefix?: string; limit?: number } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).toSorted().slice(0, limit);
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
  keys(prefix: string): string[] {
    return [...this.map.keys()].filter((key) => key.startsWith(prefix));
  }
}

const READ_ONLY = "This is a read-only copy of the dashboard.";
const DATA_OFF = /Retail data is not turned on for this organization/;
const LOCATIONS = [[1, "Downtown"], [2, "Airport"]];
const DESCRIPTION: RetailDatasetDescription = {
  tables: [{ name: "daily_sales", description: "Sales per business date.", columns: [{ name: "business_date", type: "date" }], rows: 300 }],
  metrics: [{ name: "net_sales", description: "Gross sales less discounts and refunds.", unit: "money", sql: "SELECT 1" }],
  personalDataMasked: true,
  dateRange: { from: "2026-01-01", to: "2026-11-20" },
  completeThrough: "2026-11-18",
  limits: { maxRows: 500, maxBytes: 100_000, maxParams: 100 },
};

/** The figures the scripted dataset holds, in minor units for money. */
const TOTALS: Partial<Record<RetailMetricName, number>> = { net_sales: 1_234_000, orders: 42, average_order_value: 29_381, refunds: 5_000 };
const MONEY: RetailMetricName[] = ["net_sales", "average_order_value", "refunds", "gross_sales", "discounts"];

/**
 * A scripted RETAIL_DATA: a plain object with the three read methods, which records every call
 * it receives. `fail` makes one metric throw; `description` and `sqlRows` can be swapped to
 * change what the dataset holds.
 */
function fakeRetail() {
  const calls = {
    describe: 0,
    run: [] as { sql: string; params: Scalar[] }[],
    metric: [] as { name: RetailMetricName; query: RetailMetricQuery }[],
  };
  const script = {
    description: DESCRIPTION as RetailDatasetDescription,
    describeError: null as Error | null,
    fail: new Map<RetailMetricName, Error>(),
    sqlRows: [["2026-11-01", "USD", 1000]] as Scalar[][],
    scale: 1,
  };
  const reader: RetailReader = {
    async describe() {
      calls.describe++;
      if (script.describeError) throw script.describeError;
      return script.description;
    },
    async run(sql, params = []): Promise<RetailQueryResult> {
      calls.run.push({ sql, params });
      if (/FROM locations/.test(sql)) return { columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }], rows: LOCATIONS, truncated: false };
      if (/FROM products/.test(sql)) {
        return {
          columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }, { name: "variant_name", type: "text" }],
          rows: params.map((id) => [id, `Product ${id}`, null]),
          truncated: false,
        };
      }
      return {
        columns: [{ name: "business_date", type: "date" }, { name: "currency", type: "text" }, { name: "net_amount", type: "money", currencyColumn: "currency" }],
        rows: script.sqlRows,
        truncated: false,
      };
    },
    async metric(name, query): Promise<RetailMetricResult> {
      calls.metric.push({ name, query });
      const failure = script.fail.get(name);
      if (failure) throw failure;
      const money = MONEY.includes(name);
      const total = (TOTALS[name] ?? 100) * script.scale;
      const keys = (query.groupBy ?? []).map((group) => (
        group === "location" ? { name: "location_id", type: "integer" as const }
          : group === "product" ? { name: "product_id", type: "integer" as const }
            : group === "day" ? { name: "day", type: "date" as const }
              : { name: group, type: "text" as const }
      ));
      const keyValues: Scalar[][] = keys.length === 0 ? [[]]
        : keys[0].name === "day" ? [[query.from], [query.to]]
          : keys[0].name === "location_id" ? [[1], [2]]
            : keys[0].name === "product_id" ? [[11], [12]]
              : [["a"], ["b"]];
      return {
        metric: { name, description: "", unit: money ? "money" : "count", sql: "" },
        columns: [
          ...keys,
          ...(money ? [{ name: "currency", type: "text" as const }] : []),
          money ? { name: "value", type: "money" as const, currencyColumn: "currency" } : { name: "value", type: "integer" as const },
        ],
        rows: keyValues.map((key, index) => [...key, ...(money ? ["USD"] : []), keys.length ? Math.round(total / (index + 2)) : total]),
      };
    },
  };
  const reset = () => {
    calls.describe = 0;
    calls.run.length = 0;
    calls.metric.length = 0;
  };
  /** The SQL queries received, leaving out the library's own reads of location and product names. */
  const queries = () => calls.run.filter((call) => !/FROM (locations|products)/.test(call.sql));
  return { reader, calls, script, reset, queries };
}

// The runtime's state and storage are far larger than what the gadget uses; `never` hands the
// in-memory stand-ins over without pretending to implement the rest.
function live(retail = fakeRetail(), storage = new MemoryStorage()) {
  return { gadget: new Gadget({ storage } as never, { RETAIL_DATA: retail.reader, GADGET: {} }), retail, storage };
}
/** The same gadget in a workspace whose retail data is off: its own binding, no dataset. */
const turnedOff = (storage: MemoryStorage) => new Gadget({ storage } as never, { GADGET: {} });
/** The gadget as a view-only share runs it: a copy of the storage and an empty environment. */
const readOnlyCopy = (storage: MemoryStorage) => new Gadget({ storage } as never, {});

// A subscriber as the RPC layer hands it to the server, recording what it hears.
function watcher() {
  const heard = { changed: [] as Changed[], results: [] as ResultsEvent[] };
  const subscriber = {
    changed: (event: Changed) => { heard.changed.push(event); },
    results: (event: ResultsEvent) => { heard.results.push(event); },
    dup() { return this; },
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  };
  return { subscriber, heard };
}

/** Removes every tile, so a test can build the few it reasons about. */
async function clear(gadget: Gadget): Promise<void> {
  for (const tile of (await gadget.getDashboard()).tiles) await gadget.removeTile({ id: tile.id });
}

const result = (outcome: QueryOutcome | undefined): QueryResult => {
  if (!outcome || "error" in outcome) throw new Error(`Expected a result, got ${JSON.stringify(outcome)}`);
  return outcome;
};
const byTitle = (tiles: Tile[], title: string): Tile => {
  const tile = tiles.find((each) => each.title === title);
  if (!tile) throw new Error(`No tile titled ${title}`);
  return tile;
};
const entries = (storage: MemoryStorage, id: string) => (storage.map.get("r:" + id) as StoredResults | undefined)?.entries ?? [];

const DATE_SQL = "SELECT business_date, currency, net_amount FROM daily_sales WHERE business_date BETWEEN :from AND :to";
const FIXED_SQL = "SELECT business_date, currency, net_amount FROM daily_sales LIMIT 5";
const MINUTE = 60_000;

// Only the clock is scripted (cache freshness and date presets read it); timers stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("starter content", () => {
  it("creates the Sales overview the first time the dashboard is read, and keeps it", async () => {
    const { gadget, storage } = live();
    const opened = await gadget.open();
    expect(opened.meta).toMatchObject({ revision: 0, title: "Sales overview", freshnessMinutes: 15, defaultFilters: { dateRange: { preset: "last30" }, locations: [] } });
    expect(opened.tiles.map((tile) => [tile.title, tile.visual.type, tile.query])).toEqual([
      ["Net sales", "kpi", { kind: "metric", metric: "net_sales", compare: true }],
      ["Orders", "kpi", { kind: "metric", metric: "orders", compare: true }],
      ["Average order value", "kpi", { kind: "metric", metric: "average_order_value", compare: true }],
      ["Refunds", "kpi", { kind: "metric", metric: "refunds", compare: true }],
      ["Sales by day", "line", { kind: "metric", metric: "net_sales", groupBy: ["day"] }],
      ["Top products", "bar", { kind: "metric", metric: "net_sales", groupBy: ["product"] }],
      ["Sales by location", "bar", { kind: "metric", metric: "net_sales", groupBy: ["location"] }],
    ]);
    expect(byTitle(opened.tiles, "Top products").visual).toEqual({ type: "bar", sort: { by: "value", dir: "desc" }, limit: 10 });
    for (const tile of opened.tiles) {
      expect(tile.id).toMatch(/^[a-z0-9]{8}$/);
      expect(tile.uses).toEqual(["dateRange", "locations"]);
    }
    expect(new Set(opened.tiles.map((tile) => tile.id)).size).toBe(7);
    opened.tiles.forEach((a, i) => opened.tiles.slice(i + 1).forEach((b) => expect(overlaps(a.layout, b.layout)).toBe(false)));
    expect(opened.meta.tileOrder).toEqual(opened.tiles.map((tile) => tile.id));
    expect(storage.keys("t:")).toHaveLength(7);

    const again = await new Gadget({ storage } as never, { RETAIL_DATA: fakeRetail().reader, GADGET: {} }).open();
    expect(again.tiles).toEqual(opened.tiles);
  });

  it("opens with the dataset's status and no results, without running a tile", async () => {
    const { gadget, retail } = live();
    const opened = await gadget.open();
    expect(opened.data).toMatchObject({
      status: "ok",
      mode: "live",
      anchor: "2026-11-20",
      completeThrough: "2026-11-18",
      locations: [{ id: 1, name: "Downtown" }, { id: 2, name: "Airport" }],
    });
    // The last 30 days count back from the last day with data, not from today.
    expect(opened.resolved).toEqual({ from: "2026-10-22", to: "2026-11-20", locations: [] });
    expect(opened.results).toEqual({});
    expect(opened).toMatchObject({ canUndo: false, canRedo: false });
    expect(retail.calls.metric).toEqual([]);
    expect(retail.queries()).toEqual([]);
  });

  it("reads the status again only once it is older than the freshness setting", async () => {
    const { gadget, retail } = live();
    await gadget.open();
    await gadget.open();
    expect(retail.calls.describe).toBe(1);
    vi.setSystemTime(Date.now() + 16 * MINUTE);
    await gadget.open();
    expect(retail.calls.describe).toBe(2);
  });

  it("says the dataset is empty when it has no orders yet", async () => {
    const retail = fakeRetail();
    retail.script.description = { ...DESCRIPTION, dateRange: null };
    const { gadget } = live(retail);
    expect((await gadget.open()).data).toEqual({ status: "empty", mode: "live" });
    const ran = await gadget.runTiles();
    expect(ran.results).toEqual({});
    expect(retail.calls.metric).toEqual([]);
    await expect(gadget.previewQuery({ query: { kind: "metric", metric: "orders" } })).rejects.toThrow(/No sales data yet/);
  });

  it("describes the dataset for writing queries", async () => {
    const { gadget } = live();
    const described = await gadget.describeData();
    expect(described.tables).toEqual(DESCRIPTION.tables);
    expect(described.metrics).toEqual(DESCRIPTION.metrics);
    expect(described.limits).toEqual(DESCRIPTION.limits);
    expect(described.data).toMatchObject({ status: "ok", dateRange: DESCRIPTION.dateRange, anchor: "2026-11-20" });
  });
});

describe("tiles", () => {
  it("adds a tile in the first free place of its default size", async () => {
    const { gadget } = live();
    await clear(gadget);
    const kpi = await gadget.addTile({ title: "  Units  ", visual: { type: "kpi" }, query: { kind: "metric", metric: "units_sold" } });
    const chart = await gadget.addTile({ title: "By day", visual: { type: "line" }, query: { kind: "metric", metric: "net_sales", groupBy: ["day"] } });
    await gadget.addTile({ title: "Rows", visual: { type: "table" }, query: { kind: "sql", sql: FIXED_SQL } });
    const note = await gadget.addTile({ title: "Note", visual: { type: "text", text: "# Read me" } });
    const { tiles, meta } = await gadget.getDashboard();
    expect(kpi.tileId).toMatch(/^[a-z0-9]{8}$/);
    expect(chart.revision).toBe(kpi.revision + 1);
    expect(meta.revision).toBe(note.revision);
    expect(tiles.map((tile) => [tile.title, tile.layout])).toEqual([
      ["Units", { x: 0, y: 0, w: 3, h: 2 }],
      ["By day", { x: 3, y: 0, w: 6, h: 4 }],
      ["Rows", { x: 0, y: 4, w: 6, h: 5 }],
      ["Note", { x: 6, y: 4, w: 6, h: 3 }],
    ]);
    // A tile uses the filters its query can react to, and a text tile has no query at all.
    expect(tiles.map((tile) => tile.uses)).toEqual([["dateRange", "locations"], ["dateRange", "locations"], [], []]);
    expect(byTitle(tiles, "Note").query).toBeUndefined();
    expect(tiles.every((tile) => tile.version === 1)).toBe(true);
  });

  it("puts a tile where it is asked to and moves what it covers down", async () => {
    const { gadget } = live();
    const { tileId } = await gadget.addTile({ title: "On top", visual: { type: "kpi" }, query: { kind: "metric", metric: "orders" }, layout: { x: 0, y: 0, w: 6, h: 2 } });
    const { tiles } = await gadget.getDashboard();
    expect(byTitle(tiles, "On top")).toMatchObject({ id: tileId, layout: { x: 0, y: 0, w: 6, h: 2 } });
    expect(byTitle(tiles, "Net sales").layout.y).toBe(2);
    tiles.forEach((a, i) => tiles.slice(i + 1).forEach((b) => expect(overlaps(a.layout, b.layout)).toBe(false)));
  });

  it("refuses a tile it cannot save, in plain words, and saves nothing", async () => {
    const { gadget } = live();
    const query = { kind: "metric", metric: "orders" } as const;
    await expect(gadget.addTile({ title: "   ", visual: { type: "kpi" }, query })).rejects.toThrow("A tile title must be 1 to 120 characters.");
    await expect(gadget.addTile({ title: "x".repeat(121), visual: { type: "kpi" }, query })).rejects.toThrow("A tile title must be 1 to 120 characters.");
    await expect(gadget.addTile({ title: "Pie", visual: { type: "pie" } as never, query })).rejects.toThrow(/visual's type "pie" is not one of/);
    await expect(gadget.addTile({ title: "No query", visual: { type: "bar" } })).rejects.toThrow("A bar tile needs a query.");
    await expect(gadget.addTile({ title: "Text", visual: { type: "text", text: "Hello" }, query })).rejects.toThrow(/A text tile has no query/);
    await expect(gadget.addTile({ title: "Metric", visual: { type: "kpi" }, query: { kind: "metric", metric: "profit" } as never })).rejects.toThrow(/not a standard metric/);
    await expect(gadget.addTile({ title: "Uses", visual: { type: "table" }, query: { kind: "sql", sql: DATE_SQL }, uses: ["locations"] }))
      .rejects.toThrow("This tile's query cannot react to the locations filter, so the tile cannot use it.");
    await expect(gadget.addTile({ title: "Layout", visual: { type: "kpi" }, query, layout: { x: "left" } as never })).rejects.toThrow(/A layout is \{ x, y, w, h \}/);
    await expect(gadget.addTile(null as never)).rejects.toThrow(/addTile needs/);
    const { tiles, meta } = await gadget.getDashboard();
    expect(tiles).toHaveLength(7);
    expect(meta.revision).toBe(0);
  });

  it("refuses a query that is not a single read before the dataset is ever called", async () => {
    const { gadget, retail } = live();
    await gadget.open();
    retail.reset();
    const write = { kind: "sql", sql: "DELETE FROM orders WHERE business_date BETWEEN :from AND :to" } as const;
    const stacked = { kind: "sql", sql: "SELECT 1; DROP TABLE orders" } as const;
    await expect(gadget.addTile({ title: "Write", visual: { type: "table" }, query: write })).rejects.toThrow("Only read queries can be saved.");
    await expect(gadget.addTile({ title: "Stacked", visual: { type: "table" }, query: stacked })).rejects.toThrow(/single statement/);
    await expect(gadget.previewQuery({ query: write })).rejects.toThrow("Only read queries can be saved.");
    const tile = (await gadget.getDashboard()).tiles[0];
    await expect(gadget.updateTile({ id: tile.id, query: write })).rejects.toThrow("Only read queries can be saved.");
    expect(retail.calls.run).toEqual([]);
    expect(retail.calls.metric).toEqual([]);
    expect((await gadget.getDashboard()).tiles[0]).toEqual(tile);
  });

  it("updates a tile and returns it before and after", async () => {
    const { gadget } = live();
    const tile = byTitle((await gadget.getDashboard()).tiles, "Net sales");
    const query: SavedQuery = { kind: "metric", metric: "net_sales", groupBy: ["location"] };
    const updated = await gadget.updateTile({ id: tile.id, title: "Net sales by location", visual: { type: "bar" }, query });
    expect(updated.before).toEqual(tile);
    expect(updated.after).toEqual({ ...tile, version: 2, title: "Net sales by location", visual: { type: "bar" }, query });
    expect(updated.revision).toBe(1);
    expect(byTitle((await gadget.getDashboard()).tiles, "Net sales by location")).toEqual(updated.after);
    await expect(gadget.updateTile({ id: "zzzzzzzz", title: "Nobody" })).rejects.toThrow(/There is no tile with the id zzzzzzzz/);
    await expect(gadget.updateTile({ id: "not an id", title: "Nobody" })).rejects.toThrow(/A tile id is the 8-character id/);
  });

  it("resets the filters a tile uses to what a new query can react to", async () => {
    const { gadget } = live();
    const tile = byTitle((await gadget.getDashboard()).tiles, "Orders");
    const narrowed = await gadget.updateTile({ id: tile.id, uses: ["dateRange"] });
    expect(narrowed.after.uses).toEqual(["dateRange"]);
    const retyped = await gadget.updateTile({ id: tile.id, visual: { type: "table" } });
    expect(retyped.after.uses).toEqual(["dateRange"]);
    const requeried = await gadget.updateTile({ id: tile.id, query: { kind: "sql", sql: FIXED_SQL } });
    expect(requeried.after.uses).toEqual([]);
  });

  it("removes a tile with its cached results", async () => {
    const { gadget, storage } = live();
    await gadget.runTiles();
    const tile = byTitle((await gadget.getDashboard()).tiles, "Refunds");
    expect(storage.map.has("r:" + tile.id)).toBe(true);
    await gadget.removeTile({ id: tile.id });
    const { tiles, meta, results } = await gadget.getDashboard();
    expect(tiles.map((each) => each.title)).not.toContain("Refunds");
    expect(meta.tileOrder).not.toContain(tile.id);
    expect(results[tile.id]).toBeUndefined();
    expect(storage.map.has("t:" + tile.id)).toBe(false);
    expect(storage.map.has("r:" + tile.id)).toBe(false);
    await expect(gadget.removeTile({ id: tile.id })).rejects.toThrow(/There is no tile/);
  });

  it("holds at most 40 tiles", async () => {
    const { gadget } = live();
    for (let i = 7; i < 40; i++) await gadget.addTile({ title: `Note ${i}`, visual: { type: "text", text: "." } });
    await expect(gadget.addTile({ title: "One too many", visual: { type: "text", text: "." } })).rejects.toThrow("A dashboard holds at most 40 tiles. Remove one before adding another.");
    expect((await gadget.getDashboard()).tiles).toHaveLength(40);
  });

  it("sets the title, the default filters and the freshness within their limits", async () => {
    const { gadget } = live();
    expect(await gadget.setTitle({ title: " Weekly trading " })).toEqual({ revision: 1 });
    expect(await gadget.setFreshness({ minutes: 60 })).toEqual({ revision: 2 });
    expect(await gadget.setDefaultFilters({ filters: { dateRange: { preset: "thisMonth" }, locations: [2, 2, 1] } })).toEqual({ revision: 3 });
    expect((await gadget.getDashboard()).meta).toMatchObject({
      title: "Weekly trading",
      freshnessMinutes: 60,
      defaultFilters: { dateRange: { preset: "thisMonth" }, locations: [2, 1] },
    });
    await expect(gadget.setTitle({ title: "" })).rejects.toThrow("The dashboard title must be 1 to 200 characters.");
    await expect(gadget.setTitle({ title: "x".repeat(201) })).rejects.toThrow("The dashboard title must be 1 to 200 characters.");
    await expect(gadget.setFreshness({ minutes: 0 })).rejects.toThrow("Freshness is a whole number of minutes from 1 to 1440.");
    await expect(gadget.setFreshness({ minutes: 1441 })).rejects.toThrow(/1 to 1440/);
    await expect(gadget.setFreshness({ minutes: 2.5 })).rejects.toThrow(/whole number/);
    await expect(gadget.setDefaultFilters({ filters: { dateRange: { preset: "forever" } as never, locations: [] } })).rejects.toThrow(/is not one of/);
    await expect(gadget.setDefaultFilters({ filters: { dateRange: { from: "2026-03-31", to: "2026-03-01" }, locations: [] } })).rejects.toThrow(/start date must not be after/);
    expect((await gadget.getDashboard()).meta.revision).toBe(3);
  });
});

describe("layout", () => {
  it("clamps what setLayout is given and moves covered tiles down", async () => {
    const { gadget } = live();
    const before = (await gadget.getDashboard()).tiles;
    const orders = byTitle(before, "Orders"), refunds = byTitle(before, "Refunds");
    // Orders is dropped on Net sales and made wider; Refunds is sent past the right edge.
    await gadget.setLayout({ tiles: [{ id: orders.id, x: 0, y: 0, w: 5.2, h: 1 }, { id: refunds.id, x: 40, y: 0, w: 3, h: 2 }] });
    const after = (await gadget.getDashboard()).tiles;
    expect(byTitle(after, "Orders").layout).toEqual({ x: 0, y: 0, w: 5, h: 2 });
    expect(byTitle(after, "Refunds").layout).toEqual({ x: 9, y: 0, w: 3, h: 2 });
    expect(byTitle(after, "Net sales").layout).toEqual({ x: 0, y: 2, w: 3, h: 2 });
    // The chart that sat under the headline row is pushed down in turn.
    expect(byTitle(after, "Sales by day").layout.y).toBe(4);
    after.forEach((a, i) => after.slice(i + 1).forEach((b) => expect(overlaps(a.layout, b.layout)).toBe(false)));
    expect(byTitle(after, "Orders").version).toBe(2);
    expect(byTitle(after, "Average order value")).toEqual(byTitle(before, "Average order value"));
  });

  it("refuses a layout for a tile that is not there, changing nothing", async () => {
    const { gadget } = live();
    const before = await gadget.getDashboard();
    await expect(gadget.setLayout({ tiles: [{ id: "zzzzzzzz", x: 0, y: 0, w: 3, h: 2 }] })).rejects.toThrow(/There is no tile/);
    await expect(gadget.setLayout({ tiles: [] })).rejects.toThrow(/at least one tile/);
    await expect(gadget.setLayout({ tiles: [{ id: before.tiles[0].id, x: 0, y: 0, w: Number.NaN, h: 2 }] })).rejects.toThrow(/each a number of grid units/);
    expect(await gadget.getDashboard()).toEqual(before);
  });
});

describe("undo and redo", () => {
  it("steps the structure back and forward, for everyone", async () => {
    const { gadget } = live();
    const { subscriber, heard } = watcher();
    const start = await gadget.subscribe(subscriber, { clientId: "page-1" });
    expect(await gadget.undo()).toBeNull();

    const added = await gadget.addTile({ title: "Units", visual: { type: "kpi" }, query: { kind: "metric", metric: "units_sold" }, clientId: "page-1" });
    await gadget.setTitle({ title: "Trading" });
    expect(heard.changed.map((event) => [event.revision, event.senderId, event.canUndo, event.canRedo])).toEqual([[1, "page-1", true, false], [2, undefined, true, false]]);

    const untitled = await gadget.undo({ clientId: "page-2" });
    expect(untitled).toMatchObject({ revision: 3, senderId: "page-2", canUndo: true, canRedo: true });
    expect(untitled?.meta.title).toBe("Sales overview");
    expect(untitled?.tiles).toHaveLength(8);

    const unadded = await gadget.undo();
    expect(unadded).toMatchObject({ revision: 4, canUndo: false, canRedo: true });
    expect(unadded?.tiles).toEqual(start.tiles);
    expect(await gadget.undo()).toBeNull();

    const readded = await gadget.redo();
    expect(readded?.tiles.map((tile) => tile.id)).toContain(added.tileId);
    expect(readded?.tiles.find((tile) => tile.id === added.tileId)).toMatchObject({ title: "Units", query: { kind: "metric", metric: "units_sold" } });
    const retitled = await gadget.redo();
    expect(retitled).toMatchObject({ revision: 6, canUndo: true, canRedo: false });
    expect(retitled?.meta.title).toBe("Trading");
    expect(await gadget.redo()).toBeNull();

    // Every step reached the subscriber, and what is stored is what the last step returned.
    expect(heard.changed.map((event) => event.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    const stored = await gadget.getDashboard();
    expect(stored.meta).toEqual(retitled?.meta);
    expect(stored.tiles).toEqual(retitled?.tiles);
  });

  it("forgets the steps ahead once something new is changed", async () => {
    const { gadget } = live();
    await gadget.setTitle({ title: "One" });
    await gadget.undo();
    await gadget.setTitle({ title: "Two" });
    expect(await gadget.redo()).toBeNull();
    expect((await gadget.open()).canRedo).toBe(false);
  });

  it("restores a moved layout and a changed query, dropping results the restored query did not produce", async () => {
    const { gadget, storage } = live();
    await gadget.runTiles();
    const tile = byTitle((await gadget.getDashboard()).tiles, "Orders");
    await gadget.setLayout({ tiles: [{ id: tile.id, x: 3, y: 0, w: 3, h: 4 }] });
    await gadget.updateTile({ id: tile.id, query: { kind: "metric", metric: "units_sold" } });
    await gadget.runTiles();
    expect(entries(storage, tile.id)).toHaveLength(1);

    const requeried = await gadget.undo();
    const restored = requeried?.tiles.find((each) => each.id === tile.id);
    expect(restored).toMatchObject({ query: tile.query, layout: { x: 3, y: 0, w: 3, h: 4 } });
    expect(restored?.version).toBeGreaterThan(tile.version);
    expect(entries(storage, tile.id)).toEqual([]);

    const moved = await gadget.undo();
    expect(moved?.tiles.find((each) => each.id === tile.id)).toMatchObject({ layout: tile.layout });
    expect(moved?.tiles.map((each) => each.layout)).toEqual((await gadget.getDashboard()).tiles.map((each) => each.layout));
  });
});

describe("running tiles", () => {
  it("fills the starter tiles with the dataset's figures and caches them", async () => {
    const { gadget, retail } = live();
    const { tiles } = await gadget.getDashboard();
    const ran = await gadget.runTiles();
    expect(ran.resolved).toEqual({ from: "2026-10-22", to: "2026-11-20", locations: [] });
    expect(Object.keys(ran.results).toSorted()).toEqual(tiles.map((tile) => tile.id).toSorted());

    const netSales = result(ran.results[byTitle(tiles, "Net sales").id]);
    expect(netSales.rows).toEqual([["USD", 1_234_000]]);
    expect(netSales.previous).toMatchObject({ from: "2026-09-22", to: "2026-10-21", rows: [["USD", 1_234_000]] });
    expect(netSales.period).toEqual({ from: "2026-10-22", to: "2026-11-20" });
    expect(result(ran.results[byTitle(tiles, "Orders").id]).rows).toEqual([[42]]);
    expect(result(ran.results[byTitle(tiles, "Average order value").id]).rows).toEqual([["USD", 29_381]]);
    expect(result(ran.results[byTitle(tiles, "Refunds").id]).rows).toEqual([["USD", 5_000]]);
    // Ids are shown as names.
    expect(result(ran.results[byTitle(tiles, "Sales by location").id]).rows.map((row) => row[0])).toEqual(["Downtown", "Airport"]);
    expect(result(ran.results[byTitle(tiles, "Top products").id]).rows.map((row) => row[0])).toEqual(["Product 11", "Product 12"]);

    // Standard figures come from the dataset's shared metrics: four compared, three broken down.
    expect(retail.calls.metric).toHaveLength(11);
    expect(retail.queries()).toEqual([]);
    expect((await gadget.open()).results).toEqual(ran.results);
    expect((await gadget.getDashboard()).results).toEqual(ran.results);
  });

  it("re-runs only tiles whose cached outcome is older than the freshness setting, unless forced", async () => {
    const { gadget, retail } = live();
    await clear(gadget);
    const first = await gadget.addTile({ title: "Orders", visual: { type: "kpi" }, query: { kind: "metric", metric: "orders" } });
    await gadget.runTiles();
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    const second = await gadget.addTile({ title: "Units", visual: { type: "kpi" }, query: { kind: "metric", metric: "units_sold" } });
    await gadget.runTiles();
    expect(retail.calls.metric.map((call) => call.name)).toEqual(["orders", "units_sold"]);

    // Ten minutes later the first outcome is 20 minutes old and the second 10.
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    retail.reset();
    const ran = await gadget.runTiles();
    expect(retail.calls.metric.map((call) => call.name)).toEqual(["orders"]);
    expect(result(ran.results[first.tileId]).ranAt).toBe(Date.now());
    expect(result(ran.results[second.tileId]).ranAt).toBe(Date.now() - 10 * MINUTE);

    retail.reset();
    await gadget.runTiles();
    expect(retail.calls.metric).toEqual([]);
    await gadget.runTiles({ force: true });
    expect(retail.calls.metric.map((call) => call.name).toSorted()).toEqual(["orders", "units_sold"]);
    // A forced run reads the dataset's status afresh too, so an import that just landed shows.
    expect(retail.calls.describe).toBe(1);
  });

  it("runs only the tiles it is asked for", async () => {
    const { gadget, retail } = live();
    const { tiles } = await gadget.getDashboard();
    const orders = byTitle(tiles, "Orders");
    const ran = await gadget.runTiles({ ids: [orders.id, "zzzzzzzz"] });
    expect(Object.keys(ran.results)).toEqual([orders.id]);
    expect(retail.calls.metric.map((call) => call.name)).toEqual(["orders", "orders"]);
  });

  it("re-runs only the tiles that use the filter that changed, with the new values as parameters", async () => {
    const { gadget, retail } = live();
    await clear(gadget);
    const dated = await gadget.addTile({ title: "By date", visual: { type: "table" }, query: { kind: "sql", sql: DATE_SQL } });
    const both = await gadget.addTile({ title: "Orders", visual: { type: "kpi" }, query: { kind: "metric", metric: "orders" } });
    const fixed = await gadget.addTile({ title: "Fixed", visual: { type: "table" }, query: { kind: "sql", sql: FIXED_SQL } });
    const all = [dated.tileId, both.tileId, fixed.tileId].toSorted();
    await gadget.runTiles();
    expect(retail.queries()).toHaveLength(2);
    expect(retail.calls.metric).toHaveLength(1);

    // A location is picked: the SQL tiles do not read locations, so only the metric runs.
    retail.reset();
    const located = await gadget.runTiles({ filters: { dateRange: { preset: "last30" }, locations: [2] } });
    expect(retail.queries()).toEqual([]);
    expect(retail.calls.metric).toEqual([{ name: "orders", query: { from: "2026-10-22", to: "2026-11-20", locationIds: [2] } }]);
    expect(located.resolved).toEqual({ from: "2026-10-22", to: "2026-11-20", locations: [2] });
    expect(Object.keys(located.results).toSorted()).toEqual(all);

    // The range changes: the two tiles that read dates run, the fixed one never does.
    retail.reset();
    const ranged = await gadget.runTiles({ filters: { dateRange: { from: "2026-03-01", to: "2026-03-31" }, locations: [] } });
    expect(retail.calls.metric).toEqual([{ name: "orders", query: { from: "2026-03-01", to: "2026-03-31" } }]);
    expect(retail.queries()).toEqual([{ sql: "SELECT business_date, currency, net_amount FROM daily_sales WHERE business_date BETWEEN ? AND ?", params: ["2026-03-01", "2026-03-31"] }]);
    expect(result(ranged.results[dated.tileId]).period).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    // The tile that uses no filter keeps the dashboard's default period whatever the viewer picks.
    expect(result(ranged.results[fixed.tileId]).period).toEqual({ from: "2026-10-22", to: "2026-11-20" });
  });

  it("caches a viewer's filters beside the default ones, up to the cap, and broadcasts only the default ones", async () => {
    const { gadget, retail, storage } = live();
    await clear(gadget);
    const { tileId } = await gadget.addTile({ title: "Orders", visual: { type: "kpi" }, query: { kind: "metric", metric: "orders" } });
    const { subscriber, heard } = watcher();
    await gadget.subscribe(subscriber);

    const ran = await gadget.runTiles();
    expect(heard.results).toEqual([{ results: { [tileId]: ran.results[tileId] }, resolved: { from: "2026-10-22", to: "2026-11-20", locations: [] } }]);

    for (let location = 1; location <= 10; location++) await gadget.runTiles({ filters: { dateRange: { preset: "last30" }, locations: [location] } });
    expect(heard.results).toHaveLength(1);
    const cached = entries(storage, tileId);
    expect(cached).toHaveLength(9);
    // The default outcome stays first; of the others the eight most recent are kept, newest first.
    expect(cached[0].outcome).toEqual(ran.results[tileId]);
    expect(cached.slice(1).map((entry) => entry.key)).toEqual([10, 9, 8, 7, 6, 5, 4, 3].map((location) => `2026-10-22..2026-11-20|${location}`));
    expect((await gadget.open()).results).toEqual({ [tileId]: ran.results[tileId] });

    // A cached selection is answered from the cache; one that fell out of it is read again.
    retail.reset();
    await gadget.runTiles({ filters: { dateRange: { preset: "last30" }, locations: [10] } });
    expect(retail.calls.metric).toEqual([]);
    await gadget.runTiles({ filters: { dateRange: { preset: "last30" }, locations: [1] } });
    expect(retail.calls.metric).toHaveLength(1);
    // Asking for the default filters by value is the default run, and its outcome is shared.
    vi.setSystemTime(Date.now() + MINUTE);
    await gadget.runTiles({ filters: { dateRange: { preset: "last30" }, locations: [] }, force: true });
    expect(heard.results).toHaveLength(2);
  });

  it("keeps a failing tile's error to that tile", async () => {
    const retail = fakeRetail();
    retail.script.fail.set("refunds", new Error("Error: no such column: refund_total\n    at run (dataset.js:10:3)"));
    const { gadget } = live(retail);
    const { tiles } = await gadget.getDashboard();
    const ran = await gadget.runTiles();
    const failed = ran.results[byTitle(tiles, "Refunds").id];
    expect(failed).toMatchObject({ error: "no such column: refund_total", period: { from: "2026-10-22", to: "2026-11-20" } });
    for (const tile of tiles.filter((each) => each.title !== "Refunds")) expect(result(ran.results[tile.id]).rows.length).toBeGreaterThan(0);
    expect(result(ran.results[byTitle(tiles, "Net sales").id]).rows).toEqual([["USD", 1_234_000]]);
    // The failure is the tile's cached outcome, shown to whoever opens the dashboard next.
    expect((await gadget.open()).results[byTitle(tiles, "Refunds").id]).toEqual(failed);
  });

  it("passes hostile values to the dataset only as bound parameters", async () => {
    const { gadget, retail } = live();
    await clear(gadget);
    const sql = `${DATE_SQL} AND location_id IN (:locations) AND channel = :needle`;
    const hostile = "'; DROP TABLE orders;--";
    const plain = await gadget.addTile({ title: "Plain", visual: { type: "table" }, query: { kind: "sql", sql, params: { needle: "web" } } });
    const attack = await gadget.addTile({ title: "Attack", visual: { type: "table" }, query: { kind: "sql", sql, params: { needle: hostile } } });
    retail.reset();
    await gadget.runTiles({ ids: [plain.tileId] });
    await gadget.runTiles({ ids: [attack.tileId] });
    const [benign, bound] = retail.queries();
    expect(bound.params).toEqual(["2026-10-22", "2026-11-20", 1, 2, hostile]);
    expect(benign.params).toEqual(["2026-10-22", "2026-11-20", 1, 2, "web"]);
    // The text sent is the same whatever the value: only placeholders stand where values go.
    expect(bound.sql).toBe(benign.sql);
    for (const part of ["DROP", "orders;", "'", "--"]) expect(bound.sql).not.toContain(part);

    // The same through the preview, with a value that tries to close the IN list.
    retail.reset();
    const breakout = "1) OR (1=1";
    await gadget.previewQuery({ query: { kind: "sql", sql, params: { needle: breakout } }, filters: { dateRange: { from: "2026-03-01", to: "2026-03-31" }, locations: [2] } });
    const [previewed] = retail.queries();
    expect(previewed.sql).toBe(benign.sql.replace("?, ?", "?"));
    expect(previewed.params).toEqual(["2026-03-01", "2026-03-31", 2, breakout]);
    expect(previewed.sql).not.toContain("1=1");
    expect(previewed.sql).not.toContain("2026-03-01");
  });

  it("refuses filter values that are not dates or location ids before any read", async () => {
    const { gadget, retail } = live();
    await gadget.open();
    retail.reset();
    const hostileDate = { dateRange: { from: "2026-03-01' OR '1'='1", to: "2026-03-31" }, locations: [] };
    const hostileLocation = { dateRange: { preset: "last30" }, locations: ["1) OR (1=1"] };
    await expect(gadget.runTiles({ filters: hostileDate })).rejects.toThrow(/must be a real date written YYYY-MM-DD/);
    await expect(gadget.runTiles({ filters: hostileLocation as never })).rejects.toThrow(/location ids, which are whole numbers/);
    await expect(gadget.previewQuery({ query: { kind: "metric", metric: "orders" }, filters: hostileDate })).rejects.toThrow(/real date/);
    await expect(gadget.setDefaultFilters({ filters: hostileDate })).rejects.toThrow(/real date/);
    expect(retail.calls.run).toEqual([]);
    expect(retail.calls.metric).toEqual([]);
  });

  it("previews a query without saving it or caching its result", async () => {
    const { gadget, storage } = live();
    const before = await gadget.getDashboard();
    const outcome = await gadget.previewQuery({ query: { kind: "metric", metric: "net_sales", groupBy: ["location"] }, visual: { type: "bar", sort: { by: "value", dir: "asc" }, limit: 1 } });
    expect(result(outcome).rows).toEqual([["Airport", "USD", 411_333]]);
    expect(await gadget.getDashboard()).toEqual(before);
    expect(storage.keys("r:")).toEqual([]);
  });

  it("keeps cached results through a change of visual type, and drops them when the query changes", async () => {
    const { gadget, retail, storage } = live();
    await gadget.runTiles();
    const { tiles } = await gadget.getDashboard();
    const byDay = byTitle(tiles, "Sales by day");
    const before = entries(storage, byDay.id);
    retail.reset();

    await gadget.updateTile({ id: byDay.id, visual: { type: "area" }, title: "Daily sales" });
    expect(entries(storage, byDay.id)).toEqual(before);
    await gadget.runTiles();
    expect(retail.calls.metric).toEqual([]);
    expect(retail.calls.run).toEqual([]);

    // A limit changes which rows the result holds, so it is a different question.
    await gadget.updateTile({ id: byDay.id, visual: { type: "area", limit: 1 } });
    expect(entries(storage, byDay.id)).toEqual([]);
    await gadget.runTiles();
    expect(retail.calls.metric.map((call) => call.query.groupBy)).toEqual([["day"]]);

    retail.reset();
    await gadget.updateTile({ id: byDay.id, query: { kind: "metric", metric: "net_sales", groupBy: ["week"] } });
    expect(entries(storage, byDay.id)).toEqual([]);
    await gadget.updateTile({ id: byDay.id, uses: ["dateRange"] });
    await gadget.runTiles();
    expect(retail.calls.metric.map((call) => call.query.groupBy)).toEqual([["week"]]);
    // Only this tile's cache was touched.
    expect(storage.keys("r:")).toHaveLength(7);
  });

  it("stops showing the old default results once the default filters change", async () => {
    const { gadget, retail } = live();
    await clear(gadget);
    const { tileId } = await gadget.addTile({ title: "Orders", visual: { type: "kpi" }, query: { kind: "metric", metric: "orders" } });
    const viewed = await gadget.runTiles({ filters: { dateRange: { preset: "last7" }, locations: [] } });
    await gadget.runTiles();
    await gadget.setDefaultFilters({ filters: { dateRange: { preset: "last7" }, locations: [] } });
    expect((await gadget.open()).results).toEqual({});

    // What a viewer already ran under the new defaults is fresh, so it is used instead of a read.
    retail.reset();
    const { subscriber, heard } = watcher();
    await gadget.subscribe(subscriber);
    const ran = await gadget.runTiles();
    expect(retail.calls.metric).toEqual([]);
    expect(ran.results[tileId]).toEqual(viewed.results[tileId]);
    expect(ran.resolved).toEqual({ from: "2026-11-14", to: "2026-11-20", locations: [] });
    expect((await gadget.open()).results).toEqual({ [tileId]: viewed.results[tileId] });
    expect(heard.results).toHaveLength(1);
  });
});

describe("data access modes", () => {
  it("deletes and withholds cached results once retail data is off", async () => {
    const { gadget, storage } = live();
    await gadget.runTiles();
    expect(storage.keys("r:")).toHaveLength(7);
    expect(storage.map.has("status")).toBe(true);

    const off = turnedOff(storage);
    const opened = await off.open();
    expect(opened.data).toEqual({ status: "off", mode: "off" });
    expect(opened.results).toEqual({});
    expect(opened.resolved).toBeUndefined();
    // The structure is the member's own work and stays.
    expect(opened.tiles).toHaveLength(7);
    expect(storage.keys("r:")).toEqual([]);
    expect(storage.map.has("status")).toBe(false);

    expect((await off.getDashboard()).results).toEqual({});
    expect(await off.runTiles({ force: true })).toMatchObject({ results: {}, data: { status: "off", mode: "off" } });
    await expect(off.describeData()).rejects.toThrow(DATA_OFF);
    await expect(off.previewQuery({ query: { kind: "metric", metric: "orders" } })).rejects.toThrow(DATA_OFF);
    expect(await off.setTitle({ title: "Still editable" })).toEqual({ revision: 1 });
  });

  it("purges on whichever call first finds the data off", async () => {
    const { gadget, storage } = live();
    await gadget.runTiles();
    expect((await turnedOff(storage).getDashboard()).results).toEqual({});
    expect(storage.keys("r:")).toEqual([]);
    expect(storage.map.has("status")).toBe(false);
  });

  it("serves a read-only copy from what was stored, and refuses changes and reads", async () => {
    const { gadget, storage } = live();
    const ran = await gadget.runTiles();
    const { tiles } = await gadget.getDashboard();
    const stored = JSON.stringify([...storage.map]);

    // The copy is opened days later: its results and its period are the ones it was made with.
    vi.setSystemTime(Date.now() + 3 * 24 * 60 * MINUTE);
    const copy = readOnlyCopy(storage);
    const opened = await copy.open();
    expect(opened.data).toMatchObject({ status: "ok", mode: "snapshot", anchor: "2026-11-20" });
    expect(opened.results).toEqual(ran.results);
    expect(opened.resolved).toEqual(ran.resolved);
    expect(opened).toMatchObject({ canUndo: false, canRedo: false });
    expect((await copy.getDashboard()).results).toEqual(ran.results);
    expect((await copy.runTiles({ force: true })).results).toEqual(ran.results);
    expect((await copy.runTiles({ filters: { dateRange: { preset: "last7" }, locations: [] } })).results).toEqual({});

    const id = tiles[0].id;
    const changes: (() => Promise<unknown>)[] = [
      () => copy.addTile({ title: "New", visual: { type: "text", text: "." } }),
      () => copy.updateTile({ id, title: "Renamed" }),
      () => copy.removeTile({ id }),
      () => copy.setLayout({ tiles: [{ id, x: 1, y: 0, w: 3, h: 2 }] }),
      () => copy.setTitle({ title: "Mine now" }),
      () => copy.setDefaultFilters({ filters: { dateRange: { preset: "last7" }, locations: [] } }),
      () => copy.setFreshness({ minutes: 5 }),
      () => copy.undo(),
      () => copy.redo(),
      () => copy.describeData(),
      () => copy.previewQuery({ query: { kind: "metric", metric: "orders" } }),
    ];
    for (const attempt of changes) await expect(attempt()).rejects.toThrow(READ_ONLY);
    expect(JSON.stringify([...storage.map])).toBe(stored);
  });

  it("gives a read-only copy made before anything was stored the starter layout, without storing it", async () => {
    const storage = new MemoryStorage();
    const copy = readOnlyCopy(storage);
    const opened = await copy.open();
    expect(opened.data).toMatchObject({ status: "error", mode: "snapshot" });
    expect(opened.tiles).toHaveLength(7);
    expect((await copy.open()).tiles).toEqual(opened.tiles);
    expect(storage.map.size).toBe(0);
  });

  it("treats a connection that is gone as the data being off", async () => {
    const { gadget, retail, storage } = live();
    await gadget.runTiles();
    retail.script.fail.set("orders", new Error("The gatekeeper connection has been removed."));
    const ran = await gadget.runTiles({ force: true });
    expect(ran.data).toEqual({ status: "off", mode: "off" });
    expect(ran.results).toEqual({});
    expect(storage.keys("r:")).toEqual([]);
    expect(storage.map.has("status")).toBe(false);
    expect((await gadget.getDashboard()).results).toEqual({});

    // The same when it is the status read, or a preview, that finds it gone.
    const next = live();
    await next.gadget.runTiles();
    next.retail.script.describeError = new Error("No such gatekeeper: retail");
    vi.setSystemTime(Date.now() + 16 * MINUTE);
    expect((await next.gadget.open()).data).toEqual({ status: "off", mode: "off" });
    expect(next.storage.keys("r:")).toEqual([]);
    await expect(next.gadget.describeData()).rejects.toThrow(DATA_OFF);
  });

  it("reports a dataset error without discarding what is cached", async () => {
    const { gadget, retail } = live();
    const ran = await gadget.runTiles();
    retail.script.describeError = new Error("The dataset is busy. Try again in a moment.");
    vi.setSystemTime(Date.now() + 16 * MINUTE);
    const opened = await gadget.open();
    expect(opened.data).toEqual({ status: "error", error: "The dataset is busy. Try again in a moment.", mode: "live" });
    expect(opened.results).toEqual(ran.results);
    await expect(gadget.describeData()).rejects.toThrow("The dataset is busy. Try again in a moment.");
  });
});

describe("export", () => {
  const handler = () => new ExportHandler({} as never, {} as never);
  // Decoded by hand: reading the stream as text would drop the byte order mark the file starts with.
  const text = async (stream: ReadableStream<Uint8Array>) => new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(await new Response(stream).arrayBuffer());

  it("offers PDF from the page and CSV from the server", async () => {
    expect(await handler().getExportFormats()).toEqual([
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
      { id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv" },
    ]);
    await expect(handler().export(live().gadget, "xlsx")).rejects.toThrow("Unsupported dashboard export format: xlsx");
  });

  it("writes one CSV section per tile with a query, with values as the tiles show them", async () => {
    const { gadget, retail } = live();
    await clear(gadget);
    await gadget.addTile({ title: "Net sales", visual: { type: "kpi" }, query: { kind: "metric", metric: "net_sales", compare: true } });
    await gadget.addTile({ title: "=SUM(A1)", visual: { type: "table" }, query: { kind: "sql", sql: DATE_SQL } });
    await gadget.addTile({ title: "A note", visual: { type: "text", text: "Not data" } });
    await gadget.addTile({ title: "Never run", visual: { type: "kpi" }, query: { kind: "metric", metric: "units_sold" } });
    retail.script.sqlRows = [["2026-11-01", "USD", 129_900], ["2026-11-02", "USD", -500], ["2026-11-03", "+1 (555) 0100", null]];
    const { tiles } = await gadget.getDashboard();
    await gadget.runTiles({ ids: tiles.filter((tile) => tile.title !== "Never run").map((tile) => tile.id) });
    retail.reset();

    const csv = await text(await handler().export(gadget, "csv"));
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual([
      "Net sales,22 Oct – 20 Nov 2026",
      "Currency,Value",
      'USD,"$12,340.00"',
      "Previous period,22 Sep – 21 Oct 2026",
      'USD,"$12,340.00"',
      "",
      // Text a spreadsheet would run is marked as text; a negative amount is left a number.
      "'=SUM(A1),22 Oct – 20 Nov 2026",
      "Business date,Currency,Net amount",
      '1 Nov 2026,USD,"$1,299.00"',
      "2 Nov 2026,USD,-$5.00",
      "3 Nov 2026,'+1 (555) 0100,–",
      "",
      "Never run,",
      "No result yet. Open the dashboard to run this tile.",
      "",
      "",
    ]);
    // An export is written from the cache: it reads nothing.
    expect(retail.calls.run).toEqual([]);
    expect(retail.calls.metric).toEqual([]);
  });
});
