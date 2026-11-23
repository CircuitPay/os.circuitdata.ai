// sqlparser-rs (Apache-2.0), compiled to WebAssembly, loaded from a precompiled module import.
// The package's own `init()` fetches or reads the .wasm from disk, neither of which workerd allows,
// so this instantiates the wasm-bindgen glue directly (the subpaths are exported by the pnpm patch
// in patches/). Research R4 records the workerd check.

import { initSync, parse_sql_to_json_string } from "@guanmingchiu/sqlparser-ts/wasm/sqlparser_rs_wasm.js";
import wasmModule from "@guanmingchiu/sqlparser-ts/wasm/sqlparser_rs_wasm_bg.wasm";

let initialized = false;

/** A parse failure: the text is not SQL the parser accepts. */
export class SqlSyntaxError extends Error {
  override name = "SqlSyntaxError";
}

/**
 * Parses SQLite-dialect SQL into sqlparser-rs's serde AST, one entry per statement. JSON rather
 * than the direct JS value, so the walker sees plain objects and arrays only.
 */
export function parseSqlite(sql: string): unknown[] {
  if (!initialized) {
    initSync({ module: wasmModule });
    initialized = true;
  }
  let json: string;
  try {
    json = parse_sql_to_json_string("sqlite", sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SqlSyntaxError(`The query could not be parsed: ${message}`);
  }
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new SqlSyntaxError("The query could not be parsed.");
  return parsed;
}
