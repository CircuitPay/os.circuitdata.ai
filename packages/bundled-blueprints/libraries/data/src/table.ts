/**
 * The markup builders that are not pictures: the table every result can be read as, and the small
 * Markdown a text block is written in.
 *
 * Both return strings, so they run in a Durable Object (an export) as well as a page. Everything
 * that comes from a result or from a person goes through {@link escapeHtml} on its way into the
 * string; the only tags in the output are the ones written out in this file.
 */

import { columnHeading, formatValue, isNumericColumn } from "./format.ts";
import type { QueryResult } from "./model.ts";

/** The rows a table shows when the caller sets no limit. */
export const DEFAULT_TABLE_ROWS = 100;

/** Text made safe for element content and for a quoted attribute. */
export function escapeHtml(text: string): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** One sentence saying what a table holds, for its caption and for a visual's summary. */
export function describeTable(result: QueryResult): string {
  const rows = result.rows.length;
  const columns = result.columns.map(column => columnHeading(column));
  return `Table with ${rows} ${rows === 1 ? "row" : "rows"} and ${columns.length} ${columns.length === 1 ? "column" : "columns"}: ${columns.join(", ")}.`;
}

/**
 * A result as a `<table class="data-table">`: a caption for screen readers, a header row,
 * numeric columns marked `data-num` (right-aligned by the shared styles), and at most
 * `maxRows` rows followed by a row saying how many there are in all.
 */
export function renderTable(result: QueryResult, options: { maxRows?: number } = {}, locale?: string): string {
  const { columns, rows } = result;
  const asked = options.maxRows;
  const limit = asked !== undefined && Number.isInteger(asked) && asked > 0 ? asked : DEFAULT_TABLE_ROWS;
  const numeric = columns.map(column => (isNumericColumn(column) ? ' class="data-num"' : ""));
  const head = columns.map((column, index) =>
    `<th scope="col"${numeric[index]}>${escapeHtml(columnHeading(column))}</th>`).join("");
  const body = rows.slice(0, limit).map(row => {
    const cells = columns.map((column, index) =>
      `<td${numeric[index]}>${escapeHtml(formatValue(row[index] ?? null, column, row, columns, locale))}</td>`);
    return `<tr>${cells.join("")}</tr>`;
  }).join("");
  const empty = rows.length === 0
    ? `<tr><td class="data-note" colspan="${Math.max(1, columns.length)}">No rows for this period.</td></tr>`
    : "";
  const more = rows.length > limit
    ? `<tfoot><tr><td class="data-note" colspan="${columns.length}">Showing first ${limit} of ${rows.length} rows</td></tr></tfoot>`
    : "";
  return `<table class="data-table"><caption class="sr-only">${escapeHtml(describeTable(result))}</caption>`
    + `<thead><tr>${head}</tr></thead><tbody>${body}${empty}</tbody>${more}</table>`;
}

/** `**bold**` and `*italic*` in text that is already escaped; an asterisk beside a space stays an asterisk. */
function inline(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(?=\S)([^*]*?\S)\*/g, "<em>$1</em>");
}

/**
 * Markdown-lite as HTML: `#`, `##` and `###` headings, paragraphs, `**bold**`, `*italic*`, `-`
 * lists and line breaks. Every other character is escaped, so there are no links, no images and
 * no raw HTML. The three heading levels come out as `h3`, `h4` and `h5`: the text sits under a
 * tile's or a section's own heading, and must not add a second top of the page.
 */
export function renderMarkdownLite(text: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push(`<p>${paragraph.join("<br>")}</p>`);
    if (items.length > 0) blocks.push(`<ul>${items.map(item => `<li>${item}</li>`).join("")}</ul>`);
    paragraph = [];
    items = [];
  };
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (line === "") {
      flush();
    } else if (heading) {
      flush();
      const level = heading[1].length + 2;
      blocks.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
    } else if (line.startsWith("- ")) {
      // A list ends the paragraph before it, and a paragraph ends the list before it.
      if (paragraph.length > 0) flush();
      items.push(inline(escapeHtml(line.slice(2).trim())));
    } else {
      if (items.length > 0) flush();
      paragraph.push(inline(escapeHtml(line)));
    }
  }
  flush();
  return blocks.join("");
}
