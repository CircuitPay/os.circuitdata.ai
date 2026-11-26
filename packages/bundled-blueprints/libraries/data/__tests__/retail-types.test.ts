// @vitest-environment node
//
// `src/retail.ts` is a copy of the dataset's types, because a blueprint cannot import the retail
// gatekeeper's package. This test is what keeps the copy honest: it reads both files and fails
// when a declaration in one no longer matches the other.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const copy = readFileSync(join(here, "..", "src", "retail.ts"), "utf8");
const original = readFileSync(join(here, "..", "..", "..", "..", "gatekeeper-retail", "src", "types.d.ts"), "utf8");

const COPIED = [
  "RetailTable",
  "RetailColumnType",
  "RetailColumn",
  "RetailTableDescription",
  "RetailMetricName",
  "RetailMetricDefinition",
  "RetailDatasetDescription",
  "RetailQueryResult",
  "RetailMetricQuery",
  "RetailMetricResult",
];

/**
 * Every exported type and interface in a source text, by name, with whitespace collapsed. A
 * declaration runs to the next line that opens another declaration, a top-level comment or an
 * import; the comments inside it are indented, so they stay part of it and are compared too.
 */
function declarations(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/^export (?:type|interface) (\w+)/gm)) {
    const rest = source.slice(match.index);
    const end = rest.slice(1).search(/^(?:export |import |\/\*\*|\/\/)/m);
    found.set(match[1], (end === -1 ? rest : rest.slice(0, end + 1)).replace(/\s+/g, " ").trim());
  }
  return found;
}

describe("the copied retail types", () => {
  const copied = declarations(copy);
  const originals = declarations(original);

  it("finds every declaration in the gatekeeper's file", () => {
    for (const name of COPIED) {
      expect(originals.get(name), name).toMatch(new RegExp(`^export (type|interface) ${name}\\b`));
    }
  });

  it("match the gatekeeper's declarations", () => {
    for (const name of COPIED) {
      expect(copied.get(name), name).toBe(originals.get(name));
    }
  });

  it("reads a declaration whole, with the comments inside it", () => {
    expect(declarations("/** One. */\nexport type A =\n  | \"x\"\n  /** Inner. */\n  | \"y\";\n\n/** Two. */\nexport interface B {\n  a: A;\n}\n")).toEqual(new Map([
      ["A", 'export type A = | "x" /** Inner. */ | "y";'],
      ["B", "export interface B { a: A; }"],
    ]));
  });
});
