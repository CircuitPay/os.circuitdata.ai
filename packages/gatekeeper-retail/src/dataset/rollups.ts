// Rollup recompute (research R17). Ingest queues every (location, business date) a batch touched in
// `dirty_days`, and every customer whose orders or refunds changed in `dirty_customers`. Each queued
// day of `daily_sales`, `daily_product_sales` and `daily_source_coverage` is then recomputed in full
// from the fact tables, which is cheap (a location-day is a few hundred orders) and cannot drift the
// way incremental deltas can. Location 0 holds transactions that name no location.

const SALES = "('completed', 'refunded', 'partially_refunded')";

// Line cost of the units with a known cost, rounded to the minor unit.
const LINE_COST = "CAST(ROUND(l.unit_cost_amount * l.quantity_e4 / 10000.0) AS INTEGER)";

const DAILY_SALES = `
INSERT INTO store_daily_sales (business_date, location_id, channel, currency, orders, voided_orders,
  gross_amount, discount_amount, refund_amount, tax_amount, tip_amount, service_charge_amount,
  units_e4, refunded_units_e4, cost_amount, lines_missing_cost)
SELECT ?1, ?2, channel, currency, SUM(orders), SUM(voided), SUM(gross), SUM(discount), SUM(refund),
  SUM(tax), SUM(tip), SUM(service), SUM(units), SUM(refunded_units), SUM(cost), SUM(missing_cost)
FROM (
  SELECT channel, currency,
    status IN ${SALES} AS orders, status = 'voided' AS voided,
    CASE WHEN status IN ${SALES} THEN gross_amount ELSE 0 END AS gross,
    CASE WHEN status IN ${SALES} THEN discount_amount ELSE 0 END AS discount,
    0 AS refund,
    CASE WHEN status IN ${SALES} THEN tax_amount ELSE 0 END AS tax,
    CASE WHEN status IN ${SALES} THEN tip_amount ELSE 0 END AS tip,
    CASE WHEN status IN ${SALES} THEN service_charge_amount ELSE 0 END AS service,
    0 AS units, 0 AS refunded_units, 0 AS cost, 0 AS missing_cost
  FROM store_orders
  WHERE business_date = ?1 AND location_id = ?2 AND deleted_at IS NULL
  UNION ALL
  SELECT o.channel, l.currency, 0, 0, 0, 0, 0, 0, 0, 0, l.quantity_e4, 0,
    CASE WHEN l.unit_cost_amount IS NULL THEN 0 ELSE ${LINE_COST} END,
    l.unit_cost_amount IS NULL
  FROM store_line_items l JOIN store_orders o ON o.id = l.order_id
  WHERE l.business_date = ?1 AND l.location_id = ?2 AND l.is_voided = 0 AND l.deleted_at IS NULL
    AND o.deleted_at IS NULL AND o.status IN ${SALES}
  UNION ALL
  SELECT COALESCE(o.channel, 'other'), t.currency, 0, 0, 0, 0, t.sales_amount, 0, 0, 0, 0, 0, 0, 0
  FROM store_transactions t LEFT JOIN store_orders o ON o.id = t.order_id
  WHERE t.business_date = ?1 AND COALESCE(t.location_id, 0) = ?2 AND t.kind = 'refund'
    AND t.status = 'succeeded' AND t.deleted_at IS NULL
  UNION ALL
  SELECT COALESCE(o.channel, 'other'), r.currency, 0, 0, 0, 0, 0, 0, 0, 0, 0, r.quantity_e4, 0, 0
  FROM store_refund_items r LEFT JOIN store_orders o ON o.id = r.order_id
  WHERE r.business_date = ?1 AND r.location_id = ?2 AND r.deleted_at IS NULL
)
GROUP BY channel, currency`;

const DAILY_PRODUCT_SALES = `
INSERT INTO store_daily_product_sales (business_date, location_id, product_id, channel, currency,
  units_e4, refunded_units_e4, gross_amount, discount_amount, refund_amount, cost_amount,
  units_missing_cost_e4)
SELECT ?1, ?2, product_id, channel, currency, SUM(units), SUM(refunded_units), SUM(gross),
  SUM(discount), SUM(refund), SUM(cost), SUM(missing_cost)
FROM (
  SELECT COALESCE(l.product_id, 0) AS product_id, o.channel AS channel, l.currency AS currency,
    l.quantity_e4 AS units, 0 AS refunded_units, l.gross_amount AS gross,
    l.discount_amount AS discount, 0 AS refund,
    CASE WHEN l.unit_cost_amount IS NULL THEN 0 ELSE ${LINE_COST} END AS cost,
    CASE WHEN l.unit_cost_amount IS NULL THEN l.quantity_e4 ELSE 0 END AS missing_cost
  FROM store_line_items l JOIN store_orders o ON o.id = l.order_id
  WHERE l.business_date = ?1 AND l.location_id = ?2 AND l.is_voided = 0 AND l.deleted_at IS NULL
    AND o.deleted_at IS NULL AND o.status IN ${SALES}
  UNION ALL
  SELECT COALESCE(r.product_id, 0), COALESCE(o.channel, 'other'), r.currency, 0, r.quantity_e4, 0, 0,
    r.sales_amount, 0, 0
  FROM store_refund_items r LEFT JOIN store_orders o ON o.id = r.order_id
  WHERE r.business_date = ?1 AND r.location_id = ?2 AND r.deleted_at IS NULL
)
GROUP BY product_id, channel, currency`;

const DAILY_SOURCE_COVERAGE = `
INSERT INTO store_daily_source_coverage (source_id, business_date, location_id, orders, transactions)
SELECT source_id, ?1, ?2, SUM(orders), SUM(transactions) FROM (
  SELECT source_id, 1 AS orders, 0 AS transactions FROM store_orders
  WHERE business_date = ?1 AND location_id = ?2 AND deleted_at IS NULL
  UNION ALL
  SELECT source_id, 0, 1 FROM store_transactions
  WHERE business_date = ?1 AND COALESCE(location_id, 0) = ?2 AND deleted_at IS NULL
)
GROUP BY source_id`;

const CUSTOMER_SUMMARY = `
INSERT INTO store_customer_summary (customer_id, currency, first_order_date, last_order_date, orders,
  lifetime_net_amount)
SELECT o.customer_id, o.currency, MIN(o.business_date), MAX(o.business_date), COUNT(*),
  SUM(o.gross_amount - o.discount_amount) - COALESCE(SUM((
    SELECT SUM(t.sales_amount) FROM store_transactions t
    WHERE t.order_id = o.id AND t.kind = 'refund' AND t.status = 'succeeded' AND t.deleted_at IS NULL
  )), 0)
FROM store_orders o
WHERE o.customer_id = ?1 AND o.deleted_at IS NULL AND o.status IN ${SALES}
GROUP BY o.customer_id, o.currency`;

/** What one recompute pass did. */
export type RollupResult = { days: number; customers: number; sources: number };

/**
 * Recomputes every queued day and customer, then each affected source's coverage range, and clears
 * the queues. Runs inside the caller's `transactionSync`, so readers never see a half-updated day.
 */
export function recomputeRollups(sql: SqlStorage): RollupResult {
  const days = sql.exec<{ location_id: number; business_date: string }>(
    "SELECT location_id, business_date FROM dirty_days").toArray();
  const sources = new Set<number>();
  for (const { location_id: locationId, business_date: businessDate } of days) {
    for (const { source_id } of sql.exec<{ source_id: number }>(
      "SELECT source_id FROM store_daily_source_coverage WHERE business_date = ? AND location_id = ?",
      businessDate, locationId)) {
      sources.add(source_id);
    }
    sql.exec("DELETE FROM store_daily_sales WHERE business_date = ? AND location_id = ?", businessDate, locationId);
    sql.exec("DELETE FROM store_daily_product_sales WHERE business_date = ? AND location_id = ?",
      businessDate, locationId);
    sql.exec("DELETE FROM store_daily_source_coverage WHERE business_date = ? AND location_id = ?",
      businessDate, locationId);
    sql.exec(DAILY_SALES, businessDate, locationId);
    sql.exec(DAILY_PRODUCT_SALES, businessDate, locationId);
    for (const { source_id } of sql.exec<{ source_id: number }>(
      `${DAILY_SOURCE_COVERAGE} RETURNING source_id`, businessDate, locationId)) {
      sources.add(source_id);
    }
  }
  sql.exec("DELETE FROM dirty_days");

  const customers = sql.exec<{ customer_id: number }>("SELECT customer_id FROM dirty_customers").toArray();
  for (const { customer_id: customerId } of customers) {
    sql.exec("DELETE FROM store_customer_summary WHERE customer_id = ?", customerId);
    sql.exec(CUSTOMER_SUMMARY, customerId);
  }
  sql.exec("DELETE FROM dirty_customers");

  for (const sourceId of sources) {
    sql.exec(`
      UPDATE store_sources SET
        coverage_from = (SELECT MIN(business_date) FROM store_daily_source_coverage
          WHERE source_id = ?1 AND orders > 0),
        coverage_to = (SELECT MAX(business_date) FROM store_daily_source_coverage
          WHERE source_id = ?1 AND orders > 0)
      WHERE id = ?1`, sourceId);
  }
  return { days: days.length, customers: customers.length, sources: sources.size };
}
