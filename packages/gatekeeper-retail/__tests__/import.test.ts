// CSV import (US2, T039): the report's counts, idempotency, cancellation, undo and its refusal after
// a later overlapping import, the fingerprint warning, row rejections, and the agent's suggested
// mapping through the approval queue.

import { env, runInDurableObject } from "cloudflare:test";
import type { RetailDataset } from "../src/dataset/dataset-do.js";
import { describe, expect, it } from "vitest";
import { ADMIN, MEMBER, OTHER_MEMBER, count, drain, importFiles, refusal, stage } from "./import-helpers.js";
import { inspect, newDataset } from "./helpers.js";

const HEADER = "Order ID,Date,Location,Item,Qty,Price,Tax,Tip,Total";
const NOVEMBER = [
  HEADER,
  "A-1,2026-11-02 10:15:00,Main Street,Latte,2,4.50,0.72,1.00,13.96",
  "A-1,2026-11-02 10:15:00,Main Street,Muffin,1,3.00,0.24,1.00,13.96",
  "A-2,2026-11-02 11:00:00,Main Street,Mocha,1,5.00,0.40,0.00,5.40",
  "",
].join("\n");

describe("CSV import", () => {
  it("imports one row per line item into orders and lines, and reports the counts", async () => {
    const { props, dataset } = newDataset();
    const { run } = await importFiles(dataset, props.datasetId, [{ name: "november.csv", text: NOVEMBER }]);
    expect(run.status).toBe("succeeded");
    expect(run.counts.orders).toMatchObject({ fetched: 2, written: 2, rejected: 0 });
    expect(run.counts.line_items).toMatchObject({ fetched: 3, written: 3, rejected: 0 });
    expect(run.files).toEqual([{ name: "november.csv", role: null, bytes: new TextEncoder().encode(NOVEMBER).length }]);
    expect(run.warnings).toEqual({ fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 });
    const orders = await inspect<{ source_record_id: string; gross_amount: number; tax_amount: number; tip_amount: number; total_amount: number; business_date: string }>(
      dataset, "SELECT source_record_id, gross_amount, tax_amount, tip_amount, total_amount, business_date FROM store_orders ORDER BY source_record_id");
    expect(orders).toEqual([
      { source_record_id: "A-1", gross_amount: 1200, tax_amount: 96, tip_amount: 100, total_amount: 1396, business_date: "2026-11-02" },
      { source_record_id: "A-2", gross_amount: 500, tax_amount: 40, tip_amount: 0, total_amount: 540, business_date: "2026-11-02" },
    ]);
    const lines = await inspect<{ name: string; quantity_e4: number; gross_amount: number; tax_amount: number }>(
      dataset, "SELECT name, quantity_e4, gross_amount, tax_amount FROM store_line_items ORDER BY id");
    expect(lines).toEqual([
      { name: "Latte", quantity_e4: 20_000, gross_amount: 900, tax_amount: 72 },
      { name: "Muffin", quantity_e4: 10_000, gross_amount: 300, tax_amount: 24 },
      { name: "Mocha", quantity_e4: 10_000, gross_amount: 500, tax_amount: 40 },
    ]);
    const daily = await inspect<{ orders: number; gross_amount: number }>(
      dataset, "SELECT orders, gross_amount FROM store_daily_sales WHERE business_date = '2026-11-02'");
    expect(daily).toEqual([{ orders: 2, gross_amount: 1700 }]);
  });

  it("changes nothing when the same file is imported again (idempotency)", async () => {
    const { props, dataset } = newDataset();
    const first = await importFiles(dataset, props.datasetId, [{ name: "november.csv", text: NOVEMBER }]);
    const again = await importFiles(dataset, props.datasetId, [{ name: "november.csv", text: NOVEMBER }],
      { target: first.run.sourceId });
    expect(again.run.counts.orders).toMatchObject({ fetched: 2, written: 0, updated: 0, skipped: 2 });
    expect(again.run.counts.line_items).toMatchObject({ fetched: 3, written: 0, updated: 0, skipped: 3 });
    expect(await count(dataset, "orders")).toBe(2);
    expect(await count(dataset, "line_items")).toBe(3);
  });

  it("previews without writing anything", async () => {
    const { props, dataset } = newDataset();
    const importId = await stage(dataset, props.datasetId, [{ name: "november.csv", text: NOVEMBER }]);
    const staged = await dataset.getImport(props.datasetId, importId);
    const preview = await dataset.previewImport(props.datasetId, importId, staged.deterministicMapping);
    expect(preview.rowsRead).toBe(3);
    expect(preview.truncated).toBe(false);
    expect(preview.counts.orders).toMatchObject({ written: 2 });
    expect(preview.dailyTotals).toEqual([{
      businessDate: "2026-11-02", currency: "USD", orders: 2, gross: 1700, discounts: 0, refunds: 0, net: 1700,
      tax: 136, tips: 100,
    }]);
    expect(preview.samples.find(sample => sample.table === "orders")?.rows).toHaveLength(2);
    expect(await count(dataset, "orders")).toBe(0);
    expect(await inspect(dataset, "SELECT id FROM store_sources")).toHaveLength(1);
  });

  it("cancels between batches; only the importing member or an administrator may cancel", async () => {
    const { props, dataset } = newDataset();
    const importId = await stage(dataset, props.datasetId, [{ name: "november.csv", text: NOVEMBER }]);
    const staged = await dataset.getImport(props.datasetId, importId);
    // Started and cancelled in one event, so no batch runs in between.
    const { runId, otherRefusal } = await runInDurableObject(dataset, async (instance: RetailDataset) => {
      const started = await instance.startImport(props.datasetId, importId, staged.deterministicMapping, undefined, MEMBER);
      let refused: string | null = null;
      try {
        instance.cancelRun(props.datasetId, started.runId, OTHER_MEMBER);
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      instance.cancelRun(props.datasetId, started.runId, MEMBER);
      return { runId: started.runId, otherRefusal: refused };
    });
    expect(otherRefusal).toBe("Only organization administrators can cancel another member's import.");
    await drain(dataset);
    const run = await dataset.getRun(props.datasetId, runId, MEMBER);
    expect(run.status).toBe("cancelled");
    expect(await count(dataset, "orders")).toBe(0);
    const imports = await dataset.listImports(props.datasetId);
    expect(imports).toEqual([]);
  });

  it("undoes an import, and refuses while a later overlapping import changed its rows", async () => {
    const { props, dataset } = newDataset();
    const first = await importFiles(dataset, props.datasetId, [{ name: "november.csv", text: NOVEMBER }]);
    const edited = NOVEMBER.replace("A-2,2026-11-02 11:00:00,Main Street,Mocha,1,5.00,0.40,0.00,5.40",
      "A-2,2026-11-02 11:00:00,Main Street,Mocha,1,5.00,0.40,2.00,7.40");
    const second = await importFiles(dataset, props.datasetId, [{ name: "november-fixed.csv", text: edited }],
      { target: first.run.sourceId });
    expect(second.run.counts.orders).toMatchObject({ updated: 1, skipped: 1 });

    const firstRun = await dataset.getRun(props.datasetId, first.run.id, MEMBER);
    expect(firstRun.undo).toEqual({ possible: false, reason: `Later runs changed its rows: run ${second.run.id}.` });
    expect(await refusal(dataset.undoImport(props.datasetId, first.run.id, MEMBER)))
      .toBe(`This import cannot be undone: later runs changed its rows: run ${second.run.id} (import).`);
    expect(await refusal(dataset.undoImport(props.datasetId, second.run.id, OTHER_MEMBER)))
      .toBe("Only organization administrators can undo another member's import.");

    await dataset.undoImport(props.datasetId, second.run.id, ADMIN);
    expect((await inspect<{ tip_amount: number }>(dataset, "SELECT tip_amount FROM store_orders WHERE source_record_id = 'A-2'"))[0])
      .toEqual({ tip_amount: 0 });
    expect((await dataset.getRun(props.datasetId, second.run.id, MEMBER)).status).toBe("undone");

    const { undoRunId } = await dataset.undoImport(props.datasetId, first.run.id, MEMBER);
    const undo = await dataset.getRun(props.datasetId, undoRunId, MEMBER);
    expect(undo).toMatchObject({ kind: "undo", status: "succeeded", undoOf: first.run.id });
    expect(await count(dataset, "orders")).toBe(0);
    expect(await count(dataset, "line_items")).toBe(0);
    expect(await count(dataset, "locations")).toBe(0);
    expect(await count(dataset, "daily_sales")).toBe(0);
    expect((await dataset.getRun(props.datasetId, first.run.id, MEMBER)))
      .toMatchObject({ status: "undone", undoneBy: undoRunId, undo: { possible: false, reason: "This import was undone." } });
  });

  it("warns when rows without an id are keyed by a fingerprint, and still deduplicates them", async () => {
    const { props, dataset } = newDataset();
    const text = "Date,Item,Qty,Price,Total\n2026-11-03,Latte,1,4.50,4.50\n2026-11-03,Scone,1,3.25,3.25\n";
    const first = await importFiles(dataset, props.datasetId, [{ name: "no-ids.csv", text }]);
    expect(first.run.warnings.fingerprintRows).toBe(2);
    expect(first.run.counts.orders).toMatchObject({ written: 2 });
    const second = await importFiles(dataset, props.datasetId, [{ name: "no-ids.csv", text }], { target: first.run.sourceId });
    expect(second.run.counts.orders).toMatchObject({ skipped: 2, written: 0 });
    const ids = await inspect<{ source_record_id: string }>(dataset, "SELECT source_record_id FROM store_orders");
    expect(ids.every(row => row.source_record_id.startsWith("fp:"))).toBe(true);
    expect(await count(dataset, "orders")).toBe(2);
  });

  it("records rejected rows with their file, row and reason, never their values", async () => {
    const { props, dataset } = newDataset();
    const text = [HEADER,
      "B-1,2026-11-04 09:00:00,Main Street,Latte,1,4.50,0,0,4.50",
      "B-2,not a date,Main Street,Latte,1,4.50,0,0,4.50",
      "B-3,2026-11-04 09:30:00,Main Street,Latte,1,4.5x,0,0,4.50",
      ""].join("\n");
    const { run } = await importFiles(dataset, props.datasetId, [{ name: "bad.csv", text }]);
    expect(run.counts.orders).toMatchObject({ written: 2, rejected: 1 });
    expect(run.counts.line_items).toMatchObject({ rejected: 1 });
    const rejections = await dataset.listRejections(props.datasetId, run.id);
    expect(rejections.items.map(({ id: _id, ...rest }) => rest)).toEqual([
      { table: "orders", file: "bad.csv", row: 3, reason: "bad_date", column: "orders.opened_at", detail: "not a date in the format yyyy-MM-dd HH:mm:ss" },
      { table: "line_items", file: "bad.csv", row: 4, reason: "bad_amount", column: "line_items.unit_price_amount", detail: "not an amount in the mapping's format" },
    ]);
  });
});

describe("the agent's suggested mapping", () => {
  const WITH_PII = "Ticket,When,Product,Units,Each,Total,Customer Email\nT-1,2026-11-05 12:00:00,Bagel,1,2.00,2.00,jane@example.com\n";
  const MAPPING = {
    settings: { timezone: "America/New_York", currency: "USD", dateFormat: "yyyy-MM-dd HH:mm:ss", decimalMark: "." as const },
    orderKey: "Ticket",
    fields: [
      { target: "orders.closed_at", from: "When", transform: "datetime" as const },
      { target: "orders.total_amount", from: "Total", transform: "money" as const },
      { target: "line_items.name", from: "Product" },
      { target: "line_items.quantity", from: "Units", transform: "quantity" as const },
      { target: "line_items.unit_price_amount", from: "Each", transform: "money" as const },
    ],
  };

  it("masks personal data in samples, simulates a pending suggestion, and drafts it when applied", async () => {
    const { props, dataset } = newDataset();
    const importId = await stage(dataset, props.datasetId, [{ name: "pos.csv", text: WITH_PII }]);
    const host = env.TEST_HOST.getByName(`agent-${props.datasetId}`);
    const [pending] = await host.pendingImports(props);
    expect(pending!.id).toBe(importId);
    expect(pending!.files[0]!.headers).toContain("Customer Email");
    expect(pending!.samples[0]!.rows[0]).toContain("j***@example.com");
    expect(JSON.stringify(pending)).not.toContain("jane@example.com");

    expect(await host.autoApprovable(props)).toEqual([{ tag: "proposeImportMapping", label: "Suggested CSV import mappings" }]);
    expect(await host.proposeImportMapping(props, importId, {
      settings: { timezone: "UTC", currency: "USD", dateFormat: "yyyy-MM-dd HH:mm:ss", decimalMark: "." },
      orderKey: "Ticket",
      fields: [{ target: "orders.nonsense", from: "When" }],
    })).toMatch(/orders.nonsense\): unknown target field/);

    expect(await host.proposeImportMapping(props, importId, MAPPING)).toBeNull();
    const [action] = await host.actions();
    expect(action!.description).toMatchObject({
      title: `Suggest a mapping for import ${importId}`, autoApprovable: true, implementsRevert: false,
      actionKind: { tag: "proposeImportMapping" },
    });
    // Simulated before it is applied; nothing stored yet.
    expect((await host.pendingImports(props))[0]!.currentMapping).toEqual(MAPPING);
    expect((await dataset.getImport(props.datasetId, importId)).agentMapping).toBeNull();

    await host.applyAction(props, action!.action);
    const staged = await dataset.getImport(props.datasetId, importId);
    expect(staged.agentMapping?.settings.timezone).toBe("America/New_York");
    expect((await host.pendingImports(props))[0]!.currentMapping).toEqual(MAPPING);
  });

  it("drops a rejected suggestion", async () => {
    const { props, dataset } = newDataset();
    const importId = await stage(dataset, props.datasetId, [{ name: "pos.csv", text: WITH_PII }]);
    const host = env.TEST_HOST.getByName(`agent-reject-${props.datasetId}`);
    const before = (await host.pendingImports(props))[0]!.currentMapping;
    expect(await host.proposeImportMapping(props, importId, MAPPING)).toBeNull();
    expect((await host.pendingImports(props))[0]!.currentMapping).toEqual(MAPPING);
    const [action] = await host.actions();
    await host.rejectAction(props, action!.action);
    expect((await host.pendingImports(props))[0]!.currentMapping).toEqual(before);
    expect((await dataset.getImport(props.datasetId, importId)).agentMapping).toBeNull();
  });
});
