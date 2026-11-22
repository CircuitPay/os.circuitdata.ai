// Guarded SQL (T030, US3.2, SC-008): every case in quickstart.md "Guarded SQL" is refused and leaves
// row counts and sqlite_schema unchanged; ordinary analytical queries run, typed and capped.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { RetailDataset } from "../src/dataset/dataset-do.js";
import type { RetailAccountProps } from "../src/vendor.js";
import { at, createSource, ingestRun, line, location, newDataset, order, payment } from "./helpers.js";

// Above the suite's RETAIL_SCAN_ROW_LIMIT of 50.
const ORDERS = 60;

let props: RetailAccountProps;
let dataset: DurableObjectStub<RetailDataset>;

beforeAll(async () => {
  ({ props, dataset } = newDataset());
  const sourceId = await createSource(dataset, props.datasetId);
  const days = Array.from({ length: ORDERS }, (_, index) => index);
  await ingestRun(dataset, props.datasetId, sourceId, {
    locations: [location()],
    orders: days.map(day => order({
      sourceRecordId: `o-${day}`,
      closedAt: at("2026-09-01T16:00:00Z") + day * 86_400,
      status: day % 10 === 0 ? "voided" : "completed",
      totalAmount: 500,
    })),
    lineItems: days.map(day => line({ sourceRecordId: `l-${day}`, orderRef: `o-${day}` })),
    transactions: days.map(day => payment({
      sourceRecordId: `p-${day}`, orderRef: `o-${day}`, amount: 500,
      occurredAt: at("2026-09-01T16:00:00Z") + day * 86_400,
    })),
  });
});

/** Row counts of every table plus the schema text: what a refused query must leave unchanged. */
function snapshot(): Promise<string> {
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

/** Runs `sql` through the guard inside the dataset object, returning the refusal or the result. */
function guarded(sql: string, params?: (string | number | boolean | null)[]) {
  return runInDurableObject(dataset, instance => {
    try {
      return { result: instance.query(props.datasetId, sql, params) };
    } catch (error) {
      return { refusal: error as Error & { reason?: string } };
    }
  });
}

const REFUSED: [string, string, RegExp][] = [
  ["SELECT 1; DELETE FROM orders", "not_single_statement", /exactly one SELECT/],
  ["WITH x AS (SELECT 1) DELETE FROM orders", "writes", /Only SELECT/],
  ["UPDATE store_orders SET total_amount = 0 RETURNING id", "not_a_query", /Only SELECT/],
  ["DELETE FROM store_line_items", "not_a_query", /Only SELECT/],
  ["DROP TABLE store_orders", "not_a_query", /Only SELECT/],
  ["CREATE TABLE x (a)", "not_a_query", /Only SELECT/],
  ["PRAGMA query_only = 1", "not_a_query", /Only SELECT/],
  ["ATTACH 'other.db' AS other", "not_a_query", /Only SELECT/],
  ["SELECT * FROM store_orders", "relation", /"store_orders" is not a table you can query/],
  ['SELECT * FROM "store_orders"', "relation", /"store_orders" is not a table/],
  ["SELECT * FROM sqlite_schema", "relation", /"sqlite_schema" is not a table/],
  ["SELECT * FROM main.orders", "relation", /without a schema prefix/],
  ["SELECT * FROM pragma_table_info('orders')", "relation", /Table-valued functions/],
  ["SELECT * FROM orders, json_each('[1]')", "relation", /Table-valued functions/],
  ["WITH store_orders AS (SELECT 1 AS id) SELECT id FROM store_orders", "relation", /cannot be used as a CTE name/],
  ["WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r", "recursive", /WITH RECURSIVE/],
  ["SELECT load_extension('evil')", "function", /load_extension\(\) is not allowed/],
  ["SELECT zeroblob(1000000000)", "function", /zeroblob\(\) is not allowed/],
  ["SELECT printf('%.*c', 1000000000, 'x')", "function", /printf\(\) is not allowed/],
  ["SELECT id, (SELECT COUNT(*) FROM pragma_table_list) FROM orders WHERE business_date = '2026-09-01'", "relation", /not a table you can query/],
  ["SELEKT 1", "syntax", /could not be parsed/],
  ["SELECT * FROM line_items", "full_scan", /scan all of line_items .*metric\(\) or the daily_\* tables/],
  ["SELECT l.name FROM line_items AS l", "full_scan", /scan all of line_items/],
  ["WITH x AS (SELECT * FROM line_items) SELECT COUNT(*) FROM x", "full_scan", /scan all of line_items/],
  ["SELECT COUNT(*) FROM orders o JOIN transactions t ON t.order_id = o.id", "full_scan", /scan all of/],
];

describe("guarded SQL", () => {
  it.each(REFUSED)("refuses %s", async (sql, reason, message) => {
    const before = await snapshot();
    const outcome = await guarded(sql);
    expect(outcome.result).toBeUndefined();
    expect(outcome.refusal?.reason).toBe(reason);
    expect(outcome.refusal?.message).toMatch(message);
    expect(await snapshot()).toBe(before);
  });

  it("refuses more than 100 parameters", async () => {
    const outcome = await guarded(
      "SELECT id FROM orders WHERE business_date = ?", Array.from({ length: 101 }, () => "2026-09-01"));
    expect(outcome.refusal?.reason).toBe("params");
  });

  it("runs an analytical query and types its columns", async () => {
    const { result } = await guarded(
      "SELECT business_date, currency, SUM(net_amount) AS net_amount, SUM(orders) AS orders " +
      "FROM daily_sales WHERE business_date BETWEEN ? AND ? GROUP BY business_date, currency ORDER BY business_date",
      ["2026-09-01", "2026-09-02"]);
    expect(result?.columns).toEqual([
      { name: "business_date", type: "date" },
      { name: "currency", type: "text" },
      { name: "net_amount", type: "money", currencyColumn: "currency" },
      { name: "orders", type: "integer" },
    ]);
    expect(result?.rows).toEqual([["2026-09-01", "USD", 0, 0], ["2026-09-02", "USD", 500, 1]]);
    expect(result?.truncated).toBe(false);
    expect(result?.views).toEqual(["daily_sales"]);
  });

  it("allows FILTER, window functions and indexed date ranges over fact tables", async () => {
    const { result } = await guarded(
      "SELECT COUNT(*) FILTER (WHERE status = 'voided') AS voided, COUNT(*) AS all_orders " +
      "FROM orders WHERE business_date BETWEEN ? AND ?", ["2026-09-01", "2026-10-30"]);
    expect(result?.rows).toEqual([[6, ORDERS]]);

    const windowed = await guarded(
      "SELECT business_date, SUM(net_amount) OVER (ORDER BY business_date) AS running_amount, currency " +
      "FROM daily_sales WHERE business_date <= ? ORDER BY business_date", ["2026-09-03"]);
    expect(windowed.result?.rows.map(row => row[1])).toEqual([0, 500, 1_000]);
  });

  it("caps rows and reports truncation; booleans come back as booleans", async () => {
    const { result } = await runInDurableObject(dataset, instance => ({
      result: instance.query(props.datasetId,
        "SELECT id, is_voided FROM line_items WHERE business_date BETWEEN ? AND ?", ["2026-09-01", "2026-12-31"],
        { maxRows: 5 }),
    }));
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.columns[1]).toEqual({ name: "is_voided", type: "boolean" });
    expect(result.rows[0]![1]).toBe(false);
  });

  it("serves the session's run() and records an observation without row values", async () => {
    const host = env.TEST_HOST.getByName(`guard-${props.datasetId}`);
    const result = await host.run(props,
      "SELECT order_number, total_amount, currency FROM orders WHERE business_date = ?", ["2026-09-02"]);
    expect(result).toEqual({
      columns: [
        { name: "order_number", type: "text" },
        { name: "total_amount", type: "money", currencyColumn: "currency" },
        { name: "currency", type: "text" },
      ],
      rows: [[null, 500, "USD"]],
      truncated: false,
    });
    const [observation] = await host.observations();
    expect(observation?.title).toBe("Queried retail data: orders");
    expect(observation?.description).toContain("received 1 row.");
    expect(observation?.description).toContain("WHERE business_date = ?");
    expect(observation?.description).not.toContain("2026-09-02");
  });
});
