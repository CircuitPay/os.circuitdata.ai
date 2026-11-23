// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoverageReport, RowLineage, RunSummary } from "../../src/app-api-types";
import { button, cleanup, click, field, render, type } from "../testDom";
import CoveragePage, { type CoverageApi } from "./CoveragePage";

const report: CoverageReport = {
  sources: [{ id: 3, kind: "csv", label: "Front counter exports", status: "imported", lastSuccessAt: null }],
  ranges: [{ locationId: 1, sourceId: 3, from: "2026-10-01", to: "2026-10-31" }],
  possibleGaps: [{ locationId: 1, businessDate: "2026-10-13" }],
};

const rejectingRun: RunSummary = {
  id: 40,
  sourceId: 3,
  sourceLabel: "Front counter exports",
  kind: "import",
  status: "succeeded",
  templateVersionId: null,
  mappingVersion: "import-7",
  startedBy: "member-1",
  startedAt: "2026-11-17T10:00:00Z",
  finishedAt: "2026-11-17T10:01:00Z",
  counts: { line_items: { fetched: 10, written: 8, updated: 0, skipped: 0, rejected: 2 } },
  progress: null,
  warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
  error: null,
  undoOf: null,
  undoneBy: null,
  undo: { possible: true, reason: null },
  files: [],
};

const lineage: RowLineage = {
  table: "orders",
  id: 12,
  source: { id: 3, kind: "csv", label: "Front counter exports" },
  sourceRecordId: "A1",
  run: { id: 40, kind: "import", finishedAt: "2026-11-17T10:01:00Z" },
  mappingVersion: "import-7",
  file: { name: "sales_october.csv", row: 3 },
};

function fakeApi() {
  return {
    getCoverage: vi.fn<CoverageApi["getCoverage"]>(async () => report),
    getLineage: vi.fn<CoverageApi["getLineage"]>(async () => lineage),
    listRuns: vi.fn<CoverageApi["listRuns"]>(async () => ({
      items: [rejectingRun, { ...rejectingRun, id: 39, counts: {} }],
      nextAfter: null,
    })),
    listRejections: vi.fn<CoverageApi["listRejections"]>(async () => ({
      items: [{ id: 1, table: "line_items", file: "sales_october.csv", row: 3, reason: "bad_quantity", column: "Qty", detail: "not a number" }],
      nextAfter: null,
    })),
  };
}

afterEach(cleanup);

describe("CoveragePage", () => {
  it("shows covered dates per location and source, and flags possible gaps", async () => {
    const api = fakeApi();
    await render(<CoveragePage api={api} />);

    expect(api.getCoverage).toHaveBeenCalledWith({ from: undefined, to: undefined, locationIds: undefined });
    expect(document.body.textContent).toContain("Front counter exports");
    expect(document.body.textContent).toContain("2026-10-31");
    expect(document.body.textContent).toContain("Location 1: Tuesday 2026-10-13");
  });

  it("filters by date range and location", async () => {
    const api = fakeApi();
    await render(<CoveragePage api={api} />);

    await type(field("From"), "2026-10-01");
    await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
    await click(button("Show coverage"));
    expect(api.getCoverage).toHaveBeenLastCalledWith({ from: "2026-10-01", to: undefined, locationIds: [1] });
  });

  it("opens the rejected rows of runs that rejected any", async () => {
    const api = fakeApi();
    await render(<CoveragePage api={api} />);

    const toggle = button(
      `Import into Front counter exports, ${new Date(rejectingRun.startedAt).toLocaleString()}: 2 rejected rows`,
    );
    expect(document.body.textContent).not.toContain("0 rejected rows");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(api.listRejections).toHaveBeenCalledWith(40, { limit: 50 });
    expect(document.getElementById("run-40-rejections")!.textContent).toContain("not a number");
  });

  it("traces a row to its source, run, mapping version, file and row", async () => {
    const api = fakeApi();
    await render(<CoveragePage api={api} />);

    await type(field("Row id"), "12");
    await click(button("Trace"));
    expect(api.getLineage).toHaveBeenCalledWith("orders", 12);
    const text = document.body.textContent;
    expect(text).toContain("Front counter exports (CSV import)");
    expect(text).toContain("Import 40");
    expect(text).toContain("import-7");
    expect(text).toContain("sales_october.csv, row 3");
  });

  it("shows why a row cannot be traced", async () => {
    const getLineage = vi.fn<CoverageApi["getLineage"]>(async () => {
      throw new Error("No orders row 99.");
    });
    const api = { ...fakeApi(), getLineage };
    await render(<CoveragePage api={api} />);

    await type(field("Row id"), "99");
    await click(button("Trace"));
    expect(document.body.textContent).toContain("No orders row 99.");
  });
});
