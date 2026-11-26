/**
 * The values the data formats share: a saved query, the shared filters, a query's outcome and how
 * a result is drawn, with the validators that turn something off the wire into one of them.
 *
 * A validator returns a clean copy (only the fields the type has) or throws an `Error` whose
 * message names the bad field in plain language: the same message reaches a person in the page
 * and the agent through its tool result.
 */

import { compileSql } from "./params.ts";
import { resolveRange } from "./period.ts";
import type { RetailColumnType, RetailMetricName, Scalar } from "./retail.ts";

/** How a metric can be broken down. `day`, `week` and `month` are time grains; a query uses at most one. */
export type MetricGroup = "day" | "week" | "month" | "location" | "channel" | "product" | "category";

/** A named, reviewable read of the dataset: a standard metric, or SQL with named parameters. */
export type SavedQuery =
  | {
      kind: "metric";
      metric: RetailMetricName;
      groupBy?: MetricGroup[];
      /** Also compute the same metric over the period of equal length just before `from`. */
      compare?: boolean;
    }
  | {
      kind: "sql";
      /** One SELECT or WITH statement with named parameters (`:from`, `:to`, `:locations`, declared literals). */
      sql: string;
      /** Literal values for the query's own named parameters. Names are [a-z][a-z0-9_]*, not from/to/locations. */
      params?: Record<string, Scalar>;
    };

/** Which shared filters a tile or block listens to. */
export type FilterName = "dateRange" | "locations";

/** A date range counted back from the anchor date (see `anchorDate`). */
export type DatePreset = "last7" | "last30" | "last90" | "thisMonth" | "lastMonth" | "thisYear";

/** A preset, or explicit business dates written YYYY-MM-DD. */
export type DateRangeFilter = { preset: DatePreset } | { from: string; to: string };

/** The shared filters as a viewer sets them. */
export type FilterValues = {
  dateRange: DateRangeFilter;
  /** Location ids; empty means every location. */
  locations: number[];
};

/** The shared filters as a query is bound to them: the date range resolved to business dates. */
export type ResolvedFilters = { from: string; to: string; locations: number[] };

/**
 * A column of a result. A `money` column holds integer minor units and names the column that
 * holds its currency. `label` is the heading to show instead of the column's name; the label
 * `"%"` on a `real` column marks a ratio, shown as a percentage (0.25 as 25%).
 */
export type ResultColumn = { name: string; type: RetailColumnType; currencyColumn?: string; label?: string };

/** What a saved query returned. */
export type QueryResult = {
  columns: ResultColumn[];
  rows: Scalar[][];
  /** True when rows were cut at the cap (by the dataset or by this library). */
  truncated: boolean;
  /** Present when `compare` was asked: the previous period's rows, same columns. */
  previous?: { from: string; to: string; rows: Scalar[][] };
  /** gross_margin only. */
  partial?: boolean;
  costCoverage?: number;
  period: { from: string; to: string };
  /** When the query ran, in epoch milliseconds. */
  ranAt: number;
  durationMs: number;
  rowCount: number;
};

/** A saved query that was refused or failed, with the explanation to show. */
export type QueryFailure = { error: string; ranAt: number; durationMs: number; period: { from: string; to: string } };

/** A result or a failure; a failure is the one with `error`. */
export type QueryOutcome = QueryResult | QueryFailure;

/** The ways a result can be drawn. `text` shows written text and has no query. */
export type VisualType = "kpi" | "line" | "area" | "bar" | "stackedBar" | "table" | "text";

/** How a tile or a block draws its result. */
export type VisualSpec = {
  type: VisualType;
  /** Column names in the result. Absent roles are inferred (see inferRoles). */
  x?: string;
  y?: string[];
  series?: string;
  /** Sort rows by a column before drawing, then keep the first `limit`. */
  sort?: { by: string; dir: "asc" | "desc" };
  /** Between 1 and 500. */
  limit?: number;
  /** For "text": Markdown-lite body shown as written (no query). */
  text?: string;
};

/** Every standard metric, in the dataset's order. */
export const METRIC_NAMES: RetailMetricName[] = [
  "gross_sales", "discounts", "refunds", "net_sales", "tax", "tips", "service_charges",
  "orders", "average_order_value", "units_sold", "gross_margin", "repeat_customer_rate",
];

/** Every way a metric can be broken down. */
export const METRIC_GROUPS: MetricGroup[] = ["day", "week", "month", "location", "channel", "product", "category"];

/** Every visual type, in the order a picker lists them. */
export const VISUAL_TYPES: VisualType[] = ["kpi", "line", "area", "bar", "stackedBar", "table", "text"];

/** The longest SQL text a saved query may hold, in characters. */
export const MAX_SQL_LENGTH = 8_000;
/** The most literal parameters a SQL query may declare. */
export const MAX_LITERAL_PARAMS = 20;
/** The most breakdowns a metric query may ask for. */
export const MAX_GROUP_BY = 3;
/** The most rows a visual may keep. */
export const MAX_VISUAL_LIMIT = 500;
/** The longest text a text visual may hold, in characters. */
export const MAX_TEXT_LENGTH = 20_000;
/** The most locations one filter may select: the dataset's limit for a metric query. */
export const MAX_FILTER_LOCATIONS = 50;

const TIME_GRAINS: MetricGroup[] = ["day", "week", "month"];
const DATE_PRESET_IDS: DatePreset[] = ["last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear"];
const RESERVED_PARAMS = ["from", "to", "locations"];
const COLUMN_NAME_LENGTH = 200;

/** A value quoted for an error message, cut so a hostile one cannot flood the message. */
function shown(value: unknown): string {
  if (typeof value !== "string") {
    // Anything else is named by what it is: stringifying a caller's object can throw.
    if (value === null || value === undefined) return "(none given)";
    return typeof value === "number" || typeof value === "boolean" ? String(value) : `(a value of type ${typeof value})`;
  }
  return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function columnName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > COLUMN_NAME_LENGTH) {
    throw new Error(`${field} must be the name of a column in the result.`);
  }
  return value;
}

/** Checks a saved query and returns a clean copy. SQL must be one read statement whose names all have values. */
export function validateSavedQuery(value: unknown): SavedQuery {
  const input = record(value, "The query");
  if (input.kind === "metric") {
    const metric = METRIC_NAMES.find(name => name === input.metric);
    if (!metric) {
      throw new Error(`The query's metric ${shown(input.metric)} is not a standard metric. Use one of: ${METRIC_NAMES.join(", ")}.`);
    }
    const query: SavedQuery = { kind: "metric", metric };
    if (input.groupBy !== undefined) {
      if (!Array.isArray(input.groupBy)) throw new Error("The query's groupBy must be a list.");
      const groups: MetricGroup[] = [];
      for (const entry of input.groupBy) {
        const group = METRIC_GROUPS.find(name => name === entry);
        if (!group) {
          throw new Error(`The query's groupBy has ${shown(entry)}, which is not one of: ${METRIC_GROUPS.join(", ")}.`);
        }
        if (groups.includes(group)) throw new Error(`The query's groupBy repeats "${group}".`);
        groups.push(group);
      }
      if (groups.length > MAX_GROUP_BY) throw new Error(`The query's groupBy can hold at most ${MAX_GROUP_BY} entries.`);
      if (groups.filter(group => TIME_GRAINS.includes(group)).length > 1) {
        throw new Error("The query's groupBy can use only one of day, week and month.");
      }
      query.groupBy = groups;
    }
    if (input.compare !== undefined) {
      if (typeof input.compare !== "boolean") throw new Error("The query's compare must be true or false.");
      query.compare = input.compare;
    }
    return query;
  }
  if (input.kind === "sql") {
    if (typeof input.sql !== "string" || input.sql.trim() === "") throw new Error("The query's sql must be the text of a SELECT statement.");
    if (input.sql.length > MAX_SQL_LENGTH) {
      throw new Error(`The query's sql is ${input.sql.length} characters long; the most a saved query can hold is ${MAX_SQL_LENGTH}.`);
    }
    const query: SavedQuery = { kind: "sql", sql: input.sql };
    const literals: Record<string, Scalar> = {};
    if (input.params !== undefined) {
      const declared = record(input.params, "The query's params");
      const names = Object.keys(declared);
      if (names.length > MAX_LITERAL_PARAMS) throw new Error(`The query's params can hold at most ${MAX_LITERAL_PARAMS} values.`);
      for (const name of names) {
        if (!/^[a-z][a-z0-9_]*$/.test(name) || name.length > 60) {
          throw new Error(`The parameter name ${shown(name)} must start with a lowercase letter and use only lowercase letters, digits and underscores.`);
        }
        if (RESERVED_PARAMS.includes(name)) {
          throw new Error(`The parameter name "${name}" is taken by the shared filters. Choose another name.`);
        }
        const literal = declared[name];
        if (!(literal === null || typeof literal === "string" || typeof literal === "boolean"
          || (typeof literal === "number" && Number.isFinite(literal)))) {
          throw new Error(`The parameter "${name}" must be text, a finite number, true, false or null.`);
        }
        literals[name] = literal;
      }
      query.params = literals;
    }
    // A dry run against placeholder filters: the text is refused now, in the words the compiler
    // uses, instead of every time the tile or block runs. Nothing is sent anywhere.
    compileSql(query.sql, { from: "2000-01-01", to: "2000-01-01", locations: [] }, literals, []);
    return query;
  }
  throw new Error('The query\'s kind must be "metric" or "sql".');
}

/** Checks how a result is to be drawn and returns a clean copy. */
export function validateVisual(value: unknown): VisualSpec {
  const input = record(value, "The visual");
  const type = VISUAL_TYPES.find(name => name === input.type);
  if (!type) throw new Error(`The visual's type ${shown(input.type)} is not one of: ${VISUAL_TYPES.join(", ")}.`);
  const visual: VisualSpec = { type };
  if (input.x !== undefined) visual.x = columnName(input.x, "The visual's x");
  if (input.y !== undefined) {
    if (!Array.isArray(input.y) || input.y.length > 12) throw new Error("The visual's y must be a list of at most 12 column names.");
    visual.y = input.y.map(entry => columnName(entry, "Each entry of the visual's y"));
  }
  if (input.series !== undefined) visual.series = columnName(input.series, "The visual's series");
  if (input.sort !== undefined) {
    const sort = record(input.sort, "The visual's sort");
    if (sort.dir !== "asc" && sort.dir !== "desc") throw new Error('The visual\'s sort direction must be "asc" or "desc".');
    visual.sort = { by: columnName(sort.by, "The visual's sort column"), dir: sort.dir };
  }
  if (input.limit !== undefined) {
    const limit = input.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_VISUAL_LIMIT) {
      throw new Error(`The visual's limit must be a whole number from 1 to ${MAX_VISUAL_LIMIT}.`);
    }
    visual.limit = limit;
  }
  if (input.text !== undefined) {
    if (typeof input.text !== "string") throw new Error("The visual's text must be text.");
    if (input.text.length > MAX_TEXT_LENGTH) {
      throw new Error(`The visual's text is ${input.text.length} characters long; the most it can hold is ${MAX_TEXT_LENGTH}.`);
    }
    visual.text = input.text;
  }
  return visual;
}

/** Checks a date-range filter and returns a clean copy. */
export function validateDateRange(value: unknown): DateRangeFilter {
  const input = record(value, "The date range");
  if (input.preset !== undefined) {
    const preset = DATE_PRESET_IDS.find(id => id === input.preset);
    if (!preset) throw new Error(`The date range ${shown(input.preset)} is not one of: ${DATE_PRESET_IDS.join(", ")}.`);
    return { preset };
  }
  if (typeof input.from !== "string" || typeof input.to !== "string") {
    throw new Error("The date range needs a preset, or a start and an end date written YYYY-MM-DD.");
  }
  // An explicit range resolves to itself whatever the anchor, so resolving it is the check.
  return resolveRange({ from: input.from, to: input.to }, input.from);
}

/** Checks the shared filters a viewer chose and returns a clean copy. Location ids are deduplicated. */
export function validateFilters(value: unknown): FilterValues {
  const input = record(value, "The filters");
  const dateRange = validateDateRange(input.dateRange);
  const chosen = input.locations ?? [];
  if (!Array.isArray(chosen)) throw new Error("The filters' locations must be a list of location ids.");
  const locations: number[] = [];
  for (const id of chosen) {
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      throw new Error("The filters' locations must be a list of location ids, which are whole numbers.");
    }
    if (!locations.includes(id)) locations.push(id);
  }
  if (locations.length > MAX_FILTER_LOCATIONS) {
    throw new Error(`Choose at most ${MAX_FILTER_LOCATIONS} locations, or none for every location.`);
  }
  return { dateRange, locations };
}
