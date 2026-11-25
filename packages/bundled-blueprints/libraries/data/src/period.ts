/**
 * Date presets and ranges.
 *
 * Everything here is arithmetic on calendar dates written `YYYY-MM-DD`, done in UTC: a business
 * date is a label the dataset assigned, not an instant, so no time zone takes part. A preset
 * counts back from an anchor (see {@link anchorDate}) rather than from the clock, which is what
 * keeps "last 30 days" full of data when the latest import is a few days old.
 */

import type { DatePreset, DateRangeFilter } from "./model.ts";

const DAY_MS = 86_400_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The presets a date-range control offers, in the order it lists them. */
export const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "last7", label: "Last 7 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "last90", label: "Last 90 days" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "thisYear", label: "This year" },
];

/** A calendar date as its parts; `month` counts from 1. */
type Parts = { year: number; month: number; day: number };

function parts(iso: unknown): Parts | null {
  if (typeof iso !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Date.UTC rolls an impossible day over into the next month, so a date is real exactly when it
  // survives the round trip. Year 0000 is refused: Date.UTC reads years under 100 as 19xx.
  if (year < 1) return null;
  const back = new Date(Date.UTC(year, month - 1, day));
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return { year, month, day };
}

function mustParse(iso: unknown, field: string): Parts {
  const parsed = parts(iso);
  if (!parsed) throw new Error(`${field} must be a real date written YYYY-MM-DD.`);
  return parsed;
}

function toIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function dayNumber(date: Parts): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

/** Whether `value` is a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: unknown): value is string {
  return parts(value) !== null;
}

/** The date `days` after `iso` (before it, when negative). */
export function addDays(iso: string, days: number): string {
  const date = mustParse(iso, "The date");
  return toIso(date.year, date.month, date.day + days);
}

/** How many days a range covers, counting both ends. */
export function daysInRange(range: { from: string; to: string }): number {
  return dayNumber(mustParse(range.to, "The end date")) - dayNumber(mustParse(range.from, "The start date")) + 1;
}

/** The date a preset counts back from: the earlier of today (UTC) and the dataset's last business date. */
export function anchorDate(todayIso: string, datasetTo: string | null): string {
  // `todayIso` may be a whole timestamp (`new Date().toISOString()`); only its date is read.
  const today = typeof todayIso === "string" ? todayIso.slice(0, 10) : todayIso;
  mustParse(today, "Today's date");
  if (datasetTo === null || !isIsoDate(datasetTo)) return today;
  return datasetTo < today ? datasetTo : today;
}

/**
 * The business dates a filter stands for. A preset is counted back from `anchor`; an explicit
 * range is checked (real dates, in order, under three years) and returned as it is.
 */
export function resolveRange(filter: DateRangeFilter, anchor: string): { from: string; to: string } {
  if ("preset" in filter) {
    const { year, month, day } = mustParse(anchor, "The anchor date");
    switch (filter.preset) {
      case "last7":
        return { from: toIso(year, month, day - 6), to: anchor };
      case "last30":
        return { from: toIso(year, month, day - 29), to: anchor };
      case "last90":
        return { from: toIso(year, month, day - 89), to: anchor };
      case "thisMonth":
        return { from: toIso(year, month, 1), to: anchor };
      case "lastMonth": {
        // Day 0 of the next month is the last day of this one. An anchor on that day means the
        // month is over, so it is the "last month" a monthly report wants.
        const monthEnd = toIso(year, month + 1, 0);
        if (anchor === monthEnd) return { from: toIso(year, month, 1), to: monthEnd };
        return { from: toIso(year, month - 1, 1), to: toIso(year, month, 0) };
      }
      case "thisYear":
        return { from: toIso(year, 1, 1), to: anchor };
      default:
        throw new Error(`"${String(filter.preset).slice(0, 40)}" is not a date range this format knows.`);
    }
  }
  const from = mustParse(filter.from, "The start date");
  mustParse(filter.to, "The end date");
  if (filter.from > filter.to) throw new Error("The start date must not be after the end date.");
  // The dataset refuses a range of three years or more, so one is refused here in the same words
  // a person can act on, before any read is spent on it.
  if (filter.to >= toIso(from.year + 3, from.month, from.day)) {
    throw new Error("The date range must be shorter than 3 years.");
  }
  return { from: filter.from, to: filter.to };
}

/** The range of the same number of days that ends the day before `range.from`. */
export function previousRange(range: { from: string; to: string }): { from: string; to: string } {
  const days = daysInRange(range);
  if (days < 1) throw new Error("The start date must not be after the end date.");
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** A range in words: `3 Nov 2026`, `1–31 Oct 2026`, `28 Oct – 3 Nov 2026`, `28 Dec 2025 – 3 Jan 2026`. */
export function describeRange(range: { from: string; to: string }): string {
  const from = parts(range.from);
  const to = parts(range.to);
  // A range that is not two dates is shown as it was given: this is a label, never a refusal.
  if (!from || !to) return `${range.from} – ${range.to}`;
  const monthName = (date: Parts) => MONTHS[date.month - 1];
  const full = (date: Parts) => `${date.day} ${monthName(date)} ${date.year}`;
  if (range.from === range.to) return full(to);
  if (from.year !== to.year) return `${full(from)} – ${full(to)}`;
  if (from.month !== to.month) return `${from.day} ${monthName(from)} – ${full(to)}`;
  return `${from.day}–${full(to)}`;
}
