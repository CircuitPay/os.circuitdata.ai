import { describe, expect, it } from "vitest";
import { parseBundledBlueprintManifest } from "../src/manifest.ts";

function manifest(extra: Record<string, unknown>): string {
  return JSON.stringify({
    blueprintId: "format.example",
    title: "Example",
    description: "An example format.",
    output: {id: "example", noun: "Example", plural: "Examples", icon: "chartBar"},
    author: {type: "user", name: "Test", id: "test@example.com"},
    revision: 1,
    created: "2026-01-01T00:00:00.000Z",
    version: 1,
    lastUpdated: "2026-01-01T00:00:00.000Z",
    bindings: {},
    ...extra,
  });
}

describe("a bundled blueprint's agentHint", () => {
  it("is optional, and absent from a manifest that gives none", () => {
    expect(parseBundledBlueprintManifest("example", manifest({}))).not.toHaveProperty("agentHint");
  });

  it("is carried as written", () => {
    let parsed = parseBundledBlueprintManifest("example",
        manifest({agentHint: "Use for figures that should stay current."}));
    expect(parsed.agentHint).toBe("Use for figures that should stay current.");
  });

  it.each([
    ["an empty hint", ""],
    ["a blank hint", "   "],
    ["a hint over 400 characters", "x".repeat(401)],
    ["a hint that is not text", 7],
  ])("refuses %s", (_what, agentHint) => {
    expect(() => parseBundledBlueprintManifest("example", manifest({agentHint})))
        .toThrow("agentHint must be a non-empty string of at most 400 characters");
  });
});
