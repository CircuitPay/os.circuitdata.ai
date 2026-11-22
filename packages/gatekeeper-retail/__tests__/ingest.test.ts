// Ingest (T029): idempotent upserts by source key, lineage, pre-images, business dates across the
// day cutoff and DST, quantity scale, money parsing, rejections and personal-data masking.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  businessDayOf, parseMoney, parseQuantity, roundHalfEven, zonedTimeToEpoch,
} from "../src/dataset/ingest.js";
import { recreateCustomersView } from "../src/dataset/masking.js";
import {
  at, createSource, ingestRun, inspect, line, location, newDataset, order, payment,
} from "./helpers.js";

const BATCH = {
  locations: [location()],
  orders: [order({ sourceRecordId: "o-1", totalAmount: 1_080, taxAmount: 80 })],
  lineItems: [
    line({ sourceRecordId: "l-1", orderRef: "o-1", quantityE4: 20_000, unitPriceAmount: 250 }),
    line({ sourceRecordId: "l-2", orderRef: "o-1", name: "Croissant", unitPriceAmount: 500 }),
  ],
  transactions: [payment({ sourceRecordId: "p-1", orderRef: "o-1", amount: 1_080 })],
};

describe("ingest", () => {
  it("is idempotent: re-ingesting the same records changes no row", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    const first = await ingestRun(dataset, props.datasetId, sourceId, BATCH);
    const before = await inspect(dataset, "SELECT * FROM store_orders");
    const rollupsBefore = await inspect(dataset, "SELECT * FROM store_daily_sales");

    const second = await ingestRun(dataset, props.datasetId, sourceId, BATCH, "sync");

    expect(first.result.counts.orders).toMatchObject({ fetched: 1, written: 1, skipped: 0 });
    expect(second.result.counts).toMatchObject({
      orders: { fetched: 1, written: 0, updated: 0, skipped: 1 },
      line_items: { fetched: 2, written: 0, updated: 0, skipped: 2 },
      transactions: { fetched: 1, written: 0, updated: 0, skipped: 1 },
    });
    expect(await inspect(dataset, "SELECT * FROM store_orders")).toEqual(before);
    expect(await inspect(dataset, "SELECT * FROM store_daily_sales")).toEqual(rollupsBefore);
  });

  it("updates a changed record in place and records the run that changed it", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    const first = await ingestRun(dataset, props.datasetId, sourceId, BATCH, "import", "v1");
    const [original] = await inspect<{ id: number; ingested_at: string }>(
      dataset, "SELECT id, ingested_at FROM orders");

    const second = await ingestRun(dataset, props.datasetId, sourceId, {
      orders: [order({ sourceRecordId: "o-1", totalAmount: 1_130, taxAmount: 80, tipAmount: 50 })],
    }, "import", "v2");

    expect(second.result.counts.orders).toMatchObject({ updated: 1, written: 0 });
    const rows = await inspect(dataset,
      "SELECT id, source_id, source_record_id, run_id, mapping_version, ingested_at, tip_amount FROM orders");
    expect(rows).toEqual([{
      id: original!.id, source_id: sourceId, source_record_id: "o-1", run_id: second.runId,
      mapping_version: "v2", ingested_at: original!.ingested_at, tip_amount: 50,
    }]);
    expect(first.runId).not.toBe(second.runId);
  });

  it("keeps pre-images for import runs only", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    const first = await ingestRun(dataset, props.datasetId, sourceId, BATCH, "import");
    const second = await ingestRun(dataset, props.datasetId, sourceId, {
      orders: [order({ sourceRecordId: "o-1", totalAmount: 999 })],
    }, "import");
    const sync = await ingestRun(dataset, props.datasetId, sourceId, {
      orders: [order({ sourceRecordId: "o-1", totalAmount: 998 })],
    }, "sync");

    const versions = await inspect<{ run_id: number; table_name: string; before: string | null }>(
      dataset, "SELECT run_id, table_name, before FROM row_versions ORDER BY run_id, seq");
    expect(versions.filter(version => version.run_id === first.runId).every(version => version.before === null))
      .toBe(true);
    const update = versions.find(version => version.run_id === second.runId);
    expect(update?.table_name).toBe("orders");
    expect(JSON.parse(update!.before!)).toMatchObject({ source_record_id: "o-1", total_amount: 1_080 });
    expect(versions.some(version => version.run_id === sync.runId)).toBe(false);
  });

  it("derives order gross and discount from non-voided lines", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    await ingestRun(dataset, props.datasetId, sourceId, {
      locations: [location()],
      orders: [order({ sourceRecordId: "o-1", discountAmount: 100, totalAmount: 900 })],
      lineItems: [
        line({ sourceRecordId: "l-1", orderRef: "o-1", unitPriceAmount: 1_000 }),
        line({ sourceRecordId: "l-2", orderRef: "o-1", unitPriceAmount: 700, discountAmount: 70, isVoided: true }),
      ],
    });
    const [row] = await inspect(dataset, "SELECT gross_amount, discount_amount FROM orders");
    expect(row).toEqual({ gross_amount: 1_000, discount_amount: 100 });
  });

  it("assigns business dates after the location's day cutoff, in its zone", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    await ingestRun(dataset, props.datasetId, sourceId, {
      locations: [location({ kind: "restaurant", timezone: "America/Los_Angeles" })],
      orders: [
        // 01:30 local on 6 October, before the 04:00 restaurant cutoff: still 5 October's trade.
        order({ sourceRecordId: "late", closedAt: at("2026-10-06T08:30:00Z"), totalAmount: 0 }),
        order({ sourceRecordId: "morning", closedAt: at("2026-10-06T15:00:00Z"), totalAmount: 0 }),
        // The export set's date overrides the derived one (Toast).
        order({ sourceRecordId: "toast", closedAt: at("2026-10-06T15:00:00Z"), businessDate: "2026-10-04", totalAmount: 0 }),
      ],
      transactions: [payment({ sourceRecordId: "t-late", orderRef: "late", occurredAt: at("2026-10-06T08:31:00Z") })],
    });
    const rows = await inspect(dataset,
      "SELECT source_record_id, business_date, local_hour FROM orders ORDER BY source_record_id");
    expect(rows).toEqual([
      { source_record_id: "late", business_date: "2026-10-05", local_hour: 1 },
      { source_record_id: "morning", business_date: "2026-10-06", local_hour: 8 },
      { source_record_id: "toast", business_date: "2026-10-04", local_hour: 8 },
    ]);
    expect(await inspect(dataset, "SELECT business_date FROM transactions"))
      .toEqual([{ business_date: "2026-10-05" }]);
  });

  it("follows the wall clock across DST transitions", () => {
    const cutoff = 4 * 60;
    // New York springs forward at 02:00 on 8 March 2026: 07:30Z is 03:30 EDT, 08:30Z is 04:30 EDT.
    expect(businessDayOf(at("2026-03-08T07:30:00Z"), "America/New_York", cutoff))
      .toEqual({ businessDate: "2026-03-07", localHour: 3 });
    expect(businessDayOf(at("2026-03-08T08:30:00Z"), "America/New_York", cutoff))
      .toEqual({ businessDate: "2026-03-08", localHour: 4 });
    // ...and falls back at 02:00 on 1 November: 05:30Z and 06:30Z are both 01:30 local.
    expect(businessDayOf(at("2026-11-01T05:30:00Z"), "America/New_York", cutoff).businessDate).toBe("2026-10-31");
    expect(businessDayOf(at("2026-11-01T06:30:00Z"), "America/New_York", cutoff).businessDate).toBe("2026-10-31");
    expect(businessDayOf(at("2026-11-01T09:30:00Z"), "America/New_York", cutoff))
      .toEqual({ businessDate: "2026-11-01", localHour: 4 });

    const local = { year: 2026, month: 3, day: 8, hour: 12, minute: 0, second: 0 };
    expect(zonedTimeToEpoch(local, "America/New_York")).toBe(at("2026-03-08T16:00:00Z"));
    expect(zonedTimeToEpoch({ ...local, month: 1 }, "America/New_York")).toBe(at("2026-01-08T17:00:00Z"));
    expect(zonedTimeToEpoch({ ...local, hour: 2, minute: 30 }, "America/New_York"))
      .toBe(at("2026-03-08T07:30:00Z"));
  });

  it("stores quantities exactly at 4 decimals, rounding half-even beyond", async () => {
    expect(parseQuantity("1.23456")).toEqual({ e4: 12_346, rounded: true });
    expect(parseQuantity("0.00005")).toEqual({ e4: 0, rounded: true });
    expect(parseQuantity("0.00015")).toEqual({ e4: 2, rounded: true });
    expect(parseQuantity("2,5", ",")).toEqual({ e4: 25_000, rounded: false });
    expect(parseQuantity(0.1 + 0.2)).toEqual({ e4: 3_000, rounded: false });
    expect(parseQuantity("-1.5")).toEqual({ e4: -15_000, rounded: false });
    expect(parseQuantity("one")).toBeNull();
    expect(roundHalfEven(25, 10)).toBe(2);
    expect(roundHalfEven(35, 10)).toBe(4);
    expect(roundHalfEven(-15, 10)).toBe(-2);

    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    await ingestRun(dataset, props.datasetId, sourceId, {
      locations: [location()],
      orders: [order({ sourceRecordId: "o-1", totalAmount: 0 })],
      // 0.3333 kg at 1,200 a kg, three times: sums stay exact.
      lineItems: ["a", "b", "c"].map(id =>
        line({ sourceRecordId: id, orderRef: "o-1", quantityE4: 3_333, unitPriceAmount: 1_200 })),
    });
    expect(await inspect(dataset, "SELECT quantity, gross_amount FROM line_items LIMIT 1"))
      .toEqual([{ quantity: 0.3333, gross_amount: 400 }]);
    expect(await inspect(dataset, "SELECT units FROM daily_sales")).toEqual([{ units: 0.9999 }]);
  });

  it("parses money into integer minor units without silent rounding", () => {
    const usd = { currency: "USD", decimalMark: "." } as const;
    expect(parseMoney("$1,234.56", usd)).toBe(123_456);
    expect(parseMoney("12.3", usd)).toBe(1_230);
    expect(parseMoney("(12.50)", usd)).toBe(-1_250);
    expect(parseMoney("-$4.00", usd)).toBe(-400);
    expect(parseMoney("4.00-", usd)).toBe(-400);
    expect(parseMoney("USD 7.10", usd)).toBe(710);
    expect(parseMoney("12.345", usd)).toBeNull();
    expect(parseMoney("12.340", usd)).toBe(1_234);
    expect(parseMoney("1.2.3", usd)).toBeNull();
    expect(parseMoney("", usd)).toBeNull();
    expect(parseMoney("1.234,56 €", { currency: "EUR", decimalMark: "," })).toBe(123_456);
    expect(parseMoney("¥1,200", { currency: "JPY", decimalMark: "." })).toBe(1_200);
    expect(parseMoney("1.234", { currency: "KWD", decimalMark: "." })).toBe(1_234);
  });

  it("rejects invalid rows with a reason code and keeps the rest", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    const { runId, result } = await ingestRun(dataset, props.datasetId, sourceId, {
      locations: [location()],
      orders: [
        order({ sourceRecordId: "ok", totalAmount: 500 }),
        order({ sourceRecordId: "bad-currency", currency: "XYZ", totalAmount: 500 }),
        order({ sourceRecordId: "no-date", closedAt: null, totalAmount: 500 }),
        order({ sourceRecordId: "bad-amount", totalAmount: 5.5 }),
      ],
      lineItems: [line({ sourceRecordId: "orphan", orderRef: "missing", rowIndex: 7 })],
    });

    expect(result.counts.orders).toMatchObject({ fetched: 4, written: 1, rejected: 3 });
    expect(result.counts.line_items).toMatchObject({ fetched: 1, rejected: 1 });
    const rejections = await inspect(dataset,
      "SELECT table_name, row_index, reason_code, column_name FROM run_rejections WHERE run_id = ? ORDER BY rowid",
      runId);
    expect(rejections).toEqual([
      { table_name: "orders", row_index: null, reason_code: "unknown_currency", column_name: "currency" },
      { table_name: "orders", row_index: null, reason_code: "missing_required", column_name: "business_date" },
      { table_name: "orders", row_index: null, reason_code: "bad_amount", column_name: "total_amount" },
      { table_name: "line_items", row_index: 7, reason_code: "orphan_line", column_name: "order_id" },
    ]);
    expect(JSON.parse((await inspect<{ counts: string }>(dataset, "SELECT counts FROM runs WHERE id = ?", runId))[0]!.counts))
      .toMatchObject({ orders: { rejected: 3 }, line_items: { rejected: 1 } });
  });

  it("masks personal data in the customers view and hashes it for joins", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    await ingestRun(dataset, props.datasetId, sourceId, {
      customers: [
        { sourceRecordId: "c-1", firstName: "jane", lastName: "Smith", email: "Jane@Example.com", phone: "+1 (415) 555-1234" },
        { sourceRecordId: "c-2", email: " jane@example.com" },
      ],
    });
    const masked = await inspect(dataset,
      "SELECT first_name, last_name, email, phone FROM customers WHERE source_record_id = 'c-1'");
    expect(masked).toEqual([{ first_name: "J.", last_name: "S.", email: "j***@example.com", phone: "***-***-1234" }]);
    const hashes = await inspect<{ email_hash: string }>(dataset, "SELECT email_hash FROM customers ORDER BY id");
    expect(hashes[0]!.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]!.email_hash).toBe(hashes[1]!.email_hash);

    await runInDurableObject(dataset, (_instance, state) => recreateCustomersView(state.storage.sql, true));
    expect(await inspect(dataset, "SELECT first_name, email FROM customers WHERE source_record_id = 'c-1'"))
      .toEqual([{ first_name: "jane", email: "Jane@Example.com" }]);
  });

  it("refuses a run that is not running and a dataset id the object does not hold", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId);
    const { runId } = await ingestRun(dataset, props.datasetId, sourceId, BATCH);
    // Inside the object: the pool reports a refused RPC from a test as an unhandled rejection.
    await runInDurableObject(dataset, async instance => {
      await expect(instance.ingestBatch(props.datasetId, runId, BATCH)).rejects.toThrow(/succeeded, not running/);
      expect(() => instance.describe("another-dataset")).toThrow(/belongs to another dataset/);
    });
  });
});
