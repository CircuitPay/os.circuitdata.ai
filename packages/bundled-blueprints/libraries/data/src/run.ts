/**
 * Running a saved query against the dataset, and reading the dataset's status.
 *
 * {@link runSavedQuery} is the only way a format reads figures. A metric query calls the dataset's
 * shared definition; a SQL query goes through `compileSql`, so a viewer's filter values arrive as
 * bound parameters. What comes back is cut to a size a gadget can store and broadcast, ids are
 * given their names, and a query problem becomes a {@link QueryFailure} for that one tile or block
 * instead of an exception. The one error that is thrown on is the connection having been removed,
 * because that is not about the query: the caller switches the whole gadget to "off".
 *
 * Nothing here logs. An error's message is passed on to the people who can see the gadget and to
 * nobody else, and never with row data: the dataset's refusals carry none.
 */

import type { QueryFailure, QueryOutcome, QueryResult, ResolvedFilters, ResultColumn, SavedQuery, VisualSpec } from "./model.ts";
import { compileSql } from "./params.ts";
import { previousRange } from "./period.ts";
import type { RetailColumn, RetailMetricQuery, RetailReader, Scalar } from "./retail.ts";

/** What a gadget knows about the dataset behind its binding. */
export type DataStatus =
  | {
      status: "ok";
      dateRange: { from: string; to: string };
      completeThrough: string | null;
      personalDataMasked: boolean;
      locations: { id: number; name: string }[];
    }
  /** The data is turned on and holds no orders yet. */
  | { status: "empty" }
  /** There is no binding: the data is turned off for this workspace. */
  | { status: "off" }
  | { status: "error"; error: string };

/** The most rows a result keeps. */
export const MAX_RESULT_ROWS = 500;
/** The most bytes a result's rows may take once serialized (previous-period rows included). */
export const MAX_RESULT_BYTES = 100_000;

/** The rows a product breakdown keeps when its visual sets no limit. */
export const DEFAULT_PRODUCT_LIMIT = 10;

const MAX_ERROR_LENGTH = 500;

// One read lists the products of at most this many ids: the dataset's limit on bound values.
const PRODUCT_IDS_PER_READ = 100;

const LOCATIONS_SQL = "SELECT id, name FROM locations ORDER BY name";

/**
 * Whether an error says the connection behind the binding is gone (the data was turned off, or
 * the connection was removed from the workspace), as the kernel words it.
 */
export function isConnectionGone(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("has been removed") || message.includes("no such gatekeeper") || message.includes("no longer connected");
}

/**
 * An error as one plain sentence to show beside a tile: the dataset's own explanation, without a
 * stack, without the error-class prefixes a runtime adds, and at most 500 characters.
 */
export function plainError(error: unknown): string {
  let text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // A stack starts at the first "    at …" line; everything from there on is internal.
  text = text.split(/\n\s*at\s/)[0];
  let stripped = text;
  do {
    text = stripped;
    stripped = text.replace(/^\s*(?:uncaught\s+(?:\(in promise\)\s+)?|[A-Za-z]*(?:Error|Exception):\s*)/i, "");
  } while (stripped !== text);
  text = text.replace(/\s+/g, " ").trim();
  if (text === "") return "The query could not be run.";
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/**
 * The dataset's status and its locations. No binding is "off"; a dataset with no orders is
 * "empty"; a connection that is gone is "off" as well, since the gadget can do nothing else with
 * it; any other failure is "error" with the reason.
 */
export async function readDataStatus(retail: RetailReader | undefined): Promise<DataStatus> {
  if (!retail) return { status: "off" };
  try {
    const description = await retail.describe();
    if (description.dateRange === null) return { status: "empty" };
    const listed = await retail.run(LOCATIONS_SQL, [], { maxRows: MAX_RESULT_ROWS });
    const locations: { id: number; name: string }[] = [];
    for (const [id, name] of listed.rows) {
      if (typeof id === "number") locations.push({ id, name: typeof name === "string" && name !== "" ? name : `Location ${id}` });
    }
    return {
      status: "ok",
      dateRange: { from: description.dateRange.from, to: description.dateRange.to },
      completeThrough: description.completeThrough,
      personalDataMasked: description.personalDataMasked,
      locations,
    };
  } catch (error) {
    if (isConnectionGone(error)) return { status: "off" };
    return { status: "error", error: plainError(error) };
  }
}

function resultColumn(column: RetailColumn): ResultColumn {
  const copy: ResultColumn = { name: column.name, type: column.type };
  if (column.currencyColumn !== undefined) copy.currencyColumn = column.currencyColumn;
  return copy;
}

/** Orders two cells: absent values last, numbers by size, everything else as text. */
function compareCells(a: Scalar, b: Scalar): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Rows sorted by one column (absent values stay last in both directions), then cut to `limit`. */
function arrange(rows: Scalar[][], index: number, dir: "asc" | "desc" | undefined, limit: number | undefined): Scalar[][] {
  let arranged = rows;
  if (dir !== undefined) {
    const sign = dir === "desc" ? -1 : 1;
    arranged = rows.toSorted((a, b) =>
      (a[index] === null || b[index] === null ? compareCells(a[index], b[index]) : sign * compareCells(a[index], b[index])));
  }
  return limit === undefined ? arranged : arranged.slice(0, limit);
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      // A surrogate pair is one four-byte character.
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Keeps rows while they fit the row cap and what is left of the byte budget. A row costs its JSON
 * and the comma after it, and the list its two brackets, so the kept rows serialize within budget.
 */
function capRows(rows: Scalar[][], budget: { bytes: number }): { rows: Scalar[][]; cut: boolean } {
  const kept: Scalar[][] = [];
  budget.bytes -= 2;
  for (const row of rows) {
    const size = utf8Length(JSON.stringify(row)) + 1;
    if (kept.length >= MAX_RESULT_ROWS || size > budget.bytes) return { rows: kept, cut: true };
    budget.bytes -= size;
    kept.push(row);
  }
  return { rows: kept, cut: false };
}

/** Replaces a column of ids with a text column of names, in every row set. */
function relabel(columns: ResultColumn[], rowSets: Scalar[][][], index: number, name: string, label: (id: Scalar) => string): void {
  columns[index] = { name, type: "text" };
  for (const rows of rowSets) {
    for (const row of rows) row[index] = label(row[index]);
  }
}

/** The names of the products with these ids, read in as few queries as the dataset's parameter limit allows. */
async function productNames(retail: RetailReader, ids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  for (let start = 0; start < ids.length; start += PRODUCT_IDS_PER_READ) {
    const batch = ids.slice(start, start + PRODUCT_IDS_PER_READ);
    const found = await retail.run(
      `SELECT id, name, variant_name FROM products WHERE id IN (${batch.map(() => "?").join(", ")})`,
      batch,
      { maxRows: PRODUCT_IDS_PER_READ },
    );
    for (const [id, name, variant] of found.rows) {
      if (typeof id !== "number") continue;
      const base = typeof name === "string" && name !== "" ? name : `Product ${id}`;
      names.set(id, typeof variant === "string" && variant !== "" ? `${base} (${variant})` : base);
    }
  }
  return names;
}

async function runMetricQuery(
  retail: RetailReader,
  query: Extract<SavedQuery, { kind: "metric" }>,
  visual: Pick<VisualSpec, "sort" | "limit">,
  filters: ResolvedFilters,
  locations: { id: number; name: string }[],
): Promise<Omit<QueryResult, "ranAt" | "durationMs">> {
  const period = { from: filters.from, to: filters.to };
  const groupBy = query.groupBy ?? [];
  const ask = (range: { from: string; to: string }): RetailMetricQuery => ({
    from: range.from,
    to: range.to,
    ...(groupBy.length > 0 ? { groupBy } : {}),
    ...(filters.locations.length > 0 ? { locationIds: filters.locations } : {}),
  });
  const earlier = query.compare ? previousRange(period) : null;
  const [current, before] = await Promise.all([
    retail.metric(query.metric, ask(period)),
    earlier ? retail.metric(query.metric, ask(earlier)) : null,
  ]);

  const columns = current.columns.map(resultColumn);
  // A ratio (0.25) is marked so every formatter shows it as a percentage.
  if (current.metric.unit === "ratio") {
    const value = columns.find(column => column.name === "value" && column.type === "real");
    if (value) value.label = "%";
  }
  let rows = current.rows.map(row => row.slice());
  let previousRows = before ? before.rows.map(row => row.slice()) : null;

  const locationIndex = columns.findIndex(column => column.name === "location_id");
  if (locationIndex >= 0) {
    const names = new Map(locations.map(location => [location.id, location.name]));
    relabel(columns, previousRows ? [rows, previousRows] : [rows], locationIndex, "location", id =>
      (typeof id === "number" ? names.get(id) ?? `Location ${id}` : "Unknown location"));
  }

  const productIndex = columns.findIndex(column => column.name === "product_id");
  // A product breakdown is a ranking unless the visual says otherwise: largest first, ten rows.
  const sort = visual.sort ?? (productIndex >= 0 ? { by: "value", dir: "desc" as const } : undefined);
  const limit = visual.limit ?? (productIndex >= 0 ? DEFAULT_PRODUCT_LIMIT : undefined);
  const order = () => {
    const index = sort ? sortColumn(columns, sort.by) : -1;
    rows = arrange(rows, index, sort?.dir, limit);
    if (previousRows) previousRows = arrange(previousRows, index, sort?.dir, limit);
  };
  // Sorting by product name needs the names first. Any other order is applied before they are
  // read, so a top-ten list costs one read for ten names.
  const byProductName = productIndex >= 0 && sort?.by === "product";
  if (!byProductName) order();
  let cut = false;
  if (productIndex >= 0) {
    // The row cap comes before the read, so the names of at most that many rows are asked for.
    cut = rows.length > MAX_RESULT_ROWS || (previousRows?.length ?? 0) > MAX_RESULT_ROWS;
    rows = rows.slice(0, MAX_RESULT_ROWS);
    previousRows = previousRows?.slice(0, MAX_RESULT_ROWS) ?? null;
    const ids = new Set<number>();
    for (const row of previousRows ? rows.concat(previousRows) : rows) {
      const id = row[productIndex];
      if (typeof id === "number") ids.add(id);
    }
    const names = await productNames(retail, Array.from(ids));
    relabel(columns, previousRows ? [rows, previousRows] : [rows], productIndex, "product", id =>
      (typeof id === "number" ? names.get(id) ?? `Product ${id}` : "Unlinked items"));
  }
  if (byProductName) order();

  const budget = { bytes: MAX_RESULT_BYTES };
  const capped = capRows(rows, budget);
  const cappedPrevious = previousRows ? capRows(previousRows, budget) : null;
  const result: Omit<QueryResult, "ranAt" | "durationMs"> = {
    columns,
    rows: capped.rows,
    truncated: cut || capped.cut || (cappedPrevious?.cut ?? false),
    period,
    rowCount: capped.rows.length,
  };
  if (earlier && cappedPrevious) result.previous = { from: earlier.from, to: earlier.to, rows: cappedPrevious.rows };
  if (current.partial !== undefined) result.partial = current.partial;
  if (current.costCoverage !== undefined) result.costCoverage = current.costCoverage;
  return result;
}

// A column of ids and the column of names that replaces it: a visual may sort by either name.
const SORT_ALIASES: Record<string, string> = {
  location_id: "location",
  product_id: "product",
  location: "location_id",
  product: "product_id",
};

/** The index of the column a visual sorts by. */
function sortColumn(columns: ResultColumn[], by: string): number {
  // `by` is a caller's text, so the table is read only for its own keys.
  const alias = Object.hasOwn(SORT_ALIASES, by) ? SORT_ALIASES[by] : undefined;
  const index = columns.findIndex(column => column.name === by || column.name === alias);
  if (index < 0) {
    throw new Error(`The visual sorts by "${by.slice(0, 60)}", which is not a column of the result. The columns are: ${columns.map(column => column.name).join(", ")}.`);
  }
  return index;
}

async function runSqlQuery(
  retail: RetailReader,
  query: Extract<SavedQuery, { kind: "sql" }>,
  visual: Pick<VisualSpec, "sort" | "limit">,
  filters: ResolvedFilters,
  locations: { id: number; name: string }[],
): Promise<Omit<QueryResult, "ranAt" | "durationMs">> {
  const compiled = compileSql(query.sql, filters, query.params ?? {}, locations.map(location => location.id));
  const answer = await retail.run(compiled.sql, compiled.params, { maxRows: MAX_RESULT_ROWS });
  const columns = answer.columns.map(resultColumn);
  const sortIndex = visual.sort ? sortColumn(columns, visual.sort.by) : -1;
  const capped = capRows(arrange(answer.rows, sortIndex, visual.sort?.dir, visual.limit), { bytes: MAX_RESULT_BYTES });
  return {
    columns,
    rows: capped.rows,
    truncated: answer.truncated || capped.cut,
    period: { from: filters.from, to: filters.to },
    rowCount: capped.rows.length,
  };
}

/**
 * Runs a saved query for one set of resolved filters and returns its outcome.
 *
 * A metric query calls `retail.metric` (twice with `compare`: the period, then the period of equal
 * length before it), names its locations from `context.locations` and its products with a read of
 * the `products` table, and applies the visual's sort and limit. A SQL query is compiled to
 * placeholders and bound values and run with the row cap. Either way the result is cut at
 * {@link MAX_RESULT_ROWS} rows and {@link MAX_RESULT_BYTES} bytes, with `truncated` saying so.
 *
 * A refusal or a failure is returned as a `QueryFailure`. Only a connection-gone error is thrown
 * (see {@link isConnectionGone}).
 */
export async function runSavedQuery(
  retail: RetailReader,
  query: SavedQuery,
  visual: Pick<VisualSpec, "sort" | "limit">,
  filters: ResolvedFilters,
  context: { locations: { id: number; name: string }[]; now?: () => number },
): Promise<QueryOutcome> {
  const now = context.now ?? Date.now;
  const ranAt = now();
  try {
    const result = query.kind === "metric"
      ? await runMetricQuery(retail, query, visual, filters, context.locations)
      : await runSqlQuery(retail, query, visual, filters, context.locations);
    return { ...result, ranAt, durationMs: Math.max(0, now() - ranAt) };
  } catch (error) {
    if (isConnectionGone(error)) throw error;
    const failure: QueryFailure = {
      error: plainError(error),
      ranAt,
      durationMs: Math.max(0, now() - ranAt),
      period: { from: filters.from, to: filters.to },
    };
    return failure;
  }
}
