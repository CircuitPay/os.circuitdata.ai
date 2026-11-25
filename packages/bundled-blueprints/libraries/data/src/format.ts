/**
 * How a result's values read: money, numbers, dates, percentages and ages.
 *
 * Money arrives as integer minor units beside a currency code. `Intl.NumberFormat` knows how many
 * minor-unit digits each currency has (2 for USD, 0 for JPY, 3 for KWD), so the amount is scaled
 * by exactly that and no table of currencies lives here. Nothing in this module adds two amounts.
 *
 * Every function is a pure function of its arguments and the locale. With no locale given the
 * output is {@link DEFAULT_LOCALE}'s, the same in a browser, a Durable Object and a test.
 */

import type { ResultColumn } from "./model.ts";
import { describeRange, isIsoDate } from "./period.ts";
import type { Scalar } from "./retail.ts";

/** The locale used when a caller names none: the one the formats' own wording is written in. */
export const DEFAULT_LOCALE = "en-US";

/** What stands in a cell that has no value. */
export const EMPTY_VALUE = "–";

const numberFormats = new Map<string, Intl.NumberFormat>();

/** A cached formatter. A locale `Intl` does not accept falls back to the default one. */
function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? DEFAULT_LOCALE}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    try {
      format = new Intl.NumberFormat(locale ?? DEFAULT_LOCALE, options);
    } catch (error) {
      if (locale === undefined || locale === DEFAULT_LOCALE) throw error;
      format = numberFormat(DEFAULT_LOCALE, options);
    }
    numberFormats.set(key, format);
  }
  return format;
}

/** The currency formatter for a code, or null when the code is not one `Intl` accepts (three letters). */
function currencyFormat(currency: string, locale: string | undefined, compact: boolean): Intl.NumberFormat | null {
  if (!/^[A-Za-z]{3}$/.test(currency)) return null;
  return numberFormat(locale, compact
    ? { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }
    : { style: "currency", currency });
}

/** How many minor-unit digits a currency has (2 for USD, 0 for JPY, 3 for KWD); 0 for a code `Intl` does not accept. */
export function currencyDigits(currency: string, locale?: string): number {
  return currencyFormat(currency, locale, false)?.resolvedOptions().maximumFractionDigits ?? 0;
}

/** An amount in minor units as money: `formatMoney(1299, "USD")` is `$12.99`, `formatMoney(1299, "JPY")` is `¥1,299`. */
export function formatMoney(minorUnits: number, currency: string, locale?: string): string {
  const format = currencyFormat(currency, locale, false);
  // With no usable currency the scale is unknown, so the units are shown as they are, named.
  if (!format) return `${numberFormat(locale, { maximumFractionDigits: 0 }).format(minorUnits)} ${currency}`.trim();
  return format.format(minorUnits / 10 ** currencyDigits(currency, locale));
}

/** An amount in minor units in short form, for an axis: `$12.3K`. */
export function formatMoneyCompact(minorUnits: number, currency: string, locale?: string): string {
  const format = currencyFormat(currency, locale, true);
  if (!format) return formatCompact(minorUnits, locale);
  return format.format(minorUnits / 10 ** currencyDigits(currency, locale));
}

/** A number in short form, for an axis: `950`, `1.2K`, `3.4M`, and `0.25` for a fraction. */
export function formatCompact(value: number, locale?: string): string {
  const fraction = value !== 0 && Math.abs(value) < 1;
  return numberFormat(locale, { notation: "compact", maximumFractionDigits: fraction ? 2 : 1 }).format(value);
}

/**
 * A business date for reading: `31 Oct 2026` with no locale, the locale's medium date with one.
 * A timestamp is read for its date. Text that is not a date comes back as it is.
 */
export function formatDate(iso: string, locale?: string): string {
  const date = typeof iso === "string" ? iso.slice(0, 10) : "";
  if (!isIsoDate(date)) return String(iso);
  if (locale === undefined) return describeRange({ from: date, to: date });
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return describeRange({ from: date, to: date });
  }
}

/** A UTC timestamp for reading: `31 Oct 2026, 14:03 UTC`. */
function formatTimestamp(iso: string, locale?: string): string {
  const time = /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2})/.exec(iso);
  if (!time || !isIsoDate(iso.slice(0, 10))) return iso;
  return `${formatDate(iso, locale)}, ${time[1]} UTC`;
}

/** A `YYYY-MM` month for reading: `Oct 2026`. */
function formatMonth(month: string, locale?: string): string {
  if (!isIsoDate(`${month}-01`)) return month;
  try {
    return new Intl.DateTimeFormat(locale ?? DEFAULT_LOCALE, { month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${month}-01T00:00:00Z`));
  } catch {
    return month;
  }
}

/** Whether a column holds amounts or counts: the columns a table aligns right and a chart can plot. */
export function isNumericColumn(column: ResultColumn): boolean {
  return column.type === "integer" || column.type === "real" || column.type === "money";
}

/** Whether a column holds identifiers (`id`, `location_id`): whole numbers that are names, never amounts. */
export function isIdColumn(column: ResultColumn): boolean {
  return column.type === "integer" && /(^|_)id$/i.test(column.name);
}

/** The heading a column is shown under: its label, or its name in words (`net_amount` reads `Net amount`). */
export function columnHeading(column: ResultColumn): string {
  if (column.label && column.label !== "%") return column.label;
  const words = column.name.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One cell as a person reads it. Money takes its currency from the row (`row` and `columns` are
 * the cell's own); a `real` column labelled `%` is a ratio shown as a percentage; a `month`
 * column's `YYYY-MM` reads `Oct 2026`; identifiers and years are not grouped into thousands; an
 * absent value is a dash.
 */
export function formatValue(value: Scalar, column: ResultColumn, row: Scalar[], columns: ResultColumn[], locale?: string): string {
  if (value === null || value === undefined) return EMPTY_VALUE;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") {
    if (column.type === "date") return formatDate(value, locale);
    if (column.type === "timestamp") return formatTimestamp(value, locale);
    if (column.name === "month" && /^\d{4}-\d{2}$/.test(value)) return formatMonth(value, locale);
    return value;
  }
  if (!Number.isFinite(value)) return EMPTY_VALUE;
  if (column.type === "money") {
    const currency = column.currencyColumn === undefined
      ? null
      : row[columns.findIndex(candidate => candidate.name === column.currencyColumn)];
    if (typeof currency === "string" && currency !== "") return formatMoney(value, currency, locale);
    return numberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  }
  if (column.type === "real" && column.label === "%") return formatPercent(value, locale);
  if (isIdColumn(column) || /(^|_)year$/i.test(column.name)) return String(value);
  return numberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** A ratio as a percentage: `formatPercent(0.082)` is `8.2%`, and `+8.2%` when `signed`. */
export function formatPercent(ratio: number, locale?: string, signed = false): string {
  const options: Intl.NumberFormatOptions = { style: "percent", maximumFractionDigits: 1 };
  if (signed) options.signDisplay = "exceptZero";
  return numberFormat(locale, options).format(ratio);
}

/** How long ago a result ran: `just now` under a minute, then `5 min ago`, `2 h ago`, `3 days ago`. */
export function formatAge(ranAt: number, now: number): string {
  const minutes = Math.floor((now - ranAt) / 60_000);
  if (!(minutes >= 1)) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The change from `previous` to `current` in percent (10 for a tenth more); null when there is no base to compare with. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
