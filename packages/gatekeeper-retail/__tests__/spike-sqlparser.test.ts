// Spike (research R4): sqlparser-rs WASM loads inside workerd from a precompiled module import and
// parses every case the guard depends on, including the syntax node-sql-parser fails on.

import { describe, expect, it } from "vitest";
import { parseSqlite } from "../src/dataset/sql-parser.js";

function statementKinds(sql: string): string[] {
  return parseSqlite(sql).map(statement => Object.keys(statement as object)[0]!);
}

describe("sqlparser-rs in workerd", () => {
  it("parses one SELECT into a single Query statement", () => {
    expect(statementKinds("SELECT business_date, SUM(net_amount) FROM daily_sales GROUP BY 1"))
      .toEqual(["Query"]);
  });

  it("parses the syntax node-sql-parser rejects", () => {
    for (const sql of [
      "SELECT COUNT(*) FILTER (WHERE status = 'voided') FROM orders",
      "SELECT SUM(net_amount) OVER w FROM daily_sales WINDOW w AS (PARTITION BY location_id)",
      "SELECT 1 WHERE NULL IS NOT DISTINCT FROM NULL",
      "VALUES (1, 2)",
    ]) {
      expect(statementKinds(sql)).toEqual(["Query"]);
    }
  });

  it("reports every statement of a multi-statement text", () => {
    expect(statementKinds("SELECT 1; DELETE FROM orders")).toEqual(["Query", "Delete"]);
  });

  it("names table-valued functions and pragmas as what they are", () => {
    const [query] = parseSqlite("SELECT * FROM pragma_table_info('orders')");
    expect(JSON.stringify(query)).toContain('"value":"pragma_table_info"');
    expect(JSON.stringify(query)).toContain('"args"');
    expect(statementKinds("PRAGMA query_only = 1")).toEqual(["Pragma"]);
    expect(statementKinds("ATTACH 'x.db' AS x")).toEqual(["AttachDatabase"]);
  });

  it("marks WITH RECURSIVE and a data-modifying CTE body", () => {
    const [recursive] = parseSqlite(
      "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r");
    expect(JSON.stringify(recursive)).toContain('"recursive":true');
    const [deleting] = parseSqlite("WITH x AS (SELECT 1) DELETE FROM orders");
    expect(JSON.stringify(deleting)).toMatch(/"body":\{"Delete"/);
  });

  it("throws on text that is not SQL", () => {
    expect(() => parseSqlite("SELEKT nonsense")).toThrow(/could not be parsed/);
  });
});
