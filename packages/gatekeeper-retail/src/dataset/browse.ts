// Browsing the canonical tables for the Data area (spec 008, contracts/data-app-api.md). Browse SQL
// names only the tables and columns of the fixed definitions below, and every value a caller sends
// is a bound parameter. Rows are read through the public views, so customers are masked exactly as
// they are for the agent, and search over a masked column only ever sees the mask.

import type {
  BrowseCatalog, BrowseColumn, BrowsePage, BrowseQuery, BrowseRow, BrowseTable, BrowseTableInfo, RowDetail,
  RowLineage, SourceKind,
} from "../app-api-types.js";
import type { RetailTable } from "../types.js";
import { addDays, readLineage } from "./coverage.js";
import { isIsoDate } from "./ingest.js";
import { PUBLIC_TABLES, VIEW_STORAGE } from "./schema.js";

/** Rows per page. */
const PAGE_SIZE = 100;
/** The furthest a page may start. */
const MAX_OFFSET = 1_000_000;
/** The longest search text. */
const MAX_SEARCH_LENGTH = 100;
/** Related rows shown per relation; one more is read to tell whether there are more. */
const RELATED_LIMIT = 50;
/** How many days, ending at the latest business date, a large table opens on. */
const NARROWED_DAYS = 30;

type Cell = string | number | boolean | null;

/** Rows of another table one step away from a row: `<table>.<column> = <the row's key>`. */
type Relation = {
  table: BrowseTable;
  label: string;
  column: string;
  key: string;
};

/** One browsable table: everything browse SQL may name about it. */
type Definition = {
  readonly label: string;
  readonly description: string;
  readonly dateColumn: "business_date" | null;
  /** A stable ORDER BY: newest first, ties broken by id. */
  readonly order: string;
  readonly search: { readonly columns: readonly string[]; readonly label: string } | null;
  readonly gridColumns: readonly BrowseColumn[];
  /** Every column of the public view, in its published order. */
  readonly viewColumns: readonly BrowseColumn[];
  readonly related: readonly Relation[];
};

const NEWEST_DATED = "business_date DESC, id DESC";
const NEWEST = "id DESC";

/** Builds a frozen definition, taking every column's type and description from `PUBLIC_TABLES`. */
function define(table: BrowseTable, spec: {
  label: string;
  dateColumn: "business_date" | null;
  order: string;
  search: { columns: string[]; label: string } | null;
  grid: string[];
  related: Relation[];
}): Definition {
  const published = PUBLIC_TABLES.find(entry => entry.name === table);
  if (!published) throw new Error(`${table} is not a public view.`);
  const viewColumns = published.columns.map(column => Object.freeze({ ...column }));
  const columnNamed = (name: string) => {
    const column = viewColumns.find(entry => entry.name === name);
    if (!column) throw new Error(`${table} has no column ${name}.`);
    return column;
  };
  for (const name of [...spec.grid, ...(spec.search?.columns ?? []), ...spec.related.map(relation => relation.key)]) {
    columnNamed(name);
  }
  for (const relation of spec.related) {
    if (!PUBLIC_TABLES.find(entry => entry.name === relation.table)?.columns.some(column => column.name === relation.column)) {
      throw new Error(`${relation.table} has no column ${relation.column}.`);
    }
  }
  if (spec.dateColumn) columnNamed(spec.dateColumn);
  return Object.freeze({
    label: spec.label,
    description: published.description,
    dateColumn: spec.dateColumn,
    order: spec.order,
    search: spec.search && Object.freeze({ columns: Object.freeze([...spec.search.columns]), label: spec.search.label }),
    gridColumns: Object.freeze(spec.grid.map(columnNamed)),
    viewColumns: Object.freeze(viewColumns),
    related: Object.freeze(spec.related.map(relation => Object.freeze({ ...relation }))),
  });
}

/** The browsable tables, in the order the Data area lists them (research R6, R9). */
export const BROWSE_TABLES: Readonly<Record<BrowseTable, Definition>> = Object.freeze({
  orders: define("orders", {
    label: "Orders",
    dateColumn: "business_date",
    order: NEWEST_DATED,
    search: { columns: ["order_number"], label: "order number" },
    grid: ["business_date", "order_number", "location_id", "status", "channel", "total_amount", "currency", "customer_id"],
    related: [
      { table: "line_items", label: "Line items", column: "order_id", key: "id" },
      { table: "transactions", label: "Payments", column: "order_id", key: "id" },
      { table: "locations", label: "Location", column: "id", key: "location_id" },
      { table: "customers", label: "Customer", column: "id", key: "customer_id" },
    ],
  }),
  line_items: define("line_items", {
    label: "Line items",
    dateColumn: "business_date",
    order: NEWEST_DATED,
    search: { columns: ["name"], label: "item name" },
    grid: ["business_date", "order_id", "name", "quantity", "unit_price_amount", "net_amount", "currency"],
    related: [
      { table: "orders", label: "Order", column: "id", key: "order_id" },
      { table: "products", label: "Product", column: "id", key: "product_id" },
    ],
  }),
  transactions: define("transactions", {
    label: "Payments",
    dateColumn: "business_date",
    order: NEWEST_DATED,
    search: null,
    grid: ["business_date", "order_id", "kind", "tender", "amount", "currency", "status"],
    related: [{ table: "orders", label: "Order", column: "id", key: "order_id" }],
  }),
  products: define("products", {
    label: "Products",
    dateColumn: null,
    order: NEWEST,
    search: { columns: ["name", "sku"], label: "name or SKU" },
    grid: ["name", "variant_name", "sku", "category", "price_amount", "currency", "is_active"],
    related: [{ table: "products", label: "Parent product", column: "id", key: "parent_product_id" }],
  }),
  customers: define("customers", {
    label: "Customers",
    dateColumn: null,
    order: NEWEST,
    search: { columns: ["first_name", "last_name", "email"], label: "name or email" },
    grid: ["first_name", "last_name", "email", "phone", "created_at"],
    related: [{ table: "orders", label: "Orders", column: "customer_id", key: "id" }],
  }),
  locations: define("locations", {
    label: "Locations",
    dateColumn: null,
    order: NEWEST,
    search: { columns: ["name"], label: "name" },
    grid: ["name", "kind", "timezone", "currency", "address_city"],
    related: [],
  }),
  inventory: define("inventory", {
    label: "Inventory",
    dateColumn: null,
    order: NEWEST,
    search: null,
    grid: ["product_id", "location_id", "quantity_on_hand", "state", "as_of"],
    related: [
      { table: "products", label: "Product", column: "id", key: "product_id" },
      { table: "locations", label: "Location", column: "id", key: "location_id" },
    ],
  }),
});

/** A table's approximate row count, as `describe()` and the SQL guard estimate it. */
export function rowEstimate(sql: SqlStorage, table: RetailTable): number {
  return sql.exec<{ n: number | null }>(`SELECT MAX(rowid) AS n FROM ${VIEW_STORAGE[table]}`).one().n ?? 0;
}

/** The business dates with orders, and the date every connected source is complete through. */
export function datasetDates(sql: SqlStorage): Pick<BrowseCatalog, "dateRange" | "completeThrough"> {
  const range = sql.exec<{ low: string | null; high: string | null }>(
    "SELECT MIN(business_date) AS low, MAX(business_date) AS high FROM store_orders").one();
  const complete = sql.exec<{ through: string | null }>(
    "SELECT MIN(coverage_to) AS through FROM store_sources WHERE status != 'disconnected'").one();
  return {
    dateRange: range.low && range.high ? { from: range.low, to: range.high } : null,
    completeThrough: complete.through,
  };
}

/** The browsable tables with exact counts, the dates covered, and the sources to filter by. */
export function readBrowseCatalog(sql: SqlStorage, personalDataMasked: boolean): BrowseCatalog {
  const tables = (Object.keys(BROWSE_TABLES) as BrowseTable[]).map((name): BrowseTableInfo => {
    const definition = BROWSE_TABLES[name];
    return {
      name,
      label: definition.label,
      description: definition.description,
      rows: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name} WHERE deleted_at IS NULL`).one().n,
      dateColumn: definition.dateColumn,
      search: definition.search && { columns: [...definition.search.columns], label: definition.search.label },
      gridColumns: [...definition.gridColumns],
    };
  });
  const sources = sql.exec<{ id: number; kind: SourceKind; label: string }>(
    "SELECT id, kind, label FROM store_sources ORDER BY id").toArray();
  return { tables, ...datasetDates(sql), personalDataMasked, sources };
}

/**
 * One page of `table`, newest first. A dated table with more rows than `scanRowLimit` and no date
 * range, run or source filter opens on its last {@link NARROWED_DAYS} days (FR-024).
 */
export function readBrowsePage(
  sql: SqlStorage, table: BrowseTable, query: BrowseQuery | undefined, scanRowLimit: number,
): BrowsePage {
  const definition = definitionOf(table);
  const { offset = 0, from, to, runId, sourceId, search } = query ?? {};
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % PAGE_SIZE !== 0 || offset > MAX_OFFSET) {
    throw new Error(`offset must be a multiple of ${PAGE_SIZE} from 0 to ${MAX_OFFSET}.`);
  }
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (value === undefined) continue;
    if (!definition.dateColumn) throw new Error(`${definition.label} cannot be filtered by date.`);
    if (!isIsoDate(value)) throw new Error(`${name} must be a date written YYYY-MM-DD.`);
  }
  if (from !== undefined && to !== undefined && from > to) throw new Error("from must not be after to.");
  for (const [name, value] of [["runId", runId], ["sourceId", sourceId]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`${name} must be a positive whole number.`);
    }
  }
  if (search !== undefined) {
    if (!definition.search) throw new Error(`${definition.label} cannot be searched.`);
    if (search.length < 1 || search.length > MAX_SEARCH_LENGTH) {
      throw new Error(`Search text must be 1 to ${MAX_SEARCH_LENGTH} characters.`);
    }
  }

  let range = from !== undefined || to !== undefined ? { from: from ?? "0000-01-01", to: to ?? "9999-12-31" } : null;
  let narrowedTo: BrowsePage["narrowedTo"] = null;
  if (definition.dateColumn && !range && runId === undefined && sourceId === undefined &&
    rowEstimate(sql, table) > scanRowLimit) {
    narrowedTo = latestDays(sql, table, definition.dateColumn);
    range = narrowedTo;
  }

  const where = ["deleted_at IS NULL"];
  const params: (string | number)[] = [];
  if (range && definition.dateColumn) {
    where.push(`${definition.dateColumn} BETWEEN ? AND ?`);
    params.push(range.from, range.to);
  }
  if (runId !== undefined) {
    where.push("run_id = ?");
    params.push(runId);
  }
  if (sourceId !== undefined) {
    where.push("source_id = ?");
    params.push(sourceId);
  }
  if (search !== undefined && definition.search) {
    // LIKE compares ASCII letters case-insensitively; the escapes make `%`, `_` and `\` literal.
    const pattern = `%${search.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    where.push(`(${definition.search.columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...definition.search.columns.map(() => pattern));
  }

  const total = sql.exec<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where.join(" AND ")}`, ...params).one().n;
  return {
    table,
    columns: [...definition.gridColumns],
    rows: gridRows(sql, table, where, params, PAGE_SIZE, offset),
    offset,
    total,
    pageSize: PAGE_SIZE,
    narrowedTo,
  };
}

/** One row with every field of its view, its related rows and its origin. */
export function readRowDetail(sql: SqlStorage, table: BrowseTable, id: number): RowDetail {
  const definition = definitionOf(table);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("id must be a row id.");
  const [values] = sql.exec(
    `SELECT ${definition.viewColumns.map(column => column.name).join(", ")} FROM ${table} WHERE id = ? AND deleted_at IS NULL`,
    id).raw();
  if (!values) throw new Error("This row no longer exists.");
  const raw = new Map(definition.viewColumns.map((column, index) => [column.name, values[index] ?? null]));

  const related = definition.related.flatMap(relation => {
    const key = raw.get(relation.key);
    // A relation through an empty foreign key has nothing to show; views hold no binary values.
    if (key === null || key === undefined || key instanceof ArrayBuffer) return [];
    const rows = gridRows(sql, relation.table, ["deleted_at IS NULL", `${relation.column} = ?`], [key],
      RELATED_LIMIT + 1, 0);
    return [{
      table: relation.table,
      label: relation.label,
      columns: [...BROWSE_TABLES[relation.table].gridColumns],
      rows: rows.slice(0, RELATED_LIMIT),
      truncated: rows.length > RELATED_LIMIT,
    }];
  });

  let origin: RowLineage | null;
  try {
    origin = readLineage(sql, table, id);
  } catch {
    origin = null;
  }
  return {
    table,
    id,
    fields: definition.viewColumns.map(column => ({ column, value: cell(column, raw.get(column.name) ?? null) })),
    related,
    origin,
  };
}

/** The definition of `table`, refusing anything that is not one of the browsable tables. */
function definitionOf(table: BrowseTable): Definition {
  if (!Object.hasOwn(BROWSE_TABLES, table)) throw new Error("This table cannot be browsed.");
  return BROWSE_TABLES[table];
}

/** `id` and the grid columns of the rows matching `where`, in the table's order. */
function gridRows(
  sql: SqlStorage, table: BrowseTable, where: string[], params: (string | number)[], limit: number, offset: number,
): BrowseRow[] {
  const definition = BROWSE_TABLES[table];
  const columns = definition.gridColumns;
  const cursor = sql.exec(
    `SELECT id, ${columns.map(column => column.name).join(", ")} FROM ${table} WHERE ${where.join(" AND ")} ` +
    `ORDER BY ${definition.order} LIMIT ${limit} OFFSET ?`,
    ...params, offset);
  return Array.from(cursor.raw(), ([id, ...values]) => ({
    id: Number(id),
    values: columns.map((column, index) => cell(column, values[index] ?? null)),
  }));
}

/** The last {@link NARROWED_DAYS} days ending at the dataset's latest business date (or the table's own). */
function latestDays(sql: SqlStorage, table: BrowseTable, dateColumn: string): { from: string; to: string } | null {
  const latest = datasetDates(sql).dateRange?.to ?? sql.exec<{ high: string | null }>(
    `SELECT MAX(${dateColumn}) AS high FROM ${table} WHERE deleted_at IS NULL`).one().high;
  return latest ? { from: addDays(latest, 1 - NARROWED_DAYS), to: latest } : null;
}

/** A stored value as the browser shows it: booleans as true/false. */
function cell(column: BrowseColumn, value: SqlStorageValue): Cell {
  if (value instanceof ArrayBuffer) throw new Error(`${column.name} holds binary data, which browsing cannot show.`);
  if (column.type === "boolean" && value !== null) return value !== 0;
  return value;
}
