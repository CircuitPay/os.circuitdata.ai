/**
 * The data library's browser entry (`@gadgets/bundled-blueprints/libraries/data/client`): what a
 * gadget's `client.js` needs to show a query's result.
 *
 * - {@link renderVisual} draws a result as a KPI block, an SVG chart or a table and writes the
 *   sentence a screen reader hears instead; {@link renderTable} is the table on its own, and
 *   {@link renderMarkdownLite} the text block.
 * - {@link inferRoles} and {@link compatibleVisuals} say which columns a visual uses and which
 *   visual types a result can take.
 * - The formatters turn minor units, dates and ages into what a person reads.
 * - {@link DATA_STYLES} is the stylesheet the markup needs, for light, dark and print.
 * - {@link DATE_PRESETS}, {@link resolveRange}, {@link describeRange} and {@link anchorDate}
 *   drive a date-range control.
 * - The model and dataset types, and the two validators a page can use before it sends a visual
 *   or a filter selection to its server.
 *
 * The builders return strings and never touch `document`, so a chart is the same in a page, in
 * an export and in a test. Nothing here compiles or runs a query: that is the server entry's.
 */

export { compatibleVisuals, CURRENCY_NOTE, inferRoles, MAX_SERIES, MAX_X_LABELS, MAX_Y_TICKS, type Rendered, renderVisual, type Roles } from "./src/chart.ts";
export {
  columnHeading,
  currencyDigits,
  DEFAULT_LOCALE,
  EMPTY_VALUE,
  formatAge,
  formatCompact,
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatValue,
  isIdColumn,
  isNumericColumn,
  percentChange,
} from "./src/format.ts";
export {
  type DatePreset,
  type DateRangeFilter,
  type FilterName,
  type FilterValues,
  type MetricGroup,
  type QueryFailure,
  type QueryOutcome,
  type QueryResult,
  type ResolvedFilters,
  type ResultColumn,
  type SavedQuery,
  validateFilters,
  validateVisual,
  type VisualSpec,
  type VisualType,
} from "./src/model.ts";
export { anchorDate, DATE_PRESETS, describeRange, resolveRange } from "./src/period.ts";
export type {
  RetailColumn,
  RetailColumnType,
  RetailDatasetDescription,
  RetailMetricDefinition,
  RetailMetricName,
  RetailTable,
  RetailTableDescription,
  Scalar,
} from "./src/retail.ts";
export type { DataStatus } from "./src/run.ts";
export { DATA_STYLES } from "./src/styles.ts";
export { DEFAULT_TABLE_ROWS, describeTable, escapeHtml, renderMarkdownLite, renderTable } from "./src/table.ts";
