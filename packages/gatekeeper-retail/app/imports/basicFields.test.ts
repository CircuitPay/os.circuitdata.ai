import { describe, expect, it } from "vitest";
import type {
  MappingDocument,
  RunSummary,
  StagedImport,
  StagedImportFile,
} from "../../src/app-api-types";
import {
  basicFields,
  columnOfField,
  previouslyImported,
  rowLevelOf,
  setFieldColumn,
  setRowLevel,
} from "./basicFields";
import { missingRequirements } from "./mapping";

function file(headers: string[], sampleRows: (string | null)[][], name = "sales.csv"): StagedImportFile {
  return {
    rawObjectId: 1,
    name,
    bytes: 2048,
    role: null,
    sniff: { encoding: "utf-8", delimiter: ",", headerRow: 1, footerRows: 0 },
    headers,
    sampleRows,
  };
}

const settings: MappingDocument["settings"] = {
  timezone: "UTC",
  currency: "USD",
  dateFormat: "yyyy-MM-dd",
  decimalMark: ".",
};

function mapping(overrides: Partial<MappingDocument> = {}): MappingDocument {
  return { version: 1, settings, orderKey: null, targets: [], ...overrides };
}

const files = [
  file(
    ["Order ID", "Day", "Opened", "Item", "Qty", "Price", "Total"],
    [
      ["A1", "2026-10-01", "2026-10-01 09:15", "Latte", "2", "4.50", "9.00"],
      ["A2", "", "2026-10-01 09:40", "Mocha", "1", "5.00", "5.00"],
    ],
  ),
];

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
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
    counts: {},
    progress: null,
    warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
    error: null,
    undoOf: null,
    undoneBy: null,
    undo: { possible: true, reason: null },
    files: [{ name: "sales.csv", role: null, bytes: 2048 }],
    ...overrides,
  };
}

const staged: StagedImport = {
  id: 7,
  sourceId: 3,
  sourceLabel: "CSV uploads",
  status: "staged",
  createdBy: "member-1",
  expiresAt: "2026-11-24T10:00:00Z",
  runId: 45,
  files,
  templateMatches: [],
  deterministicMapping: null,
  agentMapping: null,
  missingRequiredFiles: [],
  targets: [],
};

describe("row level", () => {
  it("is item level once any line item target is mapped", () => {
    expect(rowLevelOf(mapping({ targets: [{ target: "orders.total_amount", from: "Total" }] }))).toBe("order");
    expect(rowLevelOf(mapping({ targets: [{ target: "line_items.quantity", from: "Qty" }] }))).toBe("item");
  });

  it("drops the line item targets and their fingerprint paths when switched to order level", () => {
    const itemLevel = mapping({
      targets: [
        { target: "orders.business_date", from: "Day", transform: "date" },
        { target: "orders.total_amount", from: "Total", transform: "money" },
        { target: "line_items.name", from: "Item" },
        { target: "line_items.quantity", from: "Qty", transform: "quantity" },
      ],
      fingerprint: ["orders.business_date", "line_items.name", "line_items.quantity"],
    });

    const orderLevel = setRowLevel(itemLevel, "order");
    expect(orderLevel.targets.map((target) => target.target)).toEqual(["orders.business_date", "orders.total_amount"]);
    expect(orderLevel.fingerprint).toEqual(["orders.business_date", "orders.total_amount"]);
    expect(rowLevelOf(orderLevel)).toBe("order");
    expect(setRowLevel(itemLevel, "item")).toBe(itemLevel);
  });

  it("asks for the date and total of an order, or the date, item and quantity of an item", () => {
    expect(basicFields("order")).toEqual([
      { field: "orderKey", label: "Order identifier", required: false },
      { field: "date", label: "Date", required: true },
      { field: "total", label: "Order total", required: true },
    ]);
    expect(basicFields("item").filter((field) => field.required).map((field) => field.field)).toEqual([
      "orderKey",
      "date",
      "item",
      "quantity",
    ]);
  });
});

describe("fields", () => {
  it("maps a date column without times to the business date and one with times to the opening time", () => {
    const byDay = setFieldColumn(mapping(), "date", "Day", files);
    expect(byDay.targets).toEqual([{ target: "orders.business_date", from: "Day", transform: "date" }]);
    expect(columnOfField(byDay, "date")).toBe("Day");

    const byTime = setFieldColumn(byDay, "date", "Opened", files);
    expect(byTime.targets).toEqual([{ target: "orders.opened_at", from: "Opened", transform: "datetime" }]);
    expect(columnOfField(byTime, "date")).toBe("Opened");

    expect(setFieldColumn(byTime, "date", null, files).targets).toEqual([]);
  });

  it("maps the order total, item, quantity and price with their transforms", () => {
    let mapped = mapping();
    mapped = setFieldColumn(mapped, "total", "Total", files);
    mapped = setFieldColumn(mapped, "item", "Item", files);
    mapped = setFieldColumn(mapped, "quantity", "Qty", files);
    mapped = setFieldColumn(mapped, "price", "Price", files);

    expect(mapped.targets).toEqual([
      { target: "orders.total_amount", from: "Total", transform: "money" },
      { target: "line_items.name", from: "Item" },
      { target: "line_items.quantity", from: "Qty", transform: "quantity" },
      { target: "line_items.unit_price_amount", from: "Price", transform: "money" },
    ]);
    expect(columnOfField(mapped, "price")).toBe("Price");
    expect(rowLevelOf(mapped)).toBe("item");
  });

  it("lets a column feed one target, so choosing it for another field moves it", () => {
    const quantity = setFieldColumn(mapping(), "quantity", "Qty", files);
    const moved = setFieldColumn(quantity, "price", "Qty", files);

    expect(columnOfField(moved, "quantity")).toBeNull();
    expect(columnOfField(moved, "price")).toBe("Qty");
  });

  it("identifies orders by their date and total when an order-level file has no order identifier", () => {
    let mapped = setFieldColumn(mapping({ orderKey: "Order ID" }), "date", "Day", files);
    mapped = setFieldColumn(mapped, "total", "Total", files);
    expect(columnOfField(mapped, "orderKey")).toBe("Order ID");

    const none = setFieldColumn(mapped, "orderKey", null, files);
    expect(none.orderKey).toBeNull();
    expect(none.fingerprint).toEqual(["orders.business_date", "orders.total_amount"]);
    expect(missingRequirements(none, [])).toEqual([]);

    // A field mapped later joins the fingerprint while orders have no key.
    const byTime = setFieldColumn(none, "date", "Opened", files);
    expect(byTime.fingerprint).toEqual(["orders.total_amount", "orders.opened_at"]);
  });

  it("identifies orders by date, item and quantity when an item-level file has no order identifier", () => {
    let mapped = setFieldColumn(mapping(), "date", "Day", files);
    mapped = setFieldColumn(mapped, "item", "Item", files);
    mapped = setFieldColumn(mapped, "quantity", "Qty", files);
    mapped = setFieldColumn(mapped, "total", "Total", files);

    expect(setFieldColumn(mapped, "orderKey", null, files).fingerprint).toEqual([
      "orders.business_date",
      "line_items.name",
      "line_items.quantity",
    ]);
  });

  it("leaves nothing missing for a file with common POS headers, as the header aliases propose it", () => {
    const pos = file(
      ["Order ID", "Date", "Item", "Qty", "Unit Price", "Total"],
      [["1001", "2026-10-01", "Latte", "2", "4.50", "9.00"]],
    );
    // What `aliasMapping` (src/import/propose.ts) proposes for these headers and samples.
    const proposed: MappingDocument = {
      version: 1,
      settings: { timezone: "UTC", currency: "USD", dateFormat: "yyyy-MM-dd", decimalMark: "." },
      orderKey: "Order ID",
      targets: [
        { target: "orders.opened_at", from: "Date", transform: "datetime" },
        { target: "orders.total_amount", from: "Total", transform: "money" },
        { target: "line_items.name", from: "Item" },
        { target: "line_items.quantity", from: "Qty", transform: "quantity" },
        { target: "line_items.unit_price_amount", from: "Unit Price", transform: "money" },
      ],
    };

    expect(missingRequirements(proposed, [])).toEqual([]);
    expect(rowLevelOf(proposed)).toBe("item");
    const fields = basicFields("item").map(({ field }) => [field, columnOfField(proposed, field)]);
    expect(Object.fromEntries(fields)).toEqual({
      orderKey: "Order ID",
      date: "Date",
      item: "Item",
      quantity: "Qty",
      price: "Unit Price",
      total: "Total",
    });
    // Confirming the date in the basic panel keeps the mapping complete.
    const confirmed = setFieldColumn(proposed, "date", "Date", [pos]);
    expect(columnOfField(confirmed, "date")).toBe("Date");
    expect(missingRequirements(confirmed, [])).toEqual([]);
  });
});

describe("previouslyImported", () => {
  it("names the newest succeeded import of the same source that read a file of the same name and size", () => {
    const runs = [
      run({ id: 44, status: "undone" }),
      run({ id: 43, sourceId: 9 }),
      run({ id: 42, files: [{ name: "sales.csv", role: null, bytes: 4096 }] }),
      run({ id: 41, finishedAt: "2026-11-16T10:01:00Z" }),
      run({ id: 40 }),
    ];

    expect(previouslyImported(staged, runs)).toEqual({ runId: 41, at: "2026-11-16T10:01:00Z" });
    expect(previouslyImported(staged, runs.slice(0, 3))).toBeNull();
  });
});
