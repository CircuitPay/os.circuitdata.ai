// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowseCatalog,
  BrowseTableInfo,
  ImportListEntry,
  RetailOverview,
  RunSummary,
  SourceSummary,
} from "../../src/app-api-types";
import type { DataAppHost } from "../host";
import type { BrowseTarget } from "../navigation";
import { button, cleanup, click, render, settle } from "../testDom";
import HomePage, { type HomeApi, type HomeProps } from "./HomePage";

function source(overrides: Partial<SourceSummary>): SourceSummary {
  return {
    id: 1,
    kind: "csv",
    label: "Front counter exports",
    status: "imported",
    lastSuccessAt: "2026-11-01T10:00:00Z",
    coverageFrom: "2026-10-01",
    coverageTo: "2026-10-31",
    ...overrides,
  };
}

const overview: RetailOverview = {
  canManage: false,
  connectableProviders: ["square", "stripe"],
  sources: [source({})],
  storage: { usedBytes: 7_500_000_000, capBytes: 10_000_000_000, rawUsedBytes: 0, rawQuotaBytes: 1, warn: true },
  settings: { piiUnmasked: false, backfillYears: 3 },
  failuresNeedingAdmin: [],
};

function table(name: BrowseTableInfo["name"], label: string, rows: number): BrowseTableInfo {
  return { name, label, description: "", rows, dateColumn: null, search: null, gridColumns: [] };
}

const catalog: BrowseCatalog = {
  tables: [table("orders", "Orders", 4812), table("line_items", "Line items", 9120), table("customers", "Customers", 0)],
  dateRange: { from: "2026-10-01", to: "2026-10-31" },
  completeThrough: "2026-10-30",
  personalDataMasked: true,
  sources: [{ id: 1, kind: "csv", label: "Front counter exports" }],
};

const emptyCatalog: BrowseCatalog = {
  ...catalog,
  tables: catalog.tables.map((entry) => ({ ...entry, rows: 0 })),
  dateRange: null,
  completeThrough: null,
};

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
    id: 40,
    sourceId: 1,
    sourceLabel: "Front counter exports",
    kind: "import",
    status: "succeeded",
    templateVersionId: null,
    mappingVersion: "import-7",
    startedBy: "member-1",
    startedAt: "2026-11-17T10:00:00Z",
    finishedAt: "2026-11-17T10:01:00Z",
    counts: {
      orders: { fetched: 2, written: 2, updated: 0, skipped: 0, rejected: 0 },
      line_items: { fetched: 3, written: 3, updated: 0, skipped: 0, rejected: 0 },
    },
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

const stagedEntry: ImportListEntry = {
  id: 12,
  sourceId: 1,
  sourceLabel: "Front counter exports",
  status: "staged",
  fileNames: ["sales_november.csv"],
  runId: 45,
  createdBy: "member-1",
  expiresAt: "2026-11-24T10:00:00Z",
  hasAgentMapping: false,
};

function fakeApi(overrides: Partial<HomeApi> = {}) {
  return {
    getOverview: vi.fn<HomeApi["getOverview"]>(async () => overview),
    getBrowseCatalog: vi.fn<HomeApi["getBrowseCatalog"]>(async () => catalog),
    listRuns: vi.fn<HomeApi["listRuns"]>(async () => ({
      items: [run({}), run({ id: 39, kind: "sync", sourceLabel: "Square", files: [], counts: {} })],
      nextAfter: null,
    })),
    listImports: vi.fn<HomeApi["listImports"]>(async () => [stagedEntry]),
    ...overrides,
  };
}

function fakeActions(pickTenantFiles: DataAppHost["pickTenantFiles"] = async () => ({ importId: 12 })) {
  return {
    host: { pickTenantFiles: vi.fn<DataAppHost["pickTenantFiles"]>(pickTenantFiles) },
    onOpenImport: vi.fn<(importId: number) => void>(),
    onOpenRun: vi.fn<(runId: number) => void>(),
    onBrowse: vi.fn<(target: BrowseTarget) => void>(),
    onOpenSources: vi.fn<() => void>(),
  };
}

async function renderHome(api: HomeApi, actions: Omit<HomeProps, "api">) {
  const page = await render(<HomePage api={api} {...actions} />);
  await settle();
  return page;
}

const emptyApi = () =>
  fakeApi({
    getOverview: vi.fn<HomeApi["getOverview"]>(async () => ({ ...overview, sources: [], storage: { ...overview.storage, warn: false } })),
    getBrowseCatalog: vi.fn<HomeApi["getBrowseCatalog"]>(async () => emptyCatalog),
    listRuns: vi.fn<HomeApi["listRuns"]>(async () => ({ items: [], nextAfter: null })),
    listImports: vi.fn<HomeApi["listImports"]>(async () => []),
  });

afterEach(cleanup);

describe("HomePage", () => {
  it("leads an empty dataset with Upload a CSV and the way to connect a provider", async () => {
    const actions = fakeActions();
    const page = await renderHome(emptyApi(), actions);

    expect(page.querySelector("h2")?.textContent).toBe("Get your sales data in");
    expect(page.textContent).toContain("Toast, Square and Shopify exports are recognised.");
    expect(() => button("Browse data")).toThrow('No button "Browse data"');

    await click(button("or connect Square or Stripe"));
    expect(actions.onOpenSources).toHaveBeenCalledOnce();
  });

  it("uploads into a new CSV source when there is none, and opens the staged import", async () => {
    const actions = fakeActions();
    await renderHome(emptyApi(), actions);

    await click(button("Upload a CSV"));
    expect(actions.host.pickTenantFiles).toHaveBeenCalledWith({
      accept: [".csv", "text/csv"],
      multiple: true,
      target: { newSourceLabel: "CSV uploads" },
    });
    expect(actions.onOpenImport).toHaveBeenCalledWith(12);
  });

  it("uploads into the CSV source imported into most recently", async () => {
    const actions = fakeActions();
    const api = fakeApi({
      getOverview: vi.fn<HomeApi["getOverview"]>(async () => ({
        ...overview,
        sources: [
          source({ id: 1, lastSuccessAt: "2026-11-01T10:00:00Z" }),
          source({ id: 2, lastSuccessAt: "2026-11-10T10:00:00Z" }),
          source({ id: 3, kind: "square", lastSuccessAt: "2026-11-20T10:00:00Z" }),
          source({ id: 4, lastSuccessAt: null }),
        ],
      })),
    });
    await renderHome(api, actions);

    await click(button("Upload a CSV"));
    expect(actions.host.pickTenantFiles).toHaveBeenCalledWith(expect.objectContaining({ target: 2 }));
  });

  it("does nothing when the member cancels the upload, and shows why one failed", async () => {
    const cancelled = fakeActions(async () => null);
    await renderHome(emptyApi(), cancelled);
    await click(button("Upload a CSV"));
    expect(cancelled.onOpenImport).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("could not be imported");
    cleanup();

    const failed = fakeActions(async () => {
      throw new Error("The file is not a CSV.");
    });
    await renderHome(emptyApi(), failed);
    await click(button("Upload a CSV"));
    expect(document.body.textContent).toContain("The files could not be imported");
    expect(document.body.textContent).toContain("The file is not a CSV.");
    expect(failed.onOpenImport).not.toHaveBeenCalled();
  });

  it("summarises a dataset with data and opens its staged imports, runs and tables", async () => {
    const actions = fakeActions();
    const page = await renderHome(fakeApi(), actions);

    expect(page.textContent).toContain("Sales from Oct 1, 2026 to Oct 31, 2026, complete through Oct 30, 2026.");
    expect(page.textContent).toContain("4,812 rows");
    expect(page.textContent).toContain("9,120 rows");
    expect(page.textContent).toContain("No rows yet");
    expect(page.textContent).toContain("Import: sales_october.csv");
    expect(page.textContent).toContain("Sync: Square");

    await click(button("Continue the import of sales_november.csv"));
    expect(actions.onOpenImport).toHaveBeenCalledWith(12);

    await click(button("View rows of import 40"));
    expect(actions.onBrowse).toHaveBeenCalledWith({ table: "orders", runId: 40 });
    expect(() => button("View rows of import 39")).toThrow('No button "View rows of import 39"');

    await click(button("Report of import 40"));
    expect(actions.onOpenRun).toHaveBeenCalledWith(40);

    await click(button("Browse Line items"));
    expect(actions.onBrowse).toHaveBeenLastCalledWith({ table: "line_items" });
    await click(button("Browse data"));
    expect(actions.onBrowse).toHaveBeenLastCalledWith({ table: "orders" });
  });

  it("lists sources with their coverage and warns when the dataset is nearly full", async () => {
    const page = await renderHome(fakeApi(), fakeActions());

    expect(page.textContent).toContain("Front counter exports");
    expect(page.textContent).toContain("2026-10-01 – 2026-10-31");
    expect(page.textContent).toContain("The dataset is nearly full");
    expect(page.textContent).toContain("7.5 GB of 10 GB");
  });

  it("tells a member who cannot manage that administrators manage sources", async () => {
    const page = await renderHome(fakeApi(), fakeActions());
    expect(page.textContent).toContain("Organization administrators manage sources and settings.");
    cleanup();

    const adminPage = await renderHome(
      fakeApi({ getOverview: vi.fn<HomeApi["getOverview"]>(async () => ({ ...overview, canManage: true })) }),
      fakeActions(),
    );
    expect(adminPage.textContent).not.toContain("Organization administrators manage");
  });

  it("shows why the overview failed, such as a refused session", async () => {
    const page = await renderHome(
      fakeApi({
        getBrowseCatalog: vi.fn<HomeApi["getBrowseCatalog"]>(async () => {
          throw new Error("The active tenant changed.");
        }),
      }),
      fakeActions(),
    );

    expect(page.textContent).toContain("The data overview could not be loaded");
    expect(page.textContent).toContain("The active tenant changed.");
  });
});
