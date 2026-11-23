// Provenance and completeness (US4, T061): coverage ranges per location and source, a missing
// trading day flagged as a possible gap, rejected rows listed, and lineage back to file and row.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MEMBER, importFiles, refusal } from "./import-helpers.js";
import { inspect, newDataset } from "./helpers.js";

/** One order a day from `from` for `days` days, skipping `skip`; plus `extra` rows. */
function dailyCsv(from: string, days: number, skip: string[], extra: string[] = []): string {
  const rows = ["Order ID,Date,Location,Item,Qty,Price,Total"];
  for (let day = 0; day < days; day++) {
    const date = new Date(Date.parse(`${from}T00:00:00Z`) + day * 86_400_000).toISOString().slice(0, 10);
    if (skip.includes(date)) continue;
    rows.push(`D-${date},${date} 12:00:00,Main Street,Latte,1,4.50,4.50`);
  }
  return [...rows, ...extra, ""].join("\n");
}

describe("coverage", () => {
  it("reports covered ranges and flags a missing usual trading day", async () => {
    const { props, dataset } = newDataset();
    // 2026-11-03 is a Tuesday; the four Tuesdays before it all traded.
    const text = dailyCsv("2026-10-01", 35, ["2026-11-03"], ["BAD-1,yesterday,Main Street,Latte,1,4.50,4.50"]);
    const { run } = await importFiles(dataset, props.datasetId, [{ name: "october.csv", text }]);
    expect(run.counts.orders).toMatchObject({ written: 34, rejected: 1 });

    const coverage = await dataset.coverage(props.datasetId);
    const [locationId] = (await inspect<{ id: number }>(dataset, "SELECT id FROM store_locations")).map(row => row.id);
    expect(coverage.sources).toEqual([{ id: run.sourceId, kind: "csv", label: "Front counter", status: "imported", lastSuccessAt: expect.any(String) }]);
    expect(coverage.ranges).toEqual([
      { locationId, sourceId: run.sourceId, from: "2026-10-01", to: "2026-11-02" },
      { locationId, sourceId: run.sourceId, from: "2026-11-04", to: "2026-11-04" },
    ]);
    expect(coverage.possibleGaps).toEqual([{ locationId, businessDate: "2026-11-03" }]);

    const filtered = await dataset.coverage(props.datasetId, { from: "2026-11-01", to: "2026-11-04", locationIds: [locationId!] });
    expect(filtered.ranges).toEqual([
      { locationId, sourceId: run.sourceId, from: "2026-11-01", to: "2026-11-02" },
      { locationId, sourceId: run.sourceId, from: "2026-11-04", to: "2026-11-04" },
    ]);
    expect(filtered.possibleGaps).toEqual([{ locationId, businessDate: "2026-11-03" }]);
    expect((await dataset.coverage(props.datasetId, { locationIds: [locationId! + 100] })).ranges).toEqual([]);

    const rejections = await dataset.listRejections(props.datasetId, run.id);
    expect(rejections.items).toEqual([expect.objectContaining({
      table: "orders", file: "october.csv", row: 36, reason: "bad_date", column: "orders.opened_at",
    })]);
  });

  it("does not flag a weekday the location does not usually trade", async () => {
    const { props, dataset } = newDataset();
    // Closed every Sunday: Sundays are never gaps.
    const sundays = ["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25", "2026-11-01"];
    await importFiles(dataset, props.datasetId, [{ name: "weekdays.csv", text: dailyCsv("2026-10-01", 35, sundays) }]);
    expect((await dataset.coverage(props.datasetId)).possibleGaps).toEqual([]);
  });

  it("refuses dates that are not YYYY-MM-DD", async () => {
    const { props, dataset } = newDataset();
    expect(await refusal(dataset.coverage(props.datasetId, { from: "11/01/2026" }))).toBe("from must be a date written YYYY-MM-DD.");
  });
});

describe("lineage", () => {
  it("traces an imported row to its source, run, mapping version, file and row", async () => {
    const { props, dataset } = newDataset();
    const { run } = await importFiles(dataset, props.datasetId, [{ name: "october.csv", text: dailyCsv("2026-10-01", 3, []) }]);
    const [order] = await inspect<{ id: number }>(dataset, "SELECT id FROM store_orders WHERE source_record_id = 'D-2026-10-02'");
    const host = env.TEST_HOST.getByName(`lineage-${props.datasetId}`);
    const lineage = await host.lineage(props, "orders", order!.id);
    expect(lineage).toEqual({
      table: "orders",
      id: order!.id,
      source: { id: run.sourceId, kind: "csv", label: "Front counter" },
      sourceRecordId: "D-2026-10-02",
      run: { id: run.id, kind: "import", finishedAt: run.finishedAt },
      mappingVersion: run.mappingVersion,
      file: { name: "october.csv", row: 3 },
    });
    const [line] = await inspect<{ id: number }>(dataset, "SELECT id FROM store_line_items WHERE order_id = ?", order!.id);
    expect((await dataset.lineage(props.datasetId, "line_items", line!.id)).file).toEqual({ name: "october.csv", row: 3 });
    const observations = await host.observations();
    expect(observations.at(-1)?.title).toBe(`Traced orders row ${order!.id}`);
    expect(await refusal(dataset.lineage(props.datasetId, "daily_sales", 1))).toMatch(/computed from other rows/);
    expect(await refusal(dataset.lineage(props.datasetId, "orders", 999_999))).toBe("There is no orders row 999999.");
  });

  it("serves coverage through the binding as an observation", async () => {
    const { props, dataset } = newDataset();
    await importFiles(dataset, props.datasetId, [{ name: "october.csv", text: dailyCsv("2026-10-01", 3, []) }], { member: MEMBER });
    const host = env.TEST_HOST.getByName(`coverage-${props.datasetId}`);
    const coverage = await host.coverage(props);
    expect(coverage.ranges).toHaveLength(1);
    expect((await host.observations()).at(-1)?.title).toBe("Read retail data coverage");
  });
});
