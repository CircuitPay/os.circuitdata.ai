/**
 * A result as a picture: the single value with its comparison, and the line, area and bar charts.
 *
 * Every builder returns a string. A chart is one `<svg role="img">` whose `aria-label` is a
 * generated sentence saying what the picture shows, so a screen reader hears the summary and the
 * caller offers the table beside it. Nothing is measured and nothing is random: the same result,
 * size and locale give the same markup, which is what lets a report edition print as it was.
 *
 * Colours are never written here. A series is filled with `var(--data-series-N)` and the frame
 * with the axis, grid and text variables that `DATA_STYLES` defines for light, dark and paper.
 *
 * Amounts in different currencies are never added. When a result holds more than one currency the
 * currency becomes the series, bars sit side by side instead of stacking, a KPI shows one line per
 * currency, and nothing is combined into an "Other" series.
 */

import {
  columnHeading,
  currencyDigits,
  formatCompact,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatValue,
  isIdColumn,
  isNumericColumn,
  percentChange,
} from "./format.ts";
import type { QueryResult, ResultColumn, VisualSpec, VisualType } from "./model.ts";
import { daysInRange } from "./period.ts";
import type { Scalar } from "./retail.ts";
import { describeTable, escapeHtml, renderMarkdownLite, renderTable } from "./table.ts";

/** Which column plays which part in a visual. */
export type Roles = { x: string | null; y: string[]; series: string | null; currency: string | null };

/** A visual ready to show. */
export type Rendered = {
  /** Markup for the tile body: an <svg role="img" aria-label="…">, a KPI block or a table. */
  html: string;
  /** One or two sentences a screen reader hears instead of the picture. Plain text, not markup. */
  summary: string;
  /** Short notes to show under the visual: "Showing the first 500 rows", "Partial: covers 82% of units", "Amounts are shown per currency". */
  notes: string[];
};

/** The most series one chart draws. */
export const MAX_SERIES = 12;
/** The most ticks on the value axis. */
export const MAX_Y_TICKS = 6;
/** The most labels along the category axis. */
export const MAX_X_LABELS = 8;

/** The note a visual carries when its amounts are in more than one currency. */
export const CURRENCY_NOTE = "Amounts in different currencies are not added together";

const NO_DATA = "No data for this period.";

// An average glyph at the chart's 11px text. Nothing can be measured in a string builder, so text
// is laid out by this estimate and clipped to fit it.
const CHAR_WIDTH = 6.2;

const MARK_TITLES_UP_TO = 300;

/**
 * Which column is the category, which are the values and which splits them into series. Roles the
 * visual names win when the result has those columns; the rest are inferred: `x` is the first
 * date or text column that is not a currency (failing that, an identifier column), `y` every
 * numeric or money column that is neither `x` nor an identifier, `series` a second text column,
 * and `currency` the column a money value names as holding its currency.
 */
export function inferRoles(columns: ResultColumn[], visual: VisualSpec): Roles {
  const find = (name: string | undefined) => columns.find(column => column.name === name);
  const currencyNames = columns
    .filter(column => column.type === "money" && find(column.currencyColumn) !== undefined)
    .map(column => column.currencyColumn);
  const labels = columns.filter(column =>
    (column.type === "date" || column.type === "text" || column.type === "timestamp") && !currencyNames.includes(column.name));
  const x = find(visual.x)?.name ?? labels[0]?.name ?? columns.find(column => isIdColumn(column))?.name ?? null;
  const asked = (visual.y ?? []).filter(name => {
    const column = find(name);
    return column !== undefined && isNumericColumn(column);
  });
  const y = asked.length > 0
    ? asked
    : columns.filter(column => isNumericColumn(column) && !isIdColumn(column) && column.name !== x).map(column => column.name);
  const split = find(visual.series)?.name ?? labels.find(column => column.type === "text" && column.name !== x)?.name ?? null;
  const currency = y.map(name => find(name)?.currencyColumn).find(name => name !== undefined && currencyNames.includes(name))
    ?? currencyNames[0] ?? null;
  return { x, y, series: split === x ? null : split, currency };
}

/**
 * The visual types a result can be drawn as, in the order a picker lists them: a KPI for a
 * result with no category or a single row, the charts for one with a category and a value, a
 * stacked bar when there is something to stack, and always the table.
 */
export function compatibleVisuals(columns: ResultColumn[], rowCount: number): VisualType[] {
  const roles = inferRoles(columns, { type: "table" });
  const types: VisualType[] = [];
  if (roles.y.length > 0) {
    if (roles.x === null || rowCount <= 1) types.push("kpi");
    if (roles.x !== null) {
      if (rowCount !== 1) types.push("line", "area");
      types.push("bar");
      if (roles.series !== null || roles.y.length > 1) types.push("stackedBar");
    }
  }
  if (columns.length > 0) types.push("table");
  return types;
}

/**
 * Draws a result as its visual. `size` is the box a chart is drawn for, in CSS pixels (it becomes
 * the `viewBox`, so the picture scales with its container). A result with no rows, or with
 * nothing numeric to draw, comes back as a short message instead of an empty frame.
 */
export function renderVisual(result: QueryResult, visual: VisualSpec, size: { width: number; height: number }, locale?: string): Rendered {
  if (visual.type === "text") {
    const text = visual.text ?? "";
    return { html: renderMarkdownLite(text), summary: clip(text.replace(/[#*]/g, "").replace(/\s+/g, " ").trim(), 200), notes: [] };
  }
  const notes: string[] = [];
  if (result.truncated) notes.push(`Showing the first ${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"}`);
  if (result.partial) {
    notes.push(typeof result.costCoverage === "number"
      ? `Partial: covers ${Math.round(result.costCoverage * 100)}% of units`
      : "Partial: some units have no known cost");
  }
  if (visual.type === "table") return { html: renderTable(result, {}, locale), summary: describeTable(result), notes };
  const roles = inferRoles(result.columns, visual);
  if (result.rows.length === 0) return message(NO_DATA, notes);
  if (roles.y.length === 0) return message("This result has no numbers to draw. Show it as a table instead.", notes);
  if (visual.type === "kpi") return renderKpi(result, roles, locale, notes);
  return renderChart(result, visual.type, roles, size, locale, notes);
}

function message(text: string, notes: string[]): Rendered {
  return { html: `<p class="data-empty">${escapeHtml(text)}</p>`, summary: text, notes };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** The values of one column that differ, as text, in the order the rows bring them. */
function distinct(rows: Scalar[][], index: number): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    const value = String(row[index] ?? "");
    if (!seen.includes(value)) seen.push(value);
  }
  return seen;
}

function renderKpi(result: QueryResult, roles: Roles, locale: string | undefined, notes: string[]): Rendered {
  const { columns, rows, previous } = result;
  const valueIndex = columns.findIndex(column => column.name === roles.y[0]);
  const column = columns[valueIndex];
  const currencyIndex = column.type === "money" ? columns.findIndex(candidate => candidate.name === column.currencyColumn) : -1;
  // One line per currency: the first row of each. With no currency there is one line, the first row.
  const lines = currencyIndex < 0
    ? [rows[0]]
    : distinct(rows, currencyIndex).map(code => rows.find(row => String(row[currencyIndex] ?? "") === code) ?? rows[0]);
  if (lines.length > 1) notes.push(CURRENCY_NOTE);

  let earlier = "";
  if (previous) {
    let days = 0;
    try {
      days = daysInRange(previous);
    } catch {
      // A stored result with unreadable dates still shows its value; only the day count is lost.
    }
    earlier = days === 1 ? "the previous day" : days > 1 ? `the previous ${days} days` : "the previous period";
  }
  const heading = column.name === "value" ? "" : `${columnHeading(column)} `;
  const blocks: string[] = [];
  const sentences: string[] = [];
  for (const row of lines) {
    const value = row[valueIndex];
    const shown = formatValue(value, column, row, columns, locale);
    let change = "";
    let spoken = "";
    if (previous) {
      const before = previous.rows.find(candidate => currencyIndex < 0 || candidate[currencyIndex] === row[currencyIndex])?.[valueIndex];
      const percent = typeof value === "number" && typeof before === "number" ? percentChange(value, before) : null;
      if (percent === null) {
        change = `Nothing in ${earlier} to compare with`;
        spoken = `, with nothing in ${earlier} to compare with`;
      } else if (Math.abs(percent) < 0.05) {
        change = `No change on ${earlier}`;
        spoken = `, unchanged on ${earlier}`;
      } else {
        change = `${formatPercent(percent / 100, locale, true)} on ${earlier}`;
        spoken = `, ${percent > 0 ? "up" : "down"} ${formatPercent(Math.abs(percent) / 100, locale)} on ${earlier}`;
      }
    }
    blocks.push(`<div class="data-kpi-line"><div class="data-kpi-value">${escapeHtml(shown)}</div>`
      + `${change ? `<div class="data-kpi-change">${escapeHtml(change)}</div>` : ""}</div>`);
    sentences.push(`${heading}${shown}${spoken}`);
  }
  const summary = sentences.join("; ");
  return {
    html: `<div class="data-kpi" role="img" aria-label="${escapeHtml(summary)}">${blocks.join("")}</div>`,
    summary,
    notes,
  };
}

/** One line, one area or one colour of bars. */
type Series = {
  name: string;
  /** One value per category in the column's own units (minor units for money); null where the result has none. */
  values: (number | null)[];
  /** What divides a value into the units the axis is drawn in: 100 for USD, 1 for a count. */
  scale: number;
  /** How one of this series' values reads. */
  format: (value: number) => string;
};

/** What a chart draws, worked out from the rows before any markup is written. */
type Plot = {
  categories: string[];
  series: Series[];
  stacked: boolean;
  /** How a position on the value axis reads. */
  tick: (value: number) => string;
  /** The smallest step the value axis may use, so whole things are not split. */
  minStep: number;
  /** The values and the category in words, for the summary: "value by day". */
  subject: string;
  /** False when the result has no category column and everything is one group. */
  byCategory: boolean;
  /** The categories as the axis writes them: a date without its year when every point shares it. */
  axisLabels: string[];
};

function buildPlot(result: QueryResult, type: VisualType, roles: Roles, locale: string | undefined, notes: string[]): Plot {
  const { columns, rows } = result;
  const indexOf = (name: string | null | undefined) => columns.findIndex(column => column.name === name);
  const xIndex = indexOf(roles.x);
  const measures = roles.y.map(name => indexOf(name));
  const first = columns[measures[0]];
  const money = first.type === "money";
  const ratio = first.label === "%";
  // One axis has one unit: value columns of another kind than the first are left to the table.
  const sameUnit = measures.filter(index => (columns[index].type === "money") === money && (columns[index].label === "%") === ratio);
  const currencyIndex = money ? indexOf(first.currencyColumn) : -1;
  const codes = currencyIndex < 0 ? [] : distinct(rows, currencyIndex);
  const multiCurrency = codes.length > 1;
  if (multiCurrency) notes.push(CURRENCY_NOTE);
  const seriesIndex = indexOf(roles.series);
  // With a series column or several currencies each row names its series; otherwise each value
  // column is one.
  const split = seriesIndex >= 0 || multiCurrency;
  const plotted = split ? [measures[0]] : sameUnit;

  const categories: string[] = [];
  const categoryAt = new Map<string, number>();
  const seriesByName = new Map<string, Series>();
  for (const row of rows) {
    const rawX = xIndex < 0 ? null : row[xIndex];
    const categoryKey = `${typeof rawX}:${String(rawX)}`;
    let category = categoryAt.get(categoryKey);
    if (category === undefined) {
      category = categories.length;
      categoryAt.set(categoryKey, category);
      categories.push(xIndex < 0 ? "All" : formatValue(rawX, columns[xIndex], row, columns, locale));
      for (const series of seriesByName.values()) series.values.push(null);
    }
    const rawCode = currencyIndex < 0 ? null : row[currencyIndex];
    const code = typeof rawCode === "string" && rawCode !== "" ? rawCode : null;
    for (const index of plotted) {
      const value = row[index];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const column = columns[index];
      const names: string[] = [];
      if (seriesIndex >= 0) names.push(formatValue(row[seriesIndex], columns[seriesIndex], row, columns, locale));
      if (multiCurrency && seriesIndex !== currencyIndex) names.push(code ?? "No currency");
      const name = split ? names.join(" · ") : columnHeading(column);
      let series = seriesByName.get(name);
      if (!series) {
        series = {
          name,
          values: categories.map(() => null),
          scale: money && code ? 10 ** currencyDigits(code, locale) : 1,
          format: money && code
            ? amount => formatMoney(amount, code, locale)
            : amount => formatValue(amount, column, [], [], locale),
        };
        seriesByName.set(name, series);
      }
      // Rows that share a category and a series are added. The currency is part of the series
      // whenever there is more than one, so a sum never crosses currencies.
      series.values[category] = (series.values[category] ?? 0) + value;
    }
  }

  let axisLabels = categories;
  if (xIndex >= 0 && columns[xIndex].type === "date") {
    const years = distinct(rows, xIndex).map(value => value.slice(0, 4));
    const year = years[0] ?? "";
    // The year is cut from the end of the label, where both "31 Oct 2026" and "Oct 31, 2026" keep it.
    if (/^\d{4}$/.test(year) && years.every(other => other === year)) {
      axisLabels = categories.map(label => label.replace(new RegExp(`,?\\s*${year}$`), ""));
    }
  }

  let kept = Array.from(seriesByName.values());
  if (kept.length > MAX_SERIES) {
    const ranked = kept
      .map((entry, order) => ({ entry, order, total: entry.values.reduce<number>((sum, value) => sum + Math.abs(value ?? 0) / entry.scale, 0) }))
      .toSorted((a, b) => b.total - a.total || a.order - b.order);
    // Ratios and amounts in different currencies cannot be added, so their smaller series are
    // left out and counted instead of combined.
    const combine = !multiCurrency && !ratio;
    const largest = ranked.slice(0, combine ? MAX_SERIES - 1 : MAX_SERIES).map(item => item.entry);
    if (combine) {
      const rest = ranked.slice(MAX_SERIES - 1).map(item => item.entry);
      largest.push({
        name: "Other",
        scale: largest[0].scale,
        format: largest[0].format,
        values: categories.map((_, category) => rest.reduce<number | null>((sum, entry) => {
          const value = entry.values[category];
          return value === null ? sum : (sum ?? 0) + value;
        }, null)),
      });
      notes.push(`Showing the ${MAX_SERIES - 1} largest of ${kept.length} series; the rest are combined as Other`);
    } else {
      notes.push(`Showing the ${MAX_SERIES} largest of ${kept.length} series`);
    }
    kept = largest;
  }

  const oneCurrency = money && codes.length === 1 ? codes[0] : null;
  const scale = kept[0]?.scale ?? 1;
  let tick: Plot["tick"] = value => formatCompact(value, locale);
  if (oneCurrency) tick = value => formatMoneyCompact(Math.round(value * scale), oneCurrency, locale);
  else if (ratio) tick = value => formatPercent(value, locale);
  const whole = plotted.every(index => columns[index].type === "integer");
  const values = plotted.map(index => columnHeading(columns[index]).toLowerCase()).join(" and ");
  return {
    categories,
    series: kept,
    stacked: type === "stackedBar" && !multiCurrency && kept.length > 1,
    tick,
    minStep: oneCurrency ? 1 / scale : whole ? 1 : 0,
    subject: xIndex < 0 ? values : `${values} by ${columnHeading(columns[xIndex]).toLowerCase()}`,
    byCategory: xIndex >= 0,
    axisLabels,
  };
}

/** A step of 1, 2 or 5 times a power of ten that is at least `rough`. */
function niceStep(rough: number, minStep: number): number {
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return Math.max(nice * power, minStep);
}

/** At most {@link MAX_Y_TICKS} round positions that cover `low` to `high` and include zero. */
function axisTicks(low: number, high: number, minStep: number): number[] {
  const lo = Math.min(0, low);
  const hi = Math.max(0, high) > lo ? Math.max(0, high) : lo + 1;
  let step = niceStep((hi - lo) / (MAX_Y_TICKS - 1), minStep);
  for (;;) {
    // The small nudges keep 0.3 / 0.1 from counting as just under 3.
    const from = Math.floor(lo / step + 1e-9);
    const to = Math.ceil(hi / step - 1e-9);
    if (to - from + 1 <= MAX_Y_TICKS) {
      const ticks: number[] = [];
      for (let index = from; index <= to; index++) ticks.push(Number((index * step).toPrecision(12)));
      return ticks;
    }
    step = niceStep(step * 1.5, minStep);
  }
}

/** A coordinate as it is written: one decimal, and never `-0`. */
function px(value: number): string {
  return String(Math.round(value * 10) / 10 + 0);
}

function summarize(plot: Plot, type: VisualType): string {
  const kind = type === "line" ? "Line chart" : type === "area" ? "Area chart" : plot.stacked ? "Stacked bar chart" : "Bar chart";
  const { categories, series } = plot;
  const names = series.slice(0, 3).map(entry => entry.name).join(", ");
  const split = series.length > 1 ? `, ${series.length} series: ${names}${series.length > 3 ? ` and ${series.length - 3} more` : ""}` : "";
  let span = "";
  if (categories.length > 1) span = `, ${categories.length} points from ${categories[0]} to ${categories.at(-1)}`;
  else if (plot.byCategory) span = `, 1 point: ${categories[0]}`;
  let summary = `${kind} of ${plot.subject}${split}${span}.`;
  if (series.length === 1 && categories.length > 1) {
    const only = series[0];
    let highest = -1;
    let lowest = -1;
    only.values.forEach((value, index) => {
      if (value === null) return;
      if (highest < 0 || value > (only.values[highest] ?? value)) highest = index;
      if (lowest < 0 || value < (only.values[lowest] ?? value)) lowest = index;
    });
    if (highest >= 0 && lowest >= 0 && highest !== lowest) {
      summary += ` Highest ${only.format(only.values[highest] ?? 0)} at ${categories[highest]}, lowest ${only.format(only.values[lowest] ?? 0)} at ${categories[lowest]}.`;
    }
  }
  return summary;
}

function renderChart(
  result: QueryResult,
  type: VisualType,
  roles: Roles,
  size: { width: number; height: number },
  locale: string | undefined,
  notes: string[],
): Rendered {
  const plot = buildPlot(result, type, roles, locale, notes);
  const { categories, series } = plot;
  if (series.length === 0) return message(NO_DATA, notes);
  const summary = summarize(plot, type);
  const bars = type === "bar" || type === "stackedBar";
  const fit = (value: number, fallback: number, least: number) =>
    (Number.isFinite(value) ? Math.min(4000, Math.max(least, Math.round(value))) : fallback);
  const width = fit(size.width, 480, 160);
  const height = fit(size.height, 240, 100);

  // The value axis: what each mark reaches, in axis units.
  const drawn = series.map(entry => entry.values.map(value => (value === null ? null : value / entry.scale)));
  let low = 0;
  let high = 0;
  categories.forEach((_, category) => {
    let up = 0;
    let down = 0;
    for (const values of drawn) {
      const value = values[category];
      if (value === null) continue;
      if (plot.stacked) {
        if (value >= 0) up += value;
        else down += value;
      } else {
        up = Math.max(up, value);
        down = Math.min(down, value);
      }
    }
    high = Math.max(high, up);
    low = Math.min(low, down);
  });
  const ticks = axisTicks(low, high, plot.minStep);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const tickLabels = ticks.map(value => plot.tick(value));

  // The legend, laid out in rows by the width estimate.
  const legend: { name: string; x: number; row: number; index: number }[] = [];
  if (series.length > 1) {
    let x = 0;
    let row = 0;
    series.forEach((entry, index) => {
      const name = clip(entry.name, 18);
      const itemWidth = 16 + name.length * CHAR_WIDTH + 12;
      if (x > 0 && x + itemWidth > width - 16) {
        row++;
        x = 0;
      }
      legend.push({ name, x, row, index });
      x += itemWidth;
    });
  }
  const legendHeight = legend.length > 0 ? (legend[legend.length - 1].row + 1) * 16 + 4 : 0;

  const left = Math.min(96, Math.max(28, Math.max(...tickLabels.map(label => label.length)) * CHAR_WIDTH + 12));
  const top = 8 + legendHeight;
  const plotWidth = Math.max(40, width - left - 10);
  const plotHeight = Math.max(20, height - top - 24);
  const yOf = (value: number) => top + plotHeight - ((value - lo) / (hi - lo)) * plotHeight;
  const band = plotWidth / categories.length;
  const center = (category: number) => left + band * (category + 0.5);
  const color = (index: number) => `var(--data-series-${(index % MAX_SERIES) + 1})`;
  const titled = categories.length * series.length <= MARK_TITLES_UP_TO;
  const title = (entry: Series, category: number, value: number) => (titled
    ? `<title>${escapeHtml(`${series.length > 1 ? `${entry.name}, ` : ""}${categories[category]}: ${entry.format(value)}`)}</title>`
    : "");

  const out: string[] = [
    `<svg class="data-chart" role="img" aria-label="${escapeHtml(summary)}" viewBox="0 0 ${width} ${height}" `
    + `preserveAspectRatio="xMidYMid meet" font-size="11" xmlns="http://www.w3.org/2000/svg">`,
  ];
  out.push(`<g style="stroke:var(--data-grid)" stroke-width="1">`
    + ticks.map(value => `<line x1="${px(left)}" x2="${px(left + plotWidth)}" y1="${px(yOf(value))}" y2="${px(yOf(value))}"/>`).join("")
    + `</g>`);
  out.push(`<g style="fill:var(--data-muted)" text-anchor="end">`
    + ticks.map((value, index) => `<text x="${px(left - 6)}" y="${px(yOf(value) + 4)}">${escapeHtml(tickLabels[index])}</text>`).join("")
    + `</g>`);

  const every = Math.ceil(categories.length / MAX_X_LABELS);
  const labelChars = Math.min(18, Math.max(3, Math.floor((band * every) / CHAR_WIDTH) - 1));
  out.push(`<g style="fill:var(--data-muted)" text-anchor="middle">`
    + plot.axisLabels.map((label, category) => (category % every === 0
      ? `<text x="${px(center(category))}" y="${px(top + plotHeight + 15)}">${escapeHtml(clip(label, labelChars))}</text>`
      : "")).join("")
    + `</g>`);

  series.forEach((entry, index) => {
    const values = drawn[index];
    const marks: string[] = [];
    if (bars) {
      const inner = band * 0.8;
      const barWidth = Math.max(0.5, plot.stacked ? inner : inner / series.length);
      values.forEach((value, category) => {
        if (value === null) return;
        // A stacked bar starts where the bars under it (or, below zero, above it) end.
        let base = 0;
        if (plot.stacked) {
          for (const below of drawn.slice(0, index)) {
            const other = below[category];
            if (other !== null && (other >= 0) === (value >= 0)) base += other;
          }
        }
        const x = left + band * category + band * 0.1 + (plot.stacked ? 0 : barWidth * index);
        const y = Math.min(yOf(base), yOf(base + value));
        const barHeight = Math.abs(yOf(base) - yOf(base + value));
        marks.push(`<rect x="${px(x)}" y="${px(y)}" width="${px(barWidth)}" height="${px(barHeight)}">${title(entry, category, entry.values[category] ?? 0)}</rect>`);
      });
      out.push(`<g style="fill:${color(index)}">${marks.join("")}</g>`);
      return;
    }
    // A line breaks where the result has no value, and each unbroken run is one path.
    const runs: number[][] = [];
    let run: number[] = [];
    values.forEach((value, category) => {
      if (value === null) {
        if (run.length > 0) runs.push(run);
        run = [];
      } else {
        run.push(category);
      }
    });
    if (run.length > 0) runs.push(run);
    for (const points of runs) {
      const path = points.map((category, order) => `${order === 0 ? "M" : "L"}${px(center(category))} ${px(yOf(values[category] ?? 0))}`).join(" ");
      if (type === "area") {
        marks.push(`<path d="${path} L${px(center(points[points.length - 1]))} ${px(yOf(0))} L${px(center(points[0]))} ${px(yOf(0))} Z" `
          + `stroke="none" fill-opacity="0.18" style="fill:${color(index)}"/>`);
      }
      if (points.length > 1) marks.push(`<path d="${path}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    if (titled) {
      values.forEach((value, category) => {
        if (value === null) return;
        marks.push(`<circle cx="${px(center(category))}" cy="${px(yOf(value))}" r="2.5" stroke="none" style="fill:${color(index)}">${title(entry, category, entry.values[category] ?? 0)}</circle>`);
      });
    } else {
      // Without per-point marks a run of one point would draw nothing, so it gets its dot.
      for (const points of runs) {
        if (points.length === 1) marks.push(`<circle cx="${px(center(points[0]))}" cy="${px(yOf(values[points[0]] ?? 0))}" r="2.5" stroke="none" style="fill:${color(index)}"/>`);
      }
    }
    out.push(`<g style="stroke:${color(index)}">${marks.join("")}</g>`);
  });

  out.push(`<line x1="${px(left)}" x2="${px(left + plotWidth)}" y1="${px(yOf(0))}" y2="${px(yOf(0))}" style="stroke:var(--data-axis)" stroke-width="1"/>`);
  if (legend.length > 0) {
    out.push(`<g style="fill:var(--data-text)">`
      + legend.map(item => `<rect x="${px(8 + item.x)}" y="${px(6 + item.row * 16)}" width="10" height="10" rx="2" style="fill:${color(item.index)}"/>`
        + `<text x="${px(8 + item.x + 14)}" y="${px(15 + item.row * 16)}">${escapeHtml(item.name)}</text>`).join("")
      + `</g>`);
  }
  out.push("</svg>");
  return { html: out.join(""), summary, notes };
}
