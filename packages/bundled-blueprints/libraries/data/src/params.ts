/**
 * Named parameters for a saved SQL query: the one place a viewer's filter values meet query text.
 *
 * A saved query names its inputs (`:from`, `:to`, `:locations`, and literals it declares). The
 * compiler walks the text token by token, leaves strings, quoted identifiers and comments exactly
 * as written, and swaps each name for `?` placeholders while it builds the positional value
 * array. A value is never written into the text: the only characters this module can add are
 * `?`, `,` and a space, so no filter value can change what a query means, whatever it contains.
 *
 * The tokenizer does not have to agree with SQLite's on every corner. Where the two differ, a
 * name is left unreplaced or a placeholder goes unfilled, the placeholder count no longer matches
 * the value count, and the dataset refuses the statement. The dataset's own guard stays the
 * authority on what a read is; the checks here refuse the obvious cases without a round trip.
 */

import type { FilterName, ResolvedFilters, SavedQuery } from "./model.ts";
import type { Scalar } from "./retail.ts";

/** The most values one query may bind: the dataset's own limit (`limits.maxParams`). */
export const MAX_BOUND_VALUES = 100;

type Token =
  /** A string, a quoted identifier or a comment: copied through, never read. */
  | { kind: "opaque"; text: string; comment: boolean }
  | { kind: "space"; text: string }
  /** A run of letters, digits and underscores: a keyword, an identifier or a number. */
  | { kind: "word"; text: string }
  /** `:name`. */
  | { kind: "param"; text: string; name: string }
  /** Any other character, or `::` as one piece. */
  | { kind: "symbol"; text: string };

const isLetter = (char: string) => (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
const isWordChar = (char: string) => isLetter(char) || (char >= "0" && char <= "9") || char === "_";
const isSpace = (char: string) => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

/**
 * The end of a quoted run that opens at `start` and closes at `close`, where a doubled closing
 * character stands for itself (`'it''s'`). An unclosed run takes the rest of the text, so nothing
 * after an open quote is ever read as a parameter.
 */
function quotedEnd(sql: string, start: number, close: string, doubles: boolean): number {
  let at = start + 1;
  while (at < sql.length) {
    if (sql[at] === close) {
      if (doubles && sql[at + 1] === close) {
        at += 2;
        continue;
      }
      return at + 1;
    }
    at++;
  }
  return sql.length;
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < sql.length) {
    const char = sql[at];
    const next = sql[at + 1] ?? "";
    let end: number;
    if (char === "'" || char === '"' || char === "`") {
      end = quotedEnd(sql, at, char, true);
      tokens.push({ kind: "opaque", text: sql.slice(at, end), comment: false });
    } else if (char === "[") {
      end = quotedEnd(sql, at, "]", false);
      tokens.push({ kind: "opaque", text: sql.slice(at, end), comment: false });
    } else if (char === "-" && next === "-") {
      const newline = sql.indexOf("\n", at);
      end = newline === -1 ? sql.length : newline + 1;
      tokens.push({ kind: "opaque", text: sql.slice(at, end), comment: true });
    } else if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", at + 2);
      end = close === -1 ? sql.length : close + 2;
      tokens.push({ kind: "opaque", text: sql.slice(at, end), comment: true });
    } else if (char === ":" && next === ":") {
      end = at + 2;
      tokens.push({ kind: "symbol", text: "::" });
    } else if (char === ":" && isLetter(next)) {
      end = at + 2;
      while (end < sql.length && isWordChar(sql[end])) end++;
      tokens.push({ kind: "param", text: sql.slice(at, end), name: sql.slice(at + 1, end) });
    } else if (isSpace(char)) {
      end = at + 1;
      while (end < sql.length && isSpace(sql[end])) end++;
      tokens.push({ kind: "space", text: sql.slice(at, end) });
    } else if (isWordChar(char)) {
      end = at + 1;
      while (end < sql.length && isWordChar(sql[end])) end++;
      tokens.push({ kind: "word", text: sql.slice(at, end) });
    } else {
      end = at + 1;
      tokens.push({ kind: "symbol", text: char });
    }
    at = end;
  }
  return tokens;
}

/**
 * Turns a saved query's text into what the dataset runs: the same text with every `:name`
 * replaced by `?` placeholders, and the values those placeholders bind, in order.
 *
 * `:from` and `:to` bind the resolved business dates. `:locations` binds one value per selected
 * location, every location in `allLocationIds` when none is selected, and a single NULL when
 * there is no location at all (so `IN (:locations)` stays valid and matches nothing). Any other
 * name binds the literal the query declared for it.
 *
 * Throws, in words a person can act on, for text that is not one `SELECT` or `WITH` statement,
 * for a name with no value, for a positional `?`, and for more than {@link MAX_BOUND_VALUES}
 * bound values.
 */
export function compileSql(
  sql: string,
  filters: ResolvedFilters,
  literals: Record<string, Scalar>,
  allLocationIds: number[],
): { sql: string; params: Scalar[] } {
  const locations: Scalar[] = filters.locations.length > 0 ? filters.locations
    : allLocationIds.length > 0 ? allLocationIds
    : [null];
  const params: Scalar[] = [];
  let text = "";
  let started = false;
  let ended = false;
  for (const token of tokenize(sql)) {
    const blank = token.kind === "space" || (token.kind === "opaque" && token.comment);
    if (!blank) {
      if (ended) throw new Error("A saved query is a single statement. Remove what follows the semicolon.");
      if (!started) {
        const keyword = token.kind === "word" ? token.text.toUpperCase() : "";
        if (keyword !== "SELECT" && keyword !== "WITH") throw new Error("Only read queries can be saved.");
        started = true;
      }
    }
    if (token.kind === "symbol" && token.text === ";") ended = true;
    if (token.kind === "symbol" && token.text === "?") {
      // A positional placeholder would take the first bound value, whichever name it was meant for.
      throw new Error("Write each parameter as a name such as :from. A bare ? cannot be used in a saved query.");
    }
    if (token.kind !== "param") {
      text += token.text;
      continue;
    }
    let values: Scalar[];
    if (token.name === "from") values = [filters.from];
    else if (token.name === "to") values = [filters.to];
    else if (token.name === "locations") values = locations;
    else if (Object.hasOwn(literals, token.name)) values = [literals[token.name]];
    else throw new Error(`This query uses :${token.name.slice(0, 60)}, which is not defined.`);
    params.push(...values);
    if (params.length > MAX_BOUND_VALUES) {
      throw new Error(`This query binds more than ${MAX_BOUND_VALUES} values, which is the most the dataset accepts. Select fewer locations, or use :locations fewer times.`);
    }
    text += values.map(() => "?").join(", ");
  }
  if (!started) throw new Error("Only read queries can be saved.");
  return { sql: text, params };
}

/**
 * Whether a query can react to a shared filter. A metric query reacts to both; a SQL query to the
 * filters whose names appear in its text (`:from` or `:to` for the date range, `:locations` for
 * the locations), outside strings and comments.
 */
export function usesFilter(query: SavedQuery, name: FilterName): boolean {
  if (query.kind === "metric") return true;
  const wanted = name === "dateRange" ? ["from", "to"] : ["locations"];
  return tokenize(query.sql).some(token => token.kind === "param" && wanted.includes(token.name));
}
