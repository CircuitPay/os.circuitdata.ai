// RetailDataset: one SQLite Durable Object per tenant dataset (research R3). It owns the canonical
// storage tables, the public views, the rollups and every operational table, and is the single
// writer for all of them. It is reached only from inside this worker (ctx.exports), by name
// `<sharingDomain>\0dataset\0<datasetId>`, and every method names the dataset it expects so a
// misaddressed call is refused rather than served from another dataset.

import { DurableObject } from "cloudflare:workers";
import type {
  RetailDatasetDescription, RetailMetricQuery, RetailMetricResult, RetailTable,
} from "../types.js";
import type {
  BrowseCatalog, BrowsePage, BrowseQuery, BrowseTable, CoverageReport, DatasetOverview, ImportListEntry, ImportPreview,
  ImportTarget, LineageTable, MappingDocument, Page, RowDetail, RowLineage, RunRejection, RunSummary, SourceSummary,
  StagedImport, StorageStatus, TemplateDetail, TemplateSummary,
  MatchKind, MatchProposal,
} from "../app-api-types.js";
import type { RetailPendingImport } from "../types.js";
import {
  type DataAreaContext, type IncomingFile, type Member, askAgentPrompt, cancelRun, checkAgentMapping, copyTemplate,
  deleteTemplate, discardImport, getImport, getRun, getTemplate, listImports, listRejections, listRuns, listTemplates,
  pendingImportsForAgent, previewStaged, reapplyTemplate, saveTemplateVersion, setAgentMapping, stageImport, startImport,
  undoImport,
} from "../import/data-area.js";
import { type LookupCache, runImportStep } from "../import/import-loop.js";
import { datasetDates, readBrowseCatalog, readBrowsePage, readRowDetail, rowEstimate } from "./browse.js";
import { type CoverageOptions, readCoverage, readLineage } from "./coverage.js";
import { retailLogger } from "../observability.js";
import { writeBatch, type IngestBatch, type IngestResult, type RunKind, type TableCounts } from "./ingest.js";
import { importHmacKey, newHmacKey, protectCustomer, recreateCustomersView, type CustomerPii } from "./masking.js";
import { confirmMatch, listMatches, proposeMatches, rejectMatch, undoMatch } from "./matching.js";
import { METRIC_DEFINITIONS, runMetric } from "./metrics.js";
import {
  DEFAULT_RAW_QUOTA_BYTES, ERASE_BATCH_SIZE, R2RawStore, datasetPrefix, rawObjectKey,
} from "./raw-store.js";
import { recomputeRollups } from "./rollups.js";
import { deleteSourceRowsBatch, forgetSourceRows } from "./source-data.js";
import type { KnownTable } from "../connectors/provider.js";
import { PUBLIC_TABLES, SCHEMA_MIGRATIONS, SCHEMA_VERSION, VIEW_STORAGE } from "./schema.js";
import {
  DEFAULT_SCAN_ROW_LIMIT, QUERY_LIMITS, QueryRefusedError, queryCaps, runGuardedQuery, type GuardedResult,
} from "./sql-guard.js";

const logger = retailLogger("dataset");

/** The SQLite object's size cap, and the share at which an administrator is warned. */
export const DATASET_CAP_BYTES = 10_000_000_000;
export const SIZE_WARNING_RATIO = 0.7;

/** Retry delay of an erase step that failed. */
const ERASE_RETRY_MS = 60_000;

/** Retry delay of an import step that failed outside the loop's own error handling. */
const IMPORT_RETRY_MS = 30_000;

// Tables without a rowid, counted rather than estimated from MAX(rowid).
const COUNTED_TABLES: ReadonlySet<RetailTable> = new Set([
  "sources", "daily_sales", "daily_product_sales", "customer_summary", "daily_source_coverage",
]);

/** The DO name of a dataset. A tenant id never appears in it. */
export function datasetObjectName(sharingDomain: string, datasetId: string): string {
  return `${sharingDomain}\0dataset\0${datasetId}`;
}

type Settings = {
  dataset_id: string;
  status: "active" | "erasing";
  pii_unmasked: number;
  backfill_years: number;
  size_warned_at: number | null;
  email_hmac_key: string;
};

/** The dataset Durable Object. */
export class RetailDataset extends DurableObject<Cloudflare.Env> {
  #hmacKey: Promise<CryptoKey> | undefined;
  /** Modifier lookups of the running import, while this object stays in memory. */
  readonly #lookups: LookupCache = new Map();

  /** Tables, columns, metric definitions, date coverage and limits (the binding's `describe()`). */
  describe(datasetId: string): RetailDatasetDescription {
    const settings = this.#open(datasetId);
    const sql = this.ctx.storage.sql;
    const tables = PUBLIC_TABLES.map(table => {
      const rows = COUNTED_TABLES.has(table.name)
        ? sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${VIEW_STORAGE[table.name]}`).one().n
        : rowEstimate(sql, table.name);
      return { ...table, rows };
    });
    return {
      tables,
      metrics: [...METRIC_DEFINITIONS],
      personalDataMasked: settings.pii_unmasked === 0,
      ...datasetDates(sql),
      limits: { maxRows: QUERY_LIMITS.maxRows, maxBytes: QUERY_LIMITS.maxBytes, maxParams: QUERY_LIMITS.maxParams },
    };
  }

  /** Runs one caller query through the SQL guard. Refusals throw with an explanation. */
  query(
    datasetId: string,
    sqlText: string,
    params?: (string | number | boolean | null)[],
    options?: { maxRows?: number; maxBytes?: number },
  ): GuardedResult {
    this.#open(datasetId);
    const started = Date.now();
    try {
      const result = runGuardedQuery(this.ctx.storage, sqlText, params, queryCaps(options), this.#scanRowLimit());
      logger.info("query completed", {
        event: "query.completed", datasetId, views: result.views.join(","), rowCount: result.rows.length,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      if (error instanceof QueryRefusedError) {
        logger.info("query refused", {
          event: "query.refused", datasetId, refusalReason: error.reason, durationMs: Date.now() - started,
        });
      }
      throw error;
    }
  }

  /** Computes one standard metric (contracts/metrics.md). */
  metric(datasetId: string, name: string, query: RetailMetricQuery): RetailMetricResult {
    this.#open(datasetId);
    const started = Date.now();
    const result = runMetric(this.ctx.storage.sql, name, query);
    logger.info("metric computed", {
      event: "metric.completed", datasetId, metric: name, rowCount: result.rows.length,
      durationMs: Date.now() - started,
    });
    return result;
  }

  /** Creates a source: a provider connection or a named CSV source. */
  createSource(datasetId: string, source: {
    kind: SourceSummary["kind"];
    label: string;
    createdBy: string;
    defaultTimezone?: string;
    defaultCurrency?: string;
  }): number {
    this.#open(datasetId);
    const status = source.kind === "csv" || source.kind === "toast" ? "imported" : "connecting";
    return this.ctx.storage.sql.exec<{ id: number }>(
      "INSERT INTO store_sources (kind, label, status, created_by, created_at, default_timezone, default_currency) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      source.kind, source.label, status, source.createdBy, nowSeconds(),
      source.defaultTimezone ?? null, source.defaultCurrency ?? null).one().id;
  }

  /** Opens a run that batches are ingested under. */
  startRun(datasetId: string, run: {
    sourceId: number;
    kind: RunKind;
    mappingVersion: string;
    startedBy: string | null;
    templateVersionId?: number;
  }): number {
    this.#open(datasetId);
    return this.ctx.storage.sql.exec<{ id: number }>(
      "INSERT INTO runs (source_id, kind, status, template_version_id, mapping_version, started_by, started_at) " +
      "VALUES (?, ?, 'running', ?, ?, ?, ?) RETURNING id",
      run.sourceId, run.kind, run.templateVersionId ?? null, run.mappingVersion, run.startedBy,
      nowSeconds()).one().id;
  }

  /**
   * Ingests one batch of canonical records under a running run: one transaction writes the rows,
   * their pre-images (imports), the run's counts, and recomputes every rollup day the batch touched.
   */
  async ingestBatch(datasetId: string, runId: number, batch: IngestBatch): Promise<IngestResult> {
    const settings = this.#open(datasetId);
    const run = this.ctx.storage.sql.exec<{ source_id: number; kind: RunKind; mapping_version: string; status: string }>(
      "SELECT source_id, kind, mapping_version, status FROM runs WHERE id = ?", runId).toArray()[0];
    if (!run) throw new Error(`Run ${runId} does not exist.`);
    if (run.status !== "running") throw new Error(`Run ${runId} is ${run.status}, not running.`);
    const customerPii = new Map<string, CustomerPii>();
    if (batch.customers?.length) {
      this.#hmacKey ??= importHmacKey(settings.email_hmac_key);
      const key = await this.#hmacKey;
      for (const customer of batch.customers) {
        customerPii.set(customer.sourceRecordId, await protectCustomer(key, customer));
      }
    }
    const started = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const written = writeBatch(this.ctx.storage.sql, {
        sourceId: run.source_id, runId, runKind: run.kind, mappingVersion: run.mapping_version,
        now: nowSeconds(), customerPii,
      }, batch);
      recomputeRollups(this.ctx.storage.sql);
      this.#addRunCounts(runId, written.counts);
      return written;
    });
    const totals = Object.values(result.counts).reduce(
      (sum, counts) => ({
        written: sum.written + counts.written, updated: sum.updated + counts.updated,
        skipped: sum.skipped + counts.skipped, rejected: sum.rejected + counts.rejected,
      }),
      { written: 0, updated: 0, skipped: 0, rejected: 0 });
    logger.debug("batch ingested", {
      event: "ingest.batch", datasetId, runId, sourceId: run.source_id, ...totals,
      dirtyDays: result.dirtyDays, durationMs: Date.now() - started,
    });
    this.#checkSize(settings);
    return result;
  }

  /** Closes a run. A succeeded run marks its source's last success. */
  finishRun(datasetId: string, runId: number, status: "succeeded" | "failed" | "cancelled"): void {
    this.#open(datasetId);
    const now = nowSeconds();
    this.ctx.storage.transactionSync(() => {
      const run = this.ctx.storage.sql.exec<{ source_id: number }>(
        "UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running' RETURNING source_id",
        status, now, runId).toArray()[0];
      if (!run) throw new Error(`Run ${runId} is not running.`);
      if (status === "succeeded") {
        this.ctx.storage.sql.exec("UPDATE store_sources SET last_success_at = ? WHERE id = ?", now, run.source_id);
      }
    });
  }

  /**
   * Stores one raw object (a CSV file, a provider page) for a run, counting its bytes against the
   * dataset's raw quota before any byte is written. Returns the raw object id.
   */
  async putRawObject(
    datasetId: string,
    object: { sourceId: number; runId: number; kind: "csv_file" | "provider_page"; fileRole?: string; fileName?: string },
    body: ReadableStream<Uint8Array>,
    size: number,
  ): Promise<number> {
    const settings = this.#open(datasetId);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("size must be a byte count.");
    const sql = this.ctx.storage.sql;
    // Reserve the bytes and the key synchronously, so concurrent uploads cannot both fit the quota.
    const reserved = this.ctx.storage.transactionSync(() => {
      const used = sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM raw_objects").one().n;
      if (used + size > this.#rawQuotaBytes()) {
        throw new Error("The dataset's raw storage quota is full; remove old imports or ask the operator to raise it.");
      }
      const seq = sql.exec<{ n: number }>(
        "SELECT COUNT(*) + 1 AS n FROM raw_objects WHERE run_id = ?", object.runId).one().n;
      const key = rawObjectKey(settings.dataset_id, object.sourceId, object.runId, seq);
      const id = sql.exec<{ id: number }>(
        "INSERT INTO raw_objects (run_id, r2_key, kind, file_role, file_name, bytes, sha256) VALUES (?, ?, ?, ?, ?, ?, '') RETURNING id",
        object.runId, key, object.kind, object.fileRole ?? null, object.fileName ?? null, size).one().id;
      return { id, key };
    });
    try {
      const stored = await new R2RawStore(this.env.RETAIL_RAW).put(reserved.key, body, size);
      sql.exec("UPDATE raw_objects SET sha256 = ? WHERE id = ?", stored.sha256, reserved.id);
      return reserved.id;
    } catch (error) {
      sql.exec("DELETE FROM raw_objects WHERE id = ?", reserved.id);
      throw error;
    }
  }

  /** Storage use (FR-020). */
  storageStatus(datasetId: string): StorageStatus {
    this.#open(datasetId);
    return this.#storageStatus();
  }

  /** The Data area overview: sources, storage, settings and failures needing an administrator. */
  overview(datasetId: string): DatasetOverview {
    const settings = this.#open(datasetId);
    const sql = this.ctx.storage.sql;
    const sources = sql.exec<{
      id: number; kind: SourceSummary["kind"]; label: string; status: SourceSummary["status"];
      last_success_at: number | null; coverage_from: string | null; coverage_to: string | null;
      last_error_code: string | null; last_error_message: string | null;
    }>("SELECT * FROM store_sources ORDER BY id").toArray();
    return {
      sources: sources.map(source => ({
        id: source.id,
        kind: source.kind,
        label: source.label,
        status: source.status,
        lastSuccessAt: source.last_success_at === null ? null : isoSeconds(source.last_success_at),
        coverageFrom: source.coverage_from,
        coverageTo: source.coverage_to,
      })),
      storage: this.#storageStatus(),
      settings: { piiUnmasked: settings.pii_unmasked === 1, backfillYears: settings.backfill_years },
      failuresNeedingAdmin: sources
        .filter(source => source.status === "needs_reconnect" && source.last_error_code !== null)
        .map(source => ({
          sourceId: source.id, label: source.label, code: source.last_error_code!,
          message: source.last_error_message,
        })),
    };
  }

  /** Staged CSV imports still waiting for a mapping (the agent catalog lists the count). */
  pendingImportCount(datasetId: string): number {
    this.#open(datasetId);
    return this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM staged_imports WHERE status IN ('staged', 'mapping') AND expires_at > ?",
      nowSeconds()).one().n;
  }

  // --- Connections (provider sources; research R15, R19) ---

  /**
   * Records the handoff ticket a connection's OAuth callback minted (by hash), so a redemption over
   * this dataset's Data area can find its connection. A ticket minted for another dataset is never
   * recorded here, which is what refuses a phished handoff.
   */
  registerConnectTicket(datasetId: string, ticketHash: string, connectionId: string, expiresAt: number): void {
    this.#open(datasetId);
    const kv = this.ctx.storage.kv;
    // Drop expired tickets first; there are at most a handful in flight.
    for (const [key, value] of kv.list<{ expiresAt: number }>({ prefix: "ticket:" })) {
      if (value.expiresAt <= Date.now()) kv.delete(key);
    }
    kv.put(`ticket:${ticketHash}`, { connectionId, expiresAt });
  }

  /** Takes a recorded ticket (single use): its connection id, or null when unknown or expired. */
  takeConnectTicket(datasetId: string, ticketHash: string): string | null {
    this.#open(datasetId);
    const kv = this.ctx.storage.kv;
    const key = `ticket:${ticketHash}`;
    const ticket = kv.get<{ connectionId: string; expiresAt: number }>(key);
    if (!ticket) return null;
    kv.delete(key);
    return ticket.expiresAt > Date.now() ? ticket.connectionId : null;
  }

  /** Creates the source of a newly connected provider account. */
  createConnectedSource(datasetId: string, source: {
    kind: "square" | "stripe";
    label: string;
    createdBy: string;
    connectionName: string;
    externalAccountLabel: string;
  }): number {
    const id = this.createSource(datasetId, { kind: source.kind, label: source.label, createdBy: source.createdBy });
    this.ctx.storage.sql.exec(
      "UPDATE store_sources SET connection_name = ?, external_account_label = ? WHERE id = ?",
      source.connectionName, source.externalAccountLabel, id);
    return id;
  }

  /** A source's kind, status and connection object name, or null when there is no such source. */
  sourceConnection(datasetId: string, sourceId: number): {
    kind: SourceSummary["kind"]; status: SourceSummary["status"]; connectionName: string | null;
  } | null {
    this.#open(datasetId);
    const row = this.ctx.storage.sql.exec<{ kind: SourceSummary["kind"]; status: SourceSummary["status"]; connection_name: string | null }>(
      "SELECT kind, status, connection_name FROM store_sources WHERE id = ?", sourceId).toArray()[0];
    return row ? { kind: row.kind, status: row.status, connectionName: row.connection_name } : null;
  }

  /** The connection object names of every provider source not yet disconnected. */
  connectionNames(datasetId: string): string[] {
    this.#open(datasetId, { allowErasing: true });
    return this.ctx.storage.sql.exec<{ connection_name: string }>(
      "SELECT connection_name FROM store_sources WHERE connection_name IS NOT NULL AND status != 'disconnected'",
    ).toArray().map(row => row.connection_name);
  }

  /** Sets a provider source's status, and its error when an administrator must act. */
  setSourceStatus(
    datasetId: string, sourceId: number, status: SourceSummary["status"],
    error: { code: string; message: string } | null = null,
  ): void {
    this.#open(datasetId);
    this.ctx.storage.sql.exec(
      "UPDATE store_sources SET status = ?, last_error_code = ?, last_error_message = ? WHERE id = ?",
      status, error?.code ?? null, error?.message ?? null, sourceId);
  }

  /** How many years a new backfill reads (1–3). */
  backfillYears(datasetId: string): number {
    return this.#open(datasetId).backfill_years;
  }

  setBackfillYears(datasetId: string, years: number): void {
    this.#open(datasetId);
    if (!Number.isInteger(years) || years < 1 || years > 3) throw new Error("The backfill depth is 1 to 3 years.");
    this.ctx.storage.sql.exec("UPDATE settings SET backfill_years = ? WHERE id = 1", years);
  }

  /** Recreates the `customers` view masked or unmasked, and records who changed it (research R12). */
  setPersonalDataUnmasked(datasetId: string, on: boolean, memberId: string): void {
    this.#open(datasetId);
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      recreateCustomersView(sql, on);
      sql.exec("UPDATE settings SET pii_unmasked = ?, pii_changed_by = ?, pii_changed_at = ? WHERE id = 1",
        on ? 1 : 0, memberId, nowSeconds());
    });
    logger.info("personal data setting changed", {
      event: "dataset.pii_changed", datasetId, operation: on ? "unmask" : "mask",
    });
  }

  // --- Matching (US6) ---

  /** Proposes new cross-source matches of `kind`, then lists the open and confirmed ones. */
  listMatchProposals(datasetId: string, kind: MatchKind): MatchProposal[] {
    const settings = this.#open(datasetId);
    if (kind !== "customer" && kind !== "product") throw new Error("Unknown match kind.");
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => proposeMatches(sql, kind));
    return listMatches(sql, kind, settings.pii_unmasked === 1);
  }

  confirmMatch(datasetId: string, id: number, memberId: string): void {
    this.#open(datasetId);
    this.ctx.storage.transactionSync(() => confirmMatch(this.ctx.storage.sql, id, memberId, nowSeconds()));
  }

  rejectMatch(datasetId: string, id: number, memberId: string): void {
    this.#open(datasetId);
    this.ctx.storage.transactionSync(() => rejectMatch(this.ctx.storage.sql, id, memberId, nowSeconds()));
  }

  undoMatch(datasetId: string, id: number, memberId: string): void {
    this.#open(datasetId);
    this.ctx.storage.transactionSync(() => undoMatch(this.ctx.storage.sql, id, memberId, nowSeconds()));
  }

  /** Which of `ids` the source has already ingested into `table`. */
  knownSourceRecords(datasetId: string, sourceId: number, table: KnownTable, ids: string[]): string[] {
    this.#open(datasetId);
    const unique = [...new Set(ids)];
    const known: string[] = [];
    // SQLite's bound-parameter limit is 100 in Durable Objects.
    for (let index = 0; index < unique.length; index += 90) {
      const chunk = unique.slice(index, index + 90);
      for (const row of this.ctx.storage.sql.exec<{ source_record_id: string }>(
        `SELECT source_record_id FROM store_${table} WHERE source_id = ? AND source_record_id IN (${chunk.map(() => "?").join(",")})`,
        sourceId, ...chunk)) {
        known.push(row.source_record_id);
      }
    }
    return known;
  }

  /** Records a running run's progress and resumable position (data-model `runs`). */
  updateRunProgress(
    datasetId: string, runId: number,
    progress: { phase: string; done: number; total: number | null; etaSeconds: number | null },
    cursor: unknown = null,
  ): void {
    this.#open(datasetId);
    this.ctx.storage.sql.exec("UPDATE runs SET progress = ?, cursor = ? WHERE id = ? AND status = 'running'",
      JSON.stringify(progress), cursor === null ? null : JSON.stringify(cursor), runId);
  }

  /**
   * Deletes one batch of a source's data (US1.5): rows first, recomputing the rollup days they
   * touched, then its raw objects. Returns `done` once nothing of the source is left; the source
   * itself stays, disconnected, with its run history.
   */
  async deleteSourceDataBatch(datasetId: string, sourceId: number, limit = 2_000): Promise<{ done: boolean }> {
    const settings = this.#open(datasetId);
    const sql = this.ctx.storage.sql;
    const deleted = this.ctx.storage.transactionSync(() => {
      const count = deleteSourceRowsBatch(sql, sourceId, limit);
      recomputeRollups(sql);
      if (count === 0) forgetSourceRows(sql, sourceId);
      return count;
    });
    if (deleted > 0) return { done: false };
    const raw = await new R2RawStore(this.env.RETAIL_RAW)
      .deletePrefix(`${datasetPrefix(settings.dataset_id)}src/${sourceId}/`, ERASE_BATCH_SIZE);
    if (!raw.done) return { done: false };
    sql.exec("DELETE FROM raw_objects WHERE run_id IN (SELECT id FROM runs WHERE source_id = ?)", sourceId);
    logger.info("source data deleted", { event: "dataset.source_deleted", datasetId, sourceId });
    return { done: true };
  }

  // --- Imports, runs, templates, coverage and lineage (US2, US4, US5) ---

  /**
   * Stages files the host delivered for a CSV import: each is copied into the raw store before
   * this returns, then sniffed and matched against templates.
   */
  stageImport(datasetId: string, target: ImportTarget, files: IncomingFile[], member: Member): Promise<{ importId: number }> {
    this.#open(datasetId);
    return stageImport(this.#dataArea(datasetId), target, files, member);
  }

  listImports(datasetId: string): Promise<ImportListEntry[]> {
    this.#open(datasetId);
    return listImports(this.#dataArea(datasetId));
  }

  getImport(datasetId: string, id: number): StagedImport {
    this.#open(datasetId);
    return getImport(this.ctx.storage, id);
  }

  discardImport(datasetId: string, id: number, member: Member): Promise<void> {
    this.#open(datasetId);
    return discardImport(this.#dataArea(datasetId), id, member);
  }

  askAgentPrompt(datasetId: string, id: number): string {
    this.#open(datasetId);
    return askAgentPrompt(this.ctx.storage, id);
  }

  previewImport(datasetId: string, id: number, mapping: unknown): Promise<ImportPreview> {
    this.#open(datasetId);
    return previewStaged(this.#dataArea(datasetId), id, mapping);
  }

  startImport(
    datasetId: string, id: number, mapping: unknown,
    options: { saveAsTemplate?: { name: string } | { templateId: number } } | undefined, member: Member,
  ): Promise<{ runId: number }> {
    this.#open(datasetId);
    return startImport(this.#dataArea(datasetId), id, mapping, options, member);
  }

  cancelRun(datasetId: string, runId: number, member: Member): void {
    this.#open(datasetId);
    cancelRun(this.ctx.storage, runId, member);
  }

  undoImport(datasetId: string, runId: number, member: Member): { undoRunId: number } {
    this.#open(datasetId);
    const result = undoImport(this.ctx.storage, runId, member);
    logger.info("import undone", { event: "import.undone", datasetId, runId });
    return result;
  }

  listRuns(datasetId: string, options: { sourceId?: number; after?: number; limit?: number } | undefined, member: Member): Page<RunSummary> {
    this.#open(datasetId);
    return listRuns(this.ctx.storage, options, member);
  }

  getRun(datasetId: string, id: number, member: Member): RunSummary {
    this.#open(datasetId);
    return getRun(this.ctx.storage, id, member);
  }

  listRejections(datasetId: string, runId: number, options?: { after?: number; limit?: number }): Page<RunRejection> {
    this.#open(datasetId);
    return listRejections(this.ctx.storage, runId, options);
  }

  /** Which sources cover which dates and locations, and which days look like missing data. */
  coverage(datasetId: string, options?: CoverageOptions): CoverageReport {
    this.#open(datasetId);
    return readCoverage(this.ctx.storage.sql, options);
  }

  /** Where one row came from. */
  lineage(datasetId: string, table: LineageTable, id: number): RowLineage {
    this.#open(datasetId);
    return readLineage(this.ctx.storage.sql, table, id);
  }

  // --- Browsing (spec 008): a member's own reads through the Data area, not agent observations ---

  /** The browsable tables with exact counts, the dates covered and the sources to filter by. */
  browseCatalog(datasetId: string): BrowseCatalog {
    const settings = this.#open(datasetId);
    return readBrowseCatalog(this.ctx.storage.sql, settings.pii_unmasked === 0);
  }

  /** One page of a table's rows, newest first. */
  browseRows(datasetId: string, table: BrowseTable, query?: BrowseQuery): BrowsePage {
    this.#open(datasetId);
    const started = Date.now();
    const page = readBrowsePage(this.ctx.storage.sql, table, query, this.#scanRowLimit());
    logger.info("browse page read", {
      event: "browse.rows", table, rowCount: page.rows.length, total: page.total, durationMs: Date.now() - started,
    });
    return page;
  }

  /** One row with every field, its related rows and its origin. */
  rowDetail(datasetId: string, table: BrowseTable, id: number): RowDetail {
    this.#open(datasetId);
    return readRowDetail(this.ctx.storage.sql, table, id);
  }

  listTemplates(datasetId: string): TemplateSummary[] {
    this.#open(datasetId);
    return listTemplates(this.ctx.storage);
  }

  getTemplate(datasetId: string, id: number): TemplateDetail {
    this.#open(datasetId);
    return getTemplate(this.ctx.storage, id);
  }

  saveTemplateVersion(datasetId: string, id: number, mapping: unknown, member: Member): { versionId: number } {
    this.#open(datasetId);
    return saveTemplateVersion(this.ctx.storage, id, mapping, member);
  }

  copyTemplate(datasetId: string, id: number, name: string, member: Member): { templateId: number } {
    this.#open(datasetId);
    return copyTemplate(this.ctx.storage, id, name, member);
  }

  deleteTemplate(datasetId: string, id: number): void {
    this.#open(datasetId);
    deleteTemplate(this.ctx.storage, id);
  }

  reapplyTemplate(datasetId: string, templateId: number, versionId: number | undefined, member: Member): Promise<{ runIds: number[] }> {
    this.#open(datasetId);
    return reapplyTemplate(this.#dataArea(datasetId), templateId, versionId, member);
  }

  /** Staged imports for the agent, with masked samples; `suggestions` are pending, unapplied ones. */
  pendingImports(datasetId: string, suggestions: { importId: number; mapping: MappingDocument }[]): Promise<RetailPendingImport[]> {
    this.#open(datasetId);
    return pendingImportsForAgent(this.#dataArea(datasetId),
      new Map(suggestions.map(suggestion => [suggestion.importId, suggestion.mapping])));
  }

  /** Validates the agent's mapping for a pending import and returns it as a mapping document. */
  checkAgentMapping(datasetId: string, importId: number, mapping: unknown): MappingDocument {
    this.#open(datasetId);
    return checkAgentMapping(this.ctx.storage, importId, mapping);
  }

  /** Stores an approved agent suggestion on a pending import. */
  setAgentMapping(datasetId: string, importId: number, mapping: MappingDocument): void {
    this.#open(datasetId);
    setAgentMapping(this.ctx.storage, importId, mapping);
  }

  /**
   * Erases the dataset (FR-022, research R20): reads are refused at once, then alarms delete the
   * raw objects in batches and finally every row. Idempotent.
   */
  async erase(datasetId: string): Promise<void> {
    this.#open(datasetId, { allowErasing: true });
    this.ctx.storage.sql.exec("UPDATE settings SET status = 'erasing' WHERE id = 1");
    await this.ctx.storage.setAlarm(Date.now());
    logger.info("dataset erase started", { event: "dataset.erase.started", datasetId });
  }

  /** Runs one erase step while the dataset is being erased, otherwise one import step. */
  override async alarm(): Promise<void> {
    // A fresh or fully erased object has no schema, and so nothing to do.
    if (this.ctx.storage.kv.get<number>("schemaVersion") === undefined) return;
    const settings = this.#settings();
    if (!settings) return;
    if (settings.status !== "erasing") {
      await this.#importStep(settings.dataset_id);
      return;
    }
    const datasetId = settings.dataset_id;
    try {
      const { deleted, done } = await new R2RawStore(this.env.RETAIL_RAW)
        .deletePrefix(datasetPrefix(datasetId), ERASE_BATCH_SIZE);
      if (!done) {
        logger.debug("dataset erase step", { event: "dataset.erase.step", datasetId, deletedObjects: deleted });
        await this.ctx.storage.setAlarm(Date.now());
        return;
      }
      this.#hmacKey = undefined;
      this.#lookups.clear();
      await this.ctx.storage.deleteAll();
      logger.info("dataset erased", { event: "dataset.erased", datasetId });
    } catch (error) {
      logger.warn("dataset erase step failed", { event: "dataset.erase.failed", datasetId, error });
      await this.ctx.storage.setAlarm(Date.now() + ERASE_RETRY_MS);
    }
  }

  /** One step of the oldest running import or rebuild; re-arms while work remains. */
  async #importStep(datasetId: string): Promise<void> {
    const started = Date.now();
    try {
      const outcome = await runImportStep(this.ctx.storage, this.env.RETAIL_RAW, this.#lookups);
      if (outcome !== "idle") {
        logger.debug("import step", { event: "import.step", datasetId, operation: outcome, durationMs: Date.now() - started });
        await this.ctx.storage.setAlarm(Date.now());
      }
    } catch (error) {
      logger.warn("import step failed", { event: "import.step.failed", datasetId, error });
      await this.ctx.storage.setAlarm(Date.now() + IMPORT_RETRY_MS);
    }
  }

  /** Arms the alarm now unless it already fires sooner. */
  async #wake(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now()) await this.ctx.storage.setAlarm(Date.now());
  }

  #dataArea(datasetId: string): DataAreaContext {
    return {
      storage: this.ctx.storage,
      bucket: this.env.RETAIL_RAW,
      putRaw: (object, body, size) => this.putRawObject(datasetId, object, body, size),
      wake: () => this.#wake(),
    };
  }

  /**
   * Migrates the schema if needed and binds the object to `datasetId` on first use. Refuses a
   * different dataset id, and every read while the dataset is being erased.
   */
  #open(datasetId: string, options?: { allowErasing?: boolean }): Settings {
    if (typeof datasetId !== "string" || datasetId === "") throw new Error("A dataset id is required.");
    const kv = this.ctx.storage.kv;
    const version = kv.get<number>("schemaVersion") ?? 0;
    if (version < SCHEMA_VERSION) {
      this.ctx.storage.transactionSync(() => {
        for (const statements of SCHEMA_MIGRATIONS.slice(version)) {
          for (const statement of statements) this.ctx.storage.sql.exec(statement);
        }
        kv.put("schemaVersion", SCHEMA_VERSION);
      });
    }
    let settings = this.#settings();
    if (!settings) {
      this.ctx.storage.sql.exec(
        "INSERT INTO settings (id, dataset_id, status, email_hmac_key) VALUES (1, ?, 'active', ?)",
        datasetId, newHmacKey());
      settings = this.#settings()!;
    }
    if (settings.dataset_id !== datasetId) throw new Error("This dataset object belongs to another dataset.");
    if (settings.status === "erasing" && !options?.allowErasing) throw new Error("This dataset is being erased.");
    return settings;
  }

  #settings(): Settings | undefined {
    return this.ctx.storage.sql.exec<Settings>(
      "SELECT dataset_id, status, pii_unmasked, backfill_years, size_warned_at, email_hmac_key FROM settings WHERE id = 1",
    ).toArray()[0];
  }

  #addRunCounts(runId: number, counts: Partial<Record<string, TableCounts>>): void {
    const sql = this.ctx.storage.sql;
    const current = JSON.parse(sql.exec<{ counts: string }>("SELECT counts FROM runs WHERE id = ?", runId).one().counts) as
      Record<string, TableCounts>;
    for (const [table, add] of Object.entries(counts)) {
      const total = current[table] ??= { fetched: 0, written: 0, updated: 0, skipped: 0, rejected: 0 };
      total.fetched += add!.fetched;
      total.written += add!.written;
      total.updated += add!.updated;
      total.skipped += add!.skipped;
      total.rejected += add!.rejected;
    }
    sql.exec("UPDATE runs SET counts = ? WHERE id = ?", JSON.stringify(current), runId);
  }

  #storageStatus(): StorageStatus {
    const usedBytes = this.ctx.storage.sql.databaseSize;
    return {
      usedBytes,
      capBytes: DATASET_CAP_BYTES,
      rawUsedBytes: this.ctx.storage.sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM raw_objects").one().n,
      rawQuotaBytes: this.#rawQuotaBytes(),
      warn: usedBytes >= DATASET_CAP_BYTES * SIZE_WARNING_RATIO,
    };
  }

  /** Logs the 70% warning once per dataset. */
  #checkSize(settings: Settings): void {
    if (settings.size_warned_at !== null) return;
    const sizeBytes = this.ctx.storage.sql.databaseSize;
    if (sizeBytes < DATASET_CAP_BYTES * SIZE_WARNING_RATIO) return;
    this.ctx.storage.sql.exec("UPDATE settings SET size_warned_at = ? WHERE id = 1", nowSeconds());
    logger.warn("dataset passed 70% of its storage cap", {
      event: "dataset.size_warning", datasetId: settings.dataset_id, sizeBytes, capBytes: DATASET_CAP_BYTES,
    });
  }

  #scanRowLimit(): number {
    const configured = Number(this.env.RETAIL_SCAN_ROW_LIMIT);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_SCAN_ROW_LIMIT;
  }

  #rawQuotaBytes(): number {
    const configured = Number(this.env.RETAIL_RAW_QUOTA_BYTES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_RAW_QUOTA_BYTES;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
