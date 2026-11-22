// Sniffing and decoding of staged CSV files (research R9): encoding, delimiter, header row, footer
// total rows, and the streaming reader's resume offsets across a quoted newline.

import { describe, expect, it } from "vitest";
import { bytesCsvSource, readCsvRange, type CsvRecord } from "../src/import/csv-stream.js";
import { detectEncoding } from "../src/import/decode.js";
import { sniffCsv } from "../src/import/sniff.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** windows-1252 bytes of Latin-1 text (every character here is below U+0100). */
function cp1252(text: string): Uint8Array {
  return Uint8Array.from(text, char => char.charCodeAt(0));
}

/** UTF-16LE bytes with a BOM. */
function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index++) {
    bytes[2 + index * 2] = text.charCodeAt(index) & 0xff;
    bytes[3 + index * 2] = text.charCodeAt(index) >> 8;
  }
  return bytes;
}

/** Reads every data record of a file in ranges of `rangeBytes`, resuming from each range's end. */
async function readAll(bytes: Uint8Array, rangeBytes: number) {
  const source = bytesCsvSource(bytes);
  const sniffed = await sniffCsv(source);
  const records: CsvRecord[] = [];
  let position = { offset: sniffed.dataOffset, row: sniffed.dataRow };
  for (;;) {
    const range = await readCsvRange(source, position, {
      encoding: sniffed.sniff.encoding, delimiter: sniffed.sniff.delimiter, rangeBytes,
    });
    records.push(...range.records);
    if (range.eof) break;
    position = range.next;
  }
  return { sniffed, records };
}

describe("encoding", () => {
  it("reads valid UTF-8 as UTF-8 and other bytes as windows-1252", () => {
    expect(detectEncoding(utf8("Café,1\n"))).toBe("utf-8");
    expect(detectEncoding(cp1252("Café,1\n"))).toBe("windows-1252");
  });

  it("follows a byte-order mark", async () => {
    const sniffed = await sniffCsv(bytesCsvSource(utf16le("Order,Total\nA-1,12.50\n")));
    expect(sniffed.sniff.encoding).toBe("utf-16le");
    expect(sniffed.headers).toEqual(["Order", "Total"]);
    expect(sniffed.sampleRows).toEqual([["A-1", "12.50"]]);
  });

  it("decodes windows-1252 cells and keeps byte offsets in the file's encoding", async () => {
    const text = "Item;Qty\nCrème brûlée;2\nCafé;1\n";
    const { sniffed, records } = await readAll(cp1252(text), 12);
    expect(sniffed.sniff).toMatchObject({ encoding: "windows-1252", delimiter: ";" });
    expect(records.map(record => record.cells)).toEqual([["Crème brûlée", "2"], ["Café", "1"]]);
    expect(records.at(-1)!.end).toBe(cp1252(text).length);
  });
});

describe("delimiter, header row and footer", () => {
  const messy = [
    "Sales export",
    "Generated 11/17/2026",
    "Order Id;Date;Item;Total",
    "1001;11/16/2026;\"Latte\nlarge\";4,50",
    "1002;11/16/2026;Mocha;5,00",
    ";;Total;9,50",
    "",
  ].join("\r\n");

  it("finds the semicolon, the header on row 3 and the total row", async () => {
    const sniffed = await sniffCsv(bytesCsvSource(utf8(messy)));
    expect(sniffed.sniff).toEqual({ encoding: "utf-8", delimiter: ";", headerRow: 3, footerRows: 1 });
    expect(sniffed.headers).toEqual(["Order Id", "Date", "Item", "Total"]);
    expect(sniffed.sampleRows).toEqual([
      ["1001", "11/16/2026", "Latte\nlarge", "4,50"],
      ["1002", "11/16/2026", "Mocha", "5,00"],
    ]);
    expect(sniffed.dataRow).toBe(4);
  });

  it("honours overrides", async () => {
    const sniffed = await sniffCsv(bytesCsvSource(utf8(messy)), { headerRow: 4, footerRows: 0 });
    expect(sniffed.sniff.headerRow).toBe(4);
    expect(sniffed.headers[0]).toBe("1001");
  });

  it("picks the comma and row 1 for an ordinary file", async () => {
    const sniffed = await sniffCsv(bytesCsvSource(utf8("a,b,c\n1,2,3\n4,5,6\n")));
    expect(sniffed.sniff).toEqual({ encoding: "utf-8", delimiter: ",", headerRow: 1, footerRows: 0 });
  });
});

describe("streaming reader", () => {
  it("resumes at record boundaries, so a quoted newline never splits a row", async () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      `${index},"note ${index}\nsecond line, with comma",${"é".repeat(index % 5)}`);
    const text = `id,note,extra\n${rows.join("\n")}\n`;
    for (const rangeBytes of [7, 31, 64, 1024]) {
      const { records } = await readAll(utf8(text), rangeBytes);
      expect(records.map(record => record.cells[0])).toEqual(Array.from({ length: 40 }, (_, index) => String(index)));
      expect(records[3]!.cells[1]).toBe("note 3\nsecond line, with comma");
      expect(records.map(record => record.row)).toEqual(Array.from({ length: 40 }, (_, index) => index + 2));
    }
  });

  it("refuses an unclosed quote at the end of the file", async () => {
    const source = bytesCsvSource(utf8("a,b\n1,\"open\n"));
    await expect(readCsvRange(source, { offset: 4, row: 2 }, { encoding: "utf-8", delimiter: "," }))
      .rejects.toThrow(/quote is never closed/);
  });
});
