// What a new dashboard holds before anyone edits it: the "Sales overview". Every tile is a
// standard metric, so its figures match the same figure anywhere else, and each reacts to both
// shared filters. The server gives the tiles their ids when it first stores them.
import type { FilterValues } from "@gadgets/bundled-blueprints/libraries/data/server";
import type { Tile } from "./protocol.ts";

export const STARTER_TITLE = "Sales overview";
export const STARTER_FRESHNESS_MINUTES = 15;

/** The filters a new dashboard opens on: the last 30 days, every location. */
export function starterFilters(): FilterValues {
  return { dateRange: { preset: "last30" }, locations: [] };
}

/** A starter tile: everything but the id and version the server assigns. */
export type StarterTile = Omit<Tile, "id" | "version">;

/** The starter tiles, in reading order: four headline figures, sales over time, then two breakdowns. */
export function starterTiles(): StarterTile[] {
  return [
    {
      title: "Net sales",
      visual: { type: "kpi" },
      query: { kind: "metric", metric: "net_sales", compare: true },
      uses: ["dateRange", "locations"],
      layout: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      title: "Orders",
      visual: { type: "kpi" },
      query: { kind: "metric", metric: "orders", compare: true },
      uses: ["dateRange", "locations"],
      layout: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      title: "Average order value",
      visual: { type: "kpi" },
      query: { kind: "metric", metric: "average_order_value", compare: true },
      uses: ["dateRange", "locations"],
      layout: { x: 6, y: 0, w: 3, h: 2 },
    },
    {
      title: "Refunds",
      visual: { type: "kpi" },
      query: { kind: "metric", metric: "refunds", compare: true },
      uses: ["dateRange", "locations"],
      layout: { x: 9, y: 0, w: 3, h: 2 },
    },
    {
      title: "Sales by day",
      visual: { type: "line" },
      query: { kind: "metric", metric: "net_sales", groupBy: ["day"] },
      uses: ["dateRange", "locations"],
      layout: { x: 0, y: 2, w: 12, h: 4 },
    },
    {
      title: "Top products",
      visual: { type: "bar", sort: { by: "value", dir: "desc" }, limit: 10 },
      query: { kind: "metric", metric: "net_sales", groupBy: ["product"] },
      uses: ["dateRange", "locations"],
      layout: { x: 0, y: 6, w: 6, h: 5 },
    },
    {
      title: "Sales by location",
      visual: { type: "bar" },
      query: { kind: "metric", metric: "net_sales", groupBy: ["location"] },
      uses: ["dateRange", "locations"],
      layout: { x: 6, y: 6, w: 6, h: 5 },
    },
  ];
}
