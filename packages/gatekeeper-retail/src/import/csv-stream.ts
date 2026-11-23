// The streaming CSV reader (research R9). A file in R2 is read one byte range at a time; each range
// is decoded and parsed with csv-parse, and every record carries the absolute byte offset just
// after it (from csv-parse's `info.bytes`). A resume therefore always starts at a record boundary,
// so a quoted newline never straddles two ranges.

import { parse, type CsvError } from "csv-parse/browser/esm/sync";
import { byteOffsetOf, codeUnitsAtUtf8Offset, decodeChunk } from "./decode.js";

/** Bytes read per range. */
export const DEFAULT_RANGE_BYTES = 4 * 1024 * 1024;

/** A single record may not be longer than this. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** The field separators the sniffer and the mapping accept. */
export type Delimiter = "," | ";" | "\t" | "|";

/** One parsed record. */
export type CsvRecord = {
  cells: string[];
  /** 1-based record number in the file (the header row counts). */
  row: number;
  /** Absolute byte offset just after the record. */
  end: number;
};

/** A CSV file whose bytes can be read by range. */
export type CsvSource = {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
};

/** Where reading continues. */
export type CsvPosition = { offset: number; row: number };

/** Records read from one range, and the position after the last of them. */
export type CsvRange = { records: CsvRecord[]; next: CsvPosition; eof: boolean };

/**
 * Parses decoded text. With `final` false, the text may end inside a record: that record (complete
 * or not) is left out, and an unclosed quote at the end is not an error. Each record's `end` is
 * its UTF-16 end offset in `text`.
 */
export function parseCsvText(text: string, delimiter: Delimiter, final: boolean): { cells: string[]; end: number }[] {
  const records: { cells: string[]; utf8End: number }[] = [];
  try {
    parse(text, {
      delimiter,
      bom: false,
      relax_column_count: true,
      skip_empty_lines: true,
      on_record: (record: string[], info) => {
        records.push({ cells: record, utf8End: info.bytes });
        return null;
      },
    });
  } catch (error) {
    if (final || (error as CsvError).code !== "CSV_QUOTE_NOT_CLOSED") throw describeCsvError(error);
  }
  if (!final) records.pop();
  return records.map(record => ({ cells: record.cells, end: codeUnitsAtUtf8Offset(text, record.utf8End) }));
}

/**
 * Reads the complete records of one range starting at `position`. Grows the range when a single
 * record does not fit, up to `MAX_RECORD_BYTES`.
 */
export async function readCsvRange(
  source: CsvSource,
  position: CsvPosition,
  options: { encoding: string; delimiter: Delimiter; rangeBytes?: number },
): Promise<CsvRange> {
  let length = options.rangeBytes ?? DEFAULT_RANGE_BYTES;
  for (;;) {
    const remaining = source.size - position.offset;
    if (remaining <= 0) return { records: [], next: position, eof: true };
    const eof = length >= remaining;
    const bytes = await source.read(position.offset, Math.min(length, remaining));
    const text = decodeChunk(bytes, options.encoding, eof);
    const parsed = parseCsvText(text, options.delimiter, eof);
    if (parsed.length > 0 || eof) {
      const records = parsed.map((record, index) => ({
        cells: record.cells,
        row: position.row + index,
        end: position.offset + byteOffsetOf(text, record.end, bytes, options.encoding),
      }));
      const last = records.at(-1);
      return {
        records,
        next: eof ? { offset: source.size, row: position.row + records.length }
          : { offset: last!.end, row: last!.row + 1 },
        eof,
      };
    }
    if (length >= MAX_RECORD_BYTES) {
      throw new Error(`Row ${position.row} is longer than ${MAX_RECORD_BYTES / 1024 / 1024} MB, or a quote is never closed.`);
    }
    length = Math.min(length * 2, MAX_RECORD_BYTES);
  }
}

/** A `CsvSource` over an R2 object. */
export function r2CsvSource(bucket: R2Bucket, key: string, size: number): CsvSource {
  return {
    size,
    async read(offset, length) {
      const object = await bucket.get(key, { range: { offset, length } });
      if (!object) throw new Error("The imported file is no longer stored.");
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}

/** A `CsvSource` over bytes in memory. */
export function bytesCsvSource(bytes: Uint8Array): CsvSource {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}

/** csv-parse errors name a line; they never carry cell values. */
function describeCsvError(error: unknown): Error {
  const csv = error as Partial<CsvError> & { lines?: number };
  if (typeof csv.code === "string") {
    const reason = csv.code === "CSV_QUOTE_NOT_CLOSED" ? "a quote is never closed"
      : csv.code === "CSV_INVALID_CLOSING_QUOTE" ? "a quote closes in the middle of a field"
      : csv.code.toLowerCase().replace(/^csv_/, "").replaceAll("_", " ");
    return new Error(`The file is not valid CSV${csv.lines ? ` near line ${csv.lines}` : ""}: ${reason}.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
