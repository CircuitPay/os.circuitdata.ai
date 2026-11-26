// Mapping-editor logic over the mapping document (contracts/mapping-document.md). The import engine
// validates the document again on preview and import; this only keeps the editor honest about what
// is still missing.

import type {
  ColumnRef,
  MappingDocument,
  MappingTarget,
  MappingTransform,
  StagedImportFile,
  TargetInfo,
} from "../../src/app-api-types";

/** One source column the editor offers as a row. */
export type SourceColumn = {
  /** Stable string form of `ref`, for keys and select values. */
  key: string;
  ref: ColumnRef;
  fileIndex: number;
  file: StagedImportFile;
  column: string;
  /** The column's value in the first sample row. */
  sample: string | null;
};

export function columnKey(ref: ColumnRef): string {
  return JSON.stringify(ref);
}

export function sameColumn(a: ColumnRef, b: ColumnRef): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.file === b.file && a.column === b.column;
}

export function sourceColumns(files: StagedImportFile[], mapping: MappingDocument): SourceColumn[] {
  const byRole = mapping.files !== undefined || files.length > 1;
  return files.flatMap((file, fileIndex) =>
    file.headers.map((column, index) => {
      // A file set (or a mapping that declares one) names columns as `{ file: role, column }`.
      const ref: ColumnRef = byRole ? { file: file.role ?? file.name, column } : column;
      return {
        key: columnKey(ref),
        ref,
        fileIndex,
        file,
        column,
        sample: file.sampleRows[0]?.[index] ?? null,
      };
    }),
  );
}

export function columnLabel(ref: ColumnRef): string {
  return typeof ref === "string" ? ref : `${ref.file} › ${ref.column}`;
}

/** The first target read from a column; the editor's row shows and edits this one. */
export function targetOfColumn(mapping: MappingDocument, ref: ColumnRef): MappingTarget | undefined {
  return mapping.targets.find((target) => target.from !== null && sameColumn(target.from, ref));
}

const DEFAULT_TRANSFORMS: Partial<Record<TargetInfo["kind"], MappingTransform>> = {
  money: "money",
  datetime: "datetime",
  date: "date",
  time: "time",
  quantity: "quantity",
  boolean: "boolean",
};

/**
 * Maps a column to `target` (or unmaps it for null). A target reads one column, so whatever else
 * fed that target (another column or a constant) is dropped. Fingerprint paths that are no longer
 * mapped are dropped too.
 */
export function assignColumn(
  mapping: MappingDocument,
  ref: ColumnRef,
  target: Pick<TargetInfo, "path" | "kind"> | null,
): MappingDocument {
  const current = targetOfColumn(mapping, ref);
  let replacement: MappingTarget | null = null;
  if (target !== null) {
    replacement = { target: target.path, from: ref };
    const transform = DEFAULT_TRANSFORMS[target.kind];
    if (transform) replacement.transform = transform;
  }
  const targets = mapping.targets.flatMap((entry) => {
    if (entry === current) return replacement ? [replacement] : [];
    return replacement && entry.target === replacement.target ? [] : [entry];
  });
  if (replacement && !current) targets.push(replacement);
  return withFingerprintPruned({ ...mapping, targets });
}

export function setColumnTransform(
  mapping: MappingDocument,
  ref: ColumnRef,
  transform: MappingTransform | null,
): MappingDocument {
  const current = targetOfColumn(mapping, ref);
  if (!current) return mapping;
  return {
    ...mapping,
    targets: mapping.targets.map((entry) => {
      if (entry !== current) return entry;
      const { transform: _previous, ...rest } = entry;
      return transform === null ? rest : { ...rest, transform };
    }),
  };
}

/** Drops fingerprint paths no target maps any more. */
export function withFingerprintPruned(mapping: MappingDocument): MappingDocument {
  if (!mapping.fingerprint) return mapping;
  const mapped = new Set(mapping.targets.map((target) => target.target));
  return { ...mapping, fingerprint: mapping.fingerprint.filter((path) => mapped.has(path)) };
}

/** A fresh mapping for files no template recognised; the member confirms each setting (US2.6). */
export function blankMapping(): MappingDocument {
  return {
    version: 1,
    settings: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      currency: "",
      dateFormat: "",
      decimalMark: ".",
    },
    orderKey: null,
    targets: [],
  };
}

const BUSINESS_DATE_TARGETS = ["orders.business_date", "orders.opened_at", "orders.closed_at"];

/**
 * What the mapping still lacks before it can be imported, worded for the member: the required
 * targets of `orders` and `line_items`, the order key or fingerprint, and the settings a file
 * cannot state.
 */
export function missingRequirements(mapping: MappingDocument, targets: TargetInfo[]): string[] {
  const label = (path: string) => targets.find((target) => target.path === path)?.label ?? path;
  const mapped = new Set(mapping.targets.map((target) => target.target));
  const tables = new Set([...mapped].map((path) => path.split(".")[0]));
  const { settings } = mapping;
  const missing: string[] = [];

  if (mapped.size === 0 || tables.has("orders") || tables.has("line_items")) {
    if (
      !BUSINESS_DATE_TARGETS.some((path) => mapped.has(path)) &&
      settings.businessDate !== "from_file_date"
    ) {
      missing.push(
        `A business date: map ${BUSINESS_DATE_TARGETS.map(label).join(", ")}, or take it from the file's date`,
      );
    }
    if (settings.businessDate === "from_file_date" && !settings.fileDate) {
      missing.push("The business date of the file");
    }
    if (!mapped.has("orders.total_amount") && !tables.has("line_items")) {
      missing.push(`An order total: map ${label("orders.total_amount")}, or map line items`);
    }
    if (!mapped.has("orders.currency") && !settings.currency.trim()) {
      missing.push(`A currency: map ${label("orders.currency")}, or set the currency`);
    }
    if (mapping.orderKey === null && !mapping.fingerprint?.length) {
      missing.push("An order key, or the fields that identify an order without one");
    }
  }
  if (tables.has("line_items")) {
    for (const path of ["line_items.name", "line_items.quantity"]) {
      if (!mapped.has(path)) missing.push(label(path));
    }
  }
  if (!settings.timezone.trim()) missing.push("A timezone");
  if (!settings.dateFormat.trim()) missing.push("A date format");
  return missing;
}
