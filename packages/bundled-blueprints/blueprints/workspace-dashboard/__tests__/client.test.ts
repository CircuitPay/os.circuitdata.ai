// The Dashboard page in a jsdom document, against a scripted `gadget` stub: what it draws from
// what the server hands it, and what it asks the server for. The module runs on import (it builds
// its page and connects), so each test imports a fresh copy.
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryFailure, QueryResult } from "@gadgets/bundled-blueprints/libraries/data/client";
import type { Changed, DataState, GadgetStub, Meta, Opened, RunResult, SubscriberCallbacks, Tile } from "../files/lib/protocol.ts";

/** A promise with its resolver, for replies the test releases. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
// The page's timers run on a scripted clock (see beforeEach). One step of it lets the replies in
// flight land and be drawn, and fires none of the page's own timers, which are all longer.
const settle = () => vi.advanceTimersByTimeAsync(1);
/** Longer than the pause the location picker waits out before it runs the tiles. */
const LOCATION_PAUSE_MS = 400;

const PERIOD = { from: "2026-10-22", to: "2026-11-20" };
const RESOLVED = { ...PERIOD, locations: [] };
const DATA_OFF = "Retail data is not turned on for this organization. An administrator can turn it on under Connectors → Data.";
const DATA_EMPTY = "No sales data yet. Import a CSV or connect a source in Data, then refresh.";
const SQL = "SELECT product, units FROM daily_product_sales LIMIT 5";

// Results cached a little over five minutes ago.
const cachedAt = () => Date.now() - 5 * 60_000 - 5_000;

function kpiResult(minorUnits: number, ranAt = cachedAt()): QueryResult {
  return {
    columns: [{ name: "currency", type: "text" }, { name: "value", type: "money", currencyColumn: "currency" }],
    rows: [["USD", minorUnits]],
    previous: { from: "2026-09-22", to: "2026-10-21", rows: [["USD", 1_000_000]] },
    truncated: false,
    period: PERIOD,
    ranAt,
    durationMs: 42,
    rowCount: 1,
  };
}
function lineResult(ranAt = cachedAt()): QueryResult {
  return {
    columns: [{ name: "day", type: "date" }, { name: "currency", type: "text" }, { name: "value", type: "money", currencyColumn: "currency" }],
    rows: [["2026-11-18", "USD", 40_000], ["2026-11-19", "USD", 55_000], ["2026-11-20", "USD", 61_000]],
    truncated: false,
    period: PERIOD,
    ranAt,
    durationMs: 1_500,
    rowCount: 3,
  };
}
function tableResult(ranAt = cachedAt()): QueryResult {
  return {
    columns: [{ name: "product", type: "text" }, { name: "units", type: "integer" }],
    rows: [["Espresso", 12], ["Flat white", 7]],
    truncated: false,
    period: PERIOD,
    ranAt,
    durationMs: 8,
    rowCount: 2,
  };
}
function failure(error: string): QueryFailure {
  return { error, ranAt: cachedAt(), durationMs: 3, period: PERIOD };
}

// Three tiles that differ in the filters they use: both, the date range only, and none.
const KPI: Tile = {
  id: "kpi00001", version: 1, title: "Net sales", visual: { type: "kpi" },
  query: { kind: "metric", metric: "net_sales", compare: true },
  uses: ["dateRange", "locations"], layout: { x: 0, y: 0, w: 3, h: 2 },
};
const LINE: Tile = {
  id: "line0001", version: 1, title: "Sales by day", visual: { type: "line" },
  query: { kind: "metric", metric: "net_sales", groupBy: ["day"] },
  uses: ["dateRange"], layout: { x: 0, y: 2, w: 12, h: 4 },
};
const TABLE: Tile = {
  id: "table001", version: 1, title: "Top sellers", visual: { type: "table" },
  query: { kind: "sql", sql: SQL },
  uses: [], layout: { x: 0, y: 6, w: 6, h: 5 },
};
const META: Meta = {
  revision: 4,
  title: "Sales overview",
  freshnessMinutes: 15,
  defaultFilters: { dateRange: { preset: "last30" }, locations: [] },
  tileOrder: [KPI.id, LINE.id, TABLE.id],
  lastModified: 0,
};
const LIVE = {
  status: "ok",
  mode: "live",
  anchor: "2026-11-20",
  dateRange: { from: "2026-01-01", to: "2026-11-20" },
  completeThrough: "2026-11-20",
  personalDataMasked: true,
  locations: [{ id: 1, name: "Downtown" }, { id: 2, name: "Airport" }],
} satisfies DataState;

function opened(overrides: Partial<Opened> = {}): Opened {
  return {
    meta: META,
    tiles: [KPI, LINE, TABLE],
    data: LIVE,
    results: { [KPI.id]: kpiResult(1_234_000), [LINE.id]: lineResult(), [TABLE.id]: tableResult() },
    resolved: RESOLVED,
    canUndo: false,
    canRedo: false,
    ...overrides,
  };
}

interface Harness {
  /** The page's subscriber, for events the test delivers. Absent when the page never subscribed. */
  callbacks: SubscriberCallbacks | null;
  gadget: { [K in keyof GadgetStub]: Mock<GadgetStub[K]> };
}

interface LoadOptions {
  /** The browser-mode export being made, as the export renderer sets it. */
  exportFormat?: string;
  runTiles?: GadgetStub["runTiles"];
}

async function loadClient(state: Opened, options: LoadOptions = {}): Promise<Harness> {
  const harness: Harness = {
    callbacks: null,
    gadget: {
      subscribe: vi.fn<GadgetStub["subscribe"]>(async (callback) => {
        harness.callbacks = callback;
        return state;
      }),
      open: vi.fn<GadgetStub["open"]>(async () => state),
      // By default the server has nothing newer than what the page was opened with.
      runTiles: vi.fn<GadgetStub["runTiles"]>(options.runTiles ?? (async (): Promise<RunResult> => ({ resolved: RESOLVED, results: {}, data: state.data }))),
      undo: vi.fn<GadgetStub["undo"]>(async () => null),
      redo: vi.fn<GadgetStub["redo"]>(async () => null),
      describeData: vi.fn<GadgetStub["describeData"]>(async () => { throw new Error("The page does not describe the dataset."); }),
      getDashboard: vi.fn<GadgetStub["getDashboard"]>(async () => ({ meta: state.meta, tiles: state.tiles, results: state.results })),
      addTile: vi.fn<GadgetStub["addTile"]>(async () => { throw new Error("The page does not add tiles."); }),
      updateTile: vi.fn<GadgetStub["updateTile"]>(async ({ id }) => {
        const tile = state.tiles.find((each) => each.id === id) ?? KPI;
        return { revision: state.meta.revision, before: tile, after: tile };
      }),
      removeTile: vi.fn<GadgetStub["removeTile"]>(async () => ({ revision: state.meta.revision })),
      setLayout: vi.fn<GadgetStub["setLayout"]>(async () => ({ revision: state.meta.revision })),
      setTitle: vi.fn<GadgetStub["setTitle"]>(async () => ({ revision: state.meta.revision })),
      setDefaultFilters: vi.fn<GadgetStub["setDefaultFilters"]>(async () => ({ revision: state.meta.revision })),
      setFreshness: vi.fn<GadgetStub["setFreshness"]>(async () => ({ revision: state.meta.revision })),
      previewQuery: vi.fn<GadgetStub["previewQuery"]>(async () => { throw new Error("The page does not preview queries."); }),
    },
  };
  const gadget: GadgetStub = harness.gadget;
  globalThis.gadgetExportFormatId = options.exportFormat;
  Object.assign(globalThis, { gadget, RpcTarget: class {} });
  vi.resetModules();
  // Imported here rather than at the top: the module is the page, and it runs once per import.
  await import("../files/client.ts");
  await settle();
  return harness;
}

const sections = () => Array.from(document.querySelectorAll<HTMLElement>("section.tile"));
function section(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`section.tile[data-tile="${id}"]`);
  if (!found) throw new Error(`No tile ${id} on the page`);
  return found;
}
function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find((each) => each.textContent === label);
  if (!found) throw new Error(`No "${label}" button`);
  return found;
}
function one<E extends Element>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (!found) throw new Error(`Nothing matches ${selector}`);
  return found;
}
const updated = () => one<HTMLElement>(document, ".dash-updated").textContent;
const status = () => one<HTMLElement>(document, ".dash-status").textContent;
const rangeSelect = () => one<HTMLSelectElement>(document, "#dash-range");
function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
/** The details a tile lists, as term and value pairs. */
function facts(id: string): Record<string, string> {
  const terms = Array.from(section(id).querySelectorAll(".tile-facts dt"));
  return Object.fromEntries(terms.map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]));
}

// Each test's page keeps running after it (its age ticker, a filter's pause) and would call the
// next test's stub, so its timers are scripted: a test advances them, and what is left is dropped
// when the test ends. The clock itself stays real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.className = "";
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.gadgetExportFormatId = undefined;
});

describe("opening", () => {
  it("draws the cached results before anything is run, then refreshes behind them", async () => {
    const run = deferred<RunResult>();
    const page = await loadClient(opened(), { runTiles: () => run.promise });

    // The run the page asked for has not answered, and the cached figures are already on screen.
    expect(page.gadget.runTiles).toHaveBeenCalledTimes(1);
    expect(page.gadget.runTiles).toHaveBeenCalledWith({});
    expect(page.gadget.subscribe).toHaveBeenCalledTimes(1);
    expect(sections().map((tile) => tile.getAttribute("data-tile"))).toEqual([KPI.id, LINE.id, TABLE.id]);
    expect(one(document, "h1").textContent).toBe("Sales overview");
    expect(section(KPI.id).textContent).toContain("$12,340.00");
    expect(section(TABLE.id).textContent).toContain("Flat white");

    // While it runs, each tile keeps its picture and says it is busy.
    for (const tile of sections()) expect(tile.getAttribute("aria-busy")).toBe("true");
    expect(updated()).toBe("Updating…");

    run.resolve({ resolved: RESOLVED, results: { [KPI.id]: kpiResult(1_500_000, Date.now()) }, data: LIVE });
    await settle();
    expect(section(KPI.id).textContent).toContain("$15,000.00");
    for (const tile of sections()) expect(tile.getAttribute("aria-busy")).toBe("false");
    // The dashboard is as fresh as its oldest result.
    expect(updated()).toBe("Updated 5 min ago");
    expect(status()).toBe("The dashboard is up to date.");
  });

  it("labels every tile by its title and gives every control a name", async () => {
    await loadClient(opened());
    for (const tile of sections()) {
      const heading = document.getElementById(tile.getAttribute("aria-labelledby") ?? "");
      expect(heading?.tagName).toBe("H2");
      expect(heading?.textContent).toBe([KPI, LINE, TABLE].find((each) => each.id === tile.getAttribute("data-tile"))?.title);
    }
    expect(one(document, 'label[for="dash-range"]').textContent).toBe("Date range");
    expect(one(document, ".dash-status").getAttribute("aria-live")).toBe("polite");
    // The location picker lists the dataset's locations as real checkboxes.
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('.dash-locations input[type="checkbox"]'));
    expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual(["Downtown", "Airport"]);
    expect(one(document, ".dash-locations summary").textContent).toBe("All locations");
    expect(one<HTMLElement>(document, ".dash-locations").hidden).toBe(false);
  });

  it("hides the location picker when there are fewer than two locations", async () => {
    await loadClient(opened({ data: { ...LIVE, locations: [{ id: 1, name: "Downtown" }] } }));
    expect(one<HTMLElement>(document, ".dash-locations").hidden).toBe(true);
  });

  it("lists each tile's query, period, last run, rows and duration", async () => {
    await loadClient(opened());
    expect(facts(KPI.id)).toMatchObject({
      Query: "Standard metric net_sales, compared with the previous period",
      "Filters used": "date range and locations",
      Period: "22 Oct – 20 Nov 2026",
      Rows: "1",
      Duration: "42 ms",
    });
    expect(facts(KPI.id)["Last ran"]).toMatch(/^5 min ago \(/);
    expect(facts(LINE.id)).toMatchObject({ Query: "Standard metric net_sales, by day", "Filters used": "date range", Rows: "3", Duration: "1.5 s" });
    // A SQL tile shows the text it runs.
    expect(one(section(TABLE.id), ".tile-sql").textContent).toBe(SQL);
    expect(facts(TABLE.id)["Filters used"]).toMatch(/^none/);
  });

  it("says when the period runs past the day the data is complete through", async () => {
    await loadClient(opened({ data: { ...LIVE, completeThrough: "2026-11-18" } }));
    expect(section(KPI.id).textContent).toContain("Data is complete through 18 Nov 2026");
    expect(section(LINE.id).textContent).toContain("Data is complete through 18 Nov 2026");
    // The tile that does not use the date range makes no claim about it.
    expect(section(TABLE.id).textContent).not.toContain("Data is complete through");
  });
});

describe("states", () => {
  it("says retail data is off, with no tiles and no run", async () => {
    const page = await loadClient(opened({ data: { status: "off", mode: "off" }, results: {}, resolved: undefined }));
    const message = one<HTMLElement>(document, ".dash-message");
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe(DATA_OFF);
    expect(sections()).toEqual([]);
    expect(one<HTMLElement>(document, ".dash-filters").hidden).toBe(true);
    expect(button(document, "Refresh").hidden).toBe(true);
    expect(button(document, "Edit").hidden).toBe(true);
    expect(page.gadget.runTiles).not.toHaveBeenCalled();
  });

  it("says the dataset is empty, with no tiles, and lets the member refresh", async () => {
    const empty: DataState = { status: "empty", mode: "live" };
    const page = await loadClient(opened({ data: empty, results: {}, resolved: undefined }), {
      runTiles: async () => ({ resolved: RESOLVED, results: { [KPI.id]: kpiResult(700_000, Date.now()) }, data: LIVE }),
    });
    expect(one(document, ".dash-message").textContent).toBe(DATA_EMPTY);
    expect(sections()).toEqual([]);
    expect(page.gadget.runTiles).not.toHaveBeenCalled();

    // After an import the same button brings the dashboard to life.
    button(document, "Refresh").click();
    await settle();
    expect(page.gadget.runTiles).toHaveBeenCalledWith({ force: true });
    expect(one<HTMLElement>(document, ".dash-message").hidden).toBe(true);
    expect(sections()).toHaveLength(3);
    expect(section(KPI.id).textContent).toContain("$7,000.00");
  });

  it("drops what it shows as soon as a run finds the data off", async () => {
    await loadClient(opened(), { runTiles: async () => ({ resolved: RESOLVED, results: {}, data: { status: "off", mode: "off" } }) });
    expect(sections()).toEqual([]);
    expect(one(document, ".dash-message").textContent).toBe(DATA_OFF);
    expect(document.body.textContent).not.toContain("$12,340.00");
  });

  it("shows a read-only copy as it was shared: no run, no filters, no editing", async () => {
    const page = await loadClient(opened({ data: { ...LIVE, mode: "snapshot" } }));
    expect(one<HTMLElement>(document, ".dash-badge").hidden).toBe(false);
    expect(one(document, ".dash-badge").textContent).toBe("Read-only copy");
    expect(section(KPI.id).textContent).toContain("$12,340.00");
    expect(page.gadget.runTiles).not.toHaveBeenCalled();
    expect(rangeSelect().disabled).toBe(true);
    for (const box of document.querySelectorAll<HTMLInputElement>(".dash-locations input")) expect(box.disabled).toBe(true);
    expect(button(document, "Refresh").disabled).toBe(true);
    expect(button(document, "Edit").hidden).toBe(true);
    expect(button(document, "Undo").hidden).toBe(true);
    // Nothing on a tile can change it either.
    for (const tile of sections()) {
      expect(tile.hasAttribute("tabindex")).toBe(false);
      expect(one<HTMLElement>(tile, ".tile-tools").hidden).toBe(true);
      expect(one<HTMLElement>(tile, ".tile-resize").hidden).toBe(true);
    }
    section(KPI.id).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(page.gadget.setLayout).not.toHaveBeenCalled();
  });
});

describe("a failed tile", () => {
  it("shows its error and hands the member a request for the agent, leaving the other tiles alone", async () => {
    const error = "no such column: refund_total";
    await loadClient(opened({ results: { [KPI.id]: kpiResult(1_234_000), [LINE.id]: failure(error), [TABLE.id]: tableResult() } }));
    const tile = section(LINE.id);
    expect(one(tile, ".tile-error").textContent).toBe(error);
    expect(one<HTMLElement>(tile, ".tile-handoff").hidden).toBe(true);
    expect(section(KPI.id).textContent).toContain("$12,340.00");
    expect(section(KPI.id).querySelector(".tile-error")).toBeNull();

    button(tile, "Fix with agent").click();
    const request = one<HTMLTextAreaElement>(tile, "textarea.tile-request");
    expect(one<HTMLElement>(tile, ".tile-handoff").hidden).toBe(false);
    expect(request.readOnly).toBe(true);
    expect(request.value).toContain('the dashboard "Sales overview"');
    expect(request.value).toContain('the tile "Sales by day"');
    expect(request.value).toContain(error);
    // The text is focused and selected, so one copy takes it even where the page may not copy for the member.
    expect(document.activeElement).toBe(request);
    expect([request.selectionStart, request.selectionEnd]).toEqual([0, request.value.length]);
    expect(status()).toMatch(/paste it into the chat/);
  });
});

describe("charts", () => {
  it("carry role img with a summary, and can be read as a table", async () => {
    const page = await loadClient(opened());
    const tile = section(LINE.id);
    const chart = one(tile, 'svg[role="img"]');
    expect(chart.getAttribute("aria-label")?.length).toBeGreaterThan(10);
    expect(one(section(KPI.id), '[role="img"]').getAttribute("aria-label")).toContain("$12,340.00");
    expect(tile.querySelector("table")).toBeNull();

    const toggle = button(tile, "Show as table");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    expect(tile.querySelector("svg")).toBeNull();
    expect(Array.from(tile.querySelectorAll("table.data-table tbody tr"), (row) => row.textContent)).toEqual([
      "18 Nov 2026USD$400.00",
      "19 Nov 2026USD$550.00",
      "20 Nov 2026USD$610.00",
    ]);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Show as chart");
    toggle.click();
    expect(tile.querySelector('svg[role="img"]')).not.toBeNull();
    // A tile that is a table already has nothing to switch to.
    expect(one<HTMLElement>(section(TABLE.id), ".tile-as-table").hidden).toBe(true);
    expect(page.gadget.runTiles).toHaveBeenCalledTimes(1);
  });
});

describe("filters", () => {
  it("re-runs only the tiles that use the filter that changed, and leaves the rest untouched", async () => {
    const page = await loadClient(opened());
    const run = deferred<RunResult>();
    page.gadget.runTiles.mockImplementation(() => run.promise);

    choose(rangeSelect(), "last7");
    expect(page.gadget.runTiles).toHaveBeenLastCalledWith({ ids: [KPI.id, LINE.id], filters: { dateRange: { preset: "last7" }, locations: [] } });
    // The two tiles asked about keep their picture and are busy; the third is not involved.
    expect(section(KPI.id).getAttribute("aria-busy")).toBe("true");
    expect(section(KPI.id).textContent).toContain("$12,340.00");
    expect(section(LINE.id).getAttribute("aria-busy")).toBe("true");
    expect(section(TABLE.id).getAttribute("aria-busy")).toBe("false");

    const week = { from: "2026-11-14", to: "2026-11-20" };
    run.resolve({ resolved: { ...week, locations: [] }, results: { [KPI.id]: { ...kpiResult(300_000, Date.now()), period: week }, [LINE.id]: { ...lineResult(Date.now()), period: week } }, data: LIVE });
    await settle();
    expect(section(KPI.id).textContent).toContain("$3,000.00");
    expect(facts(KPI.id).Period).toBe("14–20 Nov 2026");
    expect(facts(TABLE.id).Period).toBe("22 Oct – 20 Nov 2026");
    expect(section(KPI.id).getAttribute("aria-busy")).toBe("false");

    // A location is ticked: only the tile that uses locations is asked about, with the id as a value.
    const airport = one<HTMLInputElement>(document, '.dash-locations input[value="2"]');
    airport.checked = true;
    airport.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(LOCATION_PAUSE_MS);
    expect(page.gadget.runTiles).toHaveBeenLastCalledWith({ ids: [KPI.id], filters: { dateRange: { preset: "last7" }, locations: [2] } });
    expect(one(document, ".dash-locations summary").textContent).toBe("Airport");
    expect(page.gadget.runTiles).toHaveBeenCalledTimes(3);
    // Filters are the viewer's own: nothing was saved to the dashboard.
    expect(page.gadget.setDefaultFilters).not.toHaveBeenCalled();
  });

  it("sends a custom range as dates, and refuses one that is back to front without asking the server", async () => {
    const page = await loadClient(opened());
    choose(rangeSelect(), "custom");
    const from = one<HTMLInputElement>(document, "#dash-from"), to = one<HTMLInputElement>(document, "#dash-to");
    expect(one<HTMLElement>(document, ".dash-custom").hidden).toBe(false);
    // The inputs open on the period now showing, and opening them asks nothing.
    expect([from.value, to.value]).toEqual(["2026-10-22", "2026-11-20"]);
    expect(page.gadget.runTiles).toHaveBeenCalledTimes(1);

    from.value = "2026-12-01";
    from.dispatchEvent(new Event("change", { bubbles: true }));
    expect(status()).toBe("The start date must not be after the end date.");
    expect(page.gadget.runTiles).toHaveBeenCalledTimes(1);

    from.value = "2026-11-01";
    from.dispatchEvent(new Event("change", { bubbles: true }));
    expect(page.gadget.runTiles).toHaveBeenLastCalledWith({ ids: [KPI.id, LINE.id], filters: { dateRange: { from: "2026-11-01", to: "2026-11-20" }, locations: [] } });
    expect(rangeSelect().value).toBe("custom");
  });

  it("refreshes every tile on demand", async () => {
    const page = await loadClient(opened());
    button(document, "Refresh").click();
    expect(page.gadget.runTiles).toHaveBeenLastCalledWith({ force: true });
    for (const tile of sections()) expect(tile.getAttribute("aria-busy")).toBe("true");
    await settle();
    for (const tile of sections()) expect(tile.getAttribute("aria-busy")).toBe("false");
  });

  it("takes results broadcast for the default filters only where the viewer is on them", async () => {
    const page = await loadClient(opened());
    const callbacks = page.callbacks;
    if (!callbacks) throw new Error("The page did not subscribe");

    // On the default filters a broadcast result is this page's result.
    callbacks.results({ results: { [KPI.id]: kpiResult(2_000_000, Date.now()) }, resolved: RESOLVED });
    expect(section(KPI.id).textContent).toContain("$20,000.00");

    // The viewer picks another range: the tiles that use it now show the viewer's answer.
    page.gadget.runTiles.mockImplementation(async () => ({ resolved: { from: "2026-11-14", to: "2026-11-20", locations: [] }, results: { [KPI.id]: kpiResult(300_000, Date.now()) }, data: LIVE }));
    choose(rangeSelect(), "last7");
    await settle();
    expect(section(KPI.id).textContent).toContain("$3,000.00");

    // Someone else's refresh of the default filters does not move this page's filters or figures.
    callbacks.results({
      results: { [KPI.id]: kpiResult(9_900_000, Date.now()), [TABLE.id]: { ...tableResult(Date.now()), rows: [["Mocha", 31]], rowCount: 1 } },
      resolved: RESOLVED,
    });
    expect(section(KPI.id).textContent).toContain("$3,000.00");
    expect(section(KPI.id).textContent).not.toContain("$99,000.00");
    expect(rangeSelect().value).toBe("last7");
    // The tile that uses no filter is asking the default question, so it takes the new answer.
    expect(section(TABLE.id).textContent).toContain("Mocha");
  });
});

describe("live structure", () => {
  it("replaces the structure on a change and runs what the change left without a result", async () => {
    const page = await loadClient(opened());
    const callbacks = page.callbacks;
    if (!callbacks) throw new Error("The page did not subscribe");
    const added: Tile = { ...KPI, id: "orders01", title: "Orders", query: { kind: "metric", metric: "orders" }, layout: { x: 3, y: 0, w: 3, h: 2 } };
    const changed: Changed = {
      revision: 5,
      meta: { ...META, revision: 5, title: "Trading", tileOrder: [KPI.id, added.id, TABLE.id] },
      tiles: [KPI, added, TABLE],
      canUndo: true,
      canRedo: false,
      senderId: "another-page",
    };
    callbacks.changed(changed);
    expect(one(document, "h1").textContent).toBe("Trading");
    expect(sections().map((tile) => tile.getAttribute("data-tile"))).toEqual([KPI.id, added.id, TABLE.id]);
    expect(status()).toBe("The dashboard was changed.");
    expect(section(KPI.id).textContent).toContain("$12,340.00");
    // Only the new tile has nothing to show, so only it is run.
    expect(page.gadget.runTiles).toHaveBeenLastCalledWith({ ids: [added.id] });

    // An event older than what the page holds changes nothing.
    callbacks.changed({ ...changed, revision: 4, meta: { ...META, title: "Stale" } });
    expect(one(document, "h1").textContent).toBe("Trading");
  });

  it("drops a tile's result when its query changed, and keeps it when only its look did", async () => {
    const page = await loadClient(opened());
    const callbacks = page.callbacks;
    if (!callbacks) throw new Error("The page did not subscribe");
    const run = deferred<RunResult>();
    page.gadget.runTiles.mockImplementation(() => run.promise);

    callbacks.changed({ revision: 5, meta: { ...META, revision: 5 }, tiles: [KPI, { ...LINE, version: 2, visual: { type: "bar" } }, TABLE], canUndo: true, canRedo: false });
    expect(section(LINE.id).querySelector('svg[role="img"]')).not.toBeNull();
    expect(page.gadget.runTiles).toHaveBeenCalledTimes(1);

    callbacks.changed({ revision: 6, meta: { ...META, revision: 6 }, tiles: [{ ...KPI, version: 2, query: { kind: "metric", metric: "gross_sales" } }, LINE, TABLE], canUndo: true, canRedo: false });
    expect(section(KPI.id).textContent).not.toContain("$12,340.00");
    expect(page.gadget.runTiles).toHaveBeenLastCalledWith({ ids: [KPI.id] });
  });
});

describe("edit mode", () => {
  async function editing() {
    const page = await loadClient(opened());
    expect(page.gadget.setLayout).not.toHaveBeenCalled();
    button(document, "Edit").click();
    return page;
  }
  const press = (tile: HTMLElement, key: string, shiftKey = false) => tile.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));

  it("offers no editing until Edit is chosen", async () => {
    const page = await loadClient(opened());
    const tile = section(KPI.id);
    expect(tile.hasAttribute("tabindex")).toBe(false);
    expect(one<HTMLElement>(tile, ".tile-tools").hidden).toBe(true);
    expect(button(document, "Undo").hidden).toBe(true);
    press(tile, "ArrowRight");
    expect(page.gadget.setLayout).not.toHaveBeenCalled();

    const edit = button(document, "Edit");
    edit.click();
    expect(edit.getAttribute("aria-pressed")).toBe("true");
    expect(tile.getAttribute("tabindex")).toBe("0");
    expect(one<HTMLElement>(tile, ".tile-tools").hidden).toBe(false);
    expect(button(document, "Undo").hidden).toBe(false);
    // The query is shown, not edited, here.
    expect(one<HTMLElement>(tile, ".tile-ask").hidden).toBe(false);
    expect(one(tile, ".tile-ask").textContent).toBe("Ask the agent to change this query.");
    expect(tile.querySelector(".tile-facts textarea, .tile-facts input")).toBeNull();
  });

  it("moves the focused tile with the arrow keys and resizes it with Shift, keeping focus on it", async () => {
    const page = await editing();
    const tile = section(KPI.id);
    tile.focus();
    expect(document.activeElement).toBe(tile);

    press(tile, "ArrowRight");
    expect(page.gadget.setLayout).toHaveBeenLastCalledWith({ tiles: [{ id: KPI.id, x: 1, y: 0, w: 3, h: 2 }], clientId: expect.any(String) });
    expect(document.activeElement).toBe(tile);
    expect(status()).toBe("Moved to column 2, row 1.");

    press(tile, "ArrowDown", true);
    expect(page.gadget.setLayout).toHaveBeenLastCalledWith({ tiles: [{ id: KPI.id, x: 1, y: 0, w: 3, h: 3 }], clientId: expect.any(String) });
    press(tile, "ArrowRight", true);
    expect(page.gadget.setLayout).toHaveBeenLastCalledWith({ tiles: [{ id: KPI.id, x: 1, y: 0, w: 4, h: 3 }], clientId: expect.any(String) });
    expect(status()).toBe("Resized to 4 columns by 3 rows.");
    expect(document.activeElement).toBe(section(KPI.id));
    expect(section(KPI.id)).toBe(tile);

    // At the grid's edge there is nowhere to go, and nothing is sent.
    press(tile, "ArrowUp");
    expect(page.gadget.setLayout).toHaveBeenCalledTimes(3);
    expect(status()).toBe("The tile is at the edge of the grid.");
    // Moving and resizing never run a query.
    expect(page.gadget.runTiles).toHaveBeenCalledTimes(1);
  });

  it("lists only the visual types the tile's result fits, and redraws without a run", async () => {
    const page = await editing();
    const options = (id: string) => Array.from(one<HTMLSelectElement>(section(id), "select.tile-type").options, (option) => option.value);
    expect(options(LINE.id)).toEqual(["line", "area", "bar", "table"]);
    expect(options(KPI.id)).toEqual(["kpi", "table"]);
    expect(options(TABLE.id)).toEqual(["line", "area", "bar", "table"]);
    expect(one<HTMLSelectElement>(section(LINE.id), "select.tile-type").value).toBe("line");
    expect(one(section(LINE.id), "select.tile-type").getAttribute("aria-label")).toBe("Visual type for Sales by day");

    choose(one<HTMLSelectElement>(section(LINE.id), "select.tile-type"), "table");
    expect(page.gadget.updateTile).toHaveBeenCalledWith({ id: LINE.id, visual: { type: "table" }, clientId: expect.any(String) });
    expect(section(LINE.id).querySelector("svg")).toBeNull();
    expect(section(LINE.id).querySelectorAll("table.data-table tbody tr")).toHaveLength(3);
    expect(one<HTMLSelectElement>(section(LINE.id), "select.tile-type").value).toBe("table");
    expect(page.gadget.runTiles).toHaveBeenCalledTimes(1);
  });

  it("renames and deletes a tile through the matching calls", async () => {
    const page = await editing();
    const title = one<HTMLInputElement>(section(KPI.id), "input.tile-title-input");
    expect(title.hidden).toBe(false);
    expect(title.value).toBe("Net sales");
    title.value = "Net sales, all stores";
    title.dispatchEvent(new Event("change", { bubbles: true }));
    expect(page.gadget.updateTile).toHaveBeenCalledWith({ id: KPI.id, title: "Net sales, all stores", clientId: expect.any(String) });
    expect(one(section(KPI.id), "h2").textContent).toBe("Net sales, all stores");

    button(section(TABLE.id), "Delete").click();
    expect(page.gadget.removeTile).toHaveBeenCalledWith({ id: TABLE.id, clientId: expect.any(String) });
    expect(sections().map((tile) => tile.getAttribute("data-tile"))).toEqual([KPI.id, LINE.id]);
    expect(status()).toBe("Top sellers was deleted. Undo brings it back.");
  });

  it("applies what undo returns", async () => {
    const page = await editing();
    const callbacks = page.callbacks;
    if (!callbacks) throw new Error("The page did not subscribe");
    callbacks.changed({ revision: 5, meta: { ...META, revision: 5 }, tiles: [KPI, LINE], canUndo: true, canRedo: false });
    const undo = button(document, "Undo");
    expect(undo.disabled).toBe(false);
    expect(button(document, "Redo").disabled).toBe(true);

    page.gadget.undo.mockImplementation(async () => ({ revision: 6, meta: { ...META, revision: 6 }, tiles: [KPI, LINE, TABLE], canUndo: false, canRedo: true }));
    undo.click();
    await settle();
    expect(page.gadget.undo).toHaveBeenCalledWith({ clientId: expect.any(String) });
    expect(sections()).toHaveLength(3);
    expect(button(document, "Undo").disabled).toBe(true);
    expect(button(document, "Redo").disabled).toBe(false);
  });
});

describe("export", () => {
  it("draws the cached results for paper: no controls, no subscription, no run", async () => {
    const page = await loadClient(opened(), { exportFormat: "pdf" });
    expect(document.documentElement.classList.contains("document-export")).toBe(true);
    expect(page.gadget.open).toHaveBeenCalledTimes(1);
    expect(page.gadget.subscribe).not.toHaveBeenCalled();
    expect(page.gadget.runTiles).not.toHaveBeenCalled();
    expect(one<HTMLElement>(document, ".dash-controls").hidden).toBe(true);
    expect(one<HTMLElement>(document, ".dash-status").hidden).toBe(true);

    // Everything was drawn by the time the module finished loading, which is what the export waits on.
    expect(sections()).toHaveLength(3);
    expect(section(KPI.id).textContent).toContain("$12,340.00");
    expect(section(LINE.id).querySelector('svg[role="img"]')).not.toBeNull();
    // Under the title: when the numbers are from, and what they were filtered to.
    const asOf = one(document, ".dash-asof").textContent ?? "";
    expect(asOf).toMatch(/^As of .+ · 22 Oct – 20 Nov 2026 · All locations$/);
    // The stylesheet carries the print layout and the shared chart styles.
    const css = Array.from(document.querySelectorAll("style"), (style) => style.textContent).join("\n");
    expect(css).toContain("@media print");
    expect(css).toContain("--data-series-1");
  });
});
