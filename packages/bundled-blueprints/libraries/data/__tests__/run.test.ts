// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { QueryOutcome, QueryResult, ResolvedFilters } from "../src/model.ts";
import type {
  RetailColumn,
  RetailDatasetDescription,
  RetailMetricDefinition,
  RetailMetricName,
  RetailMetricQuery,
  RetailMetricResult,
  RetailQueryResult,
  RetailReader,
  Scalar,
} from "../src/retail.ts";
import { isConnectionGone, MAX_RESULT_BYTES, MAX_RESULT_ROWS, plainError, readDataStatus, runSavedQuery } from "../src/run.ts";

type Call =
  | { method: "describe" }
  | { method: "run"; sql: string; params: Scalar[] | undefined; options: { maxRows?: number; maxBytes?: number } | undefined }
  | { method: "metric"; name: RetailMetricName; query: RetailMetricQuery };

type Script = {
  describe?: () => RetailDatasetDescription;
  run?: (sql: string, params: Scalar[]) => RetailQueryResult;
  metric?: (name: RetailMetricName, query: RetailMetricQuery) => RetailMetricResult;
};

/** A reader that answers from a script and records every call it receives. */
function scripted(script: Script): { retail: RetailReader; calls: Call[] } {
  const calls: Call[] = [];
  const unscripted = (method: string) => (..._args: unknown[]): never => {
    throw new Error(`The test did not script ${method}().`);
  };
  const retail: RetailReader = {
    async describe() {
      calls.push({ method: "describe" });
      return (script.describe ?? unscripted("describe"))();
    },
    async run(sql, params, options) {
      calls.push({ method: "run", sql, params, options });
      return (script.run ?? unscripted("run"))(sql, params ?? []);
    },
    async metric(name, query) {
      calls.push({ method: "metric", name, query });
      return (script.metric ?? unscripted("metric"))(name, query);
    },
  };
  return { retail, calls };
}

const definition = (name: RetailMetricName, unit: RetailMetricDefinition["unit"]): RetailMetricDefinition =>
  ({ name, unit, description: `${name} for the test`, sql: "SELECT 1" });

const CURRENCY: RetailColumn = { name: "currency", type: "text" };
const MONEY: RetailColumn = { name: "value", type: "money", currencyColumn: "currency" };

const OCTOBER: ResolvedFilters = { from: "2026-10-01", to: "2026-10-31", locations: [] };
const LOCATIONS = [{ id: 1, name: "Downtown" }, { id: 2, name: "Airport" }];

/** The outcome as a result; a failure fails the test with its own explanation. */
function succeeded(outcome: QueryOutcome): QueryResult {
  if ("error" in outcome) throw new Error(`The query failed: ${outcome.error}`);
  return outcome;
}

describe("runSavedQuery with a metric", () => {
  it("asks the dataset for the metric over the period and returns its rows", async () => {
    const { retail, calls } = scripted({
      metric: () => ({ metric: definition("net_sales", "money"), columns: [CURRENCY, MONEY], rows: [["USD", 1234000]] }),
    });
    let clock = 1_000;
    const result = succeeded(await runSavedQuery(retail, { kind: "metric", metric: "net_sales" }, {}, OCTOBER, {
      locations: LOCATIONS,
      now: () => (clock += 25),
    }));
    expect(calls).toEqual([{ method: "metric", name: "net_sales", query: { from: "2026-10-01", to: "2026-10-31" } }]);
    expect(result).toEqual({
      columns: [{ name: "currency", type: "text" }, { name: "value", type: "money", currencyColumn: "currency" }],
      rows: [["USD", 1234000]],
      truncated: false,
      period: { from: "2026-10-01", to: "2026-10-31" },
      rowCount: 1,
      ranAt: 1_025,
      durationMs: 25,
    });
  });

  it("passes the breakdown and the selected locations", async () => {
    const { retail, calls } = scripted({
      metric: () => ({ metric: definition("orders", "count"), columns: [{ name: "day", type: "date" }, { name: "value", type: "integer" }], rows: [] }),
    });
    await runSavedQuery(retail, { kind: "metric", metric: "orders", groupBy: ["day"] }, {}, { ...OCTOBER, locations: [2, 3] }, { locations: LOCATIONS });
    expect(calls).toEqual([{
      method: "metric",
      name: "orders",
      query: { from: "2026-10-01", to: "2026-10-31", groupBy: ["day"], locationIds: [2, 3] },
    }]);
  });

  it("makes a second call over the period before when asked to compare", async () => {
    const { retail, calls } = scripted({
      metric: (_name, query) => ({
        metric: definition("net_sales", "money"),
        columns: [CURRENCY, MONEY],
        rows: [["USD", query.from === "2026-10-01" ? 1234000 : 1140000]],
      }),
    });
    const result = succeeded(await runSavedQuery(retail, { kind: "metric", metric: "net_sales", compare: true }, {}, { ...OCTOBER, locations: [1] }, { locations: LOCATIONS }));
    expect(calls).toEqual([
      { method: "metric", name: "net_sales", query: { from: "2026-10-01", to: "2026-10-31", locationIds: [1] } },
      { method: "metric", name: "net_sales", query: { from: "2026-08-31", to: "2026-09-30", locationIds: [1] } },
    ]);
    expect(result.rows).toEqual([["USD", 1234000]]);
    expect(result.previous).toEqual({ from: "2026-08-31", to: "2026-09-30", rows: [["USD", 1140000]] });
  });

  it("names locations from the list it is given", async () => {
    const { retail, calls } = scripted({
      metric: () => ({
        metric: definition("net_sales", "money"),
        columns: [{ name: "location_id", type: "integer" }, CURRENCY, MONEY],
        rows: [[1, "USD", 500], [9, "USD", 300]],
      }),
    });
    const result = succeeded(await runSavedQuery(retail, { kind: "metric", metric: "net_sales", groupBy: ["location"] }, {}, OCTOBER, { locations: LOCATIONS }));
    expect(result.columns[0]).toEqual({ name: "location", type: "text" });
    expect(result.rows).toEqual([["Downtown", "USD", 500], ["Location 9", "USD", 300]]);
    // The names come from the caller's list: no read is spent on them.
    expect(calls).toHaveLength(1);
  });

  it("ranks a product breakdown, keeps ten rows and reads names for those rows only", async () => {
    const products: Scalar[][] = Array.from({ length: 12 }, (_, index) => [index + 1, "USD", (index + 1) * 100]);
    const { retail, calls } = scripted({
      metric: () => ({
        metric: definition("net_sales", "money"),
        columns: [{ name: "product_id", type: "integer" }, CURRENCY, MONEY],
        rows: [...products, [null, "USD", 5000]],
      }),
      run: () => ({
        columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }, { name: "variant_name", type: "text" }],
        rows: [[12, "Tee", "Large"], [11, "Mug", null]],
        truncated: false,
      }),
    });
    const result = succeeded(await runSavedQuery(retail, { kind: "metric", metric: "net_sales", groupBy: ["product"] }, {}, OCTOBER, { locations: LOCATIONS }));
    expect(result.columns[0]).toEqual({ name: "product", type: "text" });
    expect(result.rows).toHaveLength(10);
    expect(result.rows.slice(0, 4)).toEqual([
      ["Unlinked items", "USD", 5000],
      ["Tee (Large)", "USD", 1200],
      ["Mug", "USD", 1100],
      ["Product 10", "USD", 1000],
    ]);
    expect(result.truncated).toBe(false);
    expect(calls.slice(1)).toEqual([{
      method: "run",
      sql: "SELECT id, name, variant_name FROM products WHERE id IN (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [12, 11, 10, 9, 8, 7, 6, 5, 4],
      options: { maxRows: 100 },
    }]);
  });

  it("lets the visual choose the order and the cut of a product breakdown", async () => {
    const { retail, calls } = scripted({
      metric: () => ({
        metric: definition("units_sold", "quantity"),
        columns: [{ name: "product_id", type: "integer" }, { name: "value", type: "real" }],
        rows: [[3, 30], [1, 10], [2, 20]],
      }),
      run: () => ({ columns: [], rows: [[1, "Cap", null], [2, "Hat", null]], truncated: false }),
    });
    const result = succeeded(await runSavedQuery(
      retail,
      { kind: "metric", metric: "units_sold", groupBy: ["product"] },
      { sort: { by: "value", dir: "asc" }, limit: 2 },
      OCTOBER,
      { locations: LOCATIONS },
    ));
    expect(result.rows).toEqual([["Cap", 10], ["Hat", 20]]);
    expect(calls[1]).toMatchObject({ method: "run", params: [1, 2] });
  });

  it("marks a ratio so it is shown as a percentage, and passes on a partial margin", async () => {
    const rate = scripted({
      metric: () => ({ metric: definition("repeat_customer_rate", "ratio"), columns: [{ name: "value", type: "real" }], rows: [[0.253]] }),
    });
    const repeat = succeeded(await runSavedQuery(rate.retail, { kind: "metric", metric: "repeat_customer_rate" }, {}, OCTOBER, { locations: [] }));
    expect(repeat.columns).toEqual([{ name: "value", type: "real", label: "%" }]);

    const margin = scripted({
      metric: () => ({ metric: definition("gross_margin", "money"), columns: [CURRENCY, MONEY], rows: [["USD", 4200]], partial: true, costCoverage: 0.82 }),
    });
    const gross = succeeded(await runSavedQuery(margin.retail, { kind: "metric", metric: "gross_margin" }, {}, OCTOBER, { locations: [] }));
    expect(gross).toMatchObject({ partial: true, costCoverage: 0.82 });
  });

  it("cuts a long breakdown at the row cap and says so", async () => {
    const days: Scalar[][] = Array.from({ length: MAX_RESULT_ROWS + 40 }, (_, index) => [`day ${index}`, index]);
    const { retail } = scripted({
      metric: () => ({ metric: definition("orders", "count"), columns: [{ name: "channel", type: "text" }, { name: "value", type: "integer" }], rows: days }),
    });
    const result = succeeded(await runSavedQuery(retail, { kind: "metric", metric: "orders", groupBy: ["channel"] }, {}, OCTOBER, { locations: [] }));
    expect(result.rows).toHaveLength(500);
    expect(result.rowCount).toBe(500);
    expect(result.truncated).toBe(true);
  });
});

describe("runSavedQuery with SQL", () => {
  const columns: RetailColumn[] = [{ name: "channel", type: "text" }, { name: "orders", type: "integer" }];

  it("sends placeholders and bound values with the row cap", async () => {
    const { retail, calls } = scripted({ run: () => ({ columns, rows: [["online", 4], ["store", 9]], truncated: false }) });
    const result = succeeded(await runSavedQuery(
      retail,
      { kind: "sql", sql: "SELECT channel, COUNT(*) AS orders FROM orders WHERE business_date BETWEEN :from AND :to AND location_id IN (:locations) AND status = :status GROUP BY 1", params: { status: "completed" } },
      {},
      { ...OCTOBER, locations: [2] },
      { locations: LOCATIONS },
    ));
    expect(calls).toEqual([{
      method: "run",
      sql: "SELECT channel, COUNT(*) AS orders FROM orders WHERE business_date BETWEEN ? AND ? AND location_id IN (?) AND status = ? GROUP BY 1",
      params: ["2026-10-01", "2026-10-31", 2, "completed"],
      options: { maxRows: 500 },
    }]);
    expect(result.columns).toEqual([{ name: "channel", type: "text" }, { name: "orders", type: "integer" }]);
    expect(result.rows).toEqual([["online", 4], ["store", 9]]);
    expect(result.period).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("binds every known location when none is selected", async () => {
    const { retail, calls } = scripted({ run: () => ({ columns, rows: [], truncated: false }) });
    await runSavedQuery(retail, { kind: "sql", sql: "SELECT 1 FROM orders WHERE location_id IN (:locations)" }, {}, OCTOBER, { locations: LOCATIONS });
    expect(calls[0]).toMatchObject({ sql: "SELECT 1 FROM orders WHERE location_id IN (?, ?)", params: [1, 2] });
  });

  it("sends a hostile filter value as a value, in the same text a harmless one gets", async () => {
    const query = { kind: "sql" as const, sql: "SELECT COUNT(*) AS orders FROM orders WHERE business_date >= :from AND business_date <= :to" };
    const sent: { sql: string; params: Scalar[] }[] = [];
    const { retail } = scripted({
      run: (sql, params) => {
        sent.push({ sql, params });
        return { columns, rows: [], truncated: false };
      },
    });
    const injected = "2026-10-01'; DROP TABLE orders;--";
    await runSavedQuery(retail, query, {}, OCTOBER, { locations: [] });
    await runSavedQuery(retail, query, {}, { from: injected, to: "1) OR (1=1", locations: [] }, { locations: [] });
    expect(sent).toEqual([
      { sql: "SELECT COUNT(*) AS orders FROM orders WHERE business_date >= ? AND business_date <= ?", params: ["2026-10-01", "2026-10-31"] },
      { sql: "SELECT COUNT(*) AS orders FROM orders WHERE business_date >= ? AND business_date <= ?", params: [injected, "1) OR (1=1"] },
    ]);
  });

  it("sorts and limits the rows that came back", async () => {
    const { retail } = scripted({ run: () => ({ columns, rows: [["online", 4], ["store", 9], ["phone", null], ["kiosk", 6]], truncated: false }) });
    const query = { kind: "sql" as const, sql: "SELECT channel, COUNT(*) AS orders FROM orders GROUP BY 1" };
    const largest = succeeded(await runSavedQuery(retail, query, { sort: { by: "orders", dir: "desc" }, limit: 2 }, OCTOBER, { locations: [] }));
    expect(largest.rows).toEqual([["store", 9], ["kiosk", 6]]);
    expect(largest.truncated).toBe(false);
    // An absent value sorts last in both directions.
    const smallest = succeeded(await runSavedQuery(retail, query, { sort: { by: "orders", dir: "asc" } }, OCTOBER, { locations: [] }));
    expect(smallest.rows).toEqual([["online", 4], ["kiosk", 6], ["store", 9], ["phone", null]]);
    const byName = succeeded(await runSavedQuery(retail, query, { sort: { by: "channel", dir: "asc" } }, OCTOBER, { locations: [] }));
    expect(byName.rows.map(row => row[0])).toEqual(["kiosk", "online", "phone", "store"]);
  });

  it("passes on the dataset's own truncation", async () => {
    const { retail } = scripted({ run: () => ({ columns, rows: [["online", 4]], truncated: true }) });
    const result = succeeded(await runSavedQuery(retail, { kind: "sql", sql: "SELECT channel, 1 AS orders FROM orders" }, {}, OCTOBER, { locations: [] }));
    expect(result.truncated).toBe(true);
  });

  it("drops rows beyond the row cap", async () => {
    const rows: Scalar[][] = Array.from({ length: MAX_RESULT_ROWS + 100 }, (_, index) => ["online", index]);
    const { retail } = scripted({ run: () => ({ columns, rows, truncated: false }) });
    const result = succeeded(await runSavedQuery(retail, { kind: "sql", sql: "SELECT channel, 1 AS orders FROM orders" }, {}, OCTOBER, { locations: [] }));
    expect(result.rows).toHaveLength(500);
    expect(result.rows.at(-1)).toEqual(["online", 499]);
    expect(result.rowCount).toBe(500);
    expect(result.truncated).toBe(true);
  });

  it("drops rows beyond the byte cap", async () => {
    const rows: Scalar[][] = Array.from({ length: 100 }, (_, index) => ["é".repeat(1_000), index]);
    const { retail } = scripted({ run: () => ({ columns, rows, truncated: false }) });
    const result = succeeded(await runSavedQuery(retail, { kind: "sql", sql: "SELECT channel, 1 AS orders FROM orders" }, {}, OCTOBER, { locations: [] }));
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(100);
    expect(result.rowCount).toBe(result.rows.length);
    expect(new TextEncoder().encode(JSON.stringify(result.rows)).length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });
});

describe("runSavedQuery when the query cannot be run", () => {
  it("returns the dataset's refusal as a failure, without its stack or error class", async () => {
    const { retail } = scripted({
      run: () => {
        throw new Error("QueryRefusedError: The function load_extension() is not allowed.\n    at checkQueryText (sql-guard.ts:120:13)\n    at runGuardedQuery (sql-guard.ts:240:17)");
      },
    });
    let clock = 5_000;
    const outcome = await runSavedQuery(retail, { kind: "sql", sql: "SELECT load_extension('x')" }, {}, OCTOBER, { locations: [], now: () => (clock += 10) });
    expect(outcome).toEqual({
      error: "The function load_extension() is not allowed.",
      ranAt: 5_010,
      durationMs: 10,
      period: { from: "2026-10-01", to: "2026-10-31" },
    });
  });

  it("returns a metric's refusal as a failure", async () => {
    const { retail } = scripted({
      metric: () => {
        throw new Error("orders is an order-level metric; it cannot be grouped by product or category.");
      },
    });
    const outcome = await runSavedQuery(retail, { kind: "metric", metric: "orders", groupBy: ["product"] }, {}, OCTOBER, { locations: [] });
    expect(outcome).toMatchObject({ error: "orders is an order-level metric; it cannot be grouped by product or category." });
  });

  it("refuses a write, a second statement and an undefined name before the reader is called", async () => {
    const { retail, calls } = scripted({});
    const refused = async (sql: string) => runSavedQuery(retail, { kind: "sql", sql }, {}, OCTOBER, { locations: [] });
    expect(await refused("DELETE FROM orders")).toMatchObject({ error: "Only read queries can be saved." });
    expect(await refused("PRAGMA table_info(orders)")).toMatchObject({ error: "Only read queries can be saved." });
    expect(await refused("SELECT 1; DROP TABLE orders")).toMatchObject({ error: expect.stringContaining("single statement") });
    expect(await refused("SELECT * FROM orders WHERE channel = :channel")).toMatchObject({ error: "This query uses :channel, which is not defined." });
    expect(calls).toEqual([]);
  });

  it("returns a failure when the visual sorts by a column the result does not have", async () => {
    const { retail } = scripted({ run: () => ({ columns: [{ name: "channel", type: "text" }], rows: [["online"]], truncated: false }) });
    const outcome = await runSavedQuery(retail, { kind: "sql", sql: "SELECT channel FROM orders" }, { sort: { by: "total", dir: "desc" } }, OCTOBER, { locations: [] });
    expect(outcome).toMatchObject({ error: 'The visual sorts by "total", which is not a column of the result. The columns are: channel.' });
  });

  it("rethrows when the connection is gone, so the caller can switch to off", async () => {
    for (const message of [
      "This connection has been removed from the workspace.",
      "This session's gatekeeper connection has been removed.",
      "No such gatekeeper: 12",
      "This account is no longer connected.",
    ]) {
      const { retail } = scripted({
        run: () => {
          throw new Error(message);
        },
        metric: () => {
          throw new Error(message);
        },
      });
      await expect(runSavedQuery(retail, { kind: "sql", sql: "SELECT 1" }, {}, OCTOBER, { locations: [] })).rejects.toThrow(message);
      await expect(runSavedQuery(retail, { kind: "metric", metric: "orders" }, {}, OCTOBER, { locations: [] })).rejects.toThrow(message);
    }
  });
});

describe("isConnectionGone and plainError", () => {
  it("recognises the kernel's messages for a removed connection in any case", () => {
    expect(isConnectionGone(new Error("This connection HAS BEEN REMOVED from the workspace."))).toBe(true);
    expect(isConnectionGone(new Error("no such gatekeeper?"))).toBe(true);
    expect(isConnectionGone("This account is No Longer Connected.")).toBe(true);
    expect(isConnectionGone(new Error("no such column: total"))).toBe(false);
    expect(isConnectionGone(undefined)).toBe(false);
  });

  it("keeps the explanation and drops prefixes, stacks and extra whitespace", () => {
    expect(plainError(new Error("Error: TypeError: no such column: total"))).toBe("no such column: total");
    expect(plainError(new Error("Uncaught (in promise) Error: The range must be under 3 years;\n  split it into several queries."))).toBe("The range must be under 3 years; split it into several queries.");
    expect(plainError("sql parser error: Expected an expression, found: FROM")).toBe("sql parser error: Expected an expression, found: FROM");
  });

  it("cuts a long message at 500 characters and has words for an error with none", () => {
    const long = plainError(new Error("x".repeat(2_000)));
    expect(long).toHaveLength(500);
    expect(long.endsWith("…")).toBe(true);
    expect(plainError(new Error(""))).toBe("The query could not be run.");
    expect(plainError({ code: 7 })).toBe("The query could not be run.");
  });
});

describe("readDataStatus", () => {
  const description: RetailDatasetDescription = {
    tables: [],
    metrics: [],
    personalDataMasked: true,
    dateRange: { from: "2024-01-02", to: "2026-11-20" },
    completeThrough: "2026-11-18",
    limits: { maxRows: 10_000, maxBytes: 16_777_216, maxParams: 100 },
  };

  it("is off with no binding", async () => {
    expect(await readDataStatus(undefined)).toEqual({ status: "off" });
  });

  it("is empty when the dataset has no orders, without asking for locations", async () => {
    const { retail, calls } = scripted({ describe: () => ({ ...description, dateRange: null, completeThrough: null }) });
    expect(await readDataStatus(retail)).toEqual({ status: "empty" });
    expect(calls).toEqual([{ method: "describe" }]);
  });

  it("is ok with the dataset's dates and its locations by name", async () => {
    const { retail, calls } = scripted({
      describe: () => description,
      run: () => ({
        columns: [{ name: "id", type: "integer" }, { name: "name", type: "text" }],
        rows: [[2, "Airport"], [1, "Downtown"], [7, ""]],
        truncated: false,
      }),
    });
    expect(await readDataStatus(retail)).toEqual({
      status: "ok",
      dateRange: { from: "2024-01-02", to: "2026-11-20" },
      completeThrough: "2026-11-18",
      personalDataMasked: true,
      locations: [{ id: 2, name: "Airport" }, { id: 1, name: "Downtown" }, { id: 7, name: "Location 7" }],
    });
    expect(calls).toEqual([
      { method: "describe" },
      { method: "run", sql: "SELECT id, name FROM locations ORDER BY name", params: [], options: { maxRows: 500 } },
    ]);
  });

  it("is an error with the reason when a read fails", async () => {
    const { retail } = scripted({
      describe: () => {
        throw new Error("Error: The dataset is being rebuilt. Try again in a minute.");
      },
    });
    expect(await readDataStatus(retail)).toEqual({ status: "error", error: "The dataset is being rebuilt. Try again in a minute." });
  });

  it("is off when the connection is gone", async () => {
    const gone = scripted({
      describe: () => {
        throw new Error("This connection has been removed from the workspace.");
      },
    });
    expect(await readDataStatus(gone.retail)).toEqual({ status: "off" });
    const goneLater = scripted({
      describe: () => description,
      run: () => {
        throw new Error("No such gatekeeper: 4");
      },
    });
    expect(await readDataStatus(goneLater.retail)).toEqual({ status: "off" });
  });
});
