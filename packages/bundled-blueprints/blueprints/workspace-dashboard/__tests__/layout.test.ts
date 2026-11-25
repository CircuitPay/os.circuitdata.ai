// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  GRID_COLUMNS,
  MAX_ROW,
  type Placed,
  clampLayout,
  defaultSize,
  firstFreeSlot,
  moveLayout,
  overlaps,
  resizeLayout,
  settleLayout,
} from "../files/lib/layout.ts";
import type { Layout } from "../files/lib/protocol.ts";

const at = (x: number, y: number, w: number, h: number): Layout => ({ x, y, w, h });
const placed = (id: string, layout: Layout): Placed => ({ id, layout });

/** Every pair of tiles that share a cell, by id. */
function collisions(tiles: Placed[]): string[] {
  const pairs: string[] = [];
  tiles.forEach((a, i) => tiles.slice(i + 1).forEach((b) => {
    if (overlaps(a.layout, b.layout)) pairs.push(`${a.id}+${b.id}`);
  }));
  return pairs;
}

describe("clamping", () => {
  it("leaves a layout that already fits the grid alone", () => {
    expect(clampLayout(at(3, 4, 6, 4))).toEqual(at(3, 4, 6, 4));
  });
  it("rounds to whole grid units", () => {
    expect(clampLayout(at(2.4, 1.6, 3.5, 2.2))).toEqual(at(2, 2, 4, 2));
  });
  it("holds the size between 2 and 12 units both ways", () => {
    expect(clampLayout(at(0, 0, 1, 0))).toEqual(at(0, 0, 2, 2));
    expect(clampLayout(at(0, 0, 40, 99))).toEqual(at(0, 0, 12, 12));
  });
  it("pulls a tile back inside the 12 columns, and above the lowest row", () => {
    expect(clampLayout(at(11, 0, 4, 2))).toEqual(at(GRID_COLUMNS - 4, 0, 4, 2));
    expect(clampLayout(at(-5, -3, 4, 2))).toEqual(at(0, 0, 4, 2));
    expect(clampLayout(at(0, 1e9, 4, 2)).y).toBe(MAX_ROW);
  });
  it("reads a value that is not a number as the smallest one", () => {
    expect(clampLayout(at(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN, Number.NaN))).toEqual(at(0, 0, 2, 2));
  });
  it("moves a tile without changing its size, stopping at the grid's edges", () => {
    expect(moveLayout(at(0, 0, 3, 2), 1, 0)).toEqual(at(1, 0, 3, 2));
    expect(moveLayout(at(9, 0, 3, 2), 10, 0)).toEqual(at(9, 0, 3, 2));
    expect(moveLayout(at(0, 0, 3, 2), -1, -1)).toEqual(at(0, 0, 3, 2));
  });
  it("resizes a tile from its top left corner, which stays where it is", () => {
    expect(resizeLayout(at(2, 3, 3, 2), 5, 4)).toEqual(at(2, 3, 5, 4));
    // Growing past the right edge stops at it rather than sliding the tile left.
    expect(resizeLayout(at(8, 0, 4, 2), 9, 2)).toEqual(at(8, 0, 4, 2));
    expect(resizeLayout(at(0, 0, 4, 4), 1, 1)).toEqual(at(0, 0, 2, 2));
  });
});

describe("collisions", () => {
  it("tells tiles that share a cell from tiles that only touch", () => {
    expect(overlaps(at(0, 0, 3, 2), at(2, 1, 3, 2))).toBe(true);
    expect(overlaps(at(0, 0, 3, 2), at(3, 0, 3, 2))).toBe(false);
    expect(overlaps(at(0, 0, 3, 2), at(0, 2, 3, 2))).toBe(false);
  });
  it("leaves tiles that do not overlap exactly where they are", () => {
    const tiles = [placed("a", at(0, 0, 6, 2)), placed("b", at(6, 0, 6, 2)), placed("c", at(0, 2, 12, 4))];
    expect(settleLayout(tiles)).toEqual(tiles);
  });
  it("keeps the moved tile in place and pushes the tile it covers down below it", () => {
    const settled = settleLayout([placed("a", at(0, 0, 6, 2)), placed("b", at(4, 1, 6, 3))], ["b"]);
    expect(settled).toEqual([placed("a", at(0, 4, 6, 2)), placed("b", at(4, 1, 6, 3))]);
  });
  it("pushes on down the tiles under a tile that was pushed", () => {
    const settled = settleLayout([
      placed("moved", at(0, 0, 12, 3)),
      placed("first", at(0, 2, 6, 2)),
      placed("second", at(0, 4, 6, 2)),
      placed("aside", at(6, 5, 6, 2)),
    ], ["moved"]);
    expect(settled.map((tile) => tile.layout)).toEqual([at(0, 0, 12, 3), at(0, 3, 6, 2), at(0, 5, 6, 2), at(6, 5, 6, 2)]);
    expect(collisions(settled)).toEqual([]);
  });
  it("lets the earlier of two moved tiles keep the place both ask for", () => {
    const settled = settleLayout([placed("a", at(0, 0, 4, 2)), placed("b", at(0, 0, 4, 2))], ["b", "a"]);
    expect(settled).toEqual([placed("a", at(0, 2, 4, 2)), placed("b", at(0, 0, 4, 2))]);
  });
  it("clamps every layout it settles and returns the tiles in the order given", () => {
    const settled = settleLayout([placed("wide", at(9, 0, 8, 1)), placed("far", at(30, 0, 3, 2))], ["wide"]);
    expect(settled.map((tile) => tile.id)).toEqual(["wide", "far"]);
    expect(settled[0].layout).toEqual(at(4, 0, 8, 2));
    // "far" lands on column 9 once clamped, which "wide" covers, so it drops below.
    expect(settled[1].layout).toEqual(at(9, 2, 3, 2));
  });
  it("never leaves an overlap, whatever is dropped where", () => {
    const base = [
      placed("k1", at(0, 0, 3, 2)), placed("k2", at(3, 0, 3, 2)), placed("k3", at(6, 0, 3, 2)), placed("k4", at(9, 0, 3, 2)),
      placed("line", at(0, 2, 12, 4)), placed("left", at(0, 6, 6, 5)), placed("right", at(6, 6, 6, 5)),
    ];
    for (const target of [at(1, 0, 3, 2), at(5, 3, 6, 5), at(0, 5, 12, 12), at(9, 9, 3, 2)]) {
      for (const moved of base) {
        const settled = settleLayout(base.map((tile) => (tile.id === moved.id ? placed(tile.id, target) : tile)), [moved.id]);
        expect(collisions(settled)).toEqual([]);
        expect(settled.find((tile) => tile.id === moved.id)?.layout).toEqual(clampLayout(target));
      }
    }
  });
});

describe("first free slot", () => {
  it("is the top left corner of an empty grid", () => {
    expect(firstFreeSlot([], { w: 6, h: 4 })).toEqual(at(0, 0, 6, 4));
  });
  it("is beside a tile when the row has room", () => {
    expect(firstFreeSlot([at(0, 0, 3, 2), at(3, 0, 3, 2)], { w: 3, h: 2 })).toEqual(at(6, 0, 3, 2));
  });
  it("is the next row when the first is full", () => {
    const row = [at(0, 0, 3, 2), at(3, 0, 3, 2), at(6, 0, 3, 2), at(9, 0, 3, 2)];
    expect(firstFreeSlot(row, { w: 3, h: 2 })).toEqual(at(0, 2, 3, 2));
  });
  it("fills a gap that is big enough and passes one that is not", () => {
    const taken = [at(0, 0, 4, 4), at(8, 0, 4, 4)];
    expect(firstFreeSlot(taken, { w: 4, h: 4 })).toEqual(at(4, 0, 4, 4));
    expect(firstFreeSlot(taken, { w: 6, h: 4 })).toEqual(at(0, 4, 6, 4));
  });
  it("gives each visual type its default size", () => {
    expect(defaultSize("kpi")).toEqual({ w: 3, h: 2 });
    for (const type of ["line", "area", "bar", "stackedBar"] as const) expect(defaultSize(type)).toEqual({ w: 6, h: 4 });
    expect(defaultSize("table")).toEqual({ w: 6, h: 5 });
    expect(defaultSize("text")).toEqual({ w: 6, h: 3 });
  });
});
