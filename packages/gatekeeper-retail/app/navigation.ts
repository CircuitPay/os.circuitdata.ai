import type { BrowseTable } from "../src/app-api-types";

/** A table to open in Browse, optionally narrowed to the rows of one import run or one source. */
export type BrowseTarget = { table: BrowseTable; runId?: number; sourceId?: number };
