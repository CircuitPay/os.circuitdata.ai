// Browsing (spec 008, T006): paging covers every row once in a stable order; date, import, source
// and search filters narrow correctly and an undone import's rows are gone; hostile values match
// only literally and change nothing; unknown tables and bad queries are refused; customers stay
// masked unless allowed; a large table opens on its latest days; row detail returns every field,
// related rows and origin; the catalog counts what each view holds; the index migration applies to
// a dataset created before it.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { RetailAppApi } from "../src/app-ui.js";
import type { BrowsePage, BrowseQuery, BrowseTable } from "../src/app-api-types.js";
import { addDays } from "../src/dataset/coverage.js";
import type { RetailDataset } from "../src/dataset/dataset-do.js";
import type { RetailAccountProps } from "../src/vendor.js";
import { ADMIN, MEMBER, importFiles, refusal } from "./import-helpers.js";
import { at, createSource, ingestRun, inspect, line, location, newDataset, order, payment } from "./helpers.js";

const BROWSABLE: BrowseTable[] = ["orders", "line_items", "transactions", "products", "customers", "locations", "inventory"];

/** A table name as a caller might send it, browsable or not. */
const tableNamed = (name: string) => name as BrowseTable;

/** A query as a caller might send it, well-formed or not. */
const queryOf = (query: Record<string, unknown>) => query as BrowseQuery;

/** `perDay` orders a day for `days` days from `from`, one line each; ids `<prefix>-<date>-<n>`. */
function ordersCsv(prefix: string, from: string, days: number, perDay: number): string {
  const rows = ["Order ID,Date,Location,Item,Qty,Price,Total"];
  for (let day = 0; day < days; day++) {
    const date = addDays(from, day);
    for (let n = 1; n <= perDay; n++) rows.push(`${prefix}-${date}-${n},${date} 1${n}:00:00,Main Street,Latte,1,4.50,4.50`);
  }
  return [...rows, ""].join("\n");
}

class FakeAccess extends RpcTarget {
  constructor(private readonly member: boolean) {
    super();
  }

  async current(): Promise<{ canManage: boolean }> {
    if (!this.member) throw new Error("You are no longer a member of this organization.");
    return { canManage: false };
  }
}

function appApi(datasetId: string, member = true): RetailAppApi {
  return new RetailAppApi({
    dataset: env.RETAIL_DATASET.getByName(`test\0dataset\0${datasetId}`),
    datasetId,
    access: new RpcStub(new FakeAccess(member)) as never,
    memberId: "member-1",
    connections: env.RETAIL_CONNECTION,
    sharingDomain: "test",
    providers: [],
    baseUrl: "https://workshop.example/gatekeeper/retail",
  });
}

/** Row counts of every table plus the schema text: what a read must leave unchanged. */
function snapshot(dataset: DurableObjectStub<RetailDataset>): Promise<string> {
  return runInDurableObject(dataset, (_instance, state) => {
    const sql = state.storage.sql;
    const objects = sql.exec<{ type: string; name: string; sql: string | null }>(
      "SELECT type, name, sql FROM sqlite_schema ORDER BY name").toArray();
    // `_cf_*` tables are the runtime's own and not readable.
    const counts = objects.filter(object => object.type === "table" && !object.name.startsWith("_cf_")).map(object =>
      `${object.name}=${sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${object.name}"`).one().n}`);
    return JSON.stringify({ objects, counts });
  });
}

/** Every page of `table` under `query`, in order. */
async function allPages(
  dataset: DurableObjectStub<RetailDataset>, datasetId: string, table: BrowseTable, query: BrowseQuery,
): Promise<BrowsePage[]> {
  const pages: BrowsePage[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await dataset.browseRows(datasetId, table, { ...query, offset });
    pages.push(page);
    if (offset + 100 >= page.total) return pages;
  }
}

/** The value of `column` in each row of a page. */
function valuesOf(page: BrowsePage, column: string): (string | number | boolean | null)[] {
  const index = page.columns.findIndex(entry => entry.name === column);
  return page.rows.map(row => row.values[index]!);
}

describe("browsing CSV imports", () => {
  let props: RetailAccountProps;
  let dataset: DurableObjectStub<RetailDataset>;
  let september: { id: number; sourceId: number };
  let october: { id: number; sourceId: number };
  let website: { id: number; sourceId: number };

  beforeAll(async () => {
    ({ props, dataset } = newDataset());
    // 160 orders in all, above the suite's RETAIL_SCAN_ROW_LIMIT of 50.
    ({ run: september } = await importFiles(dataset, props.datasetId,
      [{ name: "september.csv", text: ordersCsv("S", "2026-09-01", 40, 3) }]));
    ({ run: october } = await importFiles(dataset, props.datasetId,
      [{ name: "october.csv", text: ordersCsv("O", "2026-10-11", 10, 3) }], { target: september.sourceId }));
    ({ run: website } = await importFiles(dataset, props.datasetId,
      [{ name: "web.csv", text: ordersCsv("W", "2026-10-15", 5, 2) }], { target: { newSourceLabel: "Website" } }));
  });

  it("pages through every row exactly once, newest first, with the matching total", async () => {
    const query = { from: "2026-01-01", to: "2026-12-31" };
    const pages = await allPages(dataset, props.datasetId, "orders", query);
    expect(pages.map(page => [page.offset, page.rows.length, page.total, page.narrowedTo])).toEqual([
      [0, 100, 160, null], [100, 60, 160, null],
    ]);
    const ids = pages.flatMap(page => page.rows.map(row => row.id));
    const stored = await inspect<{ id: number }>(dataset, "SELECT id FROM store_orders ORDER BY business_date DESC, id DESC");
    expect(ids).toEqual(stored.map(row => row.id));
    expect(new Set(ids).size).toBe(160);
    expect(await dataset.browseRows(props.datasetId, "orders", { ...query, offset: 100 })).toEqual(pages[1]);
    expect(await dataset.browseRows(props.datasetId, "orders", { ...query, offset: 200 }))
      .toMatchObject({ rows: [], total: 160, offset: 200, pageSize: 100 });
    expect(pages[0]!.columns.map(column => column.name)).toEqual(
      ["business_date", "order_number", "location_id", "status", "channel", "total_amount", "currency", "customer_id"]);
    expect(pages[0]!.columns.find(column => column.name === "total_amount"))
      .toEqual({ name: "total_amount", type: "money", currencyColumn: "currency", description: "What the customer was charged." });
  });

  it("narrows by date range, import and source", async () => {
    const days = await dataset.browseRows(props.datasetId, "orders", { from: "2026-10-11", to: "2026-10-12" });
    expect(days.total).toBe(6);
    expect(new Set(valuesOf(days, "business_date"))).toEqual(new Set(["2026-10-11", "2026-10-12"]));
    const lines = await dataset.browseRows(props.datasetId, "line_items", { from: "2026-10-15", to: "2026-10-15" });
    expect(lines.total).toBe(5);

    const fromOctober = await dataset.browseRows(props.datasetId, "orders", { runId: october.id });
    expect(fromOctober).toMatchObject({ total: 30, narrowedTo: null });
    const octoberIds = await inspect<{ id: number }>(dataset,
      "SELECT id FROM store_orders WHERE source_record_id LIKE 'O-%' ORDER BY business_date DESC, id DESC");
    expect(fromOctober.rows.map(row => row.id)).toEqual(octoberIds.map(row => row.id));
    const fromSeptember = await allPages(dataset, props.datasetId, "orders", { runId: september.id });
    expect(fromSeptember.flatMap(page => page.rows)).toHaveLength(120);

    expect((await dataset.browseRows(props.datasetId, "orders", { sourceId: september.sourceId })).total).toBe(150);
    expect((await dataset.browseRows(props.datasetId, "orders", { sourceId: website.sourceId })).total).toBe(10);
    expect((await dataset.browseRows(props.datasetId, "locations", { sourceId: website.sourceId })).total).toBe(1);
    expect((await dataset.browseRows(props.datasetId, "orders", { runId: october.id, sourceId: website.sourceId })).total).toBe(0);
    const combined = await dataset.browseRows(props.datasetId, "orders",
      { runId: october.id, from: "2026-10-20", to: "2026-10-20" });
    expect(combined.total).toBe(3);
  });

  it("opens a table above the scan limit on its last 30 days, and only when unfiltered", async () => {
    const page = await dataset.browseRows(props.datasetId, "orders");
    expect(page.narrowedTo).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    const [{ n }] = await inspect<{ n: number }>(dataset,
      "SELECT COUNT(*) AS n FROM store_orders WHERE business_date BETWEEN '2026-09-21' AND '2026-10-20'") as [{ n: number }];
    expect(page.total).toBe(n);
    expect(page.total).toBeLessThan(160);
    const narrowed = await allPages(dataset, props.datasetId, "orders", {});
    for (const date of narrowed.flatMap(entry => valuesOf(entry, "business_date"))) {
      expect(date! >= "2026-09-21" && date! <= "2026-10-20").toBe(true);
    }
    expect((await dataset.browseRows(props.datasetId, "orders", { runId: september.id })).narrowedTo).toBeNull();
    expect((await dataset.browseRows(props.datasetId, "orders", { sourceId: website.sourceId })).narrowedTo).toBeNull();
    expect((await dataset.browseRows(props.datasetId, "orders", { from: "2026-09-01" })).narrowedTo).toBeNull();
    expect((await dataset.browseRows(props.datasetId, "line_items")).narrowedTo).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    // Undated tables are never narrowed.
    expect((await dataset.browseRows(props.datasetId, "locations")).narrowedTo).toBeNull();
  });

  it("traces a row to its file and row number", async () => {
    const [stored] = await inspect<{ id: number }>(dataset, "SELECT id FROM store_orders WHERE source_record_id = 'O-2026-10-11-2'");
    const detail = await dataset.rowDetail(props.datasetId, "orders", stored!.id);
    expect(detail.origin).toMatchObject({
      table: "orders",
      id: stored!.id,
      source: { id: september.sourceId, kind: "csv", label: "Front counter" },
      sourceRecordId: "O-2026-10-11-2",
      run: { id: october.id, kind: "import" },
      file: { name: "october.csv", row: 3 },
    });
    const items = detail.related.find(relation => relation.label === "Line items")!;
    expect(items).toMatchObject({ table: "line_items", truncated: false });
    expect(items.rows).toHaveLength(1);
    expect(detail.related.map(relation => relation.label)).toEqual(["Line items", "Payments", "Location"]);
  });
});

describe("browsing after an undo", () => {
  it("drops the undone import's rows from pages, counts and detail", async () => {
    const { props, dataset } = newDataset();
    const { run: first } = await importFiles(dataset, props.datasetId,
      [{ name: "first.csv", text: ordersCsv("A", "2026-10-01", 5, 1) }]);
    const { run: second } = await importFiles(dataset, props.datasetId,
      [{ name: "second.csv", text: ordersCsv("B", "2026-10-06", 3, 1) }], { target: first.sourceId });
    const before = await dataset.browseRows(props.datasetId, "orders", { runId: second.id });
    expect(before.total).toBe(3);

    await dataset.undoImport(props.datasetId, second.id, MEMBER);
    expect((await dataset.browseRows(props.datasetId, "orders", { runId: second.id })).total).toBe(0);
    const remaining = await dataset.browseRows(props.datasetId, "orders");
    expect(remaining.total).toBe(5);
    expect(remaining.rows.every(row => !before.rows.some(gone => gone.id === row.id))).toBe(true);
    expect((await dataset.browseCatalog(props.datasetId)).tables.find(table => table.name === "orders")?.rows).toBe(5);
    expect(await refusal(dataset.rowDetail(props.datasetId, "orders", before.rows[0]!.id))).toBe("This row no longer exists.");
  });
});

describe("browsing ingested rows", () => {
  let props: RetailAccountProps;
  let dataset: DurableObjectStub<RetailDataset>;
  let sourceId: number;
  const id = async (table: string, sourceRecordId: string) =>
    (await inspect<{ id: number }>(dataset, `SELECT id FROM store_${table} WHERE source_record_id = ?`, sourceRecordId))[0]!.id;

  beforeAll(async () => {
    ({ props, dataset } = newDataset());
    sourceId = await createSource(dataset, props.datasetId, "Square", "square");
    const big = Array.from({ length: 55 }, (_, index) =>
      line({ sourceRecordId: `big-${index}`, orderRef: "o-big", name: `Cookie ${index}` }));
    await ingestRun(dataset, props.datasetId, sourceId, {
      locations: [location()],
      customers: [
        { sourceRecordId: "c-ada", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "+1 415 555 1234" },
        { sourceRecordId: "c-sean", firstName: "Sean", lastName: "O'Brien", email: "sean@example.com" },
      ],
      products: [
        { sourceRecordId: "p-coffee", name: "Coffee" },
        { sourceRecordId: "p-arabica", name: "100% Arabica", sku: "AR_100", parentRef: "p-coffee" },
        { sourceRecordId: "p-latte-l", name: "Latte_Large", sku: "LAT-L" },
        { sourceRecordId: "p-latte-xl", name: "Latte Large", sku: "LATXL" },
        { sourceRecordId: "p-barista", name: "Barista's Choice" },
      ],
      orders: [
        order({ sourceRecordId: "o-1", orderNumber: "1001", customerRef: "c-ada", totalAmount: 1300 }),
        order({ sourceRecordId: "o-2", orderNumber: "50%_off", customerRef: "c-sean", totalAmount: 250 }),
        order({ sourceRecordId: "o-gone", orderNumber: "1003", totalAmount: 100, deletedAt: at("2026-10-06T00:00:00Z") }),
        order({ sourceRecordId: "o-big", orderNumber: "1004", totalAmount: 55 * 500 }),
      ],
      lineItems: [
        line({ sourceRecordId: "l-1", orderRef: "o-1", productRef: "p-latte-l", name: "Latte_Large" }),
        line({ sourceRecordId: "l-2", orderRef: "o-1", productRef: "p-arabica", name: "100% Arabica", unitPriceAmount: 800 }),
        ...big,
      ],
      transactions: [payment({ sourceRecordId: "t-1", orderRef: "o-1", amount: 1300 })],
      inventory: [{ sourceRecordId: "i-1", productRef: "p-arabica", locationRef: "loc-1", quantityOnHandE4: 120_000, state: "in_stock", asOf: at("2026-10-05T00:00:00Z") }],
    });
  });

  it("counts what each view holds without deleted rows, with the dates and sources", async () => {
    const catalog = await dataset.browseCatalog(props.datasetId);
    expect(catalog.tables.map(table => table.name)).toEqual(BROWSABLE);
    for (const table of BROWSABLE) {
      const [{ n }] = await inspect<{ n: number }>(dataset, `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`) as [{ n: number }];
      expect(catalog.tables.find(entry => entry.name === table)?.rows).toBe(n);
    }
    expect(catalog.tables.find(entry => entry.name === "orders")).toMatchObject({
      label: "Orders", rows: 3, dateColumn: "business_date", search: { columns: ["order_number"], label: "order number" },
    });
    expect(catalog.tables.find(entry => entry.name === "transactions")).toMatchObject({ label: "Payments", search: null });
    expect(catalog.tables.find(entry => entry.name === "products")).toMatchObject({ rows: 5, dateColumn: null });
    const description = await dataset.describe(props.datasetId);
    expect(catalog.dateRange).toEqual(description.dateRange);
    expect(catalog.completeThrough).toBe(description.completeThrough);
    expect(catalog.personalDataMasked).toBe(true);
    expect(catalog.sources).toEqual([{ id: sourceId, kind: "square", label: "Square" }]);
  });

  it("matches search text and filter values only literally and changes nothing", async () => {
    const before = await snapshot(dataset);
    const names = async (search: string) =>
      valuesOf(await dataset.browseRows(props.datasetId, "products", { search }), "name").toSorted();
    expect(await names("%")).toEqual(["100% Arabica"]);
    expect(await names("_")).toEqual(["100% Arabica", "Latte_Large"]);
    expect(await names("e_L")).toEqual(["Latte_Large"]);
    expect(await names("LATTE")).toEqual(["Latte Large", "Latte_Large"]);
    expect(await names("ar_1")).toEqual(["100% Arabica"]);
    expect(await names("'")).toEqual(["Barista's Choice"]);
    expect(await names("\\")).toEqual([]);
    expect(await names("\"; DROP TABLE store_orders; --")).toEqual([]);
    expect(await names("') OR 1=1 --")).toEqual([]);
    const orderNumbers = async (search: string) =>
      valuesOf(await dataset.browseRows(props.datasetId, "orders", { search }), "order_number");
    expect(await orderNumbers("%")).toEqual(["50%_off"]);
    expect(await orderNumbers("0%_")).toEqual(["50%_off"]);
    expect(await orderNumbers("100")).toEqual(["1004", "1001"]);
    expect(await orderNumbers("' OR '1'='1")).toEqual([]);

    const refusals = await Promise.all([
      refusal(dataset.browseRows(props.datasetId, "orders", queryOf({ runId: "1 OR 1=1" }))),
      refusal(dataset.browseRows(props.datasetId, "orders", queryOf({ sourceId: "1; DROP TABLE store_orders" }))),
      refusal(dataset.browseRows(props.datasetId, "orders", queryOf({ from: "2026-01-01' OR '1'='1" }))),
      refusal(dataset.browseRows(props.datasetId, "orders", queryOf({ offset: "0; DELETE FROM store_orders" }))),
    ]);
    expect(refusals).toEqual([
      "runId must be a positive whole number.",
      "sourceId must be a positive whole number.",
      "from must be a date written YYYY-MM-DD.",
      "offset must be a multiple of 100 from 0 to 1000000.",
    ]);
    expect(await snapshot(dataset)).toBe(before);
    expect((await dataset.browseCatalog(props.datasetId)).tables.find(table => table.name === "orders")?.rows).toBe(3);
  });

  it("refuses unknown tables, column names and invalid queries", async () => {
    for (const name of ["store_orders", "order_number", "sources", "daily_sales", "constructor", "__proto__", "orders; DROP TABLE store_orders"]) {
      expect(await refusal(dataset.browseRows(props.datasetId, tableNamed(name)))).toBe("This table cannot be browsed.");
      expect(await refusal(dataset.rowDetail(props.datasetId, tableNamed(name), 1))).toBe("This table cannot be browsed.");
    }
    const refused = (table: BrowseTable, query: BrowseQuery) => refusal(dataset.browseRows(props.datasetId, table, query));
    for (const offset of [50, -100, 1_000_100, 1.5]) {
      expect(await refused("orders", { offset })).toBe("offset must be a multiple of 100 from 0 to 1000000.");
    }
    expect((await dataset.browseRows(props.datasetId, "orders", { offset: 1_000_000 })).rows).toEqual([]);
    expect(await refused("orders", { from: "2026-02-30" })).toBe("from must be a date written YYYY-MM-DD.");
    expect(await refused("orders", { to: "10/05/2026" })).toBe("to must be a date written YYYY-MM-DD.");
    expect(await refused("orders", { from: "2026-10-06", to: "2026-10-05" })).toBe("from must not be after to.");
    expect(await refused("products", { from: "2026-10-05" })).toBe("Products cannot be filtered by date.");
    expect(await refused("transactions", { search: "card" })).toBe("Payments cannot be searched.");
    expect(await refused("products", { search: "" })).toBe("Search text must be 1 to 100 characters.");
    expect(await refused("products", { search: "x".repeat(101) })).toBe("Search text must be 1 to 100 characters.");
    expect(await refused("orders", { runId: 0 })).toBe("runId must be a positive whole number.");
    expect(await refused("orders", { sourceId: 1.5 })).toBe("sourceId must be a positive whole number.");
    expect(await refusal(dataset.rowDetail(props.datasetId, "orders", -1))).toBe("id must be a row id.");

    // Through the Data area capability, the generated validation refuses what the types exclude.
    const api = appApi(props.datasetId);
    const call = (method: () => Promise<unknown>) => Promise.resolve().then(method);
    await expect(call(() => api.browseRows(tableNamed("store_orders")))).rejects.toThrow(TypeError);
    await expect(call(() => api.browseRows("orders", queryOf({ runId: "1 OR 1=1" })))).rejects.toThrow(TypeError);
    await expect(call(() => api.getRowDetail(tableNamed("sources"), 1))).rejects.toThrow(TypeError);
  });

  it("masks customers unless an administrator allowed unmasked access", async () => {
    const customers = async () => {
      const page = await dataset.browseRows(props.datasetId, "customers");
      return page.rows.map(row => row.values.slice(0, 4)).toSorted();
    };
    expect(await customers()).toEqual([
      ["A.", "L.", "a***@example.com", "***-***-1234"],
      ["S.", "O.", "s***@example.com", null],
    ]);
    // Search sees only the masks, so it cannot reveal a hidden name.
    expect((await dataset.browseRows(props.datasetId, "customers", { search: "Lovelace" })).total).toBe(0);
    const ada = await dataset.rowDetail(props.datasetId, "customers", await id("customers", "c-ada"));
    expect(ada.fields.find(field => field.column.name === "email")).toMatchObject({ column: { personal: true }, value: "a***@example.com" });

    await dataset.setPersonalDataUnmasked(props.datasetId, true, ADMIN.memberId);
    try {
      expect(await customers()).toEqual([
        ["Ada", "Lovelace", "ada@example.com", "+1 415 555 1234"],
        ["Sean", "O'Brien", "sean@example.com", null],
      ]);
      expect((await dataset.browseRows(props.datasetId, "customers", { search: "lovelace" })).total).toBe(1);
      expect((await dataset.browseCatalog(props.datasetId)).personalDataMasked).toBe(false);
    } finally {
      await dataset.setPersonalDataUnmasked(props.datasetId, false, ADMIN.memberId);
    }
    expect((await customers())[0]).toEqual(["A.", "L.", "a***@example.com", "***-***-1234"]);
  });

  it("returns every field of a row, its related rows and its origin", async () => {
    const orderId = await id("orders", "o-1");
    const detail = await dataset.rowDetail(props.datasetId, "orders", orderId);
    const published = (await dataset.describe(props.datasetId)).tables.find(table => table.name === "orders")!;
    expect(detail.fields.map(field => field.column)).toEqual(published.columns);
    const field = (name: string) => detail.fields.find(entry => entry.column.name === name)?.value;
    expect([field("id"), field("order_number"), field("total_amount"), field("prices_include_tax"), field("deleted_at")])
      .toEqual([orderId, "1001", 1300, false, null]);
    expect(detail.related.map(relation => [relation.label, relation.table, relation.rows.length, relation.truncated])).toEqual([
      ["Line items", "line_items", 2, false],
      ["Payments", "transactions", 1, false],
      ["Location", "locations", 1, false],
      ["Customer", "customers", 1, false],
    ]);
    const items = detail.related[0]!;
    expect(items.columns.map(column => column.name)).toEqual(
      ["business_date", "order_id", "name", "quantity", "unit_price_amount", "net_amount", "currency"]);
    expect(items.rows.map(row => row.values[2]).toSorted()).toEqual(["100% Arabica", "Latte_Large"]);
    expect(detail.related[3]!.rows[0]!.values[0]).toBe("A.");
    expect(detail.origin).toEqual({
      table: "orders", id: orderId, source: { id: sourceId, kind: "square", label: "Square" }, sourceRecordId: "o-1",
      run: { id: expect.any(Number), kind: "import", finishedAt: expect.any(String) }, mappingVersion: "test-v1",
    });

    const big = await dataset.rowDetail(props.datasetId, "orders", await id("orders", "o-big"));
    expect(big.related[0]).toMatchObject({ label: "Line items", truncated: true });
    expect(big.related[0]!.rows).toHaveLength(50);
    // No customer on the order: nothing to relate.
    expect(big.related.map(relation => relation.label)).toEqual(["Line items", "Payments", "Location"]);

    const lineDetail = await dataset.rowDetail(props.datasetId, "line_items", await id("line_items", "l-1"));
    expect(lineDetail.related.map(relation => [relation.label, relation.rows.map(row => row.id)])).toEqual([
      ["Order", [orderId]], ["Product", [await id("products", "p-latte-l")]],
    ]);
    const product = await dataset.rowDetail(props.datasetId, "products", await id("products", "p-arabica"));
    expect(product.related.map(relation => [relation.label, relation.rows.map(row => row.values[0])])).toEqual([
      ["Parent product", ["Coffee"]],
    ]);
    const customer = await dataset.rowDetail(props.datasetId, "customers", await id("customers", "c-ada"));
    expect(customer.related.map(relation => [relation.label, relation.rows.map(row => row.id)])).toEqual([["Orders", [orderId]]]);
    const stock = await dataset.rowDetail(props.datasetId, "inventory", await id("inventory", "i-1"));
    expect(stock.related.map(relation => relation.label)).toEqual(["Product", "Location"]);
    expect(stock.fields.find(entry => entry.column.name === "quantity_on_hand")?.value).toBe(12);
  });

  it("refuses a deleted or missing row", async () => {
    expect(await refusal(dataset.rowDetail(props.datasetId, "orders", await id("orders", "o-gone")))).toBe("This row no longer exists.");
    expect(await refusal(dataset.rowDetail(props.datasetId, "orders", 999_999))).toBe("This row no longer exists.");
    expect(valuesOf(await dataset.browseRows(props.datasetId, "orders", { search: "1003" }), "order_number")).toEqual([]);
  });

  it("re-reads membership on every call through the Data area capability", async () => {
    const api = appApi(props.datasetId);
    expect(await api.getBrowseCatalog()).toEqual(await dataset.browseCatalog(props.datasetId));
    expect((await api.browseRows("products", { search: "latte" })).total).toBe(2);
    expect((await api.getRowDetail("orders", await id("orders", "o-1"))).id).toBe(await id("orders", "o-1"));
    const former = appApi(props.datasetId, false);
    for (const call of [former.getBrowseCatalog(), former.browseRows("orders"), former.getRowDetail("orders", 1)]) {
      expect(await refusal(call)).toBe("You are no longer a member of this organization.");
    }
  });
});

describe("the browse index migration", () => {
  const INDEXES = BROWSABLE.flatMap(table => [`store_${table}_run`, `store_${table}_source`]).toSorted();
  const indexes = (dataset: DurableObjectStub<RetailDataset>) => runInDurableObject(dataset, (_instance, state) =>
    state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name").toArray()
      .map(row => row.name)
      .filter(name => name.startsWith("store_") && (name.endsWith("_run") || name.endsWith("_source"))));

  it("adds the run and source indexes to a dataset created before it, keeping its rows", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    await ingestRun(dataset, props.datasetId, sourceId, { locations: [location()], orders: [order({ sourceRecordId: "o-1" })] });
    expect(await indexes(dataset)).toEqual(INDEXES);

    // Back to the first schema version, as a dataset created before the migration has it.
    await runInDurableObject(dataset, (_instance, state) => {
      for (const name of INDEXES) state.storage.sql.exec(`DROP INDEX ${name}`);
      state.storage.kv.put("schemaVersion", 1);
    });
    expect(await indexes(dataset)).toEqual([]);

    expect((await dataset.browseCatalog(props.datasetId)).tables.find(table => table.name === "orders")?.rows).toBe(1);
    expect(await indexes(dataset)).toEqual(INDEXES);
    expect(await runInDurableObject(dataset, (_instance, state) => state.storage.kv.get("schemaVersion"))).toBe(2);
  });
});
