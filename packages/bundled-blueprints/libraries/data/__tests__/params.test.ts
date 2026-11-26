// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ResolvedFilters } from "../src/model.ts";
import { compileSql, MAX_BOUND_VALUES, usesFilter } from "../src/params.ts";

const BENIGN: ResolvedFilters = { from: "2026-10-01", to: "2026-10-31", locations: [1, 2] };

// What a viewer, or a page pretending to be one, might send as a filter value.
const HOSTILE = [
  "'; DROP TABLE orders;--",
  "1) OR (1=1",
  "' OR '1'='1",
  "\"quoted\" and 'single' and `ticked` and [bracketed]",
  "?",
  ":from",
  ":locations",
  "/* */ -- ;",
  "\\",
  "",
];

const SALES_BY_DAY =
  "SELECT business_date, SUM(net_amount) AS net_amount, currency FROM daily_sales "
  + "WHERE business_date BETWEEN :from AND :to AND location_id IN (:locations) GROUP BY 1, 3";

/** Filters as they arrive off the wire: nothing has checked that a date is a date or an id a number. */
function wire(filters: { from: unknown; to: unknown; locations: unknown[] }): ResolvedFilters {
  return JSON.parse(JSON.stringify(filters));
}

describe("compileSql", () => {
  it("replaces each name with placeholders and binds the values in order", () => {
    expect(compileSql(SALES_BY_DAY, BENIGN, {}, [])).toEqual({
      sql: "SELECT business_date, SUM(net_amount) AS net_amount, currency FROM daily_sales "
        + "WHERE business_date BETWEEN ? AND ? AND location_id IN (?, ?) GROUP BY 1, 3",
      params: ["2026-10-01", "2026-10-31", 1, 2],
    });
  });

  it("binds a name every time it appears", () => {
    const compiled = compileSql("SELECT :from AS start, :to AS finish FROM orders WHERE business_date >= :from", BENIGN, {}, []);
    expect(compiled.sql).toBe("SELECT ? AS start, ? AS finish FROM orders WHERE business_date >= ?");
    expect(compiled.params).toEqual(["2026-10-01", "2026-10-31", "2026-10-01"]);
  });

  it("keeps the text byte-identical when the dates are hostile, and binds them as values", () => {
    const benign = compileSql(SALES_BY_DAY, BENIGN, {}, []);
    for (const value of HOSTILE) {
      const hostile = compileSql(SALES_BY_DAY, wire({ from: value, to: value, locations: [1, 2] }), {}, []);
      expect(hostile.sql).toBe(benign.sql);
      expect(hostile.params).toEqual([value, value, 1, 2]);
    }
  });

  it("keeps the text byte-identical when the locations are hostile, and binds them as values", () => {
    const benign = compileSql(SALES_BY_DAY, BENIGN, {}, []);
    for (const value of HOSTILE) {
      const hostile = compileSql(SALES_BY_DAY, wire({ from: BENIGN.from, to: BENIGN.to, locations: [value, `${value}2`] }), {}, []);
      expect(hostile.sql).toBe(benign.sql);
      expect(hostile.params).toEqual(["2026-10-01", "2026-10-31", value, `${value}2`]);
    }
  });

  it("keeps the text byte-identical when a literal is hostile, and binds it as a value", () => {
    const sql = "SELECT COUNT(*) AS orders FROM orders WHERE channel = :channel AND business_date >= :from";
    const benign = compileSql(sql, BENIGN, { channel: "online" }, []);
    expect(benign.sql).toBe("SELECT COUNT(*) AS orders FROM orders WHERE channel = ? AND business_date >= ?");
    for (const value of HOSTILE) {
      const hostile = compileSql(sql, BENIGN, { channel: value }, []);
      expect(hostile.sql).toBe(benign.sql);
      expect(hostile.params).toEqual([value, "2026-10-01"]);
    }
  });

  it("adds nothing to the text but question marks, commas and spaces", () => {
    const strip = (text: string) => text.replace(/[?, ]/g, "");
    const written = strip(SALES_BY_DAY.replace(/:[a-z]+/g, ""));
    for (const value of HOSTILE) {
      const compiled = compileSql(SALES_BY_DAY, wire({ from: value, to: value, locations: [value, value, value] }), {}, []);
      expect(strip(compiled.sql)).toBe(written);
    }
  });

  it("expands :locations to the selection, to every location when none is selected, and to NULL when there is none", () => {
    const sql = "SELECT id FROM locations WHERE id IN (:locations)";
    expect(compileSql(sql, { ...BENIGN, locations: [3, 4, 5] }, {}, [3, 4, 5, 6])).toEqual({
      sql: "SELECT id FROM locations WHERE id IN (?, ?, ?)",
      params: [3, 4, 5],
    });
    expect(compileSql(sql, { ...BENIGN, locations: [] }, {}, [7, 8])).toEqual({
      sql: "SELECT id FROM locations WHERE id IN (?, ?)",
      params: [7, 8],
    });
    expect(compileSql(sql, { ...BENIGN, locations: [] }, {}, [])).toEqual({
      sql: "SELECT id FROM locations WHERE id IN (?)",
      params: [null],
    });
  });

  it("binds every kind of literal as it was declared", () => {
    const compiled = compileSql(
      "SELECT * FROM products WHERE is_active = :active AND price_amount > :floor AND category IS :category AND name = :name",
      BENIGN,
      { active: true, floor: 500, category: null, name: "Tee" },
      [],
    );
    expect(compiled.sql).toBe("SELECT * FROM products WHERE is_active = ? AND price_amount > ? AND category IS ? AND name = ?");
    expect(compiled.params).toEqual([true, 500, null, "Tee"]);
  });

  it("leaves names inside strings, quoted identifiers and comments untouched", () => {
    const sql = [
      "SELECT ':from' AS a, 'it''s :to' AS b, \"col:to\" AS c, `tick:locations` AS d, [bracket:from] AS e -- :to and :nope",
      "/* :locations :nope",
      "   ; DROP TABLE orders */",
      "FROM orders WHERE business_date >= :from",
    ].join("\n");
    const compiled = compileSql(sql, BENIGN, {}, []);
    expect(compiled.sql).toBe(sql.replace(/:from$/, "?"));
    expect(compiled.params).toEqual(["2026-10-01"]);
  });

  it("reads nothing after an unclosed quote or comment as a parameter", () => {
    for (const sql of ["SELECT 'open :from", "SELECT 1 /* open :from", "SELECT \"open :from", "SELECT 1 -- :from"]) {
      expect(compileSql(sql, BENIGN, {}, [])).toEqual({ sql, params: [] });
    }
  });

  it("does not take :: or a colon before a non-letter for a parameter", () => {
    const sql = "SELECT total::text, 5 :: integer, local_hour > :5, '12:30' FROM orders WHERE business_date = :to";
    const compiled = compileSql(sql, BENIGN, {}, []);
    expect(compiled.sql).toBe("SELECT total::text, 5 :: integer, local_hour > :5, '12:30' FROM orders WHERE business_date = ?");
    expect(compiled.params).toEqual(["2026-10-31"]);
  });

  it("accepts SELECT and WITH in any case, after whitespace and comments, with a closing semicolon", () => {
    const sql = "  -- top sellers\n/* by day */\n  with t as (select 1 as n) select n from t ; -- done\n /* end */ ";
    expect(compileSql(sql, BENIGN, {}, []).sql).toBe(sql);
    expect(compileSql("select ';' AS mark, 'a; DROP TABLE orders' AS note FROM orders", BENIGN, {}, []).params).toEqual([]);
  });

  it("refuses a name that has no value", () => {
    expect(() => compileSql("SELECT * FROM orders WHERE channel = :x", BENIGN, {}, []))
      .toThrow("This query uses :x, which is not defined.");
    // Names are matched exactly: a different case is a different, undefined name.
    expect(() => compileSql("SELECT * FROM orders WHERE business_date = :From", BENIGN, {}, []))
      .toThrow("This query uses :From, which is not defined.");
    // A name inherited from Object.prototype is not a declared literal.
    expect(() => compileSql("SELECT :constructor", BENIGN, {}, []))
      .toThrow("This query uses :constructor, which is not defined.");
  });

  it("refuses anything that is not a read", () => {
    const writes = [
      "DELETE FROM orders",
      "INSERT INTO orders (id) VALUES (1)",
      "UPDATE orders SET status = 'void'",
      "DROP TABLE orders",
      "CREATE TABLE t (a)",
      "PRAGMA table_info(orders)",
      "pragma writable_schema = 1",
      "ATTACH DATABASE 'x' AS y",
      "VACUUM",
      "  -- a note\n/* and another */ delete from orders",
      "(SELECT 1)",
      "; SELECT 1",
      "'SELECT' 1",
      "-- only a comment",
      "",
    ];
    for (const sql of writes) {
      expect(() => compileSql(sql, BENIGN, {}, [])).toThrow("Only read queries can be saved.");
    }
  });

  it("refuses a second statement after a semicolon", () => {
    for (const sql of ["SELECT 1; DROP TABLE orders", "SELECT 1; SELECT 2", "SELECT 1;;", "SELECT 1; -- note\n DELETE FROM orders"]) {
      expect(() => compileSql(sql, BENIGN, {}, [])).toThrow(/single statement/);
    }
  });

  it("refuses a positional placeholder, which would take another name's value", () => {
    expect(() => compileSql("SELECT * FROM orders WHERE channel = ? AND business_date >= :from", BENIGN, {}, []))
      .toThrow(/bare \? cannot be used/);
  });

  it("refuses more bound values than the dataset accepts", () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    const sql = "SELECT id FROM locations WHERE id IN (:locations)";
    expect(compileSql(sql, { ...BENIGN, locations: ids(MAX_BOUND_VALUES) }, {}, []).params).toHaveLength(100);
    expect(() => compileSql(sql, { ...BENIGN, locations: ids(MAX_BOUND_VALUES + 1) }, {}, [])).toThrow(/more than 100 values/);
    // The limit is on everything bound, so one name used three times counts three times.
    const thrice = "SELECT 1 FROM orders WHERE location_id IN (:locations) OR location_id IN (:locations) OR location_id IN (:locations)";
    expect(() => compileSql(thrice, { ...BENIGN, locations: ids(34) }, {}, [])).toThrow(/more than 100 values/);
    expect(() => compileSql(sql, { ...BENIGN, locations: [] }, {}, ids(101))).toThrow(/more than 100 values/);
  });
});

describe("usesFilter", () => {
  it("says a metric query reacts to both filters", () => {
    expect(usesFilter({ kind: "metric", metric: "net_sales" }, "dateRange")).toBe(true);
    expect(usesFilter({ kind: "metric", metric: "net_sales" }, "locations")).toBe(true);
  });

  it("says a SQL query reacts to the filters its text names", () => {
    const dated = { kind: "sql" as const, sql: "SELECT COUNT(*) FROM orders WHERE business_date <= :to" };
    expect(usesFilter(dated, "dateRange")).toBe(true);
    expect(usesFilter(dated, "locations")).toBe(false);
    const placed = { kind: "sql" as const, sql: "SELECT name FROM locations WHERE id IN (:locations)" };
    expect(usesFilter(placed, "dateRange")).toBe(false);
    expect(usesFilter(placed, "locations")).toBe(true);
  });

  it("ignores names in strings and comments", () => {
    const query = { kind: "sql" as const, sql: "SELECT ':from' AS label /* :locations */ FROM products -- :to" };
    expect(usesFilter(query, "dateRange")).toBe(false);
    expect(usesFilter(query, "locations")).toBe(false);
  });
});
