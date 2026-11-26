// Editions: building one from the report's sections and what their queries returned, comparing
// two editions' numbers, deciding which text to flag for review and which data sections the latest
// edition does not hold yet, and choosing what retention removes. Pure functions over plain data,
// so the rules are tested without a Durable Object.
import type { QueryFailure, QueryOutcome, QueryResult, Scalar } from "@gadgets/bundled-blueprints/libraries/data/server";
import { type DataSection, type Edition, type EditionAuthor, type EditionBlock, type EditionSummary, LIMITS, type Letterhead, type Section } from "./protocol.ts";

/**
 * The most characters one edition holds once serialized. An edition is one stored value, and a
 * stored value is at most 2 MiB with up to two bytes a character.
 */
export const EDITION_MAX_CHARS = 900_000;

export const ALL_PINNED = `All ${LIMITS.editions} editions are pinned. Unpin one to generate a new edition.`;

export const EDITION_TOO_LONG = "This report is too long to keep as one edition. Shorten or remove some text sections, then generate again.";

export function isFailure(outcome: QueryOutcome): outcome is QueryFailure {
  return "error" in outcome;
}

/** A copy that shares nothing with its source. Sections and outcomes are plain JSON data. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** JSON with every object's keys in order, so two equal values always read the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}

// cyrb53's two interleaved 32-bit multiplicative hashes, written out as 16 hex digits: fast, with
// no dependency, and far more than enough to tell two results of one query apart.
function hash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h2) + hex(h1);
}

/**
 * What a data block's numbers were, as one short string: a hash of its columns' names, its rows
 * and its previous period's rows, in order. A failed block's is "error".
 */
export function fingerprint(outcome: QueryOutcome): string {
  if (isFailure(outcome)) return "error";
  return hash(JSON.stringify([outcome.columns.map((column) => column.name), outcome.rows, outcome.previous ? outcome.previous.rows : null]));
}

/** What a data section runs: its query and the sort and limit applied to the rows, as one string. */
export function runKey(section: DataSection): string {
  return canonical({ query: section.query, sort: section.visual.sort ?? null, limit: section.visual.limit ?? null });
}

// Keeps the first rows that fit in `room` characters and marks the result as cut. The current
// period's rows come before the previous period's, which a comparison can do without.
function fitResult(result: QueryResult, room: number): QueryResult {
  const empty: QueryResult = { ...result, rows: [], truncated: true, ...(result.previous ? { previous: { ...result.previous, rows: [] } } : {}) };
  let left = room - JSON.stringify(empty).length;
  const take = (rows: Scalar[][]): Scalar[][] => {
    const kept: Scalar[][] = [];
    for (const row of rows) {
      const size = JSON.stringify(row).length + 1;
      if (size > left) break;
      left -= size;
      kept.push(row);
    }
    return kept;
  };
  empty.rows = take(result.rows);
  if (empty.previous && result.previous) empty.previous.rows = take(result.previous.rows);
  return empty;
}

export type EditionInput = {
  id: string;
  asOf: number;
  period: { from: string; to: string };
  createdBy: EditionAuthor;
  title: string;
  letterhead: Letterhead;
  completeThrough: string | null;
  /** The report's sections, in order, as they stand. */
  sections: Section[];
  /** What each data section's query returned, by section id. */
  outcomes: Record<string, QueryOutcome>;
};

/**
 * The edition for one generation: a copy of every section and of each data section's outcome, so
 * nothing edited or read afterwards can change it. Results past the size one edition can hold keep
 * their first rows and are marked truncated; text is never cut, so a report whose text alone is
 * over the size is refused.
 */
export function buildEdition(input: EditionInput): Edition {
  const blocks: EditionBlock[] = copy(input.sections);
  const letterhead = copy(input.letterhead);
  let room = EDITION_MAX_CHARS - JSON.stringify({ title: input.title, letterhead, blocks }).length;
  if (room < 0) throw new Error(EDITION_TOO_LONG);
  const fingerprints: Record<string, string> = {};
  for (const block of blocks) {
    if (block.kind !== "data") continue;
    const outcome = input.outcomes[block.id];
    if (!outcome) continue;
    let kept = copy(outcome);
    if (!isFailure(kept) && JSON.stringify(kept).length > room) kept = fitResult(kept, Math.max(room, 0));
    room -= JSON.stringify(kept).length;
    block.outcome = kept;
    fingerprints[block.id] = fingerprint(kept);
  }
  return {
    id: input.id,
    asOf: input.asOf,
    period: { from: input.period.from, to: input.period.to },
    pinned: false,
    createdBy: input.createdBy,
    title: input.title,
    letterhead,
    completeThrough: input.completeThrough,
    blocks,
    fingerprints,
  };
}

export function summaryOf(edition: EditionSummary): EditionSummary {
  return { id: edition.id, asOf: edition.asOf, period: { from: edition.period.from, to: edition.period.to }, pinned: edition.pinned, createdBy: edition.createdBy };
}

/** The little of an edition the review and stale rules read, small enough to keep in memory. */
export type EditionDigest = {
  id: string;
  asOf: number;
  fingerprints: Record<string, string>;
  /** What each data block ran (see {@link runKey}), by section id. */
  runs: Record<string, string>;
};

export function digestOf(edition: Edition): EditionDigest {
  const runs: Record<string, string> = {};
  for (const block of edition.blocks) if (block.kind === "data") runs[block.id] = runKey(block);
  return { id: edition.id, asOf: edition.asOf, fingerprints: { ...edition.fingerprints }, runs };
}

/**
 * The text sections to review against the newest of `editions`. A text section is flagged when it
 * states a number (holds a digit) and at least one data section present in both editions has
 * different numbers in the newest edition than in the edition the text was last written or
 * confirmed against. Text that names no edition, or one that no longer exists, is compared with
 * the oldest edition; with a single edition there is nothing to compare, and nothing is flagged.
 * Editing a text section or marking it reviewed names the newest edition, which clears its flag.
 */
export function reviewFlags(sections: Section[], editions: EditionDigest[]): string[] {
  if (!editions.length) return [];
  const latest = editions.reduce((a, b) => (b.asOf > a.asOf ? b : a));
  const oldest = editions.reduce((a, b) => (b.asOf < a.asOf ? b : a));
  const byId = new Map(editions.map((edition) => [edition.id, edition]));
  const flagged: string[] = [];
  for (const section of sections) {
    if (section.kind !== "text" || !/\d/.test(section.text)) continue;
    const base = (section.reviewedEdition ? byId.get(section.reviewedEdition) : undefined) ?? oldest;
    if (base.id === latest.id) continue;
    const changed = Object.keys(latest.fingerprints).some((id) => id in base.fingerprints && base.fingerprints[id] !== latest.fingerprints[id]);
    if (changed) flagged.push(section.id);
  }
  return flagged;
}

/**
 * The data sections the latest edition does not show as they now stand: added since, or with a
 * different query, sort or limit than the edition's copy. Nothing is stale before the first
 * edition: there is nothing to be behind.
 */
export function staleSections(sections: Section[], latest: EditionDigest | null): string[] {
  if (!latest) return [];
  const stale: string[] = [];
  for (const section of sections) {
    if (section.kind === "data" && latest.runs[section.id] !== runKey(section)) stale.push(section.id);
  }
  return stale;
}

/**
 * The latest view: the report's sections as they now read, each data section carrying what the
 * latest edition holds for it. A data section in `stale` carries nothing, because the edition's
 * result answers a different question than the section now asks.
 */
export function currentBlocks(sections: Section[], stale: string[], edition: Edition | null): EditionBlock[] {
  const outcomes = new Map<string, QueryOutcome>();
  if (edition) {
    for (const block of edition.blocks) if (block.kind === "data" && block.outcome) outcomes.set(block.id, block.outcome);
  }
  return sections.map((section): EditionBlock => {
    const outcome = section.kind === "data" && !stale.includes(section.id) ? outcomes.get(section.id) : undefined;
    return outcome ? { ...section, outcome } : section;
  });
}

/**
 * The editions to delete so that one more fits under the limit: the oldest unpinned, as many as it
 * takes (one, unless the limit was lowered). Throws when every edition is pinned.
 */
export function planRetention(editions: EditionSummary[]): string[] {
  const kept = [...editions];
  const removed: string[] = [];
  while (kept.length >= LIMITS.editions) {
    let oldest = -1;
    kept.forEach((edition, index) => {
      if (!edition.pinned && (oldest < 0 || edition.asOf < kept[oldest].asOf)) oldest = index;
    });
    if (oldest < 0) throw new Error(ALL_PINNED);
    removed.push(kept[oldest].id);
    kept.splice(oldest, 1);
  }
  return removed;
}
