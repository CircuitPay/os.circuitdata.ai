// @vitest-environment node
import { describe, expect, it } from "vitest";

import { validateFilters, validateSavedQuery, validateVisual } from "../src/model.ts";

describe("validateSavedQuery", () => {
  it("returns a clean copy of a metric query", () => {
    expect(validateSavedQuery({ kind: "metric", metric: "net_sales", groupBy: ["day", "location"], compare: true, extra: "dropped" }))
      .toEqual({ kind: "metric", metric: "net_sales", groupBy: ["day", "location"], compare: true });
    expect(validateSavedQuery({ kind: "metric", metric: "orders" })).toEqual({ kind: "metric", metric: "orders" });
  });

  it("refuses a metric or a breakdown the dataset does not have", () => {
    expect(() => validateSavedQuery({ kind: "metric", metric: "profit" })).toThrow(/"profit" is not a standard metric/);
    expect(() => validateSavedQuery({ kind: "metric", metric: "orders", groupBy: ["hour"] })).toThrow(/"hour", which is not one of/);
    expect(() => validateSavedQuery({ kind: "metric", metric: "orders", groupBy: "day" })).toThrow("The query's groupBy must be a list.");
  });

  it("holds a breakdown to three entries, one time grain and no repeats", () => {
    expect(() => validateSavedQuery({ kind: "metric", metric: "net_sales", groupBy: ["day", "location", "channel", "product"] }))
      .toThrow("The query's groupBy can hold at most 3 entries.");
    expect(() => validateSavedQuery({ kind: "metric", metric: "net_sales", groupBy: ["day", "week"] }))
      .toThrow("The query's groupBy can use only one of day, week and month.");
    expect(() => validateSavedQuery({ kind: "metric", metric: "net_sales", groupBy: ["day", "day"] }))
      .toThrow('The query\'s groupBy repeats "day".');
  });

  it("returns a clean copy of a SQL query with its literals", () => {
    const query = { kind: "sql", sql: "SELECT name FROM products WHERE category = :category AND is_active = :active", params: { category: "Tees", active: true } };
    expect(validateSavedQuery({ ...query, note: "dropped" })).toEqual(query);
  });

  it("holds SQL text to 8,000 characters and literals to 20", () => {
    const longest = `SELECT ${"1".repeat(7_993)}`;
    expect(validateSavedQuery({ kind: "sql", sql: longest })).toEqual({ kind: "sql", sql: longest });
    expect(() => validateSavedQuery({ kind: "sql", sql: `${longest}1` })).toThrow(/8001 characters long; the most a saved query can hold is 8000/);
    const params = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`p${index}`, index]));
    expect(() => validateSavedQuery({ kind: "sql", sql: "SELECT 1", params })).toThrow("The query's params can hold at most 20 values.");
  });

  it("refuses a literal whose name or value cannot be bound", () => {
    const withParams = (params: unknown) => () => validateSavedQuery({ kind: "sql", sql: "SELECT 1", params });
    expect(withParams({ Category: "x" })).toThrow(/must start with a lowercase letter/);
    expect(withParams({ "a b": "x" })).toThrow(/must start with a lowercase letter/);
    expect(withParams({ from: "2026-01-01" })).toThrow('The parameter name "from" is taken by the shared filters. Choose another name.');
    expect(withParams({ locations: 1 })).toThrow(/taken by the shared filters/);
    expect(withParams({ a: { nested: true } })).toThrow('The parameter "a" must be text, a finite number, true, false or null.');
    expect(withParams({ a: Number.POSITIVE_INFINITY })).toThrow(/finite number/);
    expect(withParams(["x"])).toThrow("The query's params must be an object.");
  });

  it("refuses SQL that is not one read, or that uses a name with no value, when it is saved", () => {
    expect(() => validateSavedQuery({ kind: "sql", sql: "DELETE FROM orders" })).toThrow("Only read queries can be saved.");
    expect(() => validateSavedQuery({ kind: "sql", sql: "PRAGMA table_info(orders)" })).toThrow("Only read queries can be saved.");
    expect(() => validateSavedQuery({ kind: "sql", sql: "SELECT 1; DROP TABLE orders" })).toThrow(/single statement/);
    expect(() => validateSavedQuery({ kind: "sql", sql: "SELECT * FROM orders WHERE channel = :channel" }))
      .toThrow("This query uses :channel, which is not defined.");
    expect(validateSavedQuery({ kind: "sql", sql: "SELECT * FROM orders WHERE business_date BETWEEN :from AND :to AND location_id IN (:locations)" }).kind).toBe("sql");
  });

  it("refuses anything that is not a query", () => {
    expect(() => validateSavedQuery(null)).toThrow("The query must be an object.");
    expect(() => validateSavedQuery("SELECT 1")).toThrow("The query must be an object.");
    expect(() => validateSavedQuery({ sql: "SELECT 1" })).toThrow('The query\'s kind must be "metric" or "sql".');
    expect(() => validateSavedQuery({ kind: "sql", sql: "   " })).toThrow("The query's sql must be the text of a SELECT statement.");
  });
});

describe("validateVisual", () => {
  it("returns a clean copy", () => {
    const visual = { type: "bar", x: "location", y: ["value"], series: "channel", sort: { by: "value", dir: "desc" }, limit: 10 };
    expect(validateVisual({ ...visual, colour: "red" })).toEqual(visual);
    expect(validateVisual({ type: "text", text: "# Notes" })).toEqual({ type: "text", text: "# Notes" });
  });

  it("refuses a type it does not draw", () => {
    expect(() => validateVisual({ type: "pie" })).toThrow(/"pie" is not one of: kpi, line, area, bar, stackedBar, table, text/);
    expect(() => validateVisual(undefined)).toThrow("The visual must be an object.");
  });

  it("holds the limit to a whole number from 1 to 500", () => {
    expect(validateVisual({ type: "table", limit: 1 }).limit).toBe(1);
    expect(validateVisual({ type: "table", limit: 500 }).limit).toBe(500);
    for (const limit of [0, 501, 1.5, -3, "10", Number.NaN]) {
      expect(() => validateVisual({ type: "table", limit })).toThrow("The visual's limit must be a whole number from 1 to 500.");
    }
  });

  it("holds text to 20,000 characters", () => {
    expect(validateVisual({ type: "text", text: "x".repeat(20_000) }).text).toHaveLength(20_000);
    expect(() => validateVisual({ type: "text", text: "x".repeat(20_001) })).toThrow(/20001 characters long; the most it can hold is 20000/);
  });

  it("refuses roles and a sort that are not column names and directions", () => {
    expect(() => validateVisual({ type: "bar", x: 3 })).toThrow("The visual's x must be the name of a column in the result.");
    expect(() => validateVisual({ type: "bar", y: "value" })).toThrow("The visual's y must be a list of at most 12 column names.");
    expect(() => validateVisual({ type: "bar", y: [""] })).toThrow("Each entry of the visual's y must be the name of a column in the result.");
    expect(() => validateVisual({ type: "bar", sort: { by: "value", dir: "down" } })).toThrow('The visual\'s sort direction must be "asc" or "desc".');
    expect(() => validateVisual({ type: "bar", sort: { dir: "asc" } })).toThrow("The visual's sort column must be the name of a column in the result.");
  });
});

describe("validateFilters", () => {
  it("returns a clean copy with each location once", () => {
    expect(validateFilters({ dateRange: { preset: "last30", from: "ignored" }, locations: [3, 3, 4], viewer: "dropped" }))
      .toEqual({ dateRange: { preset: "last30" }, locations: [3, 4] });
    expect(validateFilters({ dateRange: { from: "2026-10-01", to: "2026-10-31" } }))
      .toEqual({ dateRange: { from: "2026-10-01", to: "2026-10-31" }, locations: [] });
  });

  it("refuses a date range that is not a preset or two real dates in order", () => {
    expect(() => validateFilters({ locations: [] })).toThrow("The date range must be an object.");
    expect(() => validateFilters({ dateRange: { preset: "sinceForever" }, locations: [] })).toThrow(/"sinceForever" is not one of/);
    expect(() => validateFilters({ dateRange: { from: "2026-10-01" }, locations: [] })).toThrow(/needs a preset, or a start and an end date/);
    expect(() => validateFilters({ dateRange: { from: "2026-10-01'; DROP TABLE orders;--", to: "2026-10-31" }, locations: [] }))
      .toThrow("The start date must be a real date written YYYY-MM-DD.");
    expect(() => validateFilters({ dateRange: { from: "2026-11-01", to: "2026-10-31" }, locations: [] }))
      .toThrow("The start date must not be after the end date.");
    expect(() => validateFilters({ dateRange: { from: "2020-01-01", to: "2026-10-31" }, locations: [] }))
      .toThrow("The date range must be shorter than 3 years.");
  });

  it("refuses locations that are not ids, and more than 50 of them", () => {
    const dateRange = { preset: "last7" };
    for (const locations of [["1"], [1.5], ["1) OR (1=1"], [null], "1,2"]) {
      expect(() => validateFilters({ dateRange, locations })).toThrow(/locations must be a list of location ids/);
    }
    const ids = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    expect(validateFilters({ dateRange, locations: ids(50) }).locations).toHaveLength(50);
    expect(() => validateFilters({ dateRange, locations: ids(51) })).toThrow("Choose at most 50 locations, or none for every location.");
  });
});
