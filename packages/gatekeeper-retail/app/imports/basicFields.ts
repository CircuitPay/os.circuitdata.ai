// The basic mapping (research R3): the few fields an import cannot do without, read from and
// written to the same mapping document the full editor edits, so switching between them loses
// nothing.

import type {
  ColumnRef,
  MappingDocument,
  MappingTarget,
  RunSummary,
  StagedImport,
  StagedImportFile,
  TargetInfo,
} from "../../src/app-api-types";
import { assignColumn, withFingerprintPruned } from "./mapping";

export type RowLevel = "order" | "item";

export type BasicField = "orderKey" | "date" | "total" | "item" | "quantity" | "price";

type BasicTarget = Pick<TargetInfo, "path" | "kind">;

const BUSINESS_DATE: BasicTarget = { path: "orders.business_date", kind: "date" };
const OPENED_AT: BasicTarget = { path: "orders.opened_at", kind: "datetime" };

/** Targets the date field may hold, in the order it reads them. */
const DATE_PATHS = ["orders.business_date", "orders.opened_at", "orders.closed_at"];

const COLUMN_TARGETS: Record<Exclude<BasicField, "orderKey" | "date">, BasicTarget> = {
  total: { path: "orders.total_amount", kind: "money" },
  item: { path: "line_items.name", kind: "text" },
  quantity: { path: "line_items.quantity", kind: "quantity" },
  price: { path: "line_items.unit_price_amount", kind: "money" },
};

const FIELD_LABELS: Record<BasicField, string> = {
  orderKey: "Order identifier",
  date: "Date",
  total: "Order total",
  item: "Item",
  quantity: "Quantity",
  price: "Item price",
};

/** Item level as soon as any line item target is mapped. */
export function rowLevelOf(mapping: MappingDocument): RowLevel {
  return mapping.targets.some((target) => target.target.startsWith("line_items.")) ? "item" : "order";
}

/**
 * Order level drops every line item target. Item level changes nothing by itself: it shows the
 * item fields, and mapping one of them makes the mapping item level.
 */
export function setRowLevel(mapping: MappingDocument, level: RowLevel): MappingDocument {
  if (level === "item") return mapping;
  return withBasicFingerprint(
    withFingerprintPruned({
      ...mapping,
      targets: mapping.targets.filter((target) => !target.target.startsWith("line_items.")),
    }),
  );
}

/** The fields the basic mapping asks for at a row level, required ones as spec 006 needs them. */
export function basicFields(level: RowLevel): { field: BasicField; label: string; required: boolean }[] {
  const fields: [BasicField, boolean][] =
    level === "order"
      ? [["orderKey", false], ["date", true], ["total", true]]
      : [["orderKey", true], ["date", true], ["item", true], ["quantity", true], ["price", false], ["total", false]];
  return fields.map(([field, required]) => ({ field, label: FIELD_LABELS[field], required }));
}

/** The target a field holds: the first date target that reads a column, or the field's own. */
function fieldTarget(mapping: MappingDocument, field: Exclude<BasicField, "orderKey">): MappingTarget | undefined {
  const paths = field === "date" ? DATE_PATHS : [COLUMN_TARGETS[field].path];
  for (const path of paths) {
    const target = mapping.targets.find((entry) => entry.target === path && entry.from !== null);
    if (target) return target;
  }
  return undefined;
}

export function columnOfField(mapping: MappingDocument, field: BasicField): ColumnRef | null {
  if (field === "orderKey") return mapping.orderKey;
  return fieldTarget(mapping, field)?.from ?? null;
}

/**
 * Points a field at a column, or clears it for null. A date column whose samples carry no time
 * feeds the business date; one with times feeds the order's opening time, from which the import
 * derives the business date. No order key ("None: each row is one order") identifies orders by
 * the basic fields instead.
 */
export function setFieldColumn(
  mapping: MappingDocument,
  field: BasicField,
  column: ColumnRef | null,
  files: StagedImportFile[],
): MappingDocument {
  if (field === "orderKey") {
    return column === null
      ? { ...mapping, orderKey: null, fingerprint: basicFingerprint(mapping) }
      : { ...mapping, orderKey: column };
  }
  let next = mapping;
  const held = fieldTarget(mapping, field);
  if (held) next = withFingerprintPruned({ ...next, targets: next.targets.filter((target) => target !== held) });
  if (column !== null) {
    const target =
      field === "date" ? (columnSamples(files, column).some(hasTime) ? OPENED_AT : BUSINESS_DATE) : COLUMN_TARGETS[field];
    next = assignColumn(next, column, target);
  }
  return withBasicFingerprint(next);
}

/** The basic fields that identify an order without a key: date and total, or date, item and quantity. */
function basicFingerprint(mapping: MappingDocument): string[] {
  const fields: Exclude<BasicField, "orderKey">[] =
    rowLevelOf(mapping) === "order" ? ["date", "total"] : ["date", "item", "quantity"];
  return fields.flatMap((field) => {
    const target = fieldTarget(mapping, field);
    return target ? [target.target] : [];
  });
}

/**
 * While orders are identified without a key, a newly mapped basic field joins the fingerprint.
 * Paths the member chose in the full editor stay.
 */
function withBasicFingerprint(mapping: MappingDocument): MappingDocument {
  if (mapping.orderKey !== null || !mapping.fingerprint?.length) return mapping;
  const fingerprint = [...mapping.fingerprint];
  for (const path of basicFingerprint(mapping)) {
    if (!fingerprint.includes(path)) fingerprint.push(path);
  }
  return { ...mapping, fingerprint };
}

function columnSamples(files: StagedImportFile[], ref: ColumnRef): string[] {
  const column = typeof ref === "string" ? ref : ref.column;
  const file =
    typeof ref === "string"
      ? files.find((entry) => entry.headers.includes(ref))
      : files.find((entry) => (entry.role ?? entry.name) === ref.file);
  const index = file ? file.headers.indexOf(column) : -1;
  if (!file || index < 0) return [];
  return file.sampleRows.flatMap((row) => {
    const value = row[index]?.trim();
    return value ? [value] : [];
  });
}

const hasTime = (value: string) => /\d{1,2}:\d{2}/.test(value);

/**
 * The newest succeeded import into the same source that read a file with a staged file's name and
 * size. Importing into the same source again updates its rows, so this is what the member is told;
 * another source would hold separate rows.
 */
export function previouslyImported(
  staged: StagedImport,
  runs: RunSummary[],
): { runId: number; at: string } | null {
  const run = runs.find(
    (candidate) =>
      candidate.kind === "import" &&
      candidate.status === "succeeded" &&
      candidate.sourceId === staged.sourceId &&
      candidate.files.some((file) =>
        staged.files.some((stagedFile) => stagedFile.name === file.name && stagedFile.bytes === file.bytes),
      ),
  );
  return run ? { runId: run.id, at: run.finishedAt ?? run.startedAt } : null;
}
