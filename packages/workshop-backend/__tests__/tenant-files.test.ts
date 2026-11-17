import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_FILE_BYTES, DEFAULT_TENANT_QUOTA_BYTES, MAX_FILE_NAME_LENGTH,
  escapeLike, filesLimits, isDeniedFileType, isPreviewableType, parsePageCursor,
  sanitizeContentType, uniqueFileName, validateFileName,
} from "../src/tenant-files";

describe("validateFileName", () => {
  it("returns the trimmed name and keeps what people really call files", () => {
    expect(validateFileName("  Q3 report (final).pdf ")).toBe("Q3 report (final).pdf");
    expect(validateFileName("séance-日本語-📎.txt")).toBe("séance-日本語-📎.txt");
    expect(validateFileName("a".repeat(MAX_FILE_NAME_LENGTH))).toHaveLength(MAX_FILE_NAME_LENGTH);
  });

  it.each([
    ["blank", "   "],
    ["too long", "a".repeat(MAX_FILE_NAME_LENGTH + 1)],
    ["a slash", "dir/file.txt"],
    ["a backslash", "dir\\file.txt"],
    ["a dot name", ".."],
    ["a control character", "bad\u0000name.txt"],
    ["a newline", "bad\nname.txt"],
    ["a bidirectional override", "evil\u202Egnp.txt"],
  ])("refuses %s", (_label, name) => {
    expect(() => validateFileName(name)).toThrow();
  });
});

describe("isDeniedFileType", () => {
  it.each(["setup.exe", "run.SH", "page.html", "logo.svg", "a.b.js", "x.HTM", "evil.exe.", "evil.exe "])(
      "refuses the name %s whatever its type", name => {
    expect(isDeniedFileType(name, "application/octet-stream")).toBe(true);
  });

  it.each(["text/html", "image/svg+xml", "application/javascript"])(
      "refuses the type %s whatever its name", type => {
    expect(isDeniedFileType("harmless.txt", type)).toBe(true);
  });

  it("accepts ordinary documents, images and archives, and a hidden file with no extension", () => {
    for (const name of ["report.pdf", "photo.jpeg", "data.csv", "backup.zip", "notes.txt", ".gitignore", "exe"]) {
      expect(isDeniedFileType(name, "application/octet-stream")).toBe(false);
    }
    // The extension is the last one: a name that merely contains a denied word is not denied.
    expect(isDeniedFileType("how-to-run-a.sh.txt", "text/plain")).toBe(false);
  });
});

describe("sanitizeContentType", () => {
  it("keeps a bare lower-case type and drops parameters", () => {
    expect(sanitizeContentType("Image/PNG")).toBe("image/png");
    expect(sanitizeContentType("text/plain; charset=utf-8")).toBe("text/plain");
  });

  it.each(["", "png", "text/html\r\nSet-Cookie: x=1", "a/b/c", `text/${"x".repeat(200)}`, "<script>/x"])(
      "falls back to opaque bytes for %j", value => {
    expect(sanitizeContentType(value)).toBe("application/octet-stream");
  });
});

describe("isPreviewableType", () => {
  it("allows only images that cannot script, and PDF", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]) {
      expect(isPreviewableType(type)).toBe(true);
    }
    for (const type of ["image/svg+xml", "text/html", "text/plain", "application/octet-stream"]) {
      expect(isPreviewableType(type)).toBe(false);
    }
  });
});

describe("uniqueFileName", () => {
  it("returns a free name unchanged and numbers a taken one before the extension", () => {
    expect(uniqueFileName("a.txt", () => false)).toBe("a.txt");
    const taken = new Set(["a.txt", "a (2).txt"]);
    expect(uniqueFileName("a.txt", name => taken.has(name))).toBe("a (3).txt");
    expect(uniqueFileName("README", name => name === "README")).toBe("README (2)");
    expect(uniqueFileName(".env", name => name === ".env")).toBe(".env (2)");
  });

  it("keeps the result within the name limit", () => {
    const long = `${"a".repeat(MAX_FILE_NAME_LENGTH - 4)}.txt`;
    const result = uniqueFileName(long, name => name === long);
    expect(result.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(result.endsWith(" (2).txt")).toBe(true);
  });
});

describe("escapeLike and parsePageCursor", () => {
  it("makes wildcards literal", () => {
    expect(escapeLike("100%_done\\")).toBe("100\\%\\_done\\\\");
  });

  it("accepts a sequence number and refuses anything else", () => {
    expect(parsePageCursor(undefined)).toBeUndefined();
    expect(parsePageCursor("42")).toBe(42);
    for (const bad of ["", "-1", "1e3", "12abc", "9".repeat(16)]) {
      expect(() => parsePageCursor(bad)).toThrow("Invalid page cursor.");
    }
  });
});

describe("filesLimits", () => {
  it("uses the defaults, and the operator's positive integers over them", () => {
    expect(filesLimits({})).toEqual({
      maxFileBytes: DEFAULT_MAX_FILE_BYTES, quotaBytes: DEFAULT_TENANT_QUOTA_BYTES,
    });
    expect(filesLimits({ TENANT_FILES_MAX_FILE_BYTES: "2048", TENANT_FILES_QUOTA_BYTES: " 4096 " }))
        .toEqual({ maxFileBytes: 2048, quotaBytes: 4096 });
  });

  it.each(["0", "-5", "12.5", "lots", "", "1e9", "99999999999999999999"])(
      "falls back to the default for %j", value => {
    expect(filesLimits({ TENANT_FILES_MAX_FILE_BYTES: value, TENANT_FILES_QUOTA_BYTES: value })).toEqual({
      maxFileBytes: DEFAULT_MAX_FILE_BYTES, quotaBytes: DEFAULT_TENANT_QUOTA_BYTES,
    });
  });
});
