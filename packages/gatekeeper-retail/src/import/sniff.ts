// Sniffing a staged CSV file (research R9): encoding, delimiter, header row and footer total rows.
// Every value is a guess the member can override in the mapping's `parsing` section; the sniffer
// only reads the head (and, for large files, the tail) of the file.

import type { SniffResult } from "../app-api-types.js";
import { type CsvSource, type Delimiter, parseCsvText } from "./csv-stream.js";
import { bomLength, byteOffsetOf, decodeChunk, detectEncoding } from "./decode.js";

/** Bytes read from the start of a file to sniff it. */
export const SNIFF_HEAD_BYTES = 256 * 1024;

/** Bytes read from the end of a large file to find footer rows. */
export const SNIFF_TAIL_BYTES = 64 * 1024;

/** Characters the delimiter vote looks at. */
const DELIMITER_WINDOW = 64 * 1024;

/** Rows within which the header must appear. */
const HEADER_SEARCH_ROWS = 20;

/** Sample rows kept after the header. */
export const SAMPLE_ROWS = 20;

const DELIMITERS: readonly Delimiter[] = [",", ";", "\t", "|"];

/** What sniffing a file found. */
export type SniffedFile = {
  sniff: SniffResult;
  headers: string[];
  sampleRows: (string | null)[][];
  /** Byte offset of the first data row (after the BOM and the header row). */
  dataOffset: number;
  /** 1-based record number of the first data row. */
  dataRow: number;
};

/** Settings that override the sniffed ones. */
export type ParsingOverrides = {
  encoding?: string;
  delimiter?: Delimiter;
  headerRow?: number;
  footerRows?: number;
};

/** Sniffs a file, applying `overrides` where given. */
export async function sniffCsv(source: CsvSource, overrides: ParsingOverrides = {}): Promise<SniffedFile> {
  const headBytes = await source.read(0, Math.min(SNIFF_HEAD_BYTES, source.size));
  const encoding = overrides.encoding ?? detectEncoding(headBytes);
  const bom = bomLength(headBytes, encoding);
  const body = headBytes.subarray(bom);
  const whole = source.size <= SNIFF_HEAD_BYTES;
  const text = decodeChunk(body, encoding, whole);
  if (text.trim() === "") throw new Error("The file is empty.");

  const delimiter = overrides.delimiter ?? sniffDelimiter(text);
  const records = parseCsvText(text, delimiter, whole);
  if (records.length === 0) throw new Error("No complete row was found in the first part of the file.");

  const headerIndex = overrides.headerRow !== undefined
    ? overrides.headerRow - 1
    : findHeaderRow(records.slice(0, HEADER_SEARCH_ROWS).map(record => record.cells));
  const header = records[headerIndex];
  if (!header) throw new Error(`The file has no row ${headerIndex + 1} to read headers from.`);
  const headers = header.cells.map(cell => cell.trim());

  let footerRows = overrides.footerRows;
  if (footerRows === undefined) {
    const tailCells = whole
      ? records.slice(headerIndex + 1).map(record => record.cells)
      : await tailRecords(source, encoding, delimiter);
    footerRows = countFooterRows(headers, tailCells);
  }

  const dataRecords = records.slice(headerIndex + 1);
  const sampleRows = (whole ? dataRecords.slice(0, Math.max(0, dataRecords.length - footerRows)) : dataRecords)
    .slice(0, SAMPLE_ROWS)
    .map(record => headers.map((_, column) => record.cells[column] ?? null));
  return {
    sniff: { encoding, delimiter, headerRow: headerIndex + 1, footerRows },
    headers,
    sampleRows,
    dataOffset: bom + byteOffsetOf(text, header.end, body, encoding),
    dataRow: headerIndex + 2,
  };
}

/**
 * The delimiter whose rows have the most consistent field count (more than one field), over the
 * first 64 KB. Title lines above the header do not disturb the vote: it uses the most common count.
 */
export function sniffDelimiter(text: string): Delimiter {
  const window = text.slice(0, DELIMITER_WINDOW);
  let best: { delimiter: Delimiter; score: number } = { delimiter: ",", score: -1 };
  for (const delimiter of DELIMITERS) {
    let rows: string[][];
    try {
      rows = parseCsvText(window, delimiter, window.length === text.length).slice(0, 50).map(record => record.cells);
    } catch {
      continue;
    }
    if (rows.length === 0) continue;
    const frequency = new Map<number, number>();
    for (const row of rows) frequency.set(row.length, (frequency.get(row.length) ?? 0) + 1);
    const [mode, count] = [...frequency].toSorted((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    if (mode < 2) continue;
    const score = (count / rows.length) * 100 + Math.min(mode, 50);
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/**
 * The 0-based index of the header: the first row with the usual field count whose non-empty cells
 * are mostly non-numeric and all distinct.
 */
export function findHeaderRow(rows: string[][]): number {
  const frequency = new Map<number, number>();
  for (const row of rows) frequency.set(row.length, (frequency.get(row.length) ?? 0) + 1);
  const mode = [...frequency].toSorted((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  for (const [index, row] of rows.entries()) {
    if (row.length < Math.max(2, Math.ceil(mode * 0.8))) continue;
    const cells = row.map(cell => cell.trim()).filter(cell => cell !== "");
    if (cells.length < Math.ceil(row.length / 2)) continue;
    const textual = cells.filter(cell => !/^[-+$€£¥(]*[\d.,\s:/%)-]+$/.test(cell)).length;
    if (textual / cells.length < 0.5) continue;
    if (new Set(cells.map(cell => cell.toLowerCase())).size !== cells.length) continue;
    return index;
  }
  return 0;
}

/**
 * Trailing total rows: from the end, rows whose id column is blank or says "total", and which
 * contain the word "total" somewhere.
 */
export function countFooterRows(headers: string[], rows: string[][]): number {
  const idColumn = Math.max(0, headers.findIndex(header => /\b(id|number|no\.?|#)\s*$/i.test(header)));
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const id = (row[idColumn] ?? "").trim();
    const mentionsTotal = row.some(cell => /\btotals?\b/i.test(cell));
    if (!mentionsTotal || (id !== "" && !/\btotals?\b/i.test(id))) break;
    count++;
  }
  return count;
}

/** Complete records in the last bytes of a large file, starting after the first line break. */
async function tailRecords(source: CsvSource, encoding: string, delimiter: Delimiter): Promise<string[][]> {
  const start = Math.max(0, source.size - SNIFF_TAIL_BYTES);
  const bytes = await source.read(start, source.size - start);
  // Start on a character boundary for UTF-16 by aligning to an even offset.
  const aligned = encoding.startsWith("utf-16") && start % 2 === 1 ? bytes.subarray(1) : bytes;
  const text = decodeChunk(aligned, encoding, true);
  const firstBreak = text.search(/\r?\n/);
  if (firstBreak < 0) return [];
  try {
    return parseCsvText(text.slice(firstBreak).replace(/^\r?\n/, ""), delimiter, true).map(record => record.cells);
  } catch {
    // The window may begin inside a quoted field; then no footer is guessed.
    return [];
  }
}
