// Decoding CSV bytes (research R9). The encoding is sniffed once per file: a BOM selects UTF-8 or
// UTF-16; otherwise strict UTF-8 is tried on the first megabyte, falling back to windows-1252. The
// member can override it with any WHATWG label. Byte offsets stay in the file's own encoding, so an
// import can resume from R2 at the exact byte after the last complete record.

/** Bytes of the head that strict UTF-8 must decode for a file to be read as UTF-8. */
export const ENCODING_SNIFF_BYTES = 1024 * 1024;

/** The fallback for bytes that are not UTF-8 (the common legacy spreadsheet encoding). */
export const FALLBACK_ENCODING = "windows-1252";

// Encodings whose every byte decodes to exactly one UTF-16 code unit.
const SINGLE_BYTE = /^(ibm866|iso-8859-\d+|koi8-[ru]|macintosh|windows-874|windows-125\d|x-mac-cyrillic)$/;

/** The canonical WHATWG name of an encoding label, or null when `TextDecoder` does not know it. */
export function canonicalEncoding(label: string): string | null {
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return null;
  }
}

/** The length of the byte-order mark `bytes` start with in `encoding`, or 0. */
export function bomLength(bytes: Uint8Array, encoding: string): number {
  if (encoding === "utf-8" && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 3;
  if (encoding === "utf-16le" && bytes[0] === 0xff && bytes[1] === 0xfe) return 2;
  if (encoding === "utf-16be" && bytes[0] === 0xfe && bytes[1] === 0xff) return 2;
  return 0;
}

/** Sniffs the encoding of a file from its first bytes. */
export function detectEncoding(head: Uint8Array): string {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "utf-8";
  if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
  try {
    // `stream` keeps a multi-byte character cut by the sniff window from counting as invalid.
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(head.subarray(0, ENCODING_SNIFF_BYTES), { stream: true });
    return "utf-8";
  } catch {
    return FALLBACK_ENCODING;
  }
}

/**
 * Decodes a chunk that starts on a character boundary. When `final` is false, a character cut at
 * the end of the chunk is left out rather than replaced.
 */
export function decodeChunk(bytes: Uint8Array, encoding: string, final: boolean): string {
  return new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(bytes, { stream: !final });
}

/**
 * Where text offsets lie in the bytes `text` was decoded from: for each of `codeUnitEnds` (UTF-16
 * offsets into `text`, ascending, each on a character boundary), the number of bytes of `bytes`
 * that decode to the text before it. The work grows with the text, not with offsets × text.
 */
export function byteOffsetsOf(text: string, codeUnitEnds: readonly number[], bytes: Uint8Array, encoding: string): number[] {
  if (encoding === "utf-8") return utf8Lengths(text, codeUnitEnds);
  if (encoding === "utf-16le" || encoding === "utf-16be") return codeUnitEnds.map(end => end * 2);
  if (SINGLE_BYTE.test(encoding)) return [...codeUnitEnds];
  // Other multi-byte encodings (Shift_JIS, GBK, Big5, ...): from the previous offset, the shortest
  // run of bytes that decodes to the code units up to the next one, bracketed by doubling.
  const offsets: number[] = [];
  let start = 0;
  let decoded = 0;
  for (const end of codeUnitEnds) {
    const reaches = (to: number) => decodeChunk(bytes.subarray(start, to), encoding, false).length >= end - decoded;
    let low = start;
    let span = Math.max(1, end - decoded);
    let high = Math.min(bytes.length, start + span);
    while (high < bytes.length && !reaches(high)) {
      low = high + 1;
      span *= 2;
      high = Math.min(bytes.length, start + span);
    }
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (reaches(middle)) high = middle;
      else low = middle + 1;
    }
    offsets.push(low);
    start = low;
    decoded = end;
  }
  return offsets;
}

/**
 * The code-unit index in `text` of each of `utf8Offsets` (ascending UTF-8 byte offsets into the
 * text), in one pass.
 */
export function codeUnitsAtUtf8Offsets(text: string, utf8Offsets: readonly number[]): number[] {
  const indexes: number[] = [];
  let bytes = 0;
  let index = 0;
  for (const offset of utf8Offsets) {
    while (index < text.length && bytes < offset) {
      const code = text.codePointAt(index)!;
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      index += code >= 0x10000 ? 2 : 1;
    }
    indexes.push(index);
  }
  return indexes;
}

/** UTF-8 byte lengths of the text before each of `codeUnitEnds` (ascending), in one pass. */
function utf8Lengths(text: string, codeUnitEnds: readonly number[]): number[] {
  const lengths: number[] = [];
  let bytes = 0;
  let index = 0;
  for (const end of codeUnitEnds) {
    while (index < end) {
      const code = text.codePointAt(index)!;
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      index += code >= 0x10000 ? 2 : 1;
    }
    lengths.push(bytes);
  }
  return lengths;
}
