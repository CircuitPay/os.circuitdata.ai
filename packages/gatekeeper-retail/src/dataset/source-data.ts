// Deleting one source's data (US1.5: "disconnect and delete data"). Rows go in bounded batches, so
// a source of millions of rows never holds the dataset's single writer for long: each batch queues
// the location-days and customers it touched, and the caller recomputes the rollups in the same
// transaction. Nothing of any other source is read or written.

/** Canonical storage tables, children first, so a parent outlives the rows that name it. */
const SOURCE_TABLES = [
  "store_refund_items", "store_line_items", "store_transactions", "store_inventory_movements",
  "store_inventory", "store_orders", "store_customers", "store_products", "store_locations",
] as const;

/** Tables whose rows carry a business date and so queue rollup days. */
const DATED_TABLES: Readonly<Record<string, true>> = {
  store_refund_items: true, store_line_items: true, store_transactions: true, store_orders: true,
};

/**
 * Deletes up to `limit` rows of `sourceId` (from the first table that still has some), queueing
 * the rollup days and customers they touched. Returns how many rows went; 0 once the source has no
 * rows left. Runs inside the caller's transaction, followed by `recomputeRollups`.
 */
export function deleteSourceRowsBatch(sql: SqlStorage, sourceId: number, limit: number): number {
  for (const table of SOURCE_TABLES) {
    const ids = sql.exec<{ id: number }>(`SELECT id FROM ${table} WHERE source_id = ? LIMIT ?`, sourceId, limit)
      .toArray().map(row => row.id);
    if (ids.length === 0) continue;
    const list = `(${ids.join(",")})`;
    if (DATED_TABLES[table]) {
      sql.exec(`INSERT OR IGNORE INTO dirty_days (location_id, business_date)
        SELECT DISTINCT COALESCE(location_id, 0), business_date FROM ${table} WHERE id IN ${list}`);
    }
    if (table === "store_orders") {
      sql.exec(`INSERT OR IGNORE INTO dirty_customers (customer_id)
        SELECT DISTINCT customer_id FROM store_orders WHERE id IN ${list} AND customer_id IS NOT NULL`);
    }
    if (table === "store_customers") {
      sql.exec(`DELETE FROM store_customer_summary WHERE customer_id IN ${list}`);
      sql.exec(`DELETE FROM dirty_customers WHERE customer_id IN ${list}`);
      sql.exec(`UPDATE store_customers SET canonical_customer_id = NULL WHERE canonical_customer_id IN ${list}`);
    }
    if (table === "store_products") {
      sql.exec(`UPDATE store_products SET canonical_product_id = NULL WHERE canonical_product_id IN ${list}`);
    }
    sql.exec(`DELETE FROM ${table} WHERE id IN ${list}`);
    return ids.length;
  }
  return 0;
}

/**
 * Drops the bookkeeping that pointed at the source's rows once they are gone: pre-images of its
 * runs, and its coverage. Its runs stay, as the history of what was imported and deleted.
 */
export function forgetSourceRows(sql: SqlStorage, sourceId: number): void {
  sql.exec("DELETE FROM row_versions WHERE run_id IN (SELECT id FROM runs WHERE source_id = ?)", sourceId);
  sql.exec("DELETE FROM store_daily_source_coverage WHERE source_id = ?", sourceId);
  sql.exec("UPDATE store_sources SET coverage_from = NULL, coverage_to = NULL WHERE id = ?", sourceId);
}
