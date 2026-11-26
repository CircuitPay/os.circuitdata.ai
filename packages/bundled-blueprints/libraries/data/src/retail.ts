/**
 * The retail dataset as a gadget sees it through `env.RETAIL_DATA`.
 *
 * A blueprint may import nothing outside its own files and the gadget libraries, so the
 * declarations below are a copy of the ones in `packages/gatekeeper-retail/src/types.d.ts`, kept
 * word for word. `__tests__/retail-types.test.ts` compares the two files and fails when they
 * drift: change the gatekeeper's file first, then paste the declaration here.
 *
 * {@link RetailReader} and {@link Scalar} are this library's own: the three read methods the data
 * formats call, typed structurally so a test can stand a scripted reader in for the binding.
 */

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

/** The part of the RETAIL_DATA binding the data formats call. */
export interface RetailReader {
  describe(): Promise<RetailDatasetDescription>;
  run(sql: string, params?: Scalar[], options?: { maxRows?: number; maxBytes?: number }): Promise<RetailQueryResult>;
  metric(name: RetailMetricName, query: RetailMetricQuery): Promise<RetailMetricResult>;
}

/** A value in a result row or a bound parameter. */
export type Scalar = string | number | boolean | null;
