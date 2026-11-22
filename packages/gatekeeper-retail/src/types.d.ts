import type { RpcTarget } from "cloudflare:workers";

/** Names of the tables you can query. All are read-only views. */
export type RetailTable =
  | "locations" | "customers" | "products" | "orders" | "line_items" | "transactions"
  | "refund_items" | "inventory" | "inventory_movements" | "sources"
  | "daily_sales" | "daily_product_sales" | "customer_summary" | "daily_source_coverage";

/** The type of a column in a result or a table description. */
export type RetailColumnType =
  | "integer" | "real" | "text" | "boolean" | "json"
  /** ISO 8601 UTC timestamp text, e.g. "2026-11-17T14:03:00Z". */
  | "timestamp"
  /** Local business date "YYYY-MM-DD". */
  | "date"
  /** Integer amount in the currency's minor units (1299 = 12.99 USD); see `currencyColumn`. */
  | "money";

export interface RetailColumn {
  name: string;
  type: RetailColumnType;
  /** For "money" columns: the column in the same row that holds the ISO 4217 currency code. */
  currencyColumn?: string;
  description?: string;
  /** True for personal data. Values are masked unless the organization allowed unmasked access. */
  personal?: boolean;
}

export interface RetailTableDescription {
  name: RetailTable;
  description: string;
  columns: RetailColumn[];
  /** Approximate row count. */
  rows: number;
}

export type RetailMetricName =
  | "gross_sales" | "discounts" | "refunds" | "net_sales" | "tax" | "tips" | "service_charges"
  | "orders" | "average_order_value" | "units_sold" | "gross_margin" | "repeat_customer_rate";

export interface RetailMetricDefinition {
  name: RetailMetricName;
  description: string;
  /** "money" values carry a currency; "count" and "ratio" do not. */
  unit: "money" | "count" | "quantity" | "ratio";
  /** The exact SQL this metric runs over the rollup tables, for reference. */
  sql: string;
}

export interface RetailDatasetDescription {
  tables: RetailTableDescription[];
  metrics: RetailMetricDefinition[];
  /** Whether personal columns (names, emails, phones) are masked in your results. */
  personalDataMasked: boolean;
  /** Earliest and latest business date with any orders, or null when the dataset is empty. */
  dateRange: { from: string; to: string } | null;
  /** Business date up to which every source has reported, or null when unknown. */
  completeThrough: string | null;
  limits: { maxRows: number; maxBytes: number; maxParams: number };
}

export interface RetailQueryResult {
  columns: RetailColumn[];
  /** One array per row, in `columns` order. */
  rows: (string | number | boolean | null)[][];
  /** True when the result stopped at `maxRows` or `maxBytes`; refine the query to see the rest. */
  truncated: boolean;
}

export interface RetailMetricQuery {
  /** Inclusive business dates "YYYY-MM-DD". At most 3 years apart. */
  from: string;
  to: string;
  /**
   * Break the result down. Time grains are mutually exclusive. "week" is the ISO week starting
   * Monday; "product" and "category" are not available for order-level metrics
   * (orders, average_order_value, tips, service_charges, repeat_customer_rate).
   */
  groupBy?: ("day" | "week" | "month" | "location" | "channel" | "product" | "category")[];
  locationIds?: number[];
  /** Restrict to one currency. Money metrics are always reported per currency. */
  currency?: string;
}

export interface RetailMetricResult {
  metric: RetailMetricDefinition;
  /** Columns: the requested groupBy keys in order, then "currency" (money metrics), then "value". */
  columns: RetailColumn[];
  rows: (string | number | boolean | null)[][];
  /**
   * gross_margin only: true when some units sold had no known cost, in which case the margin
   * covers only the units with a cost. `costCoverage` is the share of units that had one (0–1).
   */
  partial?: boolean;
  costCoverage?: number;
}

export interface RetailCoverage {
  sources: {
    id: number;
    kind: "square" | "stripe" | "toast" | "csv";
    label: string;
    status: "connecting" | "backfilling" | "active" | "syncing" | "retrying" | "needs_reconnect"
      | "disconnected" | "imported";
    lastSuccessAt: string | null;
  }[];
  /** Per location and source: the business dates covered. */
  ranges: { locationId: number; sourceId: number; from: string; to: string }[];
  /**
   * Days with no orders for a location that usually trades on that weekday (orders on the same
   * weekday in at least 3 of the previous 4 weeks): possibly missing data rather than a slow day.
   */
  possibleGaps: { locationId: number; businessDate: string }[];
}

export interface RetailRowLineage {
  table: RetailTable;
  id: number;
  source: { id: number; kind: "square" | "stripe" | "toast" | "csv"; label: string };
  sourceRecordId: string;
  run: { id: number; kind: "backfill" | "sync" | "import" | "rebuild" | "undo"; finishedAt: string | null };
  mappingVersion: string;
  /** For imported rows: the file and 1-based row it came from. */
  file?: { name: string; row: number };
}

export interface RetailPendingImport {
  id: number;
  files: { name: string; headers: string[]; role?: string }[];
  /** Up to 20 sample rows per file. Personal data in samples is masked. */
  samples: { file: string; rows: (string | null)[][] }[];
  /** The mapping matched from a saved template or header names, if any. */
  currentMapping: RetailMapping | null;
}

/**
 * How the columns of a pending CSV import become rows. Each target field maps from a source
 * column with an optional transform.
 */
export interface RetailMapping {
  /** Settings the file does not state; ask the member if unsure. */
  settings: {
    timezone: string;
    currency: string;
    dateFormat: string;
    decimalMark: "." | ",";
  };
  /** Source column that identifies an order; rows sharing it form one order. */
  orderKey: string | null;
  fields: {
    target: string;
    /** Source column header, or null with `constant` set. */
    from: string | null;
    constant?: string | number | boolean;
    transform?: "date" | "datetime" | "money" | "negate_money" | "quantity" | "lowercase" | "trim";
  }[];
}

export interface RetailData extends RpcTarget {
  /** Tables, columns, metric definitions, date coverage and limits. */
  describe(): Promise<RetailDatasetDescription>;

  /**
   * Run one read-only SQL SELECT (SQLite dialect) over the tables in `describe()`.
   * Use `?` placeholders with `params`; never splice values into the SQL text.
   * Refused with an explanation when: the statement is not a single SELECT/WITH query; it names
   * anything other than the listed tables and its own CTEs; it uses WITH RECURSIVE or a disallowed
   * function; or it would scan a large table without a date filter (use `metric()` or the
   * `daily_*` tables, or narrow by `business_date`).
   * Money columns are integer minor units next to a currency column; column aliases ending in
   * "_amount" are reported as money when the result has a "currency" column.
   */
  run(
    sql: string,
    params?: (string | number | boolean | null)[],
    options?: { maxRows?: number; maxBytes?: number },
  ): Promise<RetailQueryResult>;

  /** A standard metric, computed with the shared definition every dashboard and report uses. */
  metric(name: RetailMetricName, query: RetailMetricQuery): Promise<RetailMetricResult>;

  /** Which sources cover which dates and locations, and which days look like missing data. */
  coverage(options?: { from?: string; to?: string; locationIds?: number[] }): Promise<RetailCoverage>;

  /** Where one row came from. */
  lineage(table: RetailTable, id: number): Promise<RetailRowLineage>;

  /** CSV imports a member has uploaded that are waiting for a column mapping. */
  pendingImports(): Promise<RetailPendingImport[]>;

  /**
   * Suggest a column mapping for a pending import. The member reviews a preview and confirms
   * before anything is imported; this call imports nothing. Replaces any earlier suggestion.
   * Throws if the import is no longer pending or the mapping names an unknown target field.
   */
  proposeImportMapping(importId: number, mapping: RetailMapping): Promise<void>;
}
