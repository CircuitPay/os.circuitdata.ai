// @vitest-environment node
// The rules an edition is built and compared by: fingerprints, the review flag, stale data
// sections, the latest view and retention.
import { describe, expect, it } from "vitest";
import type { QueryFailure, QueryOutcome, QueryResult } from "@gadgets/bundled-blueprints/libraries/data/server";
import {
  ALL_PINNED,
  EDITION_MAX_CHARS,
  EDITION_TOO_LONG,
  type EditionDigest,
  type EditionInput,
  buildEdition,
  currentBlocks,
  digestOf,
  fingerprint,
  planRetention,
  reviewFlags,
  staleSections,
} from "../files/lib/editions.ts";
import { type DataSection, type EditionSummary, LIMITS, type Section, type TextSection } from "../files/lib/protocol.ts";

const PERIOD = { from: "2025-10-01", to: "2025-10-31" };

function result(rows: QueryResult["rows"], extra: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: [{ name: "day", type: "date" }, { name: "value", type: "integer" }],
    rows,
    truncated: false,
    period: PERIOD,
    ranAt: 1_000,
    durationMs: 12,
    rowCount: rows.length,
    ...extra,
  };
}

const failure: QueryFailure = { error: "The dataset refused this query.", ranAt: 1_000, durationMs: 3, period: PERIOD };

function data(id: string, extra: Partial<DataSection> = {}): DataSection {
  return { id, version: 1, kind: "data", title: "Sales by day", visual: { type: "line" }, query: { kind: "metric", metric: "net_sales", groupBy: ["day"] }, width: "full", ...extra };
}

function text(id: string, body: string, reviewedEdition: string | null = null): TextSection {
  return { id, version: 1, kind: "text", text: body, reviewedEdition };
}

function input(id: string, asOf: number, sections: Section[], outcomes: Record<string, QueryOutcome>): EditionInput {
  return { id, asOf, period: PERIOD, createdBy: "member", title: "Monthly sales report", letterhead: { name: "Acme" }, completeThrough: "2025-10-31", sections, outcomes };
}

/** The digest of an edition whose one data section, "sales", returned `rows`. */
function digest(id: string, asOf: number, rows: QueryResult["rows"], sections: Section[] = [data("sales")]): EditionDigest {
  const outcomes: Record<string, QueryOutcome> = {};
  for (const section of sections) if (section.kind === "data") outcomes[section.id] = result(rows);
  return digestOf(buildEdition(input(id, asOf, sections, outcomes)));
}

describe("fingerprint", () => {
  const rows: QueryResult["rows"] = [["2025-10-01", 10], ["2025-10-02", 20]];

  it("is the same for the same columns and rows, whenever and however fast they were read", () => {
    expect(fingerprint(result(rows))).toBe(fingerprint(result(rows.map((row) => [...row]), { ranAt: 9_999, durationMs: 400 })));
  });

  it("changes when a value changes, when rows change places, and when a column is renamed", () => {
    const base = fingerprint(result(rows));
    expect(fingerprint(result([["2025-10-01", 10], ["2025-10-02", 21]]))).not.toBe(base);
    expect(fingerprint(result([rows[1], rows[0]]))).not.toBe(base);
    expect(fingerprint(result(rows, { columns: [{ name: "day", type: "date" }, { name: "amount", type: "integer" }] }))).not.toBe(base);
  });

  it("covers the previous period's rows", () => {
    const previous = (value: number) => result(rows, { previous: { from: "2025-09-01", to: "2025-09-30", rows: [["2025-09-01", value]] } });
    expect(fingerprint(previous(5))).toBe(fingerprint(previous(5)));
    expect(fingerprint(previous(5))).not.toBe(fingerprint(previous(6)));
    expect(fingerprint(previous(5))).not.toBe(fingerprint(result(rows)));
  });

  it('is "error" for a block that failed', () => {
    expect(fingerprint(failure)).toBe("error");
  });
});

describe("buildEdition", () => {
  it("copies every section and outcome, so later edits to either leave the edition as it was", () => {
    const sections: Section[] = [text("intro", "Sales were 30."), data("sales")];
    const outcome = result([["2025-10-01", 10]]);
    const edition = buildEdition(input("e1", 5_000, sections, { sales: outcome }));

    (sections[0] as TextSection).text = "Rewritten.";
    (sections[1] as DataSection).title = "Renamed";
    outcome.rows[0][1] = 999;

    expect(edition.blocks.map((block) => block.kind)).toEqual(["text", "data"]);
    expect(edition.blocks[0]).toMatchObject({ id: "intro", text: "Sales were 30." });
    expect(edition.blocks[1]).toMatchObject({ id: "sales", title: "Sales by day", outcome: { rows: [["2025-10-01", 10]] } });
    expect(edition).toMatchObject({ id: "e1", asOf: 5_000, period: PERIOD, pinned: false, createdBy: "member", title: "Monthly sales report", letterhead: { name: "Acme" }, completeThrough: "2025-10-31" });
  });

  it("fingerprints each data block by its section id, a failed one as an error", () => {
    const edition = buildEdition(input("e1", 5_000, [data("a"), data("b"), text("t", "words")], { a: result([["2025-10-01", 10]]), b: failure }));
    expect(edition.fingerprints).toEqual({ a: fingerprint(result([["2025-10-01", 10]])), b: "error" });
    expect(edition.blocks[1]).toMatchObject({ outcome: { error: "The dataset refused this query." } });
  });

  it("keeps the first rows of results that do not fit one edition and marks them truncated", () => {
    const wide = "x".repeat(1_000);
    const rows: QueryResult["rows"] = Array.from({ length: 400 }, (_, index) => [wide, index]);
    const sections = [data("a"), data("b"), data("c")];
    const edition = buildEdition(input("e1", 5_000, sections, { a: result(rows), b: result(rows), c: result(rows) }));

    expect(JSON.stringify(edition).length).toBeLessThanOrEqual(EDITION_MAX_CHARS + 1_000);
    const [a, b, c] = edition.blocks.map((block) => block.outcome as QueryResult);
    expect(a.rows).toHaveLength(400);
    expect(a.truncated).toBe(false);
    expect(b.rows).toHaveLength(400);
    expect(c.rows.length).toBeGreaterThan(0);
    expect(c.rows.length).toBeLessThan(400);
    expect(c.truncated).toBe(true);
    expect(c.rows[0]).toEqual(rows[0]);
    // The fingerprint is of what the edition holds.
    expect(edition.fingerprints.c).toBe(fingerprint(c));
  });

  it("refuses a report whose text alone is over the size of one edition", () => {
    const long = Array.from({ length: 50 }, (_, index) => text("t" + index, "y".repeat(LIMITS.text)));
    expect(() => buildEdition(input("e1", 5_000, long, {}))).toThrow(EDITION_TOO_LONG);
  });
});

describe("reviewFlags", () => {
  const before = digest("e1", 1_000, [["2025-10-01", 10]]);
  const changed = digest("e2", 2_000, [["2025-10-01", 11]]);
  const unchanged = digest("e2", 2_000, [["2025-10-01", 10]]);

  it("flags text that states a number when a block's numbers changed since the edition it was written against", () => {
    expect(reviewFlags([text("t", "Sales were 10 on the first.", "e1")], [before, changed])).toEqual(["t"]);
  });

  it("does not flag text with no digit, or text whose edition has the same numbers", () => {
    expect(reviewFlags([text("t", "Sales were strong.", "e1")], [before, changed])).toEqual([]);
    expect(reviewFlags([text("t", "Sales were 10 on the first.", "e1")], [before, unchanged])).toEqual([]);
  });

  it("is cleared by an edit or a review, both of which name the newest edition", () => {
    expect(reviewFlags([text("t", "Sales were 11 on the first.", "e2")], [before, changed])).toEqual([]);
  });

  it("compares text that names no edition with the oldest one, and flags nothing while there is only one", () => {
    const unnamed = text("t", "Sales were 10 on the first.");
    expect(reviewFlags([unnamed], [changed])).toEqual([]);
    expect(reviewFlags([unnamed], [before, changed])).toEqual(["t"]);
    expect(reviewFlags([unnamed], [])).toEqual([]);
    // An edition that was deleted since is treated the same way.
    expect(reviewFlags([text("t", "Sales were 10.", "gone")], [before, changed])).toEqual(["t"]);
  });

  it("looks only at data sections present in both editions", () => {
    const withExtra = digest("e2", 2_000, [["2025-10-01", 10]], [data("sales"), data("added")]);
    expect(reviewFlags([text("t", "Sales were 10.", "e1")], [before, withExtra])).toEqual([]);
  });

  it("uses the newest edition whatever order they are given in", () => {
    expect(reviewFlags([text("t", "Sales were 10.", "e1")], [changed, before])).toEqual(["t"]);
  });
});

describe("staleSections", () => {
  const section = data("sales", { visual: { type: "bar", sort: { by: "value", dir: "desc" }, limit: 10 } });
  const latest = digestOf(buildEdition(input("e1", 1_000, [section], { sales: result([]) })));

  it("lists nothing before the first edition", () => {
    expect(staleSections([section], null)).toEqual([]);
  });

  it("lists a data section added since, and one whose query, sort or limit changed", () => {
    expect(staleSections([section], latest)).toEqual([]);
    expect(staleSections([section, data("new")], latest)).toEqual(["new"]);
    expect(staleSections([{ ...section, query: { kind: "metric", metric: "orders", groupBy: ["day"] } }], latest)).toEqual(["sales"]);
    expect(staleSections([{ ...section, visual: { ...section.visual, sort: { by: "value", dir: "asc" } } }], latest)).toEqual(["sales"]);
    expect(staleSections([{ ...section, visual: { ...section.visual, limit: 5 } }], latest)).toEqual(["sales"]);
  });

  it("does not list a section whose title, width or visual type changed: the same rows answer it", () => {
    expect(staleSections([{ ...section, title: "Renamed", width: "half", visual: { ...section.visual, type: "table" } }], latest)).toEqual([]);
  });

  it("reads a query the same whatever order its keys were written in", () => {
    const reordered: DataSection = { ...section, query: { groupBy: ["day"], metric: "net_sales", kind: "metric" } };
    expect(staleSections([reordered], latest)).toEqual([]);
  });
});

describe("currentBlocks", () => {
  it("gives each current data section the latest edition's outcome, except a stale one", () => {
    const edition = buildEdition(input("e1", 1_000, [text("t", "Old words."), data("a"), data("b")], { a: result([["2025-10-01", 1]]), b: result([["2025-10-01", 2]]) }));
    const now: Section[] = [text("t", "New words."), data("a", { title: "Renamed" }), data("b"), data("c")];
    const blocks = currentBlocks(now, ["b", "c"], edition);

    expect(blocks[0]).toMatchObject({ text: "New words." });
    expect(blocks[1]).toMatchObject({ title: "Renamed", outcome: { rows: [["2025-10-01", 1]] } });
    expect(blocks[2].outcome).toBeUndefined();
    expect(blocks[3].outcome).toBeUndefined();
  });

  it("is the sections alone when there is no edition", () => {
    expect(currentBlocks([data("a")], [], null)).toEqual([data("a")]);
  });
});

describe("planRetention", () => {
  const editions = (count: number, pinned: (index: number) => boolean): EditionSummary[] =>
    // Newest first, as the report keeps them: index 0 is the newest.
    Array.from({ length: count }, (_, index) => ({ id: "e" + index, asOf: 10_000 - index, period: PERIOD, pinned: pinned(index), createdBy: "member" as const }));

  it("removes nothing while there is room for one more", () => {
    expect(planRetention(editions(LIMITS.editions - 1, () => false))).toEqual([]);
  });

  it("removes the oldest unpinned edition when the limit is reached", () => {
    expect(planRetention(editions(LIMITS.editions, () => false))).toEqual(["e" + (LIMITS.editions - 1)]);
  });

  it("passes over pinned editions to the oldest that is not", () => {
    const oldestTwoPinned = editions(LIMITS.editions, (index) => index >= LIMITS.editions - 2);
    expect(planRetention(oldestTwoPinned)).toEqual(["e" + (LIMITS.editions - 3)]);
  });

  it("refuses when every edition is pinned", () => {
    expect(() => planRetention(editions(LIMITS.editions, () => true))).toThrow(ALL_PINNED);
    expect(ALL_PINNED).toBe("All 24 editions are pinned. Unpin one to generate a new edition.");
  });
});
