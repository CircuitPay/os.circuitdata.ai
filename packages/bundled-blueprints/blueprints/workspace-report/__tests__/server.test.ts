// @vitest-environment node
// The Report's Durable Object over in-memory storage, against a scripted RETAIL_DATA: what it
// stores, what it refuses, and that an edition never changes once it is written.
import { restore } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  RetailDatasetDescription,
  RetailMetricName,
  RetailMetricQuery,
  RetailMetricResult,
  RetailQueryResult,
  RetailReader,
  Scalar,
} from "@gadgets/bundled-blueprints/libraries/data/server";
import { ExportHandler, Gadget } from "../files/server.ts";
import { ALL_PINNED } from "../files/lib/editions.ts";
import { type Changed, type DataSection, type Edition, type Generated, LIMITS, type ScheduledFiring, type Section, type TextSection } from "../files/lib/protocol.ts";

// Durable Object storage in memory: just the calls the gadget makes, with values copied in and out
// as the real storage serializes them.
class MemoryStorage {
  map = new Map<string, unknown>();
  writes = 0;
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
    this.writes++;
    for (const [k, v] of entries) this.map.set(k, structuredClone(v));
  }
  async delete(key: string | string[]): Promise<number> {
    if (Array.isArray(key)) MemoryStorage.check(key);
    this.writes++;
    return (Array.isArray(key) ? key : [key]).filter((k) => this.map.delete(k)).length;
  }
  async list({ prefix = "" }: { prefix?: string } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).toSorted();
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
  keys(prefix: string): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).toSorted();
  }
}

const METRIC_UNITS: Partial<Record<RetailMetricName, "money" | "count">> = { net_sales: "money", refunds: "money", discounts: "money", average_order_value: "money", orders: "count" };

// The dataset as a script: every call is recorded, and its numbers are fields a test can change.
class FakeRetail implements RetailReader {
  described = 0;
  runs: { sql: string; params: Scalar[] }[] = [];
  metrics: { name: RetailMetricName; query: RetailMetricQuery }[] = [];
  /** What net_sales (and every other money metric) reads, in cents. */
  netSales = 123_456;
  dateRange: { from: string; to: string } | null = { from: "2025-01-01", to: "2025-10-31" };
  completeThrough: string | null = "2025-10-31";
  /** A metric the dataset refuses. */
  refuse: RetailMetricName | null = null;
  /** Fails every call the way the kernel does once the connection was removed. */
  gone = false;

  check(): void {
    if (this.gone) throw new Error("The binding RETAIL_DATA has been removed from this workspace.");
  }

  async describe(): Promise<RetailDatasetDescription> {
    this.check();
    this.described++;
    return {
      tables: [{ name: "orders", description: "One sale.", columns: [{ name: "id", type: "integer" }], rows: 10 }],
      metrics: [{ name: "net_sales", description: "Gross sales less discounts and refunds.", unit: "money", sql: "SELECT 1" }],
      personalDataMasked: true,
      dateRange: this.dateRange,
      completeThrough: this.completeThrough,
      limits: { maxRows: 500, maxBytes: 100_000, maxParams: 100 },
    };
  }

  async run(sql: string, params: Scalar[] = []): Promise<RetailQueryResult> {
    this.check();
    this.runs.push({ sql, params });
    if (/FROM locations/.test(sql)) {
      return { columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }], rows: [[1, "Downtown"], [2, "Airport"]], truncated: false };
    }
    if (/FROM products/.test(sql)) {
      return {
        columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }, { name: "variant_name", type: "text" }],
        rows: params.map((id) => [id, "Product " + String(id), null]),
        truncated: false,
      };
    }
    return { columns: [{ name: "channel", type: "text" }, { name: "orders", type: "integer" }], rows: [["online", 7], ["in_store", 35]], truncated: false };
  }

  async metric(name: RetailMetricName, query: RetailMetricQuery): Promise<RetailMetricResult> {
    this.check();
    this.metrics.push({ name, query });
    if (this.refuse === name) throw new Error(`The metric ${name} is not available for this dataset.`);
    const unit = METRIC_UNITS[name] ?? "count";
    const group = query.groupBy?.[0];
    const keys: Record<string, { column: RetailMetricResult["columns"][number]; values: Scalar[] }> = {
      day: { column: { name: "day", type: "date" }, values: [query.from, query.to] },
      week: { column: { name: "week", type: "date" }, values: [query.from] },
      location: { column: { name: "location_id", type: "integer" }, values: [1, 2] },
      product: { column: { name: "product_id", type: "integer" }, values: [11, 12] },
    };
    const key = group ? keys[group] : undefined;
    const value = unit === "money" ? this.netSales : 42;
    const tail: Scalar[] = unit === "money" ? ["USD", value] : [value];
    return {
      metric: { name, description: name, unit, sql: "SELECT 1" },
      columns: [
        ...(key ? [key.column] : []),
        ...(unit === "money" ? [{ name: "currency", type: "text" as const }, { name: "value", type: "money" as const, currencyColumn: "currency" }] : [{ name: "value", type: "integer" as const }]),
      ],
      rows: key ? key.values.map((first) => [first, ...tail]) : [tail],
    };
  }
}

// The runtime's state is far larger than what the gadget uses; `never` hands the in-memory
// stand-in over without pretending to implement the rest.
function live(storage = new MemoryStorage(), retail = new FakeRetail()) {
  const gadget = new Gadget({ storage } as never, { GADGET: {}, RETAIL_DATA: retail });
  return { gadget, storage, retail };
}
/** The same report with the data turned off: the gadget binding, and no dataset. */
const off = (storage: MemoryStorage) => new Gadget({ storage } as never, { GADGET: {} });
/** The same report as a view-only copy: no bindings at all. */
const snapshot = (storage: MemoryStorage) => new Gadget({ storage } as never, {});

const handler = () => new ExportHandler({} as never, {});

// Argument checks may throw before the call returns a promise, or reject it.
function failure(call: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(call);
}

async function sectionsOf(gadget: Gadget): Promise<Section[]> {
  return (await gadget.getReport()).sections;
}

async function firstText(gadget: Gadget): Promise<TextSection> {
  const found = (await sectionsOf(gadget)).find((section): section is TextSection => section.kind === "text");
  if (!found) throw new Error("The report has no text section");
  return found;
}

function dataBlock(edition: Edition, title: string): DataSection & { outcome?: Edition["blocks"][number]["outcome"] } {
  const found = edition.blocks.find((block) => block.kind === "data" && block.title === title);
  if (!found || found.kind !== "data") throw new Error(`The edition has no block titled ${title}`);
  return found;
}

/** The rows a block of an edition holds; fails the test when the block failed or is absent. */
function rowsOf(edition: Edition, title: string): Scalar[][] {
  const outcome = dataBlock(edition, title).outcome;
  if (!outcome || "error" in outcome) throw new Error(`The block ${title} has no rows`);
  return outcome.rows;
}

// A subscriber as the RPC layer hands it to the server, recording what it hears.
function watcher(changes: Changed[], generations: Generated[]) {
  return {
    changed: (event: Changed) => { changes.push(event); },
    generated: (event: Generated) => { generations.push(event); },
    dup() { return this; },
    onRpcBroken: () => {},
  };
}

const firing = (runId: string, actualTime: string, timeZone = "UTC"): ScheduledFiring =>
  ({ scheduleId: "schedule-1", runId, scheduledTime: Date.parse(actualTime), actualTime: Date.parse(actualTime), timeZone });

const PNG = "data:image/png;base64," + btoa("\x89PNG\r\n\x1a\n" + "\0".repeat(16));
const JPEG = "data:image/jpeg;base64," + btoa("\xff\xd8\xff\xe0" + "\0".repeat(16));
const SVG = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');

describe("starter content", () => {
  it("opens as a monthly sales report for the most recent complete month, with no edition", async () => {
    const { gadget, storage } = live();
    const report = await gadget.getReport();

    expect(report.meta).toMatchObject({ title: "Monthly sales report", period: { preset: "lastMonth" }, locations: [], letterhead: {}, editions: [] });
    expect(report.latestEdition).toBeNull();
    expect(report.review).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.sections.map((section) => (section.kind === "data" ? [section.title, section.visual.type, section.width] : [section.kind, section.text]))).toEqual([
      ["heading", "Monthly sales report"],
      ["heading", "Summary"],
      ["text", "Write a short summary of the month here, or ask the agent to draft one from the figures below."],
      ["Net sales", "kpi", "half"],
      ["Orders", "kpi", "half"],
      ["Average order value", "kpi", "half"],
      ["Refunds", "kpi", "half"],
      ["Sales by day", "line", "full"],
      ["Top products", "table", "half"],
      ["Sales by location", "bar", "half"],
      ["Discounts by week", "table", "half"],
      ["Refunds by week", "table", "half"],
    ]);
    const queries = report.sections.filter((section): section is DataSection => section.kind === "data").map((section) => section.query);
    expect(queries[0]).toEqual({ kind: "metric", metric: "net_sales", compare: true });
    expect(queries[4]).toEqual({ kind: "metric", metric: "net_sales", groupBy: ["day"] });
    expect(queries[5]).toEqual({ kind: "metric", metric: "net_sales", groupBy: ["product"] });
    expect(queries[7]).toEqual({ kind: "metric", metric: "discounts", groupBy: ["week"] });
    // Every section id is 8 lowercase letters and digits, and each is stored under its own key.
    for (const section of report.sections) expect(section.id).toMatch(/^[a-z0-9]{8}$/);
    expect(storage.keys("s:")).toHaveLength(12);
  });

  it("is written once, however many reads arrive together", async () => {
    const { gadget, storage } = live();
    const [a, b] = await Promise.all([gadget.getReport(), gadget.open()]);
    expect(a.sections.map((section) => section.id)).toEqual(b.sections.map((section) => section.id));
    expect(storage.keys("s:")).toHaveLength(12);
    expect((await gadget.getReport()).sections.map((section) => section.id)).toEqual(a.sections.map((section) => section.id));
  });

  it("opens with the dataset's state and the date its period counts back from", async () => {
    const { gadget } = live();
    const opened = await gadget.open();
    expect(opened.data).toMatchObject({ status: "ok", mode: "live", anchor: "2025-10-31", completeThrough: "2025-10-31", locations: [{ id: 1, name: "Downtown" }, { id: 2, name: "Airport" }] });
    expect(opened.edition).toBeNull();
    expect(opened.canUndo).toBe(false);
  });
});

describe("sections", () => {
  it("adds a section at the end, first, or after another, and returns its id", async () => {
    const { gadget } = live();
    const before = await sectionsOf(gadget);
    const last = await gadget.addSection({ section: { kind: "text", text: "Closing words." } });
    const first = await gadget.addSection({ section: { kind: "heading", level: 3, text: "  Preface  " }, after: null });
    const middle = await gadget.addSection({ section: { kind: "heading", text: "After the title" }, after: before[0].id });

    const sections = await sectionsOf(gadget);
    expect(sections.map((section) => section.id)).toEqual([first.sectionId, before[0].id, middle.sectionId, ...before.slice(1).map((section) => section.id), last.sectionId]);
    expect(sections[0]).toMatchObject({ kind: "heading", level: 3, text: "Preface", version: 1 });
    expect(sections[2]).toMatchObject({ kind: "heading", level: 2, text: "After the title" });
    expect(sections.at(-1)).toMatchObject({ kind: "text", text: "Closing words.", reviewedEdition: null });
    expect(middle.revision).toBe(first.revision + 1);
  });

  it("adds a data section with its query and visual checked by the data library", async () => {
    const { gadget } = live();
    const { sectionId } = await gadget.addSection({
      section: { kind: "data", title: "Orders by channel", visual: { type: "bar" }, query: { kind: "sql", sql: "SELECT channel, COUNT(*) AS orders FROM orders WHERE business_date BETWEEN :from AND :to GROUP BY channel" } },
    });
    expect((await sectionsOf(gadget)).at(-1)).toMatchObject({ id: sectionId, kind: "data", title: "Orders by channel", width: "full", visual: { type: "bar" } });
  });

  it("refuses sections it cannot store, saying why", async () => {
    const { gadget, retail } = live();
    const add = (section: unknown) => failure(() => gadget.addSection({ section } as never));
    await expect(add({ kind: "slide", text: "x" })).rejects.toThrow('A section\'s kind must be "heading", "text" or "data".');
    await expect(add({ kind: "heading", text: "   " })).rejects.toThrow("A heading cannot be empty.");
    await expect(add({ kind: "heading", level: 4, text: "x" })).rejects.toThrow("A heading's level must be 1, 2 or 3.");
    await expect(add({ kind: "heading", text: "x".repeat(LIMITS.heading + 1) })).rejects.toThrow("A heading can be at most 200 characters.");
    await expect(add({ kind: "text", text: "x".repeat(LIMITS.text + 1) })).rejects.toThrow("A text section can be at most 20,000 characters.");
    await expect(add({ kind: "data", title: "", visual: { type: "bar" }, query: { kind: "metric", metric: "orders" } })).rejects.toThrow("A data section's title cannot be empty.");
    await expect(add({ kind: "data", title: "T", visual: { type: "text" }, query: { kind: "metric", metric: "orders" } })).rejects.toThrow("Use a text section for text.");
    await expect(add({ kind: "data", title: "T", visual: { type: "bar" }, query: { kind: "metric", metric: "orders" }, width: "quarter" })).rejects.toThrow('"full", "half" or "third"');
    await expect(add({ kind: "data", title: "T", visual: { type: "bar" }, query: { kind: "metric", metric: "profit" } })).rejects.toThrow("is not a standard metric");
    // A query that would change data is refused when it is saved, before anything is sent.
    await expect(add({ kind: "data", title: "T", visual: { type: "table" }, query: { kind: "sql", sql: "DELETE FROM orders" } })).rejects.toThrow("Only read queries can be saved.");
    await expect(failure(() => gadget.addSection({ section: { kind: "text", text: "x" }, after: "missing" }))).rejects.toThrow('No section has the id "missing".');
    expect(await sectionsOf(gadget)).toHaveLength(12);
    expect(retail.runs).toEqual([]);
  });

  it("holds at most 60 sections", async () => {
    const { gadget } = live();
    for (let count = 12; count < LIMITS.sections; count++) await gadget.addSection({ section: { kind: "text", text: "" } });
    await expect(gadget.addSection({ section: { kind: "text", text: "" } })).rejects.toThrow("A report holds at most 60 sections.");
    expect(await sectionsOf(gadget)).toHaveLength(LIMITS.sections);
  });

  it("updates a section's own fields and returns it before and after", async () => {
    const { gadget } = live();
    const sections = await sectionsOf(gadget);
    const heading = sections[1];
    const block = sections[3] as DataSection;

    const renamed = await gadget.updateSection({ id: heading.id, text: "Overview", level: 3 });
    expect(renamed.before).toMatchObject({ text: "Summary", level: 2, version: 1 });
    expect(renamed.after).toMatchObject({ text: "Overview", level: 3, version: 2 });

    const requeried = await gadget.updateSection({ id: block.id, query: { kind: "metric", metric: "orders", compare: true }, title: "Order count", width: "half" });
    expect(requeried.before).toMatchObject({ title: "Net sales", query: { metric: "net_sales" } });
    expect(requeried.after).toMatchObject({ title: "Order count", query: { kind: "metric", metric: "orders", compare: true }, width: "half", version: 2 });
    expect((await sectionsOf(gadget))[3]).toEqual(requeried.after);

    // Nothing changed: no new revision.
    const same = await gadget.updateSection({ id: heading.id, text: "Overview" });
    expect(same.revision).toBe(requeried.revision);
    expect(same.after.version).toBe(2);
  });

  it("refuses an update that names another kind's field, changes the kind, or names no section", async () => {
    const { gadget } = live();
    const [heading, , text] = await sectionsOf(gadget);
    await expect(gadget.updateSection({ id: heading.id, title: "x" })).rejects.toThrow('A heading section has no "title" to change.');
    await expect(gadget.updateSection({ id: text.id, kind: "heading" })).rejects.toThrow("A section's kind cannot change.");
    await expect(gadget.updateSection({ id: text.id, query: { kind: "metric", metric: "orders" } })).rejects.toThrow('A text section has no "query" to change.');
    await expect(gadget.updateSection({ id: "missing", text: "x" })).rejects.toThrow('No section has the id "missing".');
    await expect(failure(() => gadget.updateSection({ text: "x" } as never))).rejects.toThrow("id must be an id.");
  });

  it("moves and removes sections", async () => {
    const { gadget } = live();
    const ids = (await sectionsOf(gadget)).map((section) => section.id);

    await gadget.moveSection({ id: ids[2], after: null });
    expect((await sectionsOf(gadget)).map((section) => section.id)).toEqual([ids[2], ids[0], ids[1], ...ids.slice(3)]);
    await gadget.moveSection({ id: ids[2], after: ids[11] });
    expect((await sectionsOf(gadget)).map((section) => section.id)).toEqual([ids[0], ids[1], ...ids.slice(3), ids[2]]);

    await gadget.removeSection({ id: ids[1] });
    expect((await sectionsOf(gadget)).map((section) => section.id)).toEqual([ids[0], ...ids.slice(3), ids[2]]);

    await expect(failure(() => gadget.moveSection({ id: ids[0], after: ids[0] }))).rejects.toThrow("A section cannot be moved after itself.");
    await expect(gadget.moveSection({ id: ids[0], after: "missing" })).rejects.toThrow('No section has the id "missing".');
    await expect(gadget.removeSection({ id: ids[1] })).rejects.toThrow(`No section has the id "${ids[1]}".`);
  });

  it("sets the title and refuses an empty or over-long one", async () => {
    const { gadget } = live();
    await gadget.setTitle({ title: "  October sales  " });
    expect((await gadget.getReport()).meta.title).toBe("October sales");
    await expect(failure(() => gadget.setTitle({ title: "" }))).rejects.toThrow("The title cannot be empty.");
    await expect(failure(() => gadget.setTitle({ title: "x".repeat(LIMITS.title + 1) }))).rejects.toThrow("The title can be at most 200 characters.");
  });

  it("undoes and redoes changes to structure and text, for everyone", async () => {
    const { gadget } = live();
    const before = await sectionsOf(gadget);
    const text = before[2] as TextSection;
    await gadget.updateSection({ id: text.id, text: "A first draft." });
    await gadget.removeSection({ id: before[1].id });
    await gadget.setTitle({ title: "October" });

    expect((await gadget.open()).canUndo).toBe(true);
    const untitled = await gadget.undo();
    expect(untitled?.meta.title).toBe("Monthly sales report");
    expect(untitled?.canRedo).toBe(true);
    const restored = await gadget.undo();
    expect(restored?.sections.map((section) => section.id)).toEqual(before.map((section) => section.id));
    await gadget.undo();
    expect(((await sectionsOf(gadget))[2] as TextSection).text).toBe(text.text);
    expect(await gadget.undo()).toBeNull();

    const redone = await gadget.redo();
    expect(redone?.sections[2]).toMatchObject({ kind: "text", text: "A first draft." });
    // A new change ends the redo history.
    await gadget.setTitle({ title: "Another" });
    expect(await gadget.redo()).toBeNull();
  });

  it("tells every open page about a change, with who made it", async () => {
    const { gadget } = live();
    const changes: Changed[] = [];
    const opened = await gadget.subscribe(watcher(changes, []), { clientId: "page-1" });
    await gadget.setTitle({ title: "October", clientId: "page-2" });
    await gadget.setTitle({ title: "October", clientId: "page-2" });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ revision: opened.meta.revision + 1, meta: { title: "October" }, senderId: "page-2", canUndo: true, canRedo: false });
    expect(changes[0].sections).toHaveLength(12);
  });
});

describe("generating", () => {
  it("stores an edition with every section and what each data section returned", async () => {
    const { gadget, storage, retail } = live();
    const generated = await gadget.generate({ createdBy: "member" });

    expect(generated.failed).toEqual([]);
    expect(generated.review).toEqual([]);
    expect(generated.edition).toMatchObject({ period: { from: "2025-10-01", to: "2025-10-31" }, pinned: false, createdBy: "member" });
    expect(storage.keys("e:")).toEqual(["e:" + generated.edition.id]);

    const edition = await gadget.readEdition();
    expect(edition).toMatchObject({ id: generated.edition.id, title: "Monthly sales report", completeThrough: "2025-10-31", letterhead: {} });
    expect(edition.blocks.map((block) => block.kind)).toEqual((await sectionsOf(gadget)).map((section) => section.kind));
    expect(rowsOf(edition, "Net sales")).toEqual([["USD", 123_456]]);
    expect(rowsOf(edition, "Orders")).toEqual([[42]]);
    expect(rowsOf(edition, "Sales by location")).toEqual([["Downtown", "USD", 123_456], ["Airport", "USD", 123_456]]);
    expect(rowsOf(edition, "Top products").map((row) => row[0])).toEqual(["Product 11", "Product 12"]);
    expect(Object.keys(edition.fingerprints).toSorted()).toEqual(edition.blocks.filter((block) => block.kind === "data").map((block) => block.id).toSorted());

    // Every figure came from a standard metric over the resolved month, and the headline figures
    // also read the month before.
    expect(new Set(retail.metrics.map((call) => call.name))).toEqual(new Set(["net_sales", "orders", "average_order_value", "refunds", "discounts"]));
    expect(retail.metrics.filter((call) => call.query.from === "2025-10-01" && call.query.to === "2025-10-31")).toHaveLength(9);
    expect(retail.metrics.filter((call) => call.query.from === "2025-08-31" && call.query.to === "2025-09-30")).toHaveLength(4);

    const report = await gadget.getReport();
    expect(report.latestEdition).toEqual(generated.edition);
    expect(report.meta.editions).toEqual([generated.edition]);
    expect((await gadget.open()).edition).toEqual(edition);
  });

  it("names the agent as the author unless told otherwise", async () => {
    const { gadget } = live();
    expect((await gadget.generate()).edition.createdBy).toBe("agent");
    await expect(failure(() => gadget.generate({ createdBy: "robot" } as never))).rejects.toThrow('createdBy must be "member", "agent" or "schedule".');
  });

  it("keeps an edition exactly as it was when the data changes and the sections are edited", async () => {
    const { gadget, storage, retail } = live();
    const { edition: summary } = await gadget.generate();
    const frozen = await gadget.readEdition({ id: summary.id });
    const stored = structuredClone(storage.map.get("e:" + summary.id));

    retail.netSales = 999_999;
    const sections = await sectionsOf(gadget);
    await gadget.updateSection({ id: sections[2].id, text: "Rewritten after the fact, with 999 in it." });
    await gadget.updateSection({ id: sections[3].id, title: "Renamed", query: { kind: "metric", metric: "orders" } });
    await gadget.removeSection({ id: sections[7].id });
    await gadget.moveSection({ id: sections[0].id, after: sections[1].id });
    await gadget.setTitle({ title: "A different title" });
    await gadget.setLetterhead({ letterhead: { name: "Acme Retail", accent: "#AA3300" } });
    await gadget.setPeriod({ period: { preset: "last7" } });

    expect(await gadget.readEdition({ id: summary.id })).toEqual(frozen);
    expect(await gadget.getEdition({ id: summary.id })).toEqual(frozen);
    expect(storage.map.get("e:" + summary.id)).toEqual(stored);
    expect(frozen.title).toBe("Monthly sales report");
    expect(rowsOf(frozen, "Net sales")).toEqual([["USD", 123_456]]);
    expect(frozen.blocks).toHaveLength(12);

    // The report itself moved on: the changed and removed data sections are not in the edition.
    const report = await gadget.getReport();
    expect(report.stale).toEqual([sections[3].id]);
    expect(report.meta).toMatchObject({ title: "A different title", letterhead: { name: "Acme Retail", accent: "#aa3300" }, period: { preset: "last7" } });
  });

  it("makes a second edition with the new numbers and keeps the first readable", async () => {
    const { gadget, storage, retail } = live();
    const first = (await gadget.generate()).edition;
    retail.netSales = 200_000;
    const second = (await gadget.generate()).edition;

    expect(second.id).not.toBe(first.id);
    expect(second.asOf).toBeGreaterThan(first.asOf);
    expect((await gadget.getReport()).meta.editions.map((edition) => edition.id)).toEqual([second.id, first.id]);
    expect(storage.keys("e:").toSorted()).toEqual(["e:" + first.id, "e:" + second.id].toSorted());
    expect(rowsOf(await gadget.readEdition(), "Net sales")).toEqual([["USD", 200_000]]);
    expect(rowsOf(await gadget.readEdition({ id: first.id }), "Net sales")).toEqual([["USD", 123_456]]);
    expect((await gadget.open({ editionId: first.id })).edition?.id).toBe(first.id);
    expect((await gadget.open()).edition?.id).toBe(second.id);
  });

  it("flags text that states numbers when a regeneration changes them, until it is edited or reviewed", async () => {
    const { gadget, retail } = live();
    const first = (await gadget.generate()).edition;
    const summary = await firstText(gadget);
    const written = await gadget.updateSection({ id: summary.id, text: "Net sales were $1,234.56 this month." });
    expect(written.after).toMatchObject({ reviewedEdition: first.id });
    const { sectionId: plain } = await gadget.addSection({ section: { kind: "text", text: "A good month overall." } });

    // The same numbers again: nothing to review.
    expect((await gadget.generate()).review).toEqual([]);

    retail.netSales = 200_000;
    const changes: Changed[] = [];
    const generations: Generated[] = [];
    await gadget.subscribe(watcher(changes, generations));
    const regenerated = await gadget.generate();
    expect(regenerated.review).toEqual([summary.id]);
    expect((await gadget.getReport()).review).toEqual([summary.id]);
    expect((await gadget.open()).review).toEqual([summary.id]);
    expect(generations).toEqual([{ edition: regenerated.edition, review: [summary.id] }]);
    expect(changes.at(-1)).toMatchObject({ review: [summary.id], meta: { editions: [{ id: regenerated.edition.id }, {}, { id: first.id }] } });

    await gadget.markReviewed({ ids: [summary.id] });
    expect((await gadget.getReport()).review).toEqual([]);
    expect(await firstText(gadget)).toMatchObject({ reviewedEdition: regenerated.edition.id, text: "Net sales were $1,234.56 this month." });

    retail.netSales = 300_000;
    expect((await gadget.generate()).review).toEqual([summary.id]);
    await gadget.updateSection({ id: summary.id, text: "Net sales were $3,000.00 this month." });
    expect((await gadget.getReport()).review).toEqual([]);

    await expect(gadget.markReviewed({ ids: [plain, "missing"] })).rejects.toThrow('"missing" is not a text section of this report.');
  });

  it("stores a failing block with its error and still produces the edition", async () => {
    const { gadget, retail } = live();
    retail.refuse = "refunds";
    const sections = await sectionsOf(gadget);
    const refunds = sections.filter((section) => section.kind === "data" && section.query.kind === "metric" && section.query.metric === "refunds").map((section) => section.id);

    const generated = await gadget.generate();
    expect(generated.failed.toSorted()).toEqual(refunds.toSorted());
    expect(refunds).toHaveLength(2);

    const edition = await gadget.readEdition();
    expect(dataBlock(edition, "Refunds").outcome).toMatchObject({ error: "The metric refunds is not available for this dataset.", period: { from: "2025-10-01", to: "2025-10-31" } });
    expect(edition.fingerprints[refunds[0]]).toBe("error");
    expect(rowsOf(edition, "Net sales")).toEqual([["USD", 123_456]]);
    expect(rowsOf(edition, "Sales by day")).toHaveLength(2);
  });

  it("refuses when the dataset is empty or the report has nothing to compute", async () => {
    const empty = live();
    empty.retail.dateRange = null;
    await expect(empty.gadget.generate()).rejects.toThrow("No sales data yet.");
    expect((await empty.gadget.open()).data).toMatchObject({ status: "empty", mode: "live" });
    expect(empty.retail.metrics).toEqual([]);

    const bare = live();
    for (const section of await sectionsOf(bare.gadget)) if (section.kind === "data") await bare.gadget.removeSection({ id: section.id });
    await expect(bare.gadget.generate()).rejects.toThrow("This report has no data section to compute.");
    expect(bare.storage.keys("e:")).toEqual([]);
  });

  it("runs once when asked twice at the same moment", async () => {
    const { gadget, storage } = live();
    const [a, b] = await Promise.all([gadget.generate(), gadget.generate()]);
    expect(a.edition.id).toBe(b.edition.id);
    expect(storage.keys("e:")).toHaveLength(1);
  });

  it("keeps 24 editions: the oldest unpinned makes room, and a full set of pinned ones refuses", async () => {
    const { gadget, storage } = live();
    // One data section is enough to generate with, and keeps the run short.
    const sections = await sectionsOf(gadget);
    for (const section of sections.slice(4)) await gadget.removeSection({ id: section.id });

    const made: string[] = [];
    for (let count = 0; count < LIMITS.editions; count++) made.push((await gadget.generate()).edition.id);
    expect(storage.keys("e:")).toHaveLength(LIMITS.editions);

    // The oldest is pinned, so the second oldest goes.
    await gadget.pinEdition({ id: made[0], pinned: true });
    const next = (await gadget.generate()).edition.id;
    const kept = (await gadget.getReport()).meta.editions;
    expect(kept).toHaveLength(LIMITS.editions);
    expect(kept.map((edition) => edition.id)).toEqual([next, ...made.slice(2).toReversed(), made[0]]);
    expect(kept.at(-1)).toMatchObject({ id: made[0], pinned: true });
    expect(storage.map.has("e:" + made[1])).toBe(false);
    await expect(gadget.readEdition({ id: made[1] })).rejects.toThrow("That edition no longer exists.");
    expect((await gadget.readEdition({ id: made[0] })).pinned).toBe(true);

    for (const edition of kept) await gadget.pinEdition({ id: edition.id, pinned: true });
    await expect(gadget.generate()).rejects.toThrow(ALL_PINNED);
    expect(storage.keys("e:")).toHaveLength(LIMITS.editions);

    await gadget.pinEdition({ id: next, pinned: false });
    await gadget.generate();
    expect(storage.map.has("e:" + next)).toBe(false);
  });

  it("deletes an edition only when asked to, the latest included", async () => {
    const { gadget, storage } = live();
    const first = (await gadget.generate()).edition;
    const second = (await gadget.generate()).edition;
    await gadget.deleteEdition({ id: second.id });

    expect(storage.keys("e:")).toEqual(["e:" + first.id]);
    expect((await gadget.getReport()).latestEdition?.id).toBe(first.id);
    await expect(gadget.deleteEdition({ id: second.id })).rejects.toThrow("That edition no longer exists.");
    await expect(gadget.pinEdition({ id: "missing", pinned: true })).rejects.toThrow("That edition no longer exists.");
  });

  it("previews a query without saving anything", async () => {
    const { gadget, storage } = live();
    await gadget.open();
    const writes = storage.writes;
    const outcome = await gadget.previewQuery({ query: { kind: "metric", metric: "net_sales", groupBy: ["location"] }, period: { from: "2025-03-01", to: "2025-03-31" } });

    expect(outcome).toMatchObject({ rows: [["Downtown", "USD", 123_456], ["Airport", "USD", 123_456]], period: { from: "2025-03-01", to: "2025-03-31" } });
    expect(storage.writes).toBe(writes);
    expect(await sectionsOf(gadget)).toHaveLength(12);
    await expect(failure(() => gadget.previewQuery({ query: { kind: "sql", sql: "DROP TABLE orders" } }))).rejects.toThrow("Only read queries can be saved.");
  });

  it("describes the dataset for writing queries", async () => {
    const { gadget } = live();
    const description = await gadget.describeData();
    expect(description.data).toEqual({ status: "ok", dateRange: { from: "2025-01-01", to: "2025-10-31" }, completeThrough: "2025-10-31", personalDataMasked: true, locations: [{ id: 1, name: "Downtown" }, { id: 2, name: "Airport" }] });
    expect(description.tables.map((table) => table.name)).toEqual(["orders"]);
    expect(description.metrics.map((metric) => metric.name)).toEqual(["net_sales"]);
    expect(description.limits).toEqual({ maxRows: 500, maxBytes: 100_000, maxParams: 100 });
  });
});

describe("period and location values", () => {
  it("accepts a preset or real dates, and locations as whole numbers", async () => {
    const { gadget, retail } = live();
    await gadget.setPeriod({ period: { from: "2025-02-01", to: "2025-02-28" }, locations: [2, 2, 1] });
    expect((await gadget.getReport()).meta).toMatchObject({ period: { from: "2025-02-01", to: "2025-02-28" }, locations: [2, 1] });
    // Leaving the locations out keeps them.
    await gadget.setPeriod({ period: { preset: "last30" } });
    expect((await gadget.getReport()).meta).toMatchObject({ period: { preset: "last30" }, locations: [2, 1] });

    const { edition } = await gadget.generate();
    expect(edition.period).toEqual({ from: "2025-10-02", to: "2025-10-31" });
    expect(retail.metrics.every((call) => JSON.stringify(call.query.locationIds) === "[2,1]")).toBe(true);
  });

  it("refuses text where a date or a location id belongs, and stores nothing of it", async () => {
    const { gadget, storage } = live();
    const before = (await gadget.getReport()).meta;
    const hostile = "2025-10-01'; DROP TABLE orders;--";
    await expect(gadget.setPeriod({ period: { from: hostile, to: "2025-10-31" } })).rejects.toThrow();
    await expect(gadget.setPeriod({ period: { from: "2025-10-01", to: "2025-10-31 OR 1=1" } })).rejects.toThrow();
    await expect(gadget.setPeriod({ period: { preset: "last30) OR (1=1" } as never })).rejects.toThrow();
    await expect(gadget.setPeriod({ period: { preset: "last30" }, locations: ["1) OR (1=1"] as never })).rejects.toThrow("whole numbers");
    await expect(gadget.setPeriod({ period: { preset: "last30" }, locations: [1.5] })).rejects.toThrow("whole numbers");
    await expect(gadget.setPeriod({ period: { from: "2025-10-31", to: "2025-10-01" } })).rejects.toThrow("The start date must not be after the end date.");
    await expect(failure(() => gadget.setPeriod({} as never))).rejects.toThrow("period must be a preset");

    expect((await gadget.getReport()).meta).toEqual(before);
    expect(JSON.stringify([...storage.map.values()])).not.toContain("DROP TABLE");
  });

  it("sends the period, the locations and a query's own values to the dataset only as parameters", async () => {
    const sql = "SELECT channel, COUNT(*) AS orders FROM orders WHERE business_date BETWEEN :from AND :to AND location_id IN (:locations) AND note = :note GROUP BY channel";
    const queryText = async (note: string) => {
      const { gadget, retail } = live();
      for (const section of await sectionsOf(gadget)) if (section.kind === "data") await gadget.removeSection({ id: section.id });
      await gadget.addSection({ section: { kind: "data", title: "Orders by channel", visual: { type: "table" }, query: { kind: "sql", sql, params: { note } } } });
      await gadget.setPeriod({ period: { from: "2025-10-01", to: "2025-10-31" }, locations: [2, 1] });
      const generated = await gadget.generate();
      expect(generated.failed).toEqual([]);
      expect(rowsOf(await gadget.readEdition(), "Orders by channel")).toEqual([["online", 7], ["in_store", 35]]);
      const sent = retail.runs.filter((run) => !/FROM locations/.test(run.sql));
      expect(sent).toHaveLength(1);
      return sent[0];
    };

    const hostile = "'; DROP TABLE orders;-- ? :from 1) OR (1=1";
    const benign = await queryText("gift");
    const attacked = await queryText(hostile);

    // The text the dataset receives is the same whatever the values are, and holds none of them.
    expect(attacked.sql).toBe(benign.sql);
    expect(attacked.sql).not.toContain("DROP");
    expect(attacked.sql).not.toContain("2025-10-01");
    expect(attacked.sql).toContain("IN (?, ?)");
    expect(attacked.params).toEqual(["2025-10-01", "2025-10-31", 2, 1, hostile]);
    expect(benign.params).toEqual(["2025-10-01", "2025-10-31", 2, 1, "gift"]);
  });
});

describe("letterhead", () => {
  it("stores a name, an accent colour and a PNG, JPEG or SVG logo as given", async () => {
    const { gadget } = live();
    for (const logo of [PNG, JPEG, SVG]) {
      await gadget.setLetterhead({ letterhead: { name: "  Acme Retail ", accent: "#0A7F5B", logo } });
      expect((await gadget.getReport()).meta.letterhead).toEqual({ name: "Acme Retail", accent: "#0a7f5b", logo });
    }
    // Setting it again replaces it whole.
    await gadget.setLetterhead({ letterhead: { name: "Acme" } });
    expect((await gadget.getReport()).meta.letterhead).toEqual({ name: "Acme" });
  });

  it("copies the letterhead into each edition as it was", async () => {
    const { gadget } = live();
    await gadget.setLetterhead({ letterhead: { name: "Acme", logo: PNG } });
    const { edition } = await gadget.generate();
    await gadget.setLetterhead({ letterhead: { name: "Renamed" } });
    expect((await gadget.readEdition({ id: edition.id })).letterhead).toEqual({ name: "Acme", logo: PNG });
  });

  it("refuses a logo of another type, with other contents, or over 200 KB", async () => {
    const { gadget } = live();
    const set = (letterhead: unknown) => failure(() => gadget.setLetterhead({ letterhead } as never));
    await expect(set({ logo: "data:image/gif;base64," + btoa("GIF89a") })).rejects.toThrow("The logo must be a PNG, JPEG or SVG image as a base64 data URL.");
    await expect(set({ logo: "https://example.com/logo.png" })).rejects.toThrow("The logo must be a PNG, JPEG or SVG image as a base64 data URL.");
    await expect(set({ logo: "data:text/html;base64," + btoa("<script>alert(1)</script>") })).rejects.toThrow("The logo must be a PNG, JPEG or SVG image as a base64 data URL.");
    await expect(set({ logo: 'data:image/svg+xml,<svg onload="alert(1)"/>' })).rejects.toThrow("The logo must be a PNG, JPEG or SVG image as a base64 data URL.");
    // The declared type has to be what the bytes are.
    await expect(set({ logo: "data:image/png;base64," + btoa("<svg></svg>") })).rejects.toThrow("The logo's contents are not the kind of image it says it is.");
    await expect(set({ logo: "data:image/svg+xml;base64," + btoa("<html><body>hi</body></html>") })).rejects.toThrow("The logo's contents are not the kind of image it says it is.");
    await expect(set({ logo: "data:image/png;base64," + btoa("\x89PNG\r\n\x1a\n" + "\0".repeat(LIMITS.logo)) })).rejects.toThrow("The logo is too large. Use an image of at most 200 KB.");
    await expect(set({ logo: 42 })).rejects.toThrow("The logo must be an image as a data URL.");
    expect((await gadget.getReport()).meta.letterhead).toEqual({});
  });

  it("refuses a bad name, accent or field", async () => {
    const { gadget } = live();
    const set = (letterhead: unknown) => failure(() => gadget.setLetterhead({ letterhead } as never));
    await expect(set({ name: "x".repeat(LIMITS.letterheadName + 1) })).rejects.toThrow("The letterhead's name can be at most 120 characters.");
    await expect(set({ accent: "red" })).rejects.toThrow("The accent colour must be written #rrggbb.");
    await expect(set({ accent: "#12345g" })).rejects.toThrow("The accent colour must be written #rrggbb.");
    await expect(set({ footer: "x" })).rejects.toThrow('"footer" is not one of them.');
    await expect(set("Acme")).rejects.toThrow("letterhead must be an object.");
  });
});

describe("data access modes", () => {
  it("withholds editions while the data is off, deletes nothing, and shows them again when it is back", async () => {
    const { gadget, storage, retail } = live();
    const { edition } = await gadget.generate();
    const summary = await firstText(gadget);
    await gadget.updateSection({ id: summary.id, text: "Net sales were $1,234.56." });
    const stored = structuredClone(storage.map.get("e:" + edition.id));
    const calls = retail.metrics.length;

    const dark = off(storage);
    const opened = await dark.open({ editionId: edition.id });
    expect(opened.data).toEqual({ status: "off", mode: "off" });
    expect(opened.edition).toBeNull();
    expect(opened.meta.editions).toEqual([]);
    expect(opened.review).toEqual([]);
    expect(opened.stale).toEqual([]);
    expect(opened.sections).toHaveLength(12);
    expect(await dark.getReport()).toMatchObject({ latestEdition: null, meta: { editions: [], title: "Monthly sales report" } });

    const refusal = "Retail data is not turned on for this organization. An administrator can turn it on from Data in the navigation.";
    await expect(dark.readEdition()).rejects.toThrow(refusal);
    await expect(dark.getEdition({ id: edition.id })).rejects.toThrow(refusal);
    await expect(dark.generate()).rejects.toThrow(refusal);
    await expect(dark.describeData()).rejects.toThrow(refusal);
    await expect(dark.previewQuery({ query: { kind: "metric", metric: "orders" } })).rejects.toThrow(refusal);
    await expect(dark.pinEdition({ id: edition.id, pinned: true })).rejects.toThrow(refusal);
    await expect(dark.deleteEdition({ id: edition.id })).rejects.toThrow(refusal);
    await expect(handler().export(dark, "markdown")).rejects.toThrow(refusal);

    // Headings and text stay editable, and a page that is told of the change hears of no edition.
    const changes: Changed[] = [];
    await dark.subscribe(watcher(changes, []));
    await dark.setTitle({ title: "Still editable" });
    expect(changes[0]).toMatchObject({ meta: { title: "Still editable", editions: [] }, review: [], stale: [] });

    expect(storage.map.get("e:" + edition.id)).toEqual(stored);
    expect(retail.metrics).toHaveLength(calls);

    const back = live(storage, retail).gadget;
    const reopened = await back.open();
    expect(reopened.data.mode).toBe("live");
    expect(reopened.edition?.id).toBe(edition.id);
    expect(reopened.meta.editions.map((known) => known.id)).toEqual([edition.id]);
    expect(reopened.meta.title).toBe("Still editable");
  });

  it("serves a view-only copy from what is stored and refuses every change and every read of the dataset", async () => {
    const { gadget, storage, retail } = live();
    const { edition } = await gadget.generate();
    const calls = { described: retail.described, runs: retail.runs.length, metrics: retail.metrics.length };
    const writes = storage.writes;
    const sections = await sectionsOf(gadget);

    const copy = snapshot(storage);
    const opened = await copy.open();
    expect(opened.data).toMatchObject({ status: "ok", mode: "snapshot" });
    expect(opened.edition?.id).toBe(edition.id);
    expect(opened.canUndo).toBe(false);
    expect(rowsOf(await copy.readEdition(), "Net sales")).toEqual([["USD", 123_456]]);
    expect((await copy.getReport()).latestEdition?.id).toBe(edition.id);

    const readOnly = "This is a read-only copy of the report.";
    await expect(copy.generate()).rejects.toThrow(readOnly);
    await expect(copy.setTitle({ title: "x" })).rejects.toThrow(readOnly);
    await expect(copy.addSection({ section: { kind: "text", text: "x" } })).rejects.toThrow(readOnly);
    await expect(copy.updateSection({ id: sections[2].id, text: "x" })).rejects.toThrow(readOnly);
    await expect(copy.removeSection({ id: sections[2].id })).rejects.toThrow(readOnly);
    await expect(copy.moveSection({ id: sections[2].id, after: null })).rejects.toThrow(readOnly);
    await expect(copy.setPeriod({ period: { preset: "last7" } })).rejects.toThrow(readOnly);
    await expect(copy.setLetterhead({ letterhead: { name: "x" } })).rejects.toThrow(readOnly);
    await expect(copy.markReviewed({ ids: [sections[2].id] })).rejects.toThrow(readOnly);
    await expect(copy.pinEdition({ id: edition.id, pinned: true })).rejects.toThrow(readOnly);
    await expect(copy.deleteEdition({ id: edition.id })).rejects.toThrow(readOnly);
    await expect(copy.undo()).rejects.toThrow(readOnly);
    await expect(copy.redo()).rejects.toThrow(readOnly);
    await expect(copy.describeData()).rejects.toThrow(readOnly);
    await expect(copy.previewQuery({ query: { kind: "metric", metric: "orders" } })).rejects.toThrow(readOnly);

    expect(storage.writes).toBe(writes);
    expect({ described: retail.described, runs: retail.runs.length, metrics: retail.metrics.length }).toEqual(calls);
  });

  it("shows the starter of a view-only copy that has nothing stored without writing it", async () => {
    const storage = new MemoryStorage();
    const copy = snapshot(storage);
    const opened = await copy.open();
    expect(opened.sections).toHaveLength(12);
    expect(opened.edition).toBeNull();
    expect((await copy.getReport()).sections.map((section) => section.id)).toEqual(opened.sections.map((section) => section.id));
    expect(storage.map.size).toBe(0);
  });

  it("treats a removed connection as data turned off", async () => {
    const { gadget, storage, retail } = live();
    const { edition } = await gadget.generate();
    retail.gone = true;

    await expect(gadget.generate()).rejects.toThrow("Retail data is not turned on for this organization.");
    const opened = await gadget.open();
    expect(opened.data).toEqual({ status: "off", mode: "off" });
    expect(opened.edition).toBeNull();
    expect(opened.meta.editions).toEqual([]);
    await expect(gadget.readEdition()).rejects.toThrow("Retail data is not turned on for this organization.");
    expect(storage.map.has("e:" + edition.id)).toBe(true);

    retail.gone = false;
    expect((await gadget.open()).edition?.id).toBe(edition.id);
  });
});

describe("scheduled regeneration", () => {
  it("generates one edition for a run, however often the run is delivered", async () => {
    const { gadget, storage } = live();
    const hook = await gadget[restore]({ type: "regenerate" });
    await hook.onSchedule(firing("run-1", "2025-11-10T08:00:00Z"));
    await hook.onSchedule(firing("run-1", "2025-11-10T08:05:00Z"));

    const editions = (await gadget.getReport()).meta.editions;
    expect(editions).toHaveLength(1);
    expect(editions[0].createdBy).toBe("schedule");
    expect(storage.map.get("runs")).toEqual([{ runId: "run-1", editionId: editions[0].id }]);

    // A hook restored later, as the scheduler does for every firing, knows the run was handled.
    const again = await live(storage).gadget[restore]({ type: "regenerate" });
    await again.onSchedule(firing("run-1", "2025-11-10T09:00:00Z"));
    expect(storage.keys("e:")).toHaveLength(1);

    await again.onSchedule(firing("run-2", "2025-11-17T08:00:00Z"));
    expect(storage.keys("e:")).toHaveLength(2);
    expect((storage.map.get("runs") as unknown[]).length).toBe(2);
  });

  it('runs only in the first seven days of the month with monthly: "first", by the schedule\'s own time zone', async () => {
    const { gadget, storage } = live();
    const hook = await gadget[restore]({ type: "regenerate", monthly: "first" });

    await hook.onSchedule(firing("day-8", "2025-12-08T08:00:00Z"));
    await hook.onSchedule(firing("day-31", "2025-12-31T23:00:00Z"));
    // 03:00 UTC on the 1st is still the 31st in Chicago.
    await hook.onSchedule(firing("chicago-31", "2025-11-01T03:00:00Z", "America/Chicago"));
    expect(storage.keys("e:")).toEqual([]);
    expect(storage.map.has("runs")).toBe(false);

    await hook.onSchedule(firing("day-7", "2025-12-07T08:00:00Z"));
    expect(storage.keys("e:")).toHaveLength(1);
    // 23:30 UTC on the 30th is already the 1st in Tokyo.
    await hook.onSchedule(firing("tokyo-1", "2025-11-30T23:30:00Z", "Asia/Tokyo"));
    expect(storage.keys("e:")).toHaveLength(2);
  });

  it("refuses to restore anything but a regeneration", async () => {
    const { gadget } = live();
    await expect(gadget[restore]({ type: "dailyBrief" } as never)).rejects.toThrow("Unknown restore type: dailyBrief");
    await expect(gadget[restore](undefined as never)).rejects.toThrow("Unknown restore type: undefined");
    await expect(gadget[restore]({ type: "regenerate", monthly: "last" } as never)).rejects.toThrow('monthly must be "first" when given.');
  });

  it("produces nothing and does not fail when the data is off, empty, or nothing can be made", async () => {
    const storage = new MemoryStorage();
    const dark = await off(storage)[restore]({ type: "regenerate" });
    await expect(dark.onSchedule(firing("run-1", "2025-11-10T08:00:00Z"))).resolves.toBeUndefined();
    expect(storage.keys("e:")).toEqual([]);
    expect(storage.map.has("runs")).toBe(false);

    const empty = live();
    empty.retail.dateRange = null;
    const hook = await empty.gadget[restore]({ type: "regenerate" });
    await expect(hook.onSchedule(firing("run-1", "2025-11-10T08:00:00Z"))).resolves.toBeUndefined();
    expect(empty.storage.keys("e:")).toEqual([]);

    // When the data is back, the same run can still produce its edition.
    const back = await live(storage).gadget[restore]({ type: "regenerate" });
    await back.onSchedule(firing("run-1", "2025-11-10T08:30:00Z"));
    expect(storage.keys("e:")).toHaveLength(1);
  });

  it("fails a firing the scheduler should retry, and one that names no run", async () => {
    const { gadget, retail, storage } = live();
    const hook = await gadget[restore]({ type: "regenerate" });
    const describe = retail.describe.bind(retail);
    retail.describe = async () => { throw new Error("The dataset is busy."); };
    await expect(hook.onSchedule(firing("run-1", "2025-11-10T08:00:00Z"))).rejects.toThrow("The data could not be read: The dataset is busy.");
    expect(storage.map.has("runs")).toBe(false);

    retail.describe = describe;
    await hook.onSchedule(firing("run-1", "2025-11-10T08:01:00Z"));
    expect(storage.keys("e:")).toHaveLength(1);
    await expect(hook.onSchedule({ ...firing("", "2025-11-10T08:00:00Z") })).rejects.toThrow("A scheduled firing must carry its runId.");
  });
});

describe("export", () => {
  async function markdown(gadget: Gadget): Promise<string> {
    return new Response(await handler().export(gadget, "markdown")).text();
  }

  it("offers PDF from the page and Markdown from the server", async () => {
    const { gadget } = live();
    expect(await handler().getExportFormats(gadget)).toEqual([
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
      { id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown; charset=utf-8", fileExtension: ".md" },
    ]);
    await expect(handler().export(gadget, "docx")).rejects.toThrow("Unsupported report export format: docx");
  });

  it("writes the latest edition as Markdown: text as written, each data block as a table of displayed values", async () => {
    const { gadget } = live();
    await gadget.setLetterhead({ letterhead: { name: "Acme Retail" } });
    const { edition } = await gadget.generate();
    const summary = await firstText(gadget);
    await gadget.updateSection({ id: summary.id, text: "Net sales were **$1,234.56**.\n\n- Downtown led." });
    const { sectionId: added } = await gadget.addSection({ section: { kind: "data", title: "Added since", visual: { type: "kpi" }, query: { kind: "metric", metric: "orders" } } });
    expect((await gadget.getReport()).stale).toEqual([added]);

    const text = await markdown(gadget);
    const asOf = new Date(edition.asOf).toISOString().slice(0, 16).replace("T", " ");
    expect(text.startsWith(`Acme Retail\n\n# Monthly sales report\n\nAs of ${asOf} UTC · 1–31 Oct 2025\n\n## Summary\n\nNet sales were **$1,234.56**.\n\n- Downtown led.\n\n**Net sales**\n\n`)).toBe(true);
    // The title is the report's own first heading, so it is written once.
    expect(text.match(/# Monthly sales report/g)).toHaveLength(1);
    expect(text).toContain("| $1,234.56 |");
    expect(text).toContain("| Downtown | $1,234.56 |");
    expect(text).toContain("| Product 11 | $1,234.56 |");
    expect(text).toContain("**Orders**\n\n| Value |\n| ---: |\n| 42 |");
    expect(text).toContain("Previous period (31 Aug – 30 Sep 2025):");
    // A block the edition does not hold is left out.
    expect(text).not.toContain("Added since");
  });

  it("says a block failed, and that a period is not complete yet", async () => {
    const { gadget, retail } = live();
    retail.refuse = "discounts";
    retail.completeThrough = "2025-10-20";
    await gadget.generate();
    const text = await markdown(gadget);
    expect(text).toContain("**Discounts by week**\n\n_Could not be computed: The metric discounts is not available for this dataset._");
    expect(text).toContain("_Data is complete through 20 Oct 2025; later days may be missing._");
  });

  it("has nothing to export before the first edition", async () => {
    const { gadget } = live();
    await expect(markdown(gadget)).rejects.toThrow("This report has not been generated yet.");
  });
});
