// The background import (research R9): an alarm loop inside the dataset Durable Object. Each step
// reads one byte range of a raw CSV object from R2, parses it, maps it, and in one transaction
// writes the rows, their pre-images, the rejections, the counts, the rollups and the cursor, so a
// step that fails or is evicted resumes exactly at the next unwritten record. Cancellation is a
// flag the next step honours. The same reader serves the preview, inside a transaction that is
// rolled back, and rebuild runs, which re-read every raw object a template imported.

import type { ImportPreview, MappingDocument, RunTableCounts, SniffResult } from "../app-api-types.js";
import { PUBLIC_TABLES } from "../dataset/schema.js";
import {
  type IngestBatch, type PreIngestRejection, type RunKind, addRunCounts, deleteUnrebuiltRows, recordRejections,
  writeBatch,
} from "../dataset/ingest.js";
import { importHmacKey, protectCustomer, type CustomerPii } from "../dataset/masking.js";
import { recomputeRollups } from "../dataset/rollups.js";
import { type CsvPosition, type CsvRecord, readCsvRange, r2CsvSource } from "./csv-stream.js";
import {
  type FilePlan, type GroupState, MappingInterpreter, type ModifierLookup, NEW_GROUP_STATE, type RowProblem,
} from "./interpret.js";
import { sniffCsv } from "./sniff.js";

/** A staged file as `staged_imports.files` stores it. */
export type StagedFile = {
  rawObjectId: number;
  name: string;
  bytes: number;
  key: string;
  role: string | null;
  sniff: SniffResult;
  headers: string[];
  sampleRows: (string | null)[][];
  dataOffset: number;
  dataRow: number;
};

/** One file as the loop reads it, with the parsing the mapping settled on. */
export type CursorFile = {
  rawObjectId: number;
  key: string;
  size: number;
  role: string;
  encoding: string;
  delimiter: SniffResult["delimiter"];
  headers: string[];
  footerRows: number;
  dataOffset: number;
  dataRow: number;
};

/** One import's files and the mapping they are read with. */
export type CursorSet = { mapping: MappingDocument; files: CursorFile[] };

/** A run's resumable position (`runs.cursor`). */
export type ImportCursor = {
  sourceLabel: string;
  /** One set per import the run reads (several for a rebuild). */
  sets: CursorSet[];
  setIndex: number;
  /** Index into the set's read order (`MappingInterpreter.readOrder`). */
  fileIndex: number;
  position: CsvPosition;
  state: GroupState;
  /** Bytes of the files finished so far. */
  bytesDone: number;
  bytesTotal: number;
  /** Consecutive failed attempts of the current step. */
  attempts: number;
  /** Rebuild runs: the runs of the template whose rows the rebuild replaces. */
  rebuild?: { templateVersionIds: number[] };
};

/** Data rows the preview reads per file. */
export const PREVIEW_ROW_LIMIT = 50_000;

/** Rows shown per table in a preview. */
export const PREVIEW_SAMPLE_ROWS = 50;

/** Attempts of one step before the run fails. */
export const MAX_STEP_ATTEMPTS = 3;

/** A modifiers lookup file may not be larger than this. */
const MAX_LOOKUP_BYTES = 32 * 1024 * 1024;

/** Lookups loaded for a run's current set, kept while the object stays in memory. */
export type LookupCache = Map<string, ModifierLookup>;

/**
 * The files of a set with the mapping's parsing overrides applied. A file whose parsing changed is
 * sniffed again so its header and first data row are found with the new settings.
 */
export async function resolveCursorFiles(
  bucket: R2Bucket, files: StagedFile[], mapping: MappingDocument,
): Promise<CursorFile[]> {
  const isSet = (mapping.files?.length ?? 0) > 0;
  const resolved: CursorFile[] = [];
  for (const file of files) {
    const role = isSet ? file.role : "file";
    if (role === null) continue;
    const parsing = mapping.parsing;
    let { sniff, headers, dataOffset, dataRow } = file;
    const overridden = parsing && (
      (parsing.encoding !== undefined && parsing.encoding !== sniff.encoding)
      || (parsing.delimiter !== undefined && parsing.delimiter !== sniff.delimiter)
      || (parsing.headerRow !== undefined && parsing.headerRow !== sniff.headerRow)
      || (parsing.footerRows !== undefined && parsing.footerRows !== sniff.footerRows));
    if (overridden) {
      const again = await sniffCsv(r2CsvSource(bucket, file.key, file.bytes), {
        encoding: parsing.encoding ?? sniff.encoding,
        delimiter: parsing.delimiter ?? sniff.delimiter,
        headerRow: parsing.headerRow ?? sniff.headerRow,
        footerRows: parsing.footerRows ?? sniff.footerRows,
      });
      ({ sniff, headers, dataOffset, dataRow } = again);
    }
    resolved.push({
      rawObjectId: file.rawObjectId, key: file.key, size: file.bytes, role, encoding: sniff.encoding,
      delimiter: sniff.delimiter, headers, footerRows: sniff.footerRows, dataOffset, dataRow,
    });
  }
  return resolved;
}

/** A new cursor at the start of the first file of the first set. */
export function newCursor(sourceLabel: string, sets: CursorSet[], rebuild?: ImportCursor["rebuild"]): ImportCursor {
  const cursor: ImportCursor = {
    sourceLabel, sets, setIndex: 0, fileIndex: 0, position: { offset: 0, row: 1 },
    state: NEW_GROUP_STATE, attempts: 0, bytesDone: 0,
    bytesTotal: sets.flatMap(set => set.files).reduce((sum, file) => sum + file.size, 0),
    ...(rebuild ? { rebuild } : {}),
  };
  const first = currentFile(cursor);
  if (first) cursor.position = { offset: first.dataOffset, row: first.dataRow };
  return cursor;
}

/** The file the cursor is in (moving past finished sets), or null when every set is done. */
function currentFile(cursor: ImportCursor): CursorFile | null {
  while (cursor.setIndex < cursor.sets.length) {
    const set = cursor.sets[cursor.setIndex]!;
    const order = new MappingInterpreter(set.mapping, { sourceLabel: cursor.sourceLabel })
      .readOrder(set.files.map(file => file.role));
    const role = order[cursor.fileIndex];
    if (role !== undefined) return set.files.find(file => file.role === role)!;
    cursor.setIndex++;
    cursor.fileIndex = 0;
  }
  return null;
}

/**
 * Reads the next chunk of a file: one range, minus the footer rows at the end of the file, minus
 * held-back rows (footer candidates, and the last order's rows, which may continue in the next
 * range). Returns the records to interpret and where reading continues.
 */
async function nextChunk(
  bucket: R2Bucket, file: CursorFile, position: CsvPosition, interpreter: MappingInterpreter, plan: FilePlan,
): Promise<{ records: CsvRecord[]; next: CsvPosition; eof: boolean }> {
  const range = await readCsvRange(r2CsvSource(bucket, file.key, file.size), position, {
    encoding: file.encoding, delimiter: file.delimiter,
  });
  let records = range.records;
  if (range.eof) {
    return { records: records.slice(0, Math.max(0, records.length - file.footerRows)), next: range.next, eof: true };
  }
  let keep = records.length - file.footerRows;
  // Keep an order's rows together, unless the order fills the whole range. A blank key continues
  // the order above it (continuation rows).
  const keyAt = (index: number) => interpreter.groupKeyOf(plan, records[index]!.cells);
  if (keep > 0 && keyAt(keep - 1) !== null) {
    let start = keep - 1;
    while (start > 0 && keyAt(start) === "") start--;
    const lastKey = keyAt(start);
    while (start > 0 && keyAt(start - 1) === lastKey) start--;
    if (start > 0) keep = start;
  }
  if (keep <= 0) {
    // Only footer candidates fit: read them with the next range.
    keep = Math.max(1, records.length - file.footerRows);
  }
  const next = keep < records.length
    ? { offset: records[keep - 1]!.end, row: records[keep]!.row }
    : range.next;
  records = records.slice(0, keep);
  return { records, next, eof: false };
}

/** Loads a modifiers file fully into a lookup. */
async function loadLookup(
  bucket: R2Bucket, file: CursorFile, interpreter: MappingInterpreter,
): Promise<ModifierLookup> {
  if (file.size > MAX_LOOKUP_BYTES) throw new Error(`The ${file.role} file is larger than 32 MB.`);
  const plan = interpreter.plan({ role: file.role, headers: file.headers, rawObjectId: file.rawObjectId });
  const lookup: ModifierLookup = new Map();
  let position: CsvPosition = { offset: file.dataOffset, row: file.dataRow };
  for (;;) {
    const range = await readCsvRange(r2CsvSource(bucket, file.key, file.size), position, {
      encoding: file.encoding, delimiter: file.delimiter,
    });
    const records = range.eof ? range.records.slice(0, Math.max(0, range.records.length - file.footerRows)) : range.records;
    interpreter.addModifiers(plan, records, lookup);
    if (range.eof) return lookup;
    position = range.next;
  }
}

/** The lookup an items file needs, loaded once per run and set. */
async function lookupFor(
  bucket: R2Bucket, cache: LookupCache, cacheKey: string, set: CursorFile[], plan: FilePlan,
  interpreter: MappingInterpreter,
): Promise<ModifierLookup | null> {
  const role = interpreter.lookupRoleFor(plan);
  if (!role) return null;
  const file = set.find(entry => entry.role === role);
  if (!file) return null;
  const key = `${cacheKey}:${role}`;
  let lookup = cache.get(key);
  if (!lookup) {
    lookup = await loadLookup(bucket, file, interpreter);
    cache.set(key, lookup);
  }
  return lookup;
}

type RunRow = {
  id: number; source_id: number; kind: RunKind; status: string; mapping_version: string;
  cursor: string | null; cancel_requested: number; started_at: number;
};

/** What one step of the loop did. */
export type StepOutcome = "continue" | "finished" | "idle";

/**
 * Runs one step of the oldest running import or rebuild. Returns "idle" when no run is waiting,
 * "continue" when more steps are needed, "finished" when the run ended.
 */
export async function runImportStep(
  storage: DurableObjectStorage, bucket: R2Bucket, cache: LookupCache,
): Promise<StepOutcome> {
  const sql = storage.sql;
  const run = sql.exec<RunRow>(
    "SELECT id, source_id, kind, status, mapping_version, cursor, cancel_requested, started_at FROM runs " +
    "WHERE status = 'running' AND cursor IS NOT NULL ORDER BY id LIMIT 1").toArray()[0];
  if (!run) return "idle";
  const cursor = JSON.parse(run.cursor!) as ImportCursor;
  if (run.cancel_requested) {
    endRun(storage, run, "cancelled", null);
    cache.clear();
    return "finished";
  }
  try {
    const file = currentFile(cursor);
    if (!file) {
      completeRun(storage, run, cursor);
      cache.clear();
      return "finished";
    }
    const set = cursor.sets[cursor.setIndex]!;
    const interpreter = new MappingInterpreter(set.mapping, { sourceLabel: cursor.sourceLabel });
    const plan = interpreter.plan({ role: file.role, headers: file.headers, rawObjectId: file.rawObjectId });
    const lookup = await lookupFor(bucket, cache, `${run.id}:${cursor.setIndex}`, set.files, plan, interpreter);
    const chunk = await nextChunk(bucket, file, cursor.position, interpreter, plan);
    const result = await interpreter.interpret(plan, chunk.records, cursor.state, lookup);
    const next: ImportCursor = { ...cursor, attempts: 0 };
    if (chunk.eof) {
      next.bytesDone += file.size;
      next.fileIndex++;
      next.state = NEW_GROUP_STATE;
      const following = currentFile(next);
      next.position = following ? { offset: following.dataOffset, row: following.dataRow } : chunk.next;
    } else {
      next.position = chunk.next;
      next.state = result.state;
    }
    const doneBytes = next.bytesDone + (chunk.eof ? 0 : next.position.offset);
    const elapsed = Math.max(1, Math.floor(Date.now() / 1000) - run.started_at);
    const eta = doneBytes > 0 ? Math.round(elapsed * (next.bytesTotal - doneBytes) / doneBytes) : null;
    await ingestStep(storage, run, result.batch, result.problems, {
      cursor: next,
      progress: { phase: run.kind === "rebuild" ? "rebuilding" : "importing", done: doneBytes, total: next.bytesTotal, etaSeconds: eta },
      warnings: result.warnings,
    });
    return "continue";
  } catch (error) {
    const attempts = cursor.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempts >= MAX_STEP_ATTEMPTS || isPermanent(message)) {
      endRun(storage, run, "failed", message);
      cache.clear();
      return "finished";
    }
    sql.exec("UPDATE runs SET cursor = ? WHERE id = ?", JSON.stringify({ ...cursor, attempts }), run.id);
    return "continue";
  }
}

/** Parse and mapping errors do not go away on retry. */
function isPermanent(message: string): boolean {
  return /not valid CSV|longer than|no longer stored|larger than/.test(message);
}

/** Writes one step: rows, rejections, counts, warnings, rollups and the cursor, atomically. */
async function ingestStep(
  storage: DurableObjectStorage,
  run: RunRow,
  batch: IngestBatch,
  problems: RowProblem[],
  update: {
    cursor: ImportCursor;
    progress: { phase: string; done: number; total: number; etaSeconds: number | null };
    warnings: { fingerprintRows: number; quantityRounded: number };
  },
): Promise<void> {
  const sql = storage.sql;
  const customerPii = await prepareCustomers(sql, batch);
  storage.transactionSync(() => {
    const written = writeBatch(sql, {
      sourceId: run.source_id, runId: run.id, runKind: run.kind, mappingVersion: run.mapping_version,
      now: Math.floor(Date.now() / 1000), customerPii,
      ...(run.kind === "rebuild" ? { rebuildGen: run.id } : {}),
    }, batch);
    const refused = recordRejections(sql, run.id, problems.map(toRejection));
    recomputeRollups(sql);
    addRunCounts(sql, run.id, written.counts);
    addRunCounts(sql, run.id, refused);
    addWarnings(sql, run.id, { ...update.warnings, totalMismatch: written.warnings.totalMismatch });
    sql.exec("UPDATE runs SET cursor = ?, progress = ? WHERE id = ?",
      JSON.stringify(update.cursor), JSON.stringify(update.progress), run.id);
  });
}

/** Ends a run whose files are all read: a rebuild first deletes the rows it did not reproduce. */
function completeRun(storage: DurableObjectStorage, run: RunRow, cursor: ImportCursor): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    if (run.kind === "rebuild" && cursor.rebuild) {
      const versions = cursor.rebuild.templateVersionIds;
      const runIds = versions.length === 0 ? [] : sql.exec<{ id: number }>(
        `SELECT id FROM runs WHERE source_id = ? AND id != ? AND template_version_id IN (${versions.map(() => "?").join(", ")})`,
        run.source_id, run.id, ...versions).toArray().map(row => row.id);
      const deleted = deleteUnrebuiltRows(sql, run.source_id, runIds, run.id);
      recomputeRollups(sql);
      const counts = JSON.parse(sql.exec<{ counts: string }>("SELECT counts FROM runs WHERE id = ?", run.id).one().counts) as
        Record<string, RunTableCounts>;
      for (const [table, n] of Object.entries(deleted)) {
        const entry = counts[table] ??= { fetched: 0, written: 0, updated: 0, skipped: 0, rejected: 0 };
        entry.deleted = (entry.deleted ?? 0) + n!;
      }
      sql.exec("UPDATE runs SET counts = ? WHERE id = ?", JSON.stringify(counts), run.id);
    }
    endRun(storage, run, "succeeded", null);
  });
}

/** Closes a run and its staged import. */
function endRun(
  storage: DurableObjectStorage, run: RunRow, status: "succeeded" | "failed" | "cancelled", error: string | null,
): void {
  const sql = storage.sql;
  const now = Math.floor(Date.now() / 1000);
  storage.transactionSync(() => {
    const progress = sql.exec<{ progress: string | null }>("SELECT progress FROM runs WHERE id = ?", run.id).one().progress;
    const final = progress ? { ...JSON.parse(progress), phase: status, etaSeconds: 0 } : null;
    sql.exec(
      "UPDATE runs SET status = ?, finished_at = ?, cursor = NULL, error = ?, progress = ? WHERE id = ?",
      status, now, error, final ? JSON.stringify(final) : null, run.id);
    if (status === "succeeded") sql.exec("UPDATE store_sources SET last_success_at = ? WHERE id = ?", now, run.source_id);
    const staged = status === "succeeded" ? "imported" : status;
    sql.exec("UPDATE staged_imports SET status = ? WHERE run_id = ? AND status = 'importing'", staged, run.id);
  });
}

function addWarnings(
  sql: SqlStorage, runId: number, add: { fingerprintRows: number; quantityRounded: number; totalMismatch: number },
): void {
  const current = JSON.parse(sql.exec<{ warnings: string }>("SELECT warnings FROM runs WHERE id = ?", runId).one().warnings) as
    Partial<typeof add>;
  sql.exec("UPDATE runs SET warnings = ? WHERE id = ?", JSON.stringify({
    fingerprintRows: (current.fingerprintRows ?? 0) + add.fingerprintRows,
    quantityRounded: (current.quantityRounded ?? 0) + add.quantityRounded,
    totalMismatch: (current.totalMismatch ?? 0) + add.totalMismatch,
  }), runId);
}

function toRejection(problem: RowProblem): PreIngestRejection {
  return {
    table: problem.table, rawObjectId: problem.rawObjectId, row: problem.row, reason: problem.reason,
    column: problem.column, detail: problem.detail,
  };
}

/** Masks and keyed hashes of the batch's customers (asynchronous, so before the transaction). */
async function prepareCustomers(sql: SqlStorage, batch: IngestBatch): Promise<Map<string, CustomerPii>> {
  const pii = new Map<string, CustomerPii>();
  if (!batch.customers?.length) return pii;
  const key = await importHmacKey(sql.exec<{ k: string }>("SELECT email_hmac_key AS k FROM settings WHERE id = 1").one().k);
  for (const customer of batch.customers) pii.set(customer.sourceRecordId, await protectCustomer(key, customer));
  return pii;
}

// ---------------------------------------------------------------------------------------------
// Preview

/** Rolls the preview transaction back. */
class PreviewRollback extends Error {}

/**
 * Previews a mapping over the staged files: up to `PREVIEW_ROW_LIMIT` data rows per file are
 * mapped and written into a temporary source inside a transaction that is rolled back, so the
 * counts, rejections, samples and daily totals are exactly what the import would produce for
 * these files. Nothing is kept.
 */
export async function previewImport(
  storage: DurableObjectStorage, bucket: R2Bucket, files: CursorFile[], mapping: MappingDocument, sourceLabel: string,
): Promise<ImportPreview> {
  const interpreter = new MappingInterpreter(mapping, { sourceLabel });
  const batches: { batch: IngestBatch; problems: RowProblem[] }[] = [];
  const warnings = { fingerprintRows: 0, quantityRounded: 0, totalMismatch: 0 };
  let rowsRead = 0;
  let truncated = false;
  const cache: LookupCache = new Map();
  for (const role of interpreter.readOrder(files.map(file => file.role))) {
    const file = files.find(entry => entry.role === role)!;
    const plan = interpreter.plan({ role: file.role, headers: file.headers, rawObjectId: file.rawObjectId });
    const lookup = await lookupFor(bucket, cache, "preview", files, plan, interpreter);
    let position: CsvPosition = { offset: file.dataOffset, row: file.dataRow };
    let state = NEW_GROUP_STATE;
    let fileRows = 0;
    for (;;) {
      const chunk = await nextChunk(bucket, file, position, interpreter, plan);
      let records = chunk.records;
      if (fileRows + records.length > PREVIEW_ROW_LIMIT) {
        records = records.slice(0, PREVIEW_ROW_LIMIT - fileRows);
        truncated = true;
      }
      const result = await interpreter.interpret(plan, records, state, lookup);
      batches.push({ batch: result.batch, problems: result.problems });
      warnings.fingerprintRows += result.warnings.fingerprintRows;
      warnings.quantityRounded += result.warnings.quantityRounded;
      fileRows += records.length;
      state = result.state;
      position = chunk.next;
      if (chunk.eof || truncated) break;
    }
    rowsRead += fileRows;
  }
  const sql = storage.sql;
  const customerPii = new Map<string, CustomerPii>();
  for (const { batch } of batches) {
    for (const [id, pii] of await prepareCustomers(sql, batch)) customerPii.set(id, pii);
  }
  let preview: MeasuredPreview | undefined;
  try {
    storage.transactionSync(() => {
      const now = Math.floor(Date.now() / 1000);
      const sourceId = sql.exec<{ id: number }>(
        "INSERT INTO store_sources (kind, label, status, created_at) VALUES ('csv', ?, 'imported', ?) RETURNING id",
        sourceLabel, now).one().id;
      const runId = sql.exec<{ id: number }>(
        "INSERT INTO runs (source_id, kind, status, mapping_version, started_at) VALUES (?, 'import', 'running', 'preview', ?) RETURNING id",
        sourceId, now).one().id;
      for (const { batch, problems } of batches) {
        // Not an import, so no pre-images are kept for rows that are rolled back anyway.
        const written = writeBatch(sql, {
          sourceId, runId, runKind: "rebuild", mappingVersion: "preview", now, customerPii,
        }, batch);
        warnings.totalMismatch += written.warnings.totalMismatch;
        addRunCounts(sql, runId, written.counts);
        addRunCounts(sql, runId, recordRejections(sql, runId, problems.map(toRejection)));
      }
      preview = measurePreview(sql, runId, sourceId);
      throw new PreviewRollback();
    });
  } catch (error) {
    if (!(error instanceof PreviewRollback)) throw error;
  }
  return { ...preview!, rowsRead, truncated, rowLimit: PREVIEW_ROW_LIMIT, warnings };
}

/** What a preview run measures before its rollback; the reader adds the row totals. */
type MeasuredPreview = Omit<ImportPreview, "rowsRead" | "truncated" | "rowLimit" | "warnings">;

/** Counts, samples, problems and daily totals of a preview run, read before the rollback. */
function measurePreview(sql: SqlStorage, runId: number, sourceId: number): MeasuredPreview {
  const counts = JSON.parse(sql.exec<{ counts: string }>("SELECT counts FROM runs WHERE id = ?", runId).one().counts) as
    ImportPreview["counts"];
  const samples: ImportPreview["samples"] = [];
  for (const table of PUBLIC_TABLES) {
    if (!(table.name in counts)) continue;
    const cursor = sql.exec(`SELECT * FROM ${table.name} WHERE source_id = ? ORDER BY id LIMIT ?`, sourceId, PREVIEW_SAMPLE_ROWS);
    const rows = Array.from(cursor.raw()) as (string | number | null)[][];
    if (rows.length > 0) samples.push({ table: table.name, columns: cursor.columnNames, rows });
  }
  const rejections = sql.exec<{
    table_name: string; reason_code: string; raw_object_id: number | null; row_index: number | null;
    column_name: string | null; detail: string | null; file_name: string | null;
  }>(`SELECT r.table_name, r.reason_code, r.raw_object_id, r.row_index, r.column_name, r.detail, o.file_name
      FROM run_rejections r LEFT JOIN raw_objects o ON o.id = r.raw_object_id
      WHERE r.run_id = ? ORDER BY r.rowid`, runId).toArray();
  const problems = new Map<string, ImportPreview["problems"][number]>();
  for (const rejection of rejections) {
    const entry = problems.get(rejection.reason_code) ?? { reason: rejection.reason_code, count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 5) {
      entry.examples.push({
        table: rejection.table_name, file: rejection.file_name, row: rejection.row_index,
        column: rejection.column_name, detail: rejection.detail,
      });
    }
    problems.set(rejection.reason_code, entry);
  }
  const days = new Map<string, ImportPreview["dailyTotals"][number]>();
  const day = (businessDate: string, currency: string) => {
    const key = `${businessDate}\0${currency}`;
    let entry = days.get(key);
    if (!entry) {
      entry = { businessDate, currency, orders: 0, gross: 0, discounts: 0, refunds: 0, net: 0, tax: 0, tips: 0 };
      days.set(key, entry);
    }
    return entry;
  };
  for (const row of sql.exec<{ d: string; c: string; n: number; g: number; disc: number; t: number; tip: number }>(`
    SELECT business_date AS d, currency AS c, COUNT(*) AS n, SUM(gross_amount) AS g, SUM(discount_amount) AS disc,
      SUM(tax_amount) AS t, SUM(tip_amount) AS tip
    FROM store_orders WHERE source_id = ? AND status != 'voided' AND deleted_at IS NULL GROUP BY 1, 2`, sourceId)) {
    Object.assign(day(row.d, row.c), { orders: row.n, gross: row.g, discounts: row.disc, tax: row.t, tips: row.tip });
  }
  for (const row of sql.exec<{ d: string; c: string; r: number }>(`
    SELECT business_date AS d, currency AS c, SUM(COALESCE(sales_amount, amount)) AS r
    FROM store_transactions WHERE source_id = ? AND kind = 'refund' AND status = 'succeeded' AND deleted_at IS NULL
    GROUP BY 1, 2`, sourceId)) {
    day(row.d, row.c).refunds = row.r;
  }
  const dailyTotals = [...days.values()]
    .map(entry => ({ ...entry, net: entry.gross - entry.discounts - entry.refunds }))
    .toSorted((a, b) => a.businessDate.localeCompare(b.businessDate) || a.currency.localeCompare(b.currency));
  return { counts, samples, problems: [...problems.values()], dailyTotals };
}
