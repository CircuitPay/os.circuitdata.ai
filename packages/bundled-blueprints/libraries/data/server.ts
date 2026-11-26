/**
 * The data library's server entry (`@gadgets/bundled-blueprints/libraries/data/server`): what a
 * gadget's Durable Object needs to read the organization's retail dataset through
 * `env.RETAIL_DATA` and keep what it read.
 *
 * - The dataset's types as a gadget sees them, and {@link RetailReader}, the part of the binding
 *   the data formats call.
 * - The saved-query model ({@link SavedQuery}, {@link VisualSpec}, {@link FilterValues},
 *   {@link QueryOutcome}) with the validators that turn an RPC argument into one.
 * - {@link compileSql}, which turns named parameters into placeholders and bound values, so a
 *   filter value is never part of the query text.
 * - {@link anchorDate}, {@link resolveRange} and {@link previousRange} for date presets.
 * - {@link runSavedQuery} and {@link readDataStatus}, which do the reads and cap the results.
 * - The value formatters, for a server-side export that writes values as they are displayed.
 *
 * The entry imports nothing from the runtime and touches no DOM: every module runs in Node under
 * its tests.
 */

export type {
  RetailColumn,
  RetailColumnType,
  RetailDatasetDescription,
  RetailMetricDefinition,
  RetailMetricName,
  RetailMetricQuery,
  RetailMetricResult,
  RetailQueryResult,
  RetailReader,
  RetailTable,
  RetailTableDescription,
  Scalar,
} from "./src/retail.ts";
export {
  type DatePreset,
  type DateRangeFilter,
  type FilterName,
  type FilterValues,
  MAX_FILTER_LOCATIONS,
  MAX_GROUP_BY,
  MAX_LITERAL_PARAMS,
  MAX_SQL_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_VISUAL_LIMIT,
  METRIC_GROUPS,
  METRIC_NAMES,
  type MetricGroup,
  type QueryFailure,
  type QueryOutcome,
  type QueryResult,
  type ResolvedFilters,
  type ResultColumn,
  type SavedQuery,
  validateDateRange,
  validateFilters,
  validateSavedQuery,
  validateVisual,
  VISUAL_TYPES,
  type VisualSpec,
  type VisualType,
} from "./src/model.ts";
export { compileSql, MAX_BOUND_VALUES, usesFilter } from "./src/params.ts";
export {
  addDays,
  anchorDate,
  DATE_PRESETS,
  daysInRange,
  describeRange,
  isIsoDate,
  previousRange,
  resolveRange,
} from "./src/period.ts";
export {
  type DataStatus,
  DEFAULT_PRODUCT_LIMIT,
  isConnectionGone,
  MAX_RESULT_BYTES,
  MAX_RESULT_ROWS,
  plainError,
  readDataStatus,
  runSavedQuery,
} from "./src/run.ts";
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
