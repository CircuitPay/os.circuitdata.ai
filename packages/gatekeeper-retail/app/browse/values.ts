import type { BrowseColumn, BrowseRow } from "../../src/app-api-types";
import { formatDate, formatDateTime, formatMoney } from "../format";

export type BrowseValue = BrowseRow["values"][number];

/** How an absent value reads. */
export const ABSENT = "–";

function summarizeJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (Array.isArray(parsed)) return `${parsed.length} ${parsed.length === 1 ? "item" : "items"}`;
  if (parsed !== null && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    if (keys.length === 0) return "Empty";
    return keys.length > 3 ? `${keys.slice(0, 3).join(", ")}, …` : keys.join(", ");
  }
  return String(parsed);
}

/**
 * A value as Browse shows it: money in its row's currency, dates and times readably, booleans as
 * Yes or No. JSON is summarised in a grid and shown in full in the row detail.
 */
export function formatValue(
  column: BrowseColumn,
  value: BrowseValue,
  currency: BrowseValue,
  mode: "grid" | "detail",
): string {
  if (value === null) return ABSENT;
  switch (column.type) {
    case "money":
      return typeof value === "number" && typeof currency === "string" && currency !== ""
        ? formatMoney(value, currency)
        : String(value);
    case "date":
      return typeof value === "string" ? formatDate(value) : String(value);
    case "timestamp":
      return typeof value === "string" ? formatDateTime(value) : String(value);
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "json":
      return mode === "grid" ? summarizeJson(String(value)) : String(value);
    case "integer":
    case "real": {
      // Ids and foreign keys read as written, without digit grouping.
      const key = column.name === "id" || column.name.endsWith("_id");
      return typeof value === "number" && !key ? value.toLocaleString() : String(value);
    }
    case "text":
      return String(value);
  }
}

/** The value of a money column's currency column in the same row, if the row carries it. */
export function currencyOf(
  column: BrowseColumn,
  columns: BrowseColumn[],
  values: BrowseValue[],
): BrowseValue {
  if (!column.currencyColumn) return null;
  const index = columns.findIndex((entry) => entry.name === column.currencyColumn);
  return index < 0 ? null : (values[index] ?? null);
}
