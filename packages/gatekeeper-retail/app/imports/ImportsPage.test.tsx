// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ImportPreview,
  MappingDocument,
  RetailOverview,
  RunSummary,
  StagedImport,
} from "../../src/app-api-types";
import type { DataAppHost } from "../host";
import { button, byRole, choose, cleanup, click, render, settle } from "../testDom";
import ImportsPage, { type ImportsApi } from "./ImportsPage";

const settings: MappingDocument["settings"] = {
  timezone: "America/New_York",
  currency: "USD",
  dateFormat: "MM/dd/yyyy",
  decimalMark: ".",
};

// The header-alias mapping finds the date and item name but neither the quantity nor an order key.
const deterministicMapping: MappingDocument = {
  version: 1,
  settings,
  orderKey: null,
  targets: [
    { target: "orders.business_date", from: "Txn Date", transform: "date" },
    { target: "line_items.name", from: "Item" },
  ],
};

const agentMapping: MappingDocument = {
  ...deterministicMapping,
  orderKey: "Order",
  targets: [
    ...deterministicMapping.targets,
    { target: "line_items.quantity", from: "Qty", transform: "quantity" },
    { target: "orders.total_amount", from: "Total", transform: "money" },
  ],
};

const staged: StagedImport = {
  id: 7,
  sourceId: 3,
  sourceLabel: "Front counter exports",
  status: "staged",
  createdBy: "member-1",
  expiresAt: "2026-11-24T10:00:00Z",
  runId: 40,
  files: [{
    rawObjectId: 1,
    name: "sales_october.csv",
    bytes: 2048,
    role: null,
    sniff: { encoding: "utf-8", delimiter: ",", headerRow: 1, footerRows: 0 },
    headers: ["Txn Date", "Order", "Item", "Qty", "Total"],
    sampleRows: [
      ["10/01/2026", "A1", "Latte", "2", "9.00"],
      ["10/01/2026", "A2", "Mocha", "x", "5.00"],
    ],
  }],
  templateMatches: [],
  deterministicMapping,
  agentMapping: null,
  missingRequiredFiles: [],
  targets: [
    { path: "orders.business_date", label: "Business date", kind: "date", description: "" },
    { path: "orders.total_amount", label: "Total", kind: "money", description: "" },
    { path: "orders.currency", label: "Currency", kind: "text", description: "" },
    { path: "line_items.name", label: "Item name", kind: "text", description: "" },
    { path: "line_items.quantity", label: "Quantity", kind: "quantity", description: "" },
  ],
};

const overview: RetailOverview = {
  canManage: false,
  connectableProviders: ["square", "stripe"],
  sources: [{
    id: 3,
    kind: "csv",
    label: "Front counter exports",
    status: "imported",
    lastSuccessAt: null,
    coverageFrom: null,
    coverageTo: null,
  }],
  storage: { usedBytes: 0, capBytes: 1, rawUsedBytes: 0, rawQuotaBytes: 1, warn: false },
  settings: { piiUnmasked: false, backfillYears: 3 },
  failuresNeedingAdmin: [],
};

const preview: ImportPreview = {
  rowsRead: 2,
  truncated: false,
  rowLimit: 50_000,
  counts: {
    orders: { fetched: 2, written: 2, updated: 0, skipped: 0, rejected: 0 },
    line_items: { fetched: 2, written: 1, updated: 0, skipped: 0, rejected: 1 },
  },
  samples: [{ table: "orders", columns: ["source_record_id", "business_date"], rows: [["A1", "2026-10-01"]] }],
  problems: [{
    reason: "bad_quantity",
    count: 1,
    examples: [{ table: "line_items", file: "sales_october.csv", row: 3, column: "Qty", detail: "not a number" }],
  }],
  warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
  dailyTotals: [{
    businessDate: "2026-10-01",
    currency: "USD",
    orders: 2,
    gross: 1400,
    discounts: 0,
    refunds: 0,
    net: 1400,
    tax: 0,
    tips: 0,
  }],
};

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
    id: 40,
    sourceId: 3,
    sourceLabel: "Front counter exports",
    kind: "import",
    status: "succeeded",
    templateVersionId: null,
    mappingVersion: "import-7",
    startedBy: "member-1",
    startedAt: "2026-11-17T10:00:00Z",
    finishedAt: null,
    counts: {},
    progress: null,
    warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
    error: null,
    undoOf: null,
    undoneBy: null,
    undo: { possible: false, reason: null },
    files: [{ name: "sales_october.csv", role: null, bytes: 2048 }],
    ...overrides,
  };
}

function fakeApi(overrides: Partial<ImportsApi> = {}) {
  return {
    getOverview: vi.fn<ImportsApi["getOverview"]>(async () => overview),
    listImports: vi.fn<ImportsApi["listImports"]>(async () => []),
    listRuns: vi.fn<ImportsApi["listRuns"]>(async () => ({ items: [], nextAfter: null })),
    getImport: vi.fn<ImportsApi["getImport"]>(async () => staged),
    discardImport: vi.fn<ImportsApi["discardImport"]>(async () => {}),
    askAgentPrompt: vi.fn<ImportsApi["askAgentPrompt"]>(async (id) => `Propose a column mapping for pending import ${id}.`),
    preview: vi.fn<ImportsApi["preview"]>(async () => preview),
    startImport: vi.fn<ImportsApi["startImport"]>(async () => ({ runId: 40 })),
    getRun: vi.fn<ImportsApi["getRun"]>(async (id) => run({ id })),
    listRejections: vi.fn<ImportsApi["listRejections"]>(async () => ({ items: [], nextAfter: null })),
    cancelRun: vi.fn<ImportsApi["cancelRun"]>(async () => {}),
    undoImport: vi.fn<ImportsApi["undoImport"]>(async () => ({ undoRunId: 41 })),
    ...overrides,
  };
}

function fakeHost() {
  return {
    openPrompt: vi.fn<(prompt: string) => Promise<void>>(async () => {}),
    pickTenantFiles: vi.fn<DataAppHost["pickTenantFiles"]>(async () => ({ importId: 7 })),
  };
}

const stillNeeded = () => document.querySelector('[aria-live="polite"][aria-label="Still needed"]')!.textContent;

/** Opens import 7 the way a member does: Import CSV → existing source → pick files. */
async function openImport(api: ImportsApi, host: Pick<DataAppHost, "openPrompt" | "pickTenantFiles">) {
  await render(<ImportsPage api={api} host={host} />);
  await click(button("Import CSV"));
  await click(button("Choose files", document.querySelector('[role="dialog"]')!));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ImportsPage", () => {
  it("picks CSV files into the chosen source and opens the staged import", async () => {
    const api = fakeApi();
    const host = fakeHost();
    await openImport(api, host);

    expect(host.pickTenantFiles).toHaveBeenCalledWith({ accept: [".csv", "text/csv"], multiple: true, target: 3 });
    expect(api.getImport).toHaveBeenCalledWith(7);
    expect(document.querySelector("h2")!.textContent).toBe("Import into Front counter exports");
    expect(document.activeElement).toBe(document.querySelector("h2"));
    expect(document.body.textContent).toContain("sales_october.csv: first 2 rows");
    expect(document.body.textContent).toContain("utf-8");
  });

  it("lists what the mapping still needs in a live region as columns are mapped", async () => {
    const api = fakeApi({ getImport: vi.fn<ImportsApi["getImport"]>(async () => ({ ...staged, agentMapping })) });
    await openImport(api, fakeHost());

    expect(stillNeeded()).toContain("Quantity");
    expect(stillNeeded()).toContain("An order key");

    await choose("Imported as, for Qty", "Quantity (line_items.quantity)");
    expect(stillNeeded()).not.toContain("Quantity");
    expect(byRole("combobox", "Transform for Qty").textContent).toContain("Quantity");

    await click(button("Use the agent's suggestion"));
    expect(stillNeeded()).toBe("Everything an import needs is mapped.");
  });

  it("asks the agent through the host and refreshes to show its suggestion", async () => {
    const getImport = vi
      .fn<ImportsApi["getImport"]>()
      .mockResolvedValueOnce(staged)
      .mockResolvedValueOnce({ ...staged, agentMapping });
    const api = fakeApi({ getImport });
    const host = fakeHost();
    await openImport(api, host);
    expect(document.body.textContent).not.toContain("The agent suggested a mapping");

    await click(button("Ask the agent"));
    expect(api.askAgentPrompt).toHaveBeenCalledWith(7);
    expect(host.openPrompt).toHaveBeenCalledWith("Propose a column mapping for pending import 7.");

    await click(button("Refresh"));
    expect(document.body.textContent).toContain("The agent suggested a mapping");
  });

  it("refuses a file set with missing files before preview, naming them", async () => {
    const api = fakeApi({
      getImport: vi.fn<ImportsApi["getImport"]>(async () => ({ ...staged, missingRequiredFiles: ["PaymentDetails"] })),
    });
    await openImport(api, fakeHost());

    expect(document.body.textContent).toContain("PaymentDetails must be imported with the other files");
    expect(button("Preview").disabled).toBe(true);
  });

  it("previews the mapping with captioned tables, totals and problems that focus their row", async () => {
    const api = fakeApi({ getImport: vi.fn<ImportsApi["getImport"]>(async () => ({ ...staged, agentMapping })) });
    await openImport(api, fakeHost());
    await click(button("Use the agent's suggestion"));
    expect(button("Start import").disabled).toBe(true);

    await click(button("Preview"));
    expect(api.preview).toHaveBeenCalledWith(7, agentMapping);

    const captions = [...document.querySelectorAll("caption")].map((caption) => caption.textContent);
    expect(captions).toContain("orders: first 1 rows as they would be imported");
    expect(captions).toContain("Totals per business date, to compare with your point-of-sale report");
    expect(document.body.textContent).toContain("$14.00");
    expect(document.body.textContent).toContain("This preview read all 2 rows.");

    await click(button("Row 3 of sales_october.csv in Qty (line_items): not a number"));
    expect(document.activeElement?.id).toBe("import-7-file-0-row-3");
    expect(document.activeElement?.textContent).toContain("Mocha");
  });

  it("starts the import, follows its progress, and undoes it", async () => {
    let finished = false;
    let undone = false;
    const getRun = vi.fn<ImportsApi["getRun"]>(async (id) => {
      if (id === 41) {
        undone = true;
        return run({ id: 41, kind: "undo", status: "succeeded", undoOf: 40 });
      }
      if (undone) return run({ status: "undone", undoneBy: 41 });
      if (!finished) {
        return run({
          status: "running",
          progress: { phase: "Writing orders", done: 50, total: 200, etaSeconds: 30 },
        });
      }
      return run({
        status: "succeeded",
        finishedAt: "2026-11-17T10:01:00Z",
        counts: { orders: { fetched: 2, written: 2, updated: 0, skipped: 0, rejected: 0 } },
        warnings: { fingerprintRows: 2, totalMismatch: 0, quantityRounded: 0 },
        undo: { possible: true, reason: null },
      });
    });
    const api = fakeApi({ getImport: vi.fn<ImportsApi["getImport"]>(async () => ({ ...staged, agentMapping })), getRun });
    await openImport(api, fakeHost());
    await click(button("Use the agent's suggestion"));
    await click(button("Preview"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await click(button("Start import"));
    expect(api.startImport).toHaveBeenCalledWith(7, agentMapping, undefined);

    const progress = document.querySelector('[role="progressbar"]')!;
    expect(progress.getAttribute("aria-valuenow")).toBe("50");
    expect(progress.getAttribute("aria-valuemax")).toBe("200");
    expect(progress.getAttribute("aria-valuetext")).toBe("Writing orders: 50 of 200, about 30 seconds left");
    expect(button("Cancel")).toBeDefined();

    finished = true;
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await settle();
    vi.useRealTimers();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.body.textContent).toContain("Finished");
    expect(document.body.textContent).toContain("2 rows had no id and were matched by their contents");

    await click(button("Undo import"));
    await click(button("Undo import", document.querySelector('[role="alertdialog"]')!));
    expect(api.undoImport).toHaveBeenCalledWith(40);
    await settle();
    expect(getRun).toHaveBeenCalledWith(41);
    expect(document.body.textContent).toContain("Undone");
    expect(document.body.textContent).not.toContain("Undo import");
  });

  it("shows why an import cannot be undone", async () => {
    const api = fakeApi({
      listRuns: vi.fn<ImportsApi["listRuns"]>(async () => ({ items: [run({})], nextAfter: null })),
      getRun: vi.fn<ImportsApi["getRun"]>(async () =>
        run({ undo: { possible: false, reason: "Import 52 changed the same rows later." } }),
      ),
    });
    await render(<ImportsPage api={api} host={fakeHost()} />);
    await click(button("Report of import 40"));

    expect(document.body.textContent).toContain("Import 52 changed the same rows later.");
    expect(() => button("Undo import")).toThrow('No button "Undo import"');
  });
});
