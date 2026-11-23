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
 * The number of bytes of `bytes` (decoded with `encoding`) that make up the first `codeUnits`
 * UTF-16 code units of the decoded text, i.e. where a text offset lies in the original bytes.
 */
export function byteOffsetOf(text: string, codeUnits: number, bytes: Uint8Array, encoding: string): number {
  if (encoding === "utf-8") return utf8Length(text, codeUnits);
  if (encoding === "utf-16le" || encoding === "utf-16be") return codeUnits * 2;
  if (SINGLE_BYTE.test(encoding)) return codeUnits;
  // Other multi-byte encodings (Shift_JIS, GBK, Big5, ...): the shortest prefix that decodes to at
  // least `codeUnits` code units.
  let low = 0;
  let high = bytes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (decodeChunk(bytes.subarray(0, middle), encoding, false).length >= codeUnits) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The code-unit index of the text position `utf8Offset` UTF-8 bytes into `text`. */
export function codeUnitsAtUtf8Offset(text: string, utf8Offset: number): number {
  let bytes = 0;
  let index = 0;
  while (index < text.length && bytes < utf8Offset) {
    const code = text.codePointAt(index)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += code >= 0x10000 ? 2 : 1;
  }
  return index;
}

/** UTF-8 byte length of the first `codeUnits` code units of `text`. */
function utf8Length(text: string, codeUnits: number): number {
  let bytes = 0;
  let index = 0;
  while (index < codeUnits) {
    const code = text.codePointAt(index)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += code >= 0x10000 ? 2 : 1;
  }
  return bytes;
}
