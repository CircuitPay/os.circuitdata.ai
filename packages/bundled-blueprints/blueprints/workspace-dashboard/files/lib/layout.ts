// Grid placement for the Dashboard: tiles sit on a 12-column grid in whole units, never overlap,
// and a tile that something lands on drops below it. The server applies these rules to every
// layout it stores, and the page applies the same ones while a tile is dragged, so what a person
// sees while moving a tile is what is saved.
import type { VisualType } from "@gadgets/bundled-blueprints/libraries/data/server";
import type { Layout } from "./protocol.ts";

export const GRID_COLUMNS = 12;
/** The smallest and largest a tile may be, in grid units, both ways. */
export const MIN_SPAN = 2;
export const MAX_SPAN = 12;
/** The lowest row a tile may be put on, so a stray number cannot make an endless page. */
export const MAX_ROW = 500;

/** A tile's id with its place. */
export type Placed = { id: string; layout: Layout };

function clampInt(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, Math.round(value)));
}

/** The nearest layout that is whole units, within the size limits and inside the grid. */
export function clampLayout(layout: Layout): Layout {
  const w = clampInt(layout.w, MIN_SPAN, GRID_COLUMNS);
  const h = clampInt(layout.h, MIN_SPAN, MAX_SPAN);
  return { x: clampInt(layout.x, 0, GRID_COLUMNS - w), y: clampInt(layout.y, 0, MAX_ROW), w, h };
}

/** The layout moved to a column and row, keeping its size. */
export function moveLayout(layout: Layout, x: number, y: number): Layout {
  return clampLayout({ ...layout, x, y });
}

/** The layout resized from its top left corner, which stays where it is: it grows no further than the grid's right edge. */
export function resizeLayout(layout: Layout, w: number, h: number): Layout {
  const from = clampLayout(layout);
  return { ...from, w: clampInt(w, MIN_SPAN, GRID_COLUMNS - from.x), h: clampInt(h, MIN_SPAN, MAX_SPAN) };
}

/** Whether two layouts share any cell. */
export function overlaps(a: Layout, b: Layout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * The tiles with every layout clamped and no two overlapping. The tiles named in `moved` keep
 * the place they ask for, an earlier name winning over a later one. Every other tile stays where
 * it is unless something now covers it, and then drops to just below what covers it, which may in
 * turn push the tiles under it. Returned in the order given.
 */
export function settleLayout(tiles: Placed[], moved: string[] = []): Placed[] {
  const rank = new Map(moved.map((id, index) => [id, index]));
  const order = tiles
    .map((tile, index) => ({ id: tile.id, layout: clampLayout(tile.layout), index, rank: rank.get(tile.id) ?? moved.length }))
    .sort((a, b) => a.rank - b.rank || a.layout.y - b.layout.y || a.layout.x - b.layout.x || a.index - b.index);
  const taken: Layout[] = [];
  const settled = new Map<string, Layout>();
  for (const item of order) {
    let layout = item.layout;
    // Each step moves the tile strictly down past one settled tile, so this ends.
    for (let blocker = taken.find((other) => overlaps(other, layout)); blocker; blocker = taken.find((other) => overlaps(other, layout))) {
      layout = { ...layout, y: blocker.y + blocker.h };
    }
    taken.push(layout);
    settled.set(item.id, layout);
  }
  return tiles.map((tile) => ({ id: tile.id, layout: settled.get(tile.id) ?? clampLayout(tile.layout) }));
}

/** The first place, reading rows left to right from the top, where a tile of this size covers nothing. */
export function firstFreeSlot(taken: Layout[], size: { w: number; h: number }): Layout {
  const { w, h } = clampLayout({ x: 0, y: 0, w: size.w, h: size.h });
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) {
      const candidate = { x, y, w, h };
      if (!taken.some((other) => overlaps(other, candidate))) return candidate;
    }
  }
}

/** The size a new tile takes when none is given. */
export function defaultSize(type: VisualType): { w: number; h: number } {
  if (type === "kpi") return { w: 3, h: 2 };
  if (type === "table") return { w: 6, h: 5 };
  if (type === "text") return { w: 6, h: 3 };
  return { w: 6, h: 4 };
}
