// Guarded read-only SQL (research R4). DO SQLite has no read-only mode and no authorizer hook, and
// `exec` runs every statement of a multi-statement text, so `run(sql)` is enforced in four layers:
//
// 1. Parse with sqlparser-rs: exactly one statement, a query whose bodies only select; no WITH
//    RECURSIVE; relations allow-listed to the public views and the query's own CTEs (a
//    table-valued function such as pragma_table_info is a relation with arguments, and refused);
//    functions allow-listed.
// 2. Plan check: EXPLAIN QUERY PLAN refuses a full scan of a large fact table, because nothing can
//    interrupt a running query.
// 3. Execute inside transactionSync, comparing total_changes() and the schema before and after;
//    any difference throws, which rolls the statement back.
// 4. Cap rows and bytes while iterating the cursor; never materialize caller SQL whole.

import type { RetailColumn, RetailQueryResult } from "../types.js";
import { parseSqlite } from "./sql-parser.js";
import { PUBLIC_TABLES, PUBLIC_VIEW_NAMES, SCAN_GUARDED_TABLES } from "./schema.js";

/** Default and maximum caps (contracts/retail-binding.md). */
export const QUERY_LIMITS = {
  defaultMaxRows: 1_000,
  maxRows: 10_000,
  defaultMaxBytes: 4 * 1024 * 1024,
  maxBytes: 16 * 1024 * 1024,
  maxParams: 100,
  maxSqlLength: 100_000,
} as const;

/** Above this many rows, a full scan of a fact table is refused unless overridden by the operator. */
export const DEFAULT_SCAN_ROW_LIMIT = 250_000;

/** Why a query was refused; logged as `refusalReason`. */
export type RefusalReason =
  | "syntax" | "not_single_statement" | "not_a_query" | "writes" | "recursive" | "relation"
  | "function" | "params" | "too_long" | "full_scan" | "changed_data";

/** A refused query. The message explains the refusal to the caller and carries no row data. */
export class QueryRefusedError extends Error {
  override name = "QueryRefusedError";
  constructor(readonly reason: RefusalReason, message: string) {
    super(message);
  }
}

// Scalar, aggregate, window, date and JSON functions that read only their arguments. Absent on
// purpose: table-valued and schema functions, load_extension, randomness, and functions that can
// build huge values from small inputs (zeroblob, randomblob, printf/format widths).
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "abs", "avg", "char", "coalesce", "concat", "concat_ws", "count", "date", "datetime", "group_concat",
  "hex", "ifnull", "iif", "instr", "julianday", "length", "like", "lower", "ltrim", "max", "min",
  "nullif", "octet_length", "quote", "replace", "round", "rtrim", "sign", "strftime", "string_agg",
  "substr", "substring", "sum", "time", "timediff", "total", "trim", "typeof", "unicode", "unixepoch",
  "upper", "ceil", "ceiling", "floor", "trunc", "mod", "pow", "power", "sqrt", "exp", "ln", "log",
  "log2", "glob",
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value",
  "json", "json_array", "json_array_length", "json_extract", "json_group_array", "json_group_object",
  "json_object", "json_quote", "json_type", "json_valid",
]);

// Query bodies that only read. Anything else under a `body` (DELETE, INSERT, UPDATE, TABLE ...) is
// refused, which is what catches `WITH x AS (...) DELETE ...`.
const READ_BODIES: ReadonlySet<string> = new Set(["Select", "Query", "SetOperation", "Values"]);
const WRITE_NODES: ReadonlySet<string> = new Set(["Insert", "Update", "Delete", "Merge"]);
const READ_RELATIONS: ReadonlySet<string> = new Set(["Table", "Derived", "NestedJoin"]);

type Node = Record<string, unknown>;

/** What a query reads, as found by the parser. */
export type QueryShape = {
  /** The public views the query names, lowercase. */
  views: string[];
  /** The query's own CTE names, lowercase. */
  ctes: ReadonlySet<string>;
  /** Each FROM alias, lowercase, mapped to the relation it names. */
  aliases: ReadonlyMap<string, string>;
};

type Found = {
  relations: Set<string>;
  ctes: Set<string>;
  functions: Set<string>;
  aliases: Map<string, string>;
};

/**
 * Layer 1: parses `sql` and refuses anything but one read-only query over the public views.
 * `schemaNames` are every object in sqlite_schema, so a CTE cannot shadow a storage table name and
 * then be referenced from a scope it does not cover.
 */
export function checkQueryText(sql: string, schemaNames: ReadonlySet<string>): QueryShape {
  if (sql.length > QUERY_LIMITS.maxSqlLength) {
    throw new QueryRefusedError("too_long", `The query is longer than ${QUERY_LIMITS.maxSqlLength} characters.`);
  }
  let statements: unknown[];
  try {
    statements = parseSqlite(sql);
  } catch (error) {
    throw new QueryRefusedError("syntax", error instanceof Error ? error.message : String(error));
  }
  if (statements.length !== 1) {
    throw new QueryRefusedError("not_single_statement", "Send exactly one SELECT statement.");
  }
  const statement = statements[0] as Node;
  if (!isNode(statement) || !isNode(statement.Query)) {
    throw new QueryRefusedError("not_a_query", "Only SELECT queries (optionally with WITH) are allowed.");
  }
  const found: Found = {
    relations: new Set(), ctes: new Set(), functions: new Set(), aliases: new Map(),
  };
  walk(statement, found);
  for (const cte of found.ctes) {
    if ((schemaNames.has(cte) && !PUBLIC_VIEW_NAMES.has(cte)) || /^(sqlite_|pragma_)/.test(cte)) {
      throw new QueryRefusedError("relation", `"${cte}" cannot be used as a CTE name; choose another.`);
    }
  }
  const views: string[] = [];
  for (const relation of found.relations) {
    if (PUBLIC_VIEW_NAMES.has(relation)) views.push(relation);
    else if (!found.ctes.has(relation)) {
      throw new QueryRefusedError("relation",
        `"${relation}" is not a table you can query. Use the tables listed by describe().`);
    }
  }
  for (const fn of found.functions) {
    if (!ALLOWED_FUNCTIONS.has(fn)) {
      throw new QueryRefusedError("function", `The function ${fn}() is not allowed.`);
    }
  }
  return { views: views.toSorted(), ctes: found.ctes, aliases: found.aliases };
}

function walk(node: unknown, found: Found): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, found);
    return;
  }
  if (!isNode(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (WRITE_NODES.has(key)) {
      throw new QueryRefusedError("writes", "The query must only read; it contains a data-modifying statement.");
    }
    if (key === "with" && isNode(value) && value.recursive === true) {
      throw new QueryRefusedError("recursive",
        "WITH RECURSIVE is not allowed; use metric() or the daily_* tables instead.");
    }
    if (key === "body" && isNode(value)) {
      const kind = Object.keys(value)[0];
      if (kind === undefined || !READ_BODIES.has(kind)) {
        throw new QueryRefusedError("writes", "Only SELECT queries (optionally with WITH) are allowed.");
      }
    }
    if (key === "cte_tables" && Array.isArray(value)) {
      for (const cte of value) {
        const name = identifierValue((cte as Node | undefined)?.alias, "name");
        if (name) found.ctes.add(name.toLowerCase());
      }
    }
    if (key === "relation" && isNode(value)) {
      const kind = Object.keys(value)[0];
      if (kind === undefined || !READ_RELATIONS.has(kind)) {
        throw new QueryRefusedError("relation",
          "Only the tables listed by describe() and subqueries may appear in FROM; table-valued functions are not allowed.");
      }
      if (kind === "Table") {
        const table = value.Table as Node;
        if (table.args !== null && table.args !== undefined) {
          throw new QueryRefusedError("relation", "Table-valued functions are not allowed in FROM.");
        }
        const relation = objectName(table.name, "relation").toLowerCase();
        found.relations.add(relation);
        const alias = identifierValue(table.alias, "name");
        if (alias) found.aliases.set(alias.toLowerCase(), relation);
      }
    }
    if (key === "Function" && isNode(value)) {
      found.functions.add(objectName(value.name, "function").toLowerCase());
    }
    walk(value, found);
  }
}

function objectName(parts: unknown, kind: "relation" | "function"): string {
  if (!Array.isArray(parts) || parts.length !== 1) {
    throw new QueryRefusedError(kind, kind === "relation"
      ? "Name tables without a schema prefix, as listed by describe()."
      : "Qualified function names are not allowed.");
  }
  const value = identifierValue(parts[0], "Identifier");
  if (value === undefined) throw new QueryRefusedError(kind, "The query names an object the guard cannot read.");
  return value;
}

function identifierValue(node: unknown, key: string): string | undefined {
  if (!isNode(node)) return undefined;
  const identifier = node[key];
  return isNode(identifier) && typeof identifier.value === "string" ? identifier.value : undefined;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Caps for one guarded run, already clamped. */
export type QueryCaps = { maxRows: number; maxBytes: number };

/** Clamps the caller's options to the contract's defaults and maxima. */
export function queryCaps(options?: { maxRows?: number; maxBytes?: number }): QueryCaps {
  const clamp = (value: number | undefined, fallback: number, max: number) =>
    value === undefined ? fallback : Math.max(1, Math.min(max, Math.floor(value)));
  return {
    maxRows: clamp(options?.maxRows, QUERY_LIMITS.defaultMaxRows, QUERY_LIMITS.maxRows),
    maxBytes: clamp(options?.maxBytes, QUERY_LIMITS.defaultMaxBytes, QUERY_LIMITS.maxBytes),
  };
}

type Param = string | number | boolean | null;

/** A guarded query's result plus the views it read (for the observation and logs). */
export type GuardedResult = RetailQueryResult & { views: string[] };

/**
 * Runs one caller query through all four layers against the dataset's storage. Throws
 * QueryRefusedError for every refusal; the database is unchanged afterwards.
 */
export function runGuardedQuery(
  storage: DurableObjectStorage,
  sql: string,
  params: readonly Param[] | undefined,
  caps: QueryCaps,
  scanRowLimit: number,
): GuardedResult {
  const bindings = checkParams(params);
  const db = storage.sql;
  const schemaNames = new Set(db.exec<{ name: string }>("SELECT lower(name) AS name FROM sqlite_schema")
    .toArray().map(row => row.name));
  const shape = checkQueryText(sql, schemaNames);
  // Everything that hands caller text to SQLite runs inside the guarded transaction, the plan check
  // included: should SQLite ever read a second statement the parser did not see, its writes are
  // still detected and rolled back.
  return storage.transactionSync(() => {
    const changesBefore = totalChanges(db);
    const schemaBefore = schemaFingerprint(db);
    checkPlan(db, sql, bindings, scanRowLimit, shape);
    const cursor = db.exec(sql, ...bindings);
    const rows: SqlStorageValue[][] = [];
    let bytes = 0;
    let truncated = false;
    for (const row of cursor.raw()) {
      const size = row.reduce<number>((sum, value) => sum + valueBytes(value), 0);
      if (rows.length >= caps.maxRows || bytes + size > caps.maxBytes) {
        truncated = true;
        break;
      }
      bytes += size;
      rows.push(row);
    }
    const columnNames = cursor.columnNames;
    if (cursor.rowsWritten > 0 || totalChanges(db) !== changesBefore || schemaFingerprint(db) !== schemaBefore) {
      // Throwing rolls the transaction back.
      throw new QueryRefusedError("changed_data", "The query tried to change data and was rolled back.");
    }
    return { ...typedResult(columnNames, rows), truncated, views: shape.views };
  });
}

function checkParams(params: readonly Param[] | undefined): SqlStorageValue[] {
  const list = params ?? [];
  if (list.length > QUERY_LIMITS.maxParams) {
    throw new QueryRefusedError("params", `At most ${QUERY_LIMITS.maxParams} parameters are allowed.`);
  }
  return list.map(value => {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new QueryRefusedError("params", "Parameters must be finite numbers, strings, booleans or null.");
    }
    return value;
  });
}

const GUARDED_VIEW_STORAGE: ReadonlyMap<string, string> = new Map(
  Object.entries(SCAN_GUARDED_TABLES).map(([table, view]) => [view, table]));

/**
 * Layer 2: refuses a plan that scans a whole fact table holding more than `scanRowLimit` rows.
 * Views flatten into their storage tables, so a scan is named by the storage table, the view, or
 * the caller's alias for it. A scan of a name that maps to none of those (a flattened CTE, say)
 * is judged conservatively by the fact views the query names.
 */
function checkPlan(
  db: SqlStorage, sql: string, bindings: SqlStorageValue[], scanRowLimit: number, shape: QueryShape,
): void {
  let plan: { detail: string }[];
  try {
    plan = db.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...bindings).toArray();
  } catch (error) {
    throw new QueryRefusedError("syntax", `The query is not valid SQLite: ${error instanceof Error ? error.message : String(error)}`);
  }
  const derived = new Set<string>();
  const rowsOf = (storageTable: string) =>
    db.exec<{ n: number | null }>(`SELECT MAX(rowid) AS n FROM ${storageTable}`).one().n ?? 0;
  const refuseIfLarge = (view: string) => {
    const rows = rowsOf(GUARDED_VIEW_STORAGE.get(view)!);
    if (rows > scanRowLimit) {
      throw new QueryRefusedError("full_scan",
        `This query would scan all of ${view} (about ${rows} rows). Use metric() or the daily_* tables, ` +
        "or narrow it with a business_date range.");
    }
  };
  for (const { detail } of plan) {
    const source = /^(?:MATERIALIZE|CO-ROUTINE) (\S+)/.exec(detail);
    if (source) {
      derived.add(source[1]!.toLowerCase());
      continue;
    }
    const scan = /^SCAN (\S+)/.exec(detail);
    if (!scan) continue;
    const name = scan[1]!.toLowerCase();
    if (derived.has(name)) continue;
    const relation = SCAN_GUARDED_TABLES[name] ?? shape.aliases.get(name) ?? name;
    if (GUARDED_VIEW_STORAGE.has(relation)) {
      refuseIfLarge(relation);
    } else if (!PUBLIC_VIEW_NAMES.has(relation) && !relation.startsWith("store_")) {
      for (const view of shape.views) if (GUARDED_VIEW_STORAGE.has(view)) refuseIfLarge(view);
    }
  }
}

function totalChanges(db: SqlStorage): number {
  return db.exec<{ n: number }>("SELECT total_changes() AS n").one().n;
}

function schemaFingerprint(db: SqlStorage): string {
  return db.exec<{ f: string | null }>(
    "SELECT group_concat(type || ':' || name || ':' || COALESCE(sql, ''), char(10)) AS f FROM sqlite_schema")
    .one().f ?? "";
}

function valueBytes(value: SqlStorageValue): number {
  if (value === null) return 4;
  if (typeof value === "number") return 8;
  if (typeof value === "string") return value.length * 2;
  return value.byteLength;
}

// Column name → its published type, from the catalog (first definition wins; names agree across views).
const KNOWN_COLUMNS: ReadonlyMap<string, RetailColumn> = new Map(
  PUBLIC_TABLES.flatMap(table => table.columns).toReversed().map(column => [column.name, column]));

/**
 * Types each result column: a column named like a catalog column takes its type; other names are
 * typed from their values. Money needs a "currency" column in the result (aliases ending in
 * "_amount" count as money then); booleans come back as true/false.
 */
function typedResult(names: string[], rows: SqlStorageValue[][]): Pick<RetailQueryResult, "columns" | "rows"> {
  const hasCurrency = names.includes("currency");
  const columns = names.map((name, index): RetailColumn => {
    const known = KNOWN_COLUMNS.get(name);
    if (known?.type === "money" || (!known && name.endsWith("_amount"))) {
      return hasCurrency
        ? { name, type: "money", currencyColumn: "currency" }
        : { name, type: inferType(rows, index) };
    }
    if (known) return { name, type: known.type, ...(known.personal ? { personal: true } : {}) };
    return { name, type: inferType(rows, index) };
  });
  const converted = rows.map(row => row.map((value, index) => {
    if (value instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
    }
    if (columns[index]!.type === "boolean" && typeof value === "number") return value !== 0;
    return value;
  }));
  return { columns, rows: converted };
}

function inferType(rows: SqlStorageValue[][], index: number): RetailColumn["type"] {
  for (const row of rows) {
    const value = row[index];
    if (value === null || value === undefined) continue;
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "real";
    return "text";
  }
  return "text";
}
