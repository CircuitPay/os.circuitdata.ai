// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowseCatalog, RetailAppClient, RetailOverview, RunSummary } from "../src/app-api-types";
import App from "./App";
import type { DataAppHost } from "./host";
import { button, byRole, cleanup, click, render, settle } from "./testDom";

const overview: RetailOverview = {
  canManage: true,
  connectableProviders: ["square", "stripe"],
  sources: [],
  storage: { usedBytes: 0, capBytes: 1, rawUsedBytes: 0, rawQuotaBytes: 1, warn: false },
  settings: { piiUnmasked: false, backfillYears: 3 },
  failuresNeedingAdmin: [],
};

const catalog: BrowseCatalog = {
  tables: [{
    name: "orders",
    label: "Orders",
    description: "One row per sale.",
    rows: 2,
    dateColumn: "business_date",
    search: null,
    gridColumns: [],
  }],
  dateRange: { from: "2026-10-01", to: "2026-10-01" },
  completeThrough: "2026-10-01",
  personalDataMasked: true,
  sources: [],
};

const importRun: RunSummary = {
  id: 40,
  sourceId: 3,
  sourceLabel: "CSV uploads",
  kind: "import",
  status: "succeeded",
  templateVersionId: null,
  mappingVersion: "import-7",
  startedBy: "member-1",
  startedAt: "2026-11-17T10:00:00Z",
  finishedAt: "2026-11-17T10:01:00Z",
  counts: { orders: { fetched: 2, written: 2, updated: 0, skipped: 0, rejected: 0 } },
  progress: null,
  warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
  error: null,
  undoOf: null,
  undoneBy: null,
  undo: { possible: true, reason: null },
  files: [{ name: "sales_october.csv", role: null, bytes: 2048 }],
};

// Every other capability method resolves to something empty; the tests follow navigation.
function fakeApi() {
  const empty = { items: [], nextAfter: null };
  const api: Partial<RetailAppClient> = {
    getOverview: vi.fn<RetailAppClient["getOverview"]>(async () => overview),
    getBrowseCatalog: vi.fn<RetailAppClient["getBrowseCatalog"]>(async () => catalog),
    browseRows: vi.fn<RetailAppClient["browseRows"]>(async (table, query) => ({
      table,
      columns: [],
      rows: [],
      offset: query?.offset ?? 0,
      total: 0,
      pageSize: 100,
      narrowedTo: null,
    })),
    listImports: vi.fn<RetailAppClient["listImports"]>(async () => []),
    listRuns: vi.fn<RetailAppClient["listRuns"]>(async () => ({ items: [importRun], nextAfter: null })),
    getRun: vi.fn<RetailAppClient["getRun"]>(async () => importRun),
    listTemplates: vi.fn<RetailAppClient["listTemplates"]>(async () => []),
    getCoverage: vi.fn<RetailAppClient["getCoverage"]>(async () => ({ sources: [], ranges: [], possibleGaps: [] })),
    listMatchProposals: vi.fn<RetailAppClient["listMatchProposals"]>(async () => []),
  };
  return new Proxy(api, {
    get: (target, key: string) => target[key as keyof RetailAppClient] ?? (async () => empty),
  }) as RetailAppClient;
}

const host: DataAppHost = {
  openPrompt: async () => {},
  pickTenantFiles: async () => null,
  openConnectPopup: async () => {},
};

const TABS = ["Home", "Browse", "Imports", "Templates", "Coverage", "Sources", "Settings"];

afterEach(cleanup);

describe("App", () => {
  it("navigates between the Data tabs, loading each panel on its first visit", async () => {
    const api = fakeApi();
    await render(<App api={api} host={host} />);

    const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(TABS);
    expect(byRole("tabpanel", "Home").hidden).toBe(false);
    expect(api.getCoverage).not.toHaveBeenCalled();

    await click(byRole("tab", "Coverage"));
    expect(byRole("tab", "Coverage").getAttribute("aria-selected")).toBe("true");
    expect(byRole("tabpanel", "Coverage").hidden).toBe(false);
    expect(byRole("tabpanel", "Home").hidden).toBe(true);
    expect(api.getCoverage).toHaveBeenCalledOnce();

    await click(byRole("tab", "Home"));
    // Home is read again on each visit, to show what changed meanwhile.
    expect(api.getBrowseCatalog).toHaveBeenCalledTimes(2);
    await click(byRole("tab", "Coverage"));
    // The panel stayed mounted, so returning does not load it again.
    expect(api.getCoverage).toHaveBeenCalledOnce();
  });

  it("still renders every tab the Data area had before Home and Browse", async () => {
    await render(<App api={fakeApi()} host={host} />);

    for (const name of TABS) {
      await click(byRole("tab", name));
      await settle();
      const panel = byRole("tabpanel", name);
      expect(panel.hidden).toBe(false);
      expect(panel.querySelector("h2, h3, [role='status']")).not.toBeNull();
    }
  });

  it("opens a run's report on Imports and its rows on Browse from Home's recent runs", async () => {
    const api = fakeApi();
    await render(<App api={api} host={host} />);
    await settle();

    await click(button("Report of import 40"));
    expect(byRole("tab", "Imports").getAttribute("aria-selected")).toBe("true");
    expect(api.getRun).toHaveBeenCalledWith(40);
    expect(byRole("tabpanel", "Imports").querySelector("h2")?.textContent).toBe("Import into CSV uploads");

    await click(byRole("tab", "Home"));
    await click(button("View rows of import 40"));
    expect(byRole("tab", "Browse").getAttribute("aria-selected")).toBe("true");
    expect(api.browseRows).toHaveBeenCalledWith("orders", { runId: 40 });

    // The report on Imports leads to the same rows.
    await click(byRole("tab", "Imports"));
    await click(button("View the imported rows"));
    expect(byRole("tab", "Browse").getAttribute("aria-selected")).toBe("true");
    expect(api.browseRows).toHaveBeenCalledTimes(2);
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", { runId: 40 });
  });
});
