// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowseCatalog,
  BrowseColumn,
  BrowsePage as BrowsePageData,
  BrowseQuery,
  BrowseTable,
  RowDetail,
  RunSummary,
} from "../../src/app-api-types";
import { button, choose, cleanup, click, field, render, settle, type } from "../testDom";
import BrowsePage, { type BrowseApi, type BrowseRequest } from "./BrowsePage";

const orderColumns: BrowseColumn[] = [
  { name: "business_date", type: "date", description: "The trading day the order counts towards." },
  { name: "order_number", type: "text" },
  { name: "total_amount", type: "money", currencyColumn: "currency" },
  { name: "currency", type: "text" },
];

const lineColumns: BrowseColumn[] = [
  { name: "order_id", type: "integer" },
  { name: "name", type: "text" },
  { name: "quantity", type: "real" },
];

const customerColumns: BrowseColumn[] = [
  { name: "first_name", type: "text", personal: true },
  { name: "email", type: "text", personal: true },
];

const catalog: BrowseCatalog = {
  tables: [
    {
      name: "orders",
      label: "Orders",
      description: "One row per sale.",
      rows: 4812,
      dateColumn: "business_date",
      search: { columns: ["order_number"], label: "order number" },
      gridColumns: orderColumns,
    },
    {
      name: "line_items",
      label: "Line items",
      description: "What each order sold.",
      rows: 9120,
      dateColumn: "business_date",
      search: { columns: ["name"], label: "item name" },
      gridColumns: lineColumns,
    },
    {
      name: "customers",
      label: "Customers",
      description: "People who bought.",
      rows: 3,
      dateColumn: null,
      search: { columns: ["first_name", "last_name", "email"], label: "name or email" },
      gridColumns: customerColumns,
    },
    {
      name: "inventory",
      label: "Inventory",
      description: "Stock on hand.",
      rows: 0,
      dateColumn: null,
      search: null,
      gridColumns: [],
    },
  ],
  dateRange: { from: "2026-10-01", to: "2026-10-31" },
  completeThrough: "2026-10-31",
  personalDataMasked: true,
  sources: [{ id: 3, kind: "csv", label: "Front counter exports" }],
};

const importRun: RunSummary = {
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
  counts: {},
  progress: null,
  warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
  error: null,
  undoOf: null,
  undoneBy: null,
  undo: { possible: true, reason: null },
  files: [{ name: "sales_october.csv", role: null, bytes: 2048 }],
};

function page(table: BrowseTable, query: BrowseQuery | undefined, total: number): BrowsePageData {
  const offset = query?.offset ?? 0;
  const count = Math.max(0, Math.min(100, total - offset));
  const columns = catalog.tables.find((entry) => entry.name === table)!.gridColumns;
  return {
    table,
    columns,
    rows: Array.from({ length: count }, (_, index) => {
      const id = total - offset - index;
      return {
        id,
        values: table === "orders" ? ["2026-10-01", `A${id}`, 900, "USD"] : columns.map(() => "Hidden"),
      };
    }),
    offset,
    total,
    pageSize: 100,
    narrowedTo: null,
  };
}

const orderDetail: RowDetail = {
  table: "orders",
  id: 4812,
  fields: [
    { column: { name: "id", type: "integer" }, value: 4812 },
    { column: orderColumns[0], value: "2026-10-01" },
    { column: orderColumns[2], value: 900 },
    { column: orderColumns[3], value: "USD" },
    { column: { name: "notes", type: "text" }, value: null },
  ],
  related: [
    { table: "line_items", label: "Line items", columns: lineColumns, rows: [{ id: 70, values: [4812, "Latte", 2] }], truncated: false },
    { table: "transactions", label: "Payments", columns: [], rows: [], truncated: false },
  ],
  origin: {
    table: "orders",
    id: 4812,
    source: { id: 3, kind: "csv", label: "Front counter exports" },
    sourceRecordId: "A4812",
    run: { id: 40, kind: "import", finishedAt: "2026-11-17T10:01:00Z" },
    mappingVersion: "import-7",
    file: { name: "sales_october.csv", row: 2 },
  },
};

const lineDetail: RowDetail = {
  table: "line_items",
  id: 70,
  fields: [{ column: { name: "name", type: "text" }, value: "Latte" }],
  related: [],
  origin: null,
};

function fakeApi(overrides: Partial<BrowseApi> = {}) {
  return {
    getBrowseCatalog: vi.fn<BrowseApi["getBrowseCatalog"]>(async () => catalog),
    listRuns: vi.fn<BrowseApi["listRuns"]>(async () => ({ items: [importRun], nextAfter: null })),
    browseRows: vi.fn<BrowseApi["browseRows"]>(async (table, query) =>
      page(table, query, catalog.tables.find((entry) => entry.name === table)!.rows),
    ),
    getRowDetail: vi.fn<BrowseApi["getRowDetail"]>(async (table) => (table === "orders" ? orderDetail : lineDetail)),
    ...overrides,
  };
}

async function renderBrowse(api: BrowseApi, request?: BrowseRequest) {
  const view = await render(<BrowsePage api={api} request={request} />);
  await settle();
  return view;
}

const position = () => document.querySelector('[aria-live="polite"]')?.textContent;
const visible = (element: Element) => element.closest("[hidden]") === null;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BrowsePage", () => {
  it("lists every table with its row count and description, and says when one is empty", async () => {
    const view = await renderBrowse(fakeApi());
    const tables = view.querySelector('nav[aria-label="Tables"]')!.textContent;

    expect(tables).toContain("Orders4,812 rows · One row per sale.");
    expect(tables).toContain("Line items9,120 rows");
    expect(tables).toContain("InventoryNo rows yet · Stock on hand.");
    expect(button("Orders").getAttribute("aria-current")).toBe("true");
  });

  it("shows rows under the schema's names with money in its currency and readable dates", async () => {
    const view = await renderBrowse(fakeApi());
    const headers = [...view.querySelectorAll("thead th")].map((cell) => cell.textContent);
    expect(headers).toEqual(["id", "business_date", "order_number", "total_amount", "currency"]);

    const firstRow = view.querySelector("tbody tr")!.textContent;
    expect(firstRow).toContain("Oct 1, 2026");
    expect(firstRow).toContain("$9.00");
    expect(view.querySelector("caption")!.textContent).toBe("Orders");
  });

  it("passes the date range, import and search to browseRows as values", async () => {
    const api = fakeApi();
    await renderBrowse(api);
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", {});

    await type(field("From"), "2026-10-01");
    await type(field("To"), "2026-10-15");
    await settle();
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", { from: "2026-10-01", to: "2026-10-15" });

    await choose("Rows from", "Import 40: sales_october.csv, Nov 17, 2026");
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", { from: "2026-10-01", to: "2026-10-15", runId: 40 });

    const search = field("Search");
    await type(search, "A1'); DROP TABLE store_orders; --");
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", {
      from: "2026-10-01",
      to: "2026-10-15",
      runId: 40,
      search: "A1'); DROP TABLE store_orders; --",
    });
    expect(document.querySelector("caption")!.textContent).toBe(
      "Orders, Oct 1, 2026 – Oct 15, 2026, rows from Import 40: sales_october.csv, Nov 17, 2026, matching “A1'); DROP TABLE store_orders; --”",
    );

    await choose("Rows from", "Front counter exports (CSV import)");
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", {
      from: "2026-10-01",
      to: "2026-10-15",
      sourceId: 3,
      search: "A1'); DROP TABLE store_orders; --",
    });
  });

  it("applies a search after a pause in typing", async () => {
    const api = fakeApi();
    await renderBrowse(api);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await type(field("Search"), "A48");
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", {});
    await act(() => vi.advanceTimersByTimeAsync(500));
    await settle();
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", { search: "A48" });
  });

  it("pages forward and back, announcing where the member is", async () => {
    const api = fakeApi();
    await renderBrowse(api);
    expect(position()).toBe("1–100 of 4,812");
    expect(button("Previous").disabled).toBe(true);

    await click(button("Next"));
    await click(button("Next"));
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", { offset: 200 });
    expect(position()).toBe("201–300 of 4,812");

    await click(button("Previous"));
    expect(api.browseRows).toHaveBeenLastCalledWith("orders", { offset: 100 });
    expect(position()).toBe("101–200 of 4,812");
  });

  it("says when a large table opened on a recent period", async () => {
    const api = fakeApi({
      browseRows: vi.fn<BrowseApi["browseRows"]>(async (table, query) => ({
        ...page(table, query, 120),
        narrowedTo: { from: "2026-10-02", to: "2026-10-31" },
      })),
    });
    await renderBrowse(api);

    expect(document.body.textContent).toContain(
      "This table is large, so it opens on Oct 2, 2026 – Oct 31, 2026. Choose dates to see others.",
    );
  });

  it("says that customers' personal data is hidden", async () => {
    const api = fakeApi();
    await renderBrowse(api);
    expect(document.body.textContent).not.toContain("Names, emails and phone numbers are hidden.");

    await click(button("Customers"));
    expect(api.browseRows).toHaveBeenLastCalledWith("customers", {});
    expect(document.body.textContent).toContain(
      "Names, emails and phone numbers are hidden.An administrator can show them in Settings.",
    );
    expect(() => field("From")).toThrow('No field labelled "From"');
  });

  it("opens a row with its fields, related rows and origin, and returns focus to each opener", async () => {
    const api = fakeApi();
    await renderBrowse(api);

    const opener = button("Open row 4812");
    await click(opener);
    expect(api.getRowDetail).toHaveBeenCalledWith("orders", 4812);
    const heading = document.activeElement!;
    expect(heading.textContent).toBe("Orders row 4812");
    expect(visible(opener)).toBe(false);
    const detail = heading.closest("div:not([hidden])")!.parentElement!;
    expect(detail.textContent).toContain("From Front counter exports · import #40 · sales_october.csv, row 2");
    expect(detail.textContent).toContain("The trading day the order counts towards.");
    expect(detail.textContent).toContain("$9.00");
    expect(detail.textContent).toContain("notes–");
    expect(detail.textContent).toContain("PaymentsNone.");

    const related = button("Open row 70");
    await click(related);
    expect(api.getRowDetail).toHaveBeenLastCalledWith("line_items", 70);
    expect(document.activeElement!.textContent).toBe("Line items row 70");

    await click(button("Back", document.activeElement!.closest("div:not([hidden])")!.parentElement!));
    expect(document.activeElement).toBe(related);
    expect(visible(related)).toBe(true);

    const backButtons = [...document.querySelectorAll("button")].filter(
      (element) => element.textContent === "Back" && visible(element),
    );
    await click(backButtons[0]);
    expect(document.activeElement).toBe(opener);
    expect(visible(opener)).toBe(true);
  });

  it("returns to the table with the message when the row no longer exists", async () => {
    const api = fakeApi({
      getRowDetail: vi.fn<BrowseApi["getRowDetail"]>(async () => {
        throw new Error("This row no longer exists.");
      }),
    });
    await renderBrowse(api);

    const opener = button("Open row 4812");
    await click(opener);
    expect(visible(opener)).toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(document.body.textContent).toContain("The row could not be opened");
    expect(document.body.textContent).toContain("This row no longer exists.");
  });

  it("opens on the table and import another panel asks for", async () => {
    const api = fakeApi();
    await renderBrowse(api, { table: "line_items", runId: 40, seq: 1 });

    expect(api.browseRows).toHaveBeenCalledWith("line_items", { runId: 40 });
    expect(button("Line items").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Line items");
  });
});
