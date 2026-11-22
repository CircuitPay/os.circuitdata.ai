// SC-006a load test (T028, research R3, gate G2). On demand only:
//
//   RETAIL_LOAD_SCALE=0.01 pnpm --filter @gadgets/gatekeeper-retail test:load
//
// Generates 10 locations x 3 years of synthetic sales through the real ingest path (rollups
// included), then reports the database size, ingest throughput, standard-metric times and a
// guarded run() per fact table. Scale 1 is the full target (about 3M orders, 15M line items and
// 4.5M transactions); smaller scales keep the date span and locations and thin the orders per day,
// and the size is extrapolated linearly. The SC-006a gates are asserted only at scale 1.

import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { IngestBatch, LineItemRecord, OrderRecord, TransactionRecord } from "../../src/dataset/ingest.js";
import { createSource, newDataset } from "../helpers.js";

const LOCATIONS = 10;
const FIRST_DAY = Date.UTC(2024, 0, 1) / 1000;
const DAYS = 1_096;
// A busy location-year: 100k orders, 5 lines and 1.5 transactions per order (research R3).
const FULL_ORDERS_PER_DAY = 274;
const LINES_PER_ORDER = 5;
const PRODUCTS = 200;
const CUSTOMERS = 5_000;
const ORDERS_PER_BATCH = 500;
const SIZE_GATE_BYTES = 7_500_000_000;

it("measures size and query times at 10 locations x 3 years", async () => {
  const scale = Number(env.RETAIL_LOAD_SCALE ?? "0.01");
  const ordersPerDay = Math.max(1, Math.round(FULL_ORDERS_PER_DAY * scale));
  const { props, dataset } = newDataset();
  const { datasetId } = props;
  const sourceId = await createSource(dataset, datasetId, "Synthetic POS", "square");
  const runId = await dataset.startRun(datasetId, { sourceId, kind: "backfill", mappingVersion: "load-v1", startedBy: null });

  await dataset.ingestBatch(datasetId, runId, {
    locations: Array.from({ length: LOCATIONS }, (_, index) => ({
      sourceRecordId: `loc-${index}`, name: `Store ${index}`, kind: index % 3 === 0 ? "restaurant" as const : "store" as const,
      timezone: index % 2 ? "America/New_York" : "America/Los_Angeles", currency: "USD",
    })),
    products: Array.from({ length: PRODUCTS }, (_, index) => ({
      sourceRecordId: `p-${index}`, name: `Product ${index}`, category: `Category ${index % 12}`,
      sku: `SKU-${index}`, priceAmount: 300 + (index % 40) * 25, currency: "USD",
      unitCostAmount: index % 5 === 0 ? null : 100 + (index % 40) * 8,
    })),
  });
  // Customers in a few batches: their keyed hashes are computed per record.
  const customers = Math.max(200, Math.round(CUSTOMERS * scale));
  for (let start = 0; start < customers; start += 1_000) {
    await dataset.ingestBatch(datasetId, runId, {
      customers: Array.from({ length: Math.min(1_000, customers - start) }, (_, offset) => ({
        sourceRecordId: `c-${start + offset}`, email: `customer${start + offset}@example.com`,
      })),
    });
  }

  let rows = 0;
  let ingestMs = 0;
  let orderCount = 0;
  const daysPerBatch = Math.max(1, Math.floor(ORDERS_PER_BATCH / ordersPerDay));
  for (let locationIndex = 0; locationIndex < LOCATIONS; locationIndex++) {
    for (let day = 0; day < DAYS; day += daysPerBatch) {
      const batch = salesBatch(locationIndex, day, Math.min(daysPerBatch, DAYS - day), ordersPerDay, customers, orderCount);
      orderCount += batch.orders!.length;
      rows += batch.orders!.length + batch.lineItems!.length + batch.transactions!.length;
      const started = Date.now();
      await dataset.ingestBatch(datasetId, runId, batch);
      ingestMs += Date.now() - started;
    }
  }
  await dataset.finishRun(datasetId, runId, "succeeded");

  const storage = await dataset.storageStatus(datasetId);
  const timed = async <T>(work: () => Promise<T>) => {
    const started = Date.now();
    const result = await work();
    return { ms: Date.now() - started, result };
  };
  const host = env.TEST_HOST.getByName(`load-${datasetId}`);
  const oneLocationYear = await timed(() => host.metric(props, "net_sales", {
    from: "2025-01-01", to: "2025-12-31", groupBy: ["day"], locationIds: [1],
  }));
  const allLocationsThreeYears = await timed(() => host.metric(props, "net_sales", {
    from: "2024-01-01", to: "2026-12-30", groupBy: ["month", "location"],
  }));
  const units = await timed(() => host.metric(props, "units_sold", {
    from: "2024-01-01", to: "2026-12-30", groupBy: ["category"],
  }));
  const margin = await timed(() => host.metric(props, "gross_margin", { from: "2024-01-01", to: "2026-12-30" }));
  const repeat = await timed(() => host.metric(props, "repeat_customer_rate", {
    from: "2025-01-01", to: "2025-12-31", groupBy: ["month"],
  }));
  const runs: Record<string, number> = {};
  for (const [table, sql] of Object.entries({
    orders: "SELECT location_id, COUNT(*) AS orders, SUM(total_amount) AS total_amount, currency FROM orders WHERE business_date BETWEEN ? AND ? GROUP BY location_id, currency",
    line_items: "SELECT product_id, SUM(quantity) AS units FROM line_items WHERE business_date BETWEEN ? AND ? GROUP BY product_id ORDER BY units DESC LIMIT 20",
    transactions: "SELECT tender, COUNT(*) AS payments FROM transactions WHERE business_date BETWEEN ? AND ? GROUP BY tender",
    daily_sales: "SELECT substr(business_date, 1, 7) AS month, SUM(net_amount) AS net_amount, currency FROM daily_sales GROUP BY month, currency",
  })) {
    runs[table] = (await timed(() => host.run(props, sql, table === "daily_sales" ? [] : ["2025-06-01", "2025-06-30"]))).ms;
  }

  const report = {
    scale,
    orders: orderCount,
    canonicalRows: rows,
    databaseBytes: storage.usedBytes,
    projectedFullScaleBytes: Math.round(storage.usedBytes / scale),
    projectedShareOfCap: Number((storage.usedBytes / scale / storage.capBytes).toFixed(3)),
    ingestRowsPerSecond: Math.round(rows / (ingestMs / 1000)),
    metricMs: {
      netSalesOneLocationOneYear: oneLocationYear.ms,
      netSalesTenLocationsThreeYears: allLocationsThreeYears.ms,
      unitsByCategoryThreeYears: units.ms,
      grossMarginThreeYears: margin.ms,
      repeatCustomerRateOneYear: repeat.ms,
    },
    guardedRunMs: runs,
  };
  console.log(`SC-006a load report ${JSON.stringify(report, null, 2)}`);

  expect(oneLocationYear.result.rows.length).toBeGreaterThan(300);
  if (scale >= 1) {
    expect(storage.usedBytes).toBeLessThanOrEqual(SIZE_GATE_BYTES);
    expect(oneLocationYear.ms).toBeLessThan(2_000);
    expect(allLocationsThreeYears.ms).toBeLessThan(5_000);
  }
});

/** Orders, lines and payments of `days` days at one location. Deterministic, so reruns are idempotent. */
function salesBatch(
  locationIndex: number, firstDay: number, days: number, ordersPerDay: number, customers: number, offset: number,
): IngestBatch {
  const orders: OrderRecord[] = [];
  const lineItems: LineItemRecord[] = [];
  const transactions: TransactionRecord[] = [];
  let sequence = offset;
  for (let day = firstDay; day < firstDay + days; day++) {
    for (let index = 0; index < ordersPerDay; index++) {
      const id = `${locationIndex}-${day}-${index}`;
      const closedAt = FIRST_DAY + day * 86_400 + 15 * 3_600 + Math.floor((index / ordersPerDay) * 10 * 3_600);
      let gross = 0;
      for (let lineIndex = 0; lineIndex < LINES_PER_ORDER; lineIndex++) {
        const product = (sequence * 7 + lineIndex * 13) % PRODUCTS;
        const price = 300 + (product % 40) * 25;
        gross += price;
        lineItems.push({
          sourceRecordId: `${id}-${lineIndex}`, orderRef: id, productRef: `p-${product}`, name: `Product ${product}`,
          quantityE4: 10_000, unitPriceAmount: price,
          unitCostAmount: product % 5 === 0 ? null : 100 + (product % 40) * 8,
        });
      }
      const tax = Math.round(gross * 0.08);
      const voided = sequence % 50 === 0;
      orders.push({
        sourceRecordId: id, locationRef: `loc-${locationIndex}`, status: voided ? "voided" : "completed",
        channel: sequence % 4 === 0 ? "online" : "in_store", currency: "USD", openedAt: closedAt - 300, closedAt,
        customerRef: sequence % 3 === 0 ? `c-${sequence % customers}` : null,
        taxAmount: tax, tipAmount: 0, totalAmount: gross + tax, orderNumber: String(sequence),
      });
      transactions.push({
        sourceRecordId: `${id}-p`, orderRef: id, kind: "payment", tender: sequence % 2 ? "card" : "cash",
        amount: gross + tax, currency: "USD", occurredAt: closedAt,
      });
      // Every other order is split across two tenders, for 1.5 transactions per order.
      if (sequence % 2 === 0) {
        transactions.push({
          sourceRecordId: `${id}-q`, orderRef: id, kind: "payment", tender: "gift_card", amount: 0,
          currency: "USD", occurredAt: closedAt,
        });
      }
      sequence++;
    }
  }
  return { orders, lineItems, transactions };
}
