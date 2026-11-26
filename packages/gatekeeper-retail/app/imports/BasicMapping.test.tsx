// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportPreview, MappingDocument, RunSummary, StagedImport } from "../../src/app-api-types";
import { button, byRole, choose, cleanup, click, field, render, settle } from "../testDom";
import ImportView, { type ImportViewApi } from "./ImportView";

// The header aliases found the order id, date, item and total, but not the quantity.
const deterministicMapping: MappingDocument = {
  version: 1,
  settings: { timezone: "America/New_York", currency: "USD", dateFormat: "yyyy-MM-dd", decimalMark: "." },
  orderKey: "Order ID",
  targets: [
    { target: "orders.business_date", from: "Date", transform: "date" },
    { target: "orders.total_amount", from: "Total", transform: "money" },
    { target: "line_items.name", from: "Item" },
  ],
};

const staged: StagedImport = {
  id: 7,
  sourceId: 3,
  sourceLabel: "CSV uploads",
  status: "staged",
  createdBy: "member-1",
  expiresAt: "2026-11-24T10:00:00Z",
  runId: 45,
  files: [{
    rawObjectId: 1,
    name: "sales_october.csv",
    bytes: 2048,
    role: null,
    sniff: { encoding: "utf-8", delimiter: ",", headerRow: 1, footerRows: 0 },
    headers: ["Order ID", "Date", "Item", "Qty", "Total"],
    sampleRows: [["1001", "2026-10-01", "Latte", "2", "9.00"]],
  }],
  templateMatches: [],
  deterministicMapping,
  agentMapping: null,
  missingRequiredFiles: [],
  targets: [
    { path: "orders.business_date", label: "Business date", kind: "date", description: "" },
    { path: "orders.opened_at", label: "Opened at", kind: "datetime", description: "" },
    { path: "orders.closed_at", label: "Closed at", kind: "datetime", description: "" },
    { path: "orders.total_amount", label: "Total", kind: "money", description: "" },
    { path: "orders.currency", label: "Currency", kind: "text", description: "" },
    { path: "line_items.name", label: "Item name", kind: "text", description: "" },
    { path: "line_items.quantity", label: "Quantity", kind: "quantity", description: "" },
  ],
};

const preview: ImportPreview = {
  rowsRead: 1,
  truncated: false,
  rowLimit: 50_000,
  counts: {},
  samples: [],
  problems: [],
  warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
  dailyTotals: [],
};

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
    id: 40,
    sourceId: 3,
    sourceLabel: "CSV uploads",
    kind: "import",
    status: "succeeded",
    templateVersionId: null,
    mappingVersion: "import-6",
    startedBy: "member-1",
    startedAt: "2026-11-17T10:00:00Z",
    finishedAt: "2026-11-17T10:01:00Z",
    counts: {},
    progress: null,
    warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
    error: null,
    undoOf: null,
    undoneBy: null,
    undo: { possible: true, reason: null },
    files: [{ name: "sales_october.csv", role: null, bytes: 2048 }],
    ...overrides,
  };
}

function fakeApi(runs: RunSummary[] = []) {
  return {
    getImport: vi.fn<ImportViewApi["getImport"]>(async () => staged),
    listRuns: vi.fn<ImportViewApi["listRuns"]>(async () => ({ items: runs, nextAfter: null })),
    discardImport: vi.fn<ImportViewApi["discardImport"]>(async () => {}),
    askAgentPrompt: vi.fn<ImportViewApi["askAgentPrompt"]>(async () => "Propose a mapping."),
    preview: vi.fn<ImportViewApi["preview"]>(async () => preview),
    startImport: vi.fn<ImportViewApi["startImport"]>(async () => ({ runId: 46 })),
  };
}

const host = { openPrompt: async () => {}, pickTenantFiles: async () => null };

async function renderImport(api: ImportViewApi) {
  await render(
    <ImportView api={api} host={host} importId={7} onBack={() => {}} onOpenImport={() => {}} onStarted={() => {}} />,
  );
  await settle();
}

/** The basic panel's select for a field, by its visible label. */
const basicSelect = (label: string) => byRole("combobox", label);

afterEach(cleanup);

describe("BasicMapping", () => {
  it("keeps Preview unavailable until the required fields are matched, then previews the mapping", async () => {
    const api = fakeApi();
    await renderImport(api);

    expect(basicSelect("Date").textContent).toContain("Date (e.g. 2026-10-01)");
    expect(basicSelect("Quantity").textContent).toContain("Not in this file");
    expect(document.body.textContent).toContain("Needed");
    expect(field("Timezone").value).toBe("America/New_York");
    expect(field("Currency").value).toBe("USD");
    expect(button("Preview").disabled).toBe(true);

    await choose("Quantity", "Qty (e.g. 2)");
    expect(document.body.textContent).not.toContain("Needed");
    expect(button("Preview").disabled).toBe(false);

    await click(button("Preview"));
    expect(api.preview).toHaveBeenCalledWith(7, {
      ...deterministicMapping,
      targets: [
        ...deterministicMapping.targets,
        { target: "line_items.quantity", from: "Qty", transform: "quantity" },
      ],
    });
  });

  it("keeps the choices in both directions when More options opens the full editor", async () => {
    await renderImport(fakeApi());
    await choose("Quantity", "Qty (e.g. 2)");

    await click(button("More options"));
    expect(button("More options").getAttribute("aria-expanded")).toBe("true");
    expect(byRole("combobox", "Imported as, for Qty").textContent).toContain("Quantity (line_items.quantity)");
    expect(document.body.textContent).toContain("sales_october.csv: first 1 rows");

    await choose("Imported as, for Item", "Not imported");
    expect(basicSelect("Item").textContent).toContain("Not in this file");
    expect(button("Preview").disabled).toBe(true);

    await click(button("More options"));
    expect(() => byRole("combobox", "Imported as, for Qty")).toThrow('No combobox "Imported as, for Qty"');
    expect(basicSelect("Quantity").textContent).toContain("Qty");
  });

  it("says when the same file was imported into this source before", async () => {
    await renderImport(fakeApi([run({ status: "undone" }), run({ sourceId: 9 })]));
    expect(document.body.textContent).not.toContain("This file looks like one imported on");
    cleanup();

    await renderImport(fakeApi([run({})]));
    expect(document.body.textContent).toContain(
      "This file looks like one imported on Nov 17, 2026. Importing it again updates those rows rather than adding new ones.",
    );
  });
});
