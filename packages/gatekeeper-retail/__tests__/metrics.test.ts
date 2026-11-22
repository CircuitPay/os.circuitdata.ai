// Standard metrics (T031, FR-014/015/017): refunds on their own business date, voids, split tender,
// tax-inclusive prices, a zero-decimal currency, several currencies, and partial cost coverage.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { RetailDataset } from "../src/dataset/dataset-do.js";
import type { RetailAccountProps } from "../src/vendor.js";
import { at, createSource, ingestRun, inspect, line, location, newDataset, order, payment } from "./helpers.js";

let props: RetailAccountProps;
let dataset: DurableObjectStub<RetailDataset>;
let newYork: number;

const MONDAY = "2026-10-05";
const TUESDAY = "2026-10-06";
const NOON = at("2026-10-05T16:00:00Z");

beforeAll(async () => {
  ({ props, dataset } = newDataset());
  const sourceId = await createSource(dataset, props.datasetId);
  await ingestRun(dataset, props.datasetId, sourceId, {
    locations: [
      location(),
      location({ sourceRecordId: "loc-tokyo", name: "Shibuya", timezone: "Asia/Tokyo", currency: "JPY" }),
    ],
    customers: [
      { sourceRecordId: "c-1", email: "ana@example.com" },
      { sourceRecordId: "c-2", email: "ben@example.com" },
      { sourceRecordId: "c-3", email: "ben@example.org" },
    ],
    products: [
      { sourceRecordId: "latte", name: "Latte", category: "Coffee", unitCostAmount: 150 },
      { sourceRecordId: "muffin", name: "Muffin", category: "Bakery" },
      { sourceRecordId: "sandwich", name: "Sandwich", category: "Food" },
      { sourceRecordId: "onigiri", name: "Onigiri", category: "Food" },
    ],
    orders: [
      // A: two lattes (costed) and a muffin (no cost), an order-level discount, tax and a tip.
      order({ sourceRecordId: "A", customerRef: "c-1", discountAmount: 100, taxAmount: 112, tipAmount: 200, totalAmount: 1_612 }),
      // B: voided; excluded from every sales metric.
      order({ sourceRecordId: "B", customerRef: "c-2", status: "voided", totalAmount: 500 }),
      // C: paid with two tenders; one of its lines was voided.
      order({ sourceRecordId: "C", customerRef: "c-1", totalAmount: 600 }),
      // D: tax-inclusive price; its tax is reported but not added to the total.
      order({ sourceRecordId: "D", customerRef: "c-2", pricesIncludeTax: true, taxAmount: 100, totalAmount: 1_100 }),
      // F: zero-decimal currency at another location (12:00 in Tokyo on the 5th).
      order({ sourceRecordId: "F", locationRef: "loc-tokyo", currency: "JPY", closedAt: at("2026-10-05T03:00:00Z"), totalAmount: 300 }),
      // G: a second currency at the same location.
      order({ sourceRecordId: "G", customerRef: "c-3", currency: "EUR", totalAmount: 450 }),
    ],
    lineItems: [
      line({ sourceRecordId: "A1", orderRef: "A", productRef: "latte", quantityE4: 20_000, unitPriceAmount: 500, unitCostAmount: 150 }),
      line({ sourceRecordId: "A2", orderRef: "A", productRef: "muffin", name: "Muffin", unitPriceAmount: 400 }),
      line({ sourceRecordId: "B1", orderRef: "B", productRef: "latte", unitPriceAmount: 500, unitCostAmount: 150 }),
      line({ sourceRecordId: "C1", orderRef: "C", productRef: "latte", unitPriceAmount: 600, unitCostAmount: 150 }),
      line({ sourceRecordId: "C2", orderRef: "C", name: "Cookie", unitPriceAmount: 250, isVoided: true }),
      line({ sourceRecordId: "D1", orderRef: "D", productRef: "sandwich", name: "Sandwich", unitPriceAmount: 1_100, taxAmount: 100 }),
      line({ sourceRecordId: "F1", orderRef: "F", productRef: "onigiri", name: "Onigiri", quantityE4: 20_000, unitPriceAmount: 150 }),
      line({ sourceRecordId: "G1", orderRef: "G", productRef: "latte", unitPriceAmount: 450 }),
    ],
    transactions: [
      payment({ sourceRecordId: "pA", orderRef: "A", amount: 1_612, tipAmount: 200 }),
      payment({ sourceRecordId: "pC1", orderRef: "C", amount: 300, tender: "card" }),
      payment({ sourceRecordId: "pC2", orderRef: "C", amount: 300, tender: "cash" }),
      payment({ sourceRecordId: "pD", orderRef: "D", amount: 1_100 }),
      // A latte from A is refunded the next day: the refund lands on Tuesday, as Square reports it.
      payment({ sourceRecordId: "rA", orderRef: "A", parentRef: "pA", kind: "refund", amount: 500, occurredAt: NOON + 86_400 }),
    ],
    refundItems: [
      { sourceRecordId: "rA1", orderRef: "A", transactionRef: "rA", lineItemRef: "A1", quantityE4: 10_000, salesAmount: 500 },
    ],
  });
  [{ id: newYork }] = await inspect<{ id: number }>(dataset, "SELECT id FROM locations WHERE source_record_id = 'loc-1'");
});

function metric(name: string, query: { from: string; to: string; groupBy?: string[]; currency?: string; locationIds?: number[] }) {
  return runInDurableObject(dataset, instance => instance.metric(props.datasetId, name, query as never));
}

describe("standard metrics", () => {
  it("attributes sales to the order's day and refunds to the refund's day, per currency", async () => {
    const net = await metric("net_sales", { from: MONDAY, to: TUESDAY, groupBy: ["day"] });
    expect(net.columns.map(column => column.name)).toEqual(["day", "currency", "value"]);
    expect(net.columns[2]).toEqual({ name: "value", type: "money", currencyColumn: "currency" });
    expect(net.rows).toEqual([
      [MONDAY, "EUR", 450],
      [MONDAY, "JPY", 300],
      // 1,400 + 600 + 1,100 gross, less A's 100 discount; B and the voided cookie are excluded.
      [MONDAY, "USD", 3_000],
      [TUESDAY, "USD", -500],
    ]);
    expect((await metric("refunds", { from: MONDAY, to: TUESDAY, currency: "usd" })).rows).toEqual([["USD", 500]]);
    expect((await metric("gross_sales", { from: MONDAY, to: MONDAY, currency: "USD" })).rows).toEqual([["USD", 3_100]]);
    expect((await metric("discounts", { from: MONDAY, to: MONDAY, currency: "USD" })).rows).toEqual([["USD", 100]]);
  });

  it("counts non-voided orders once however they were paid", async () => {
    expect((await metric("orders", { from: MONDAY, to: TUESDAY })).rows).toEqual([[5]]);
    expect((await metric("orders", { from: MONDAY, to: MONDAY, groupBy: ["location"] })).rows)
      .toEqual([[newYork, 4], [newYork + 1, 1]]);
    expect((await metric("orders", { from: "2025-01-01", to: "2025-01-02" })).rows).toEqual([[0]]);
  });

  it("reports tax, tips and tax-inclusive orders without adding tax into sales", async () => {
    expect((await metric("tax", { from: MONDAY, to: MONDAY, currency: "USD" })).rows).toEqual([["USD", 212]]);
    expect((await metric("tips", { from: MONDAY, to: MONDAY, currency: "USD" })).rows).toEqual([["USD", 200]]);
    expect((await metric("service_charges", { from: MONDAY, to: MONDAY, currency: "USD" })).rows).toEqual([["USD", 0]]);
  });

  it("averages order value per currency, rounded to the minor unit", async () => {
    expect((await metric("average_order_value", { from: MONDAY, to: MONDAY })).rows).toEqual([
      ["EUR", 450], ["JPY", 300], ["USD", 1_000],
    ]);
  });

  it("counts units sold net of itemized refunds, exactly", async () => {
    // 2 + 1 lattes and a muffin in A and C, a sandwich, 2 onigiri, a EUR latte; one latte refunded.
    expect((await metric("units_sold", { from: MONDAY, to: TUESDAY })).rows).toEqual([[7]]);
    const byCategory = await metric("units_sold", { from: MONDAY, to: TUESDAY, groupBy: ["category"] });
    expect(byCategory.rows).toEqual([["Bakery", 1], ["Coffee", 3], ["Food", 3]]);
  });

  it("reports a partial gross margin over the units with a known cost", async () => {
    const margin = await metric("gross_margin", { from: MONDAY, to: MONDAY, currency: "USD", groupBy: ["product"] });
    const latte = margin.rows.find(row => row[0] !== null && row[2] === 1_150);
    // Lattes: 1,000 + 600 net, less 3 x 150 cost. The muffin and sandwich have no cost.
    expect(latte).toBeDefined();
    expect(margin.partial).toBe(true);
    expect(margin.costCoverage).toBe(0.6);
    const total = await metric("gross_margin", { from: MONDAY, to: MONDAY, currency: "USD" });
    expect(total.rows).toEqual([["USD", 1_150]]);
  });

  it("never adds amounts in different currencies", async () => {
    const gross = await metric("gross_sales", { from: MONDAY, to: MONDAY, groupBy: ["location"] });
    expect(gross.rows).toEqual([[newYork, "EUR", 450], [newYork, "USD", 3_100], [newYork + 1, "JPY", 300]]);
  });

  it("groups by ISO week and month", async () => {
    expect((await metric("orders", { from: MONDAY, to: TUESDAY, groupBy: ["week"] })).rows).toEqual([[MONDAY, 5]]);
    expect((await metric("orders", { from: MONDAY, to: TUESDAY, groupBy: ["month"] })).rows).toEqual([["2026-10", 5]]);
  });

  it("measures repeat customers, merging confirmed matches", async () => {
    // Ana ordered twice (A, C); Ben once (D; B was voided); Ben's other address once (G).
    expect((await metric("repeat_customer_rate", { from: MONDAY, to: MONDAY })).rows).toEqual([[1 / 3]]);
    await runInDurableObject(dataset, (_instance, state) => {
      state.storage.sql.exec(`UPDATE store_customers SET canonical_customer_id =
        (SELECT id FROM store_customers WHERE source_record_id = 'c-2') WHERE source_record_id = 'c-3'`);
    });
    expect((await metric("repeat_customer_rate", { from: MONDAY, to: MONDAY })).rows).toEqual([[1]]);
  });

  it.each([
    ["net_sales", { from: "2023-01-01", to: "2026-01-01" }, /under 3 years/],
    ["net_sales", { from: TUESDAY, to: MONDAY }, /must not be after/],
    ["revenue", { from: MONDAY, to: MONDAY }, /Unknown metric/],
    ["orders", { from: MONDAY, to: MONDAY, groupBy: ["product"] }, /order-level metric/],
    ["tips", { from: MONDAY, to: MONDAY, groupBy: ["category"] }, /order-level metric/],
    ["net_sales", { from: MONDAY, to: MONDAY, groupBy: ["day", "month"] }, /only one of day, week and month/],
    ["net_sales", { from: MONDAY, to: MONDAY, groupBy: ["hour"] }, /Unknown groupBy/],
    ["net_sales", { from: MONDAY, to: MONDAY, currency: "DOLLARS" }, /not an ISO 4217/],
    ["repeat_customer_rate", { from: MONDAY, to: MONDAY, groupBy: ["day"] }, /location and month only/],
  ] as const)("refuses %s %o", async (name, query, message) => {
    await runInDurableObject(dataset, instance => {
      expect(() => instance.metric(props.datasetId, name, query as never)).toThrow(message);
    });
  });

  it("publishes every definition with its SQL through the session, as an observation", async () => {
    const host = env.TEST_HOST.getByName(`metrics-${props.datasetId}`);
    const description = await host.describeData(props);
    expect(description.metrics.map(definition => definition.name)).toEqual([
      "gross_sales", "discounts", "refunds", "net_sales", "tax", "tips", "service_charges", "orders",
      "average_order_value", "units_sold", "gross_margin", "repeat_customer_rate",
    ]);
    expect(description.metrics.find(definition => definition.name === "net_sales")?.sql)
      .toBe("SELECT d.currency, SUM(d.net_amount) FROM daily_sales d WHERE d.business_date BETWEEN ? AND ? GROUP BY d.currency ORDER BY d.currency");
    // Orders all fall on Monday; Tuesday has only the refund.
    expect(description.dateRange).toEqual({ from: MONDAY, to: MONDAY });
    expect(description.personalDataMasked).toBe(true);

    const result = await host.metric(props, "net_sales", { from: MONDAY, to: TUESDAY, groupBy: ["day"] });
    expect(result.rows).toHaveLength(4);
    const observations = await host.observations();
    expect(observations.map(observation => observation.title)).toEqual([
      "Described retail dataset",
      `Computed net_sales for ${MONDAY} to ${TUESDAY}`,
    ]);
  });
});
