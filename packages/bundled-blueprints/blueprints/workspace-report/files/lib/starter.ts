// The "Monthly sales report" a new report opens with: a summary to write, the month's headline
// figures, and the standard breakdowns. Every figure is one of the dataset's shared metrics, so a
// number here matches the same number on every dashboard and report.
import type { DateRangeFilter, MetricGroup, RetailMetricName, VisualSpec } from "@gadgets/bundled-blueprints/libraries/data/server";
import type { DataSection, HeadingLevel, Section, SectionWidth } from "./protocol.ts";

export const STARTER_TITLE = "Monthly sales report";

/** The most recent complete month, resolved against the dataset when an edition is generated. */
export const STARTER_PERIOD: DateRangeFilter = { preset: "lastMonth" };

export const STARTER_SUMMARY = "Write a short summary of the month here, or ask the agent to draft one from the figures below.";

/** The starter sections in order, each with an id from `newId`. */
export function starterSections(newId: () => string): Section[] {
  const heading = (level: HeadingLevel, text: string): Section => ({ id: newId(), version: 1, kind: "heading", level, text });
  const headline = (title: string, metric: RetailMetricName): DataSection => ({
    id: newId(),
    version: 1,
    kind: "data",
    title,
    visual: { type: "kpi" },
    query: { kind: "metric", metric, compare: true },
    // Two to a row: four figures at a third each would leave the last one alone on a row.
    width: "half",
  });
  const breakdown = (title: string, metric: RetailMetricName, group: MetricGroup, visual: VisualSpec, width: SectionWidth): DataSection => ({
    id: newId(),
    version: 1,
    kind: "data",
    title,
    visual,
    query: { kind: "metric", metric, groupBy: [group] },
    width,
  });
  return [
    heading(1, STARTER_TITLE),
    heading(2, "Summary"),
    { id: newId(), version: 1, kind: "text", text: STARTER_SUMMARY, reviewedEdition: null },
    headline("Net sales", "net_sales"),
    headline("Orders", "orders"),
    headline("Average order value", "average_order_value"),
    headline("Refunds", "refunds"),
    breakdown("Sales by day", "net_sales", "day", { type: "line" }, "full"),
    breakdown("Top products", "net_sales", "product", { type: "table", sort: { by: "value", dir: "desc" }, limit: 10 }, "half"),
    breakdown("Sales by location", "net_sales", "location", { type: "bar" }, "half"),
    breakdown("Discounts by week", "discounts", "week", { type: "table" }, "half"),
    breakdown("Refunds by week", "refunds", "week", { type: "table" }, "half"),
  ];
}
