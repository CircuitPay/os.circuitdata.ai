// The standard metrics (specs/006-retail-data-layer/contracts/metrics.md, FR-017). One definition
// each: `metric()` runs it, `describe()` publishes it, and dashboards and reports reuse it. All but
// repeat_customer_rate read the rollup views, which every run keeps current.

import type {
  RetailColumn, RetailMetricDefinition, RetailMetricName, RetailMetricQuery, RetailMetricResult,
} from "../types.js";
import { isIsoDate, normalizeCurrency, roundHalfEven } from "./ingest.js";

type GroupKey = NonNullable<RetailMetricQuery["groupBy"]>[number];
type Value = string | number | boolean | null;

/** A metric query the contract refuses (metrics.md "Refused metric queries"). */
export class MetricQueryError extends Error {
  override name = "MetricQueryError";
}

/** At most this many location ids per metric query (each is one bound parameter). */
export const MAX_METRIC_LOCATIONS = 50;

const SALES = "('completed', 'refunded', 'partially_refunded')";

/** Product-level metrics: the only ones that may group by product or category. */
const PRODUCT_LEVEL: ReadonlySet<RetailMetricName> = new Set([
  "gross_sales", "discounts", "refunds", "net_sales", "units_sold", "gross_margin",
]);

type MetricSpec = {
  description: string;
  unit: RetailMetricDefinition["unit"];
  /** Aggregate expressions over the rollup alias `d`; the first is the value unless derived. */
  aggregates: string[];
};

const SPECS: Record<Exclude<RetailMetricName, "repeat_customer_rate">, MetricSpec> = {
  gross_sales: {
    description: "Gross sales: quantity x unit price (with modifiers) on non-voided lines of non-voided orders, before discounts; excludes tax, tips and service charges.",
    unit: "money",
    aggregates: ["SUM(d.gross_amount)"],
  },
  discounts: {
    description: "Line- and order-level discounts. Grouped by product or category, only line discounts count: order-level discounts are not allocated to products.",
    unit: "money",
    aggregates: ["SUM(d.discount_amount)"],
  },
  refunds: {
    description: "The sales portion of succeeded refunds (excluding refunded tax and tips), on the refund's business date. Grouped by product or category, only itemized refunds count.",
    unit: "money",
    aggregates: ["SUM(d.refund_amount)"],
  },
  net_sales: {
    description: "gross_sales - discounts - refunds. Grouped by product or category, it deducts line discounts and itemized refunds only.",
    unit: "money",
    aggregates: ["SUM(d.net_amount)"],
  },
  tax: {
    description: "Tax collected on non-voided orders.",
    unit: "money",
    aggregates: ["SUM(d.tax_amount)"],
  },
  tips: {
    description: "Tips on non-voided orders.",
    unit: "money",
    aggregates: ["SUM(d.tip_amount)"],
  },
  service_charges: {
    description: "Service charges on non-voided orders.",
    unit: "money",
    aggregates: ["SUM(d.service_charge_amount)"],
  },
  orders: {
    description: "Non-voided orders.",
    unit: "count",
    aggregates: ["SUM(d.orders)"],
  },
  average_order_value: {
    description: "net_sales / orders, rounded half-even to the minor unit; null when there are no orders.",
    unit: "money",
    aggregates: ["SUM(d.net_amount)", "SUM(d.orders)"],
  },
  units_sold: {
    description: "Units on non-voided lines minus itemized refunded units.",
    unit: "quantity",
    aggregates: ["SUM(d.units) - SUM(d.refunded_units)"],
  },
  gross_margin: {
    description: "Product net sales (line discounts and itemized refunds deducted; order-level discounts are not allocated to products) minus cost, over the units with a known cost: net sales of partly costed rows are prorated by costed units. partial and costCoverage report the share of units that had a cost.",
    unit: "money",
    aggregates: [
      "SUM(CASE WHEN d.units > 0 THEN d.net_amount * (d.units - d.units_missing_cost) / d.units ELSE d.net_amount END) - SUM(d.cost_amount)",
      "SUM(d.units)",
      "SUM(d.units_missing_cost)",
    ],
  },
};

const REPEAT_DESCRIPTION =
  "Identified customers (merged through confirmed matches) with at least 2 non-voided orders in the range, divided by those with at least 1; null when there are none.";

const WEEK_START = (column: string) =>
  `date(${column}, '-' || ((CAST(strftime('%w', ${column}) AS INTEGER) + 6) % 7) || ' days')`;

const GROUP_EXPRESSIONS: Record<GroupKey, string> = {
  day: "d.business_date",
  week: WEEK_START("d.business_date"),
  month: "substr(d.business_date, 1, 7)",
  location: "d.location_id",
  channel: "d.channel",
  product: "d.product_id",
  category: "p.category",
};

const GROUP_COLUMNS: Record<GroupKey, RetailColumn> = {
  day: { name: "day", type: "date" },
  week: { name: "week", type: "date", description: "Monday starting the ISO week." },
  month: { name: "month", type: "text", description: "YYYY-MM" },
  location: { name: "location_id", type: "integer" },
  channel: { name: "channel", type: "text" },
  product: { name: "product_id", type: "integer" },
  category: { name: "category", type: "text" },
};

const TIME_GRAINS: ReadonlySet<GroupKey> = new Set(["day", "week", "month"]);

type Plan = { sql: string; bindings: Value[]; keys: GroupKey[]; perCurrency: boolean };

function rollupPlan(name: Exclude<RetailMetricName, "repeat_customer_rate">, query: Required<Pick<RetailMetricQuery, "from" | "to">> & RetailMetricQuery, keys: GroupKey[]): Plan {
  const spec = SPECS[name];
  const productRollup = name === "gross_margin" || keys.includes("product") || keys.includes("category");
  const perCurrency = spec.unit === "money";
  const groups = [...keys.map(key => GROUP_EXPRESSIONS[key]), ...(perCurrency ? ["d.currency"] : [])];
  const bindings: Value[] = [query.from, query.to];
  let where = "d.business_date BETWEEN ? AND ?";
  if (query.locationIds?.length) {
    where += ` AND d.location_id IN (${query.locationIds.map(() => "?").join(", ")})`;
    bindings.push(...query.locationIds);
  }
  if (query.currency) {
    where += " AND d.currency = ?";
    bindings.push(query.currency);
  }
  const from = productRollup
    ? `daily_product_sales d${keys.includes("category") ? " LEFT JOIN products p ON p.id = d.product_id" : ""}`
    : "daily_sales d";
  const select = [...groups, ...spec.aggregates].join(", ");
  const grouping = groups.length ? ` GROUP BY ${groups.join(", ")} ORDER BY ${groups.join(", ")}` : "";
  return { sql: `SELECT ${select} FROM ${from} WHERE ${where}${grouping}`, bindings, keys, perCurrency };
}

function repeatPlan(query: Required<Pick<RetailMetricQuery, "from" | "to">> & RetailMetricQuery, keys: GroupKey[]): Plan {
  const expressions = keys.map(key => key === "month" ? "substr(o.business_date, 1, 7)" : "o.location_id");
  const bindings: Value[] = [query.from, query.to];
  let where = `o.business_date BETWEEN ? AND ? AND o.customer_id IS NOT NULL AND o.deleted_at IS NULL AND o.status IN ${SALES}`;
  if (query.locationIds?.length) {
    where += ` AND o.location_id IN (${query.locationIds.map(() => "?").join(", ")})`;
    bindings.push(...query.locationIds);
  }
  if (query.currency) {
    where += " AND o.currency = ?";
    bindings.push(query.currency);
  }
  const inner = expressions.map((expression, index) => `${expression} AS k${index}`);
  const outer = keys.map((_, index) => `k${index}`);
  const innerGroup = [...outer, "person"].join(", ");
  const sql =
    `SELECT ${[...outer, "CAST(SUM(n >= 2) AS REAL) / COUNT(*)"].join(", ")} FROM (` +
    `SELECT ${[...inner, "COALESCE(c.canonical_customer_id, o.customer_id) AS person", "COUNT(*) AS n"].join(", ")} ` +
    `FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE ${where} GROUP BY ${innerGroup})` +
    (outer.length ? ` GROUP BY ${outer.join(", ")} ORDER BY ${outer.join(", ")}` : "");
  return { sql, bindings, keys, perCurrency: false };
}

const REFERENCE_QUERY = { from: "?", to: "?" };

/** Every standard metric's published definition, in contract order. */
export const METRIC_DEFINITIONS: readonly RetailMetricDefinition[] = [
  ...(Object.keys(SPECS) as (keyof typeof SPECS)[]).map(name => ({
    name,
    description: SPECS[name].description,
    unit: SPECS[name].unit,
    sql: rollupPlan(name, REFERENCE_QUERY, []).sql,
  })),
  {
    name: "repeat_customer_rate",
    description: REPEAT_DESCRIPTION,
    unit: "ratio",
    sql: repeatPlan(REFERENCE_QUERY, []).sql,
  },
];

const DEFINITIONS_BY_NAME = new Map(METRIC_DEFINITIONS.map(definition => [definition.name, definition]));

/** Validates a metric query against the contract, returning its normalized form. */
export function validateMetricQuery(name: string, query: RetailMetricQuery):
  { definition: RetailMetricDefinition; query: RetailMetricQuery; keys: GroupKey[] } {
  const definition = DEFINITIONS_BY_NAME.get(name as RetailMetricName);
  if (!definition) throw new MetricQueryError(`Unknown metric "${name}".`);
  if (!isIsoDate(query.from) || !isIsoDate(query.to)) {
    throw new MetricQueryError("from and to must be dates written YYYY-MM-DD.");
  }
  if (query.from > query.to) throw new MetricQueryError("from must not be after to.");
  const limit = new Date(`${query.from}T00:00:00Z`);
  limit.setUTCFullYear(limit.getUTCFullYear() + 3);
  if (query.to >= limit.toISOString().slice(0, 10)) {
    throw new MetricQueryError("The range must be under 3 years; split it into several queries.");
  }
  const keys = query.groupBy ?? [];
  if (new Set(keys).size !== keys.length) throw new MetricQueryError("groupBy repeats a key.");
  for (const key of keys) {
    if (!Object.hasOwn(GROUP_EXPRESSIONS, key)) throw new MetricQueryError(`Unknown groupBy "${key}".`);
  }
  if (keys.filter(key => TIME_GRAINS.has(key)).length > 1) {
    throw new MetricQueryError("groupBy may use only one of day, week and month.");
  }
  if ((keys.includes("product") || keys.includes("category")) && !PRODUCT_LEVEL.has(definition.name)) {
    throw new MetricQueryError(`${definition.name} is an order-level metric; it cannot be grouped by product or category.`);
  }
  if (definition.name === "repeat_customer_rate" && keys.some(key => key !== "location" && key !== "month")) {
    throw new MetricQueryError("repeat_customer_rate can be grouped by location and month only.");
  }
  let currency: string | undefined;
  if (query.currency !== undefined) {
    currency = normalizeCurrency(query.currency) ?? undefined;
    if (!currency) throw new MetricQueryError(`"${query.currency}" is not an ISO 4217 currency code.`);
  }
  if (query.locationIds !== undefined) {
    if (query.locationIds.length > MAX_METRIC_LOCATIONS) {
      throw new MetricQueryError(`At most ${MAX_METRIC_LOCATIONS} locationIds per query.`);
    }
    if (!query.locationIds.every(id => Number.isSafeInteger(id))) {
      throw new MetricQueryError("locationIds must be integers.");
    }
  }
  return { definition, query: { ...query, groupBy: keys, currency }, keys };
}

/** Runs a validated metric query against the dataset's views. */
export function runMetric(sql: SqlStorage, name: string, input: RetailMetricQuery): RetailMetricResult {
  const { definition, query, keys } = validateMetricQuery(name, input);
  const plan = definition.name === "repeat_customer_rate"
    ? repeatPlan(query, keys)
    : rollupPlan(definition.name, query, keys);
  const raw = Array.from(sql.exec(plan.sql, ...plan.bindings).raw()) as Value[][];
  const keyCount = keys.length + (plan.perCurrency ? 1 : 0);
  const columns: RetailColumn[] = [
    ...keys.map(key => GROUP_COLUMNS[key]),
    ...(plan.perCurrency ? [{ name: "currency", type: "text" } as RetailColumn] : []),
    valueColumn(definition, plan.perCurrency),
  ];
  let costedUnits = 0;
  let totalUnits = 0;
  const rows = raw.map(row => {
    const head = row.slice(0, keyCount);
    const [first, second, third] = row.slice(keyCount) as (number | null)[];
    switch (definition.name) {
      case "average_order_value":
        return [...head, second ? roundHalfEven(first ?? 0, second) : null];
      case "units_sold":
        return [...head, Math.round((first ?? 0) * 10_000) / 10_000];
      case "gross_margin":
        totalUnits += second ?? 0;
        costedUnits += (second ?? 0) - (third ?? 0);
        return [...head, Math.round(first ?? 0)];
      default:
        return [...head, first ?? (definition.unit === "count" ? 0 : null)];
    }
  });
  const result: RetailMetricResult = { metric: definition, columns, rows };
  if (definition.name === "gross_margin") {
    result.costCoverage = totalUnits > 0 ? Math.round((costedUnits / totalUnits) * 10_000) / 10_000 : 1;
    result.partial = result.costCoverage < 1;
  }
  return result;
}

function valueColumn(definition: RetailMetricDefinition, perCurrency: boolean): RetailColumn {
  switch (definition.unit) {
    case "money":
      return perCurrency
        ? { name: "value", type: "money", currencyColumn: "currency" }
        : { name: "value", type: "integer" };
    case "count":
      return { name: "value", type: "integer" };
    case "quantity":
    case "ratio":
      return { name: "value", type: "real" };
  }
}
