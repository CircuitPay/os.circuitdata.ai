// Staged imports, runs, undo and templates, as the dataset Durable Object serves them to the Data
// area (contracts/data-area-api.md) and to the binding's `pendingImports()`. Every function runs
// inside the dataset object, against its own storage; permission rules (own imports vs.
// administrators) are applied here from the member id and rights the caller re-read.

import type {
  ImportListEntry, ImportPreview, ImportTarget, MappingDocument, Page, RunKind, RunRejection, RunStatus,
  RunSummary, StagedImport, StagedImportStatus, TemplateDetail, TemplateMatch, TemplateSummary,
} from "../app-api-types.js";
import { type RetailPendingImport } from "../types.js";
import { UNDO_RETENTION_DAYS, UndoRefusedError, laterChanges, undoImportRun } from "../dataset/ingest.js";
import { maskEmail, maskName, maskPhone } from "../dataset/masking.js";
import { recomputeRollups } from "../dataset/rollups.js";
import { r2CsvSource } from "./csv-stream.js";
import {
  type CursorSet, type StagedFile, newCursor, previewImport, resolveCursorFiles,
} from "./import-loop.js";
import { sha256Hex } from "./interpret.js";
import {
  MappingError, SINGLE_FILE_ROLE, TARGETS, TARGET_INFOS, fromAgentMapping, parseMappingDocument, resolveRef,
  toAgentMapping, validateMapping,
} from "./mapping.js";
import { type CandidateTemplate, matchTemplate, propose } from "./propose.js";
import { sniffCsv } from "./sniff.js";
import { BUILTIN_TEMPLATES, headerSignatures } from "./templates/index.js";

/** At most this many files per import. */
export const MAX_IMPORT_FILES = 10;

/** The largest file an import accepts (the tenant file limit). */
export const MAX_IMPORT_FILE_BYTES = 512 * 1024 * 1024;

/** Abandoned staged imports expire after this long, with their raw objects. */
export const STAGED_IMPORT_TTL_SECONDS = 7 * 86_400;

/** Sample rows shown to the agent per file. */
const AGENT_SAMPLE_ROWS = 20;

/** What the functions here need from the dataset object. */
export type DataAreaContext = {
  storage: DurableObjectStorage;
  bucket: R2Bucket;
  /** Stores one raw object, counting it against the quota; returns its id. */
  putRaw(
    object: { sourceId: number; runId: number; kind: "csv_file"; fileName: string },
    body: ReadableStream<Uint8Array>,
    size: number,
  ): Promise<number>;
  /** Makes sure the import loop runs soon. */
  wake(): Promise<void>;
};

/** Who is asking, with the rights they hold right now. */
export type Member = { memberId: string; canManage: boolean };

/** A file handed over by the host. */
export type IncomingFile = { name: string; size: number; contentType: string; stream: ReadableStream<Uint8Array> };

type StagedRow = {
  id: number; source_id: number; files: string; status: StagedImportStatus; deterministic_mapping: string | null;
  agent_mapping: string | null; import_mapping: string | null; chosen_template_version_id: number | null;
  run_id: number; created_by: string | null; created_at: number; expires_at: number; matches: string;
  missing_files: string;
};

type RunRow = {
  id: number; source_id: number; kind: RunKind; status: RunStatus; template_version_id: number | null;
  mapping_version: string; started_by: string | null; started_at: number; finished_at: number | null;
  counts: string; progress: string | null; undo_of: number | null; undone_by: number | null; warnings: string;
  error: string | null; cancel_requested: number;
};

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------------------------
// Templates

/** Seeds the built-in templates, adding a version whenever a release changed one (US5.2). */
export function ensureBuiltinTemplates(storage: DurableObjectStorage): void {
  const stamp = BUILTIN_TEMPLATES.map(template => `${template.key}:${template.version}`).join(",");
  if (storage.kv.get<string>("builtinTemplates") === stamp) return;
  const sql = storage.sql;
  storage.transactionSync(() => {
    for (const builtin of BUILTIN_TEMPLATES) {
      let template = sql.exec<{ id: number }>(
        "SELECT id FROM templates WHERE origin = 'builtin' AND builtin_key = ?", builtin.key).toArray()[0];
      if (!template) {
        template = sql.exec<{ id: number }>(
          "INSERT INTO templates (name, origin, builtin_key) VALUES (?, 'builtin', ?) RETURNING id",
          builtin.name, builtin.key).one();
      }
      const existing = sql.exec<{ id: number }>(
        "SELECT id FROM template_versions WHERE template_id = ? AND version = ?", template.id, builtin.version).toArray()[0];
      if (existing) continue;
      const versionId = sql.exec<{ id: number }>(
        "INSERT INTO template_versions (template_id, version, mapping, header_signatures, created_at) " +
        "VALUES (?, ?, ?, ?, ?) RETURNING id",
        template.id, builtin.version, JSON.stringify(builtin.mapping),
        JSON.stringify(headerSignatures(builtin.mapping, builtin.signature)), now()).one().id;
      sql.exec("UPDATE templates SET current_version_id = ?, name = ? WHERE id = ?", versionId, builtin.name, template.id);
    }
    storage.kv.put("builtinTemplates", stamp);
  });
}

/** The current version of every template, for matching. */
function candidateTemplates(sql: SqlStorage): CandidateTemplate[] {
  return sql.exec<{
    template_id: number; version_id: number; name: string; origin: "builtin" | "user"; mapping: string;
    header_signatures: string; last_used: number | null;
  }>(`
    SELECT t.id AS template_id, v.id AS version_id, t.name, t.origin, v.mapping, v.header_signatures,
      (SELECT MAX(r.started_at) FROM runs r JOIN template_versions rv ON rv.id = r.template_version_id
        WHERE rv.template_id = t.id AND r.kind = 'import' AND r.status NOT IN ('staged', 'expired')) AS last_used
    FROM templates t JOIN template_versions v ON v.id = t.current_version_id`).toArray()
    .map(row => ({
      templateId: row.template_id, versionId: row.version_id, name: row.name, origin: row.origin,
      mapping: JSON.parse(row.mapping) as MappingDocument,
      signatures: JSON.parse(row.header_signatures) as { role: string; headers: string[] }[],
      lastUsedAt: row.last_used,
    }));
}

/** The mapping version string rows record for a template version. */
function versionLabel(sql: SqlStorage, versionId: number): string {
  const row = sql.exec<{ template_id: number; version: number; origin: string; builtin_key: string | null }>(`
    SELECT v.template_id, v.version, t.origin, t.builtin_key FROM template_versions v
    JOIN templates t ON t.id = v.template_id WHERE v.id = ?`, versionId).one();
  return row.origin === "builtin" ? `builtin:${row.builtin_key}:v${row.version}` : `template:${row.template_id}:v${row.version}`;
}

/** Templates, with how often they were used and whether a rebuild is offered. */
export function listTemplates(storage: DurableObjectStorage): TemplateSummary[] {
  ensureBuiltinTemplates(storage);
  const sql = storage.sql;
  return sql.exec<{
    id: number; name: string; origin: "builtin" | "user"; builtin_key: string | null;
    current_version_id: number | null; version: number | null;
  }>(`
    SELECT t.id, t.name, t.origin, t.builtin_key, t.current_version_id, v.version
    FROM templates t LEFT JOIN template_versions v ON v.id = t.current_version_id
    ORDER BY t.origin DESC, t.name`).toArray().map(row => ({
      id: row.id, name: row.name, origin: row.origin, builtinKey: row.builtin_key,
      currentVersionId: row.current_version_id, currentVersion: row.version,
      runs: templateRuns(sql, row.id),
      rebuildOffered: rebuildOffered(sql, row.id, row.current_version_id),
    }));
}

function templateRuns(sql: SqlStorage, templateId: number, versionId?: number): number {
  return sql.exec<{ n: number }>(`
    SELECT COUNT(*) AS n FROM runs WHERE status = 'succeeded' AND kind IN ('import', 'rebuild')
      AND template_version_id IN (SELECT id FROM template_versions WHERE template_id = ?)
      AND (? IS NULL OR template_version_id = ?)`, templateId, versionId ?? null, versionId ?? null).one().n;
}

/**
 * True when some source's latest data from the template came from an older version than the
 * current one, i.e. a newer version has not been re-applied there yet.
 */
function rebuildOffered(sql: SqlStorage, templateId: number, currentVersionId: number | null): boolean {
  if (currentVersionId === null) return false;
  return sql.exec<{ n: number }>(`
    SELECT COUNT(*) AS n FROM runs r
    WHERE r.status = 'succeeded' AND r.kind IN ('import', 'rebuild') AND r.template_version_id != ?
      AND r.template_version_id IN (SELECT id FROM template_versions WHERE template_id = ?)
      AND NOT EXISTS (SELECT 1 FROM runs later WHERE later.source_id = r.source_id AND later.id > r.id
        AND later.status = 'succeeded' AND later.kind = 'rebuild' AND later.template_version_id = ?)`,
  currentVersionId, templateId, currentVersionId).one().n > 0;
}

/** One template with every version. */
export function getTemplate(storage: DurableObjectStorage, id: number): TemplateDetail {
  const summary = listTemplates(storage).find(template => template.id === id);
  if (!summary) throw new Error(`There is no template ${id}.`);
  const versions = storage.sql.exec<{
    id: number; version: number; created_by: string | null; created_at: number; mapping: string;
  }>("SELECT id, version, created_by, created_at, mapping FROM template_versions WHERE template_id = ? ORDER BY version DESC", id)
    .toArray().map(row => ({
      id: row.id, version: row.version, createdBy: row.created_by, createdAt: isoSeconds(row.created_at),
      mapping: JSON.parse(row.mapping) as MappingDocument, runs: templateRuns(storage.sql, id, row.id),
    }));
  return { ...summary, versions };
}

/** Adds a version to a user template. */
export function saveTemplateVersion(
  storage: DurableObjectStorage, id: number, input: unknown, member: Member,
): { versionId: number } {
  const sql = storage.sql;
  const template = sql.exec<{ origin: string }>("SELECT origin FROM templates WHERE id = ?", id).toArray()[0];
  if (!template) throw new Error(`There is no template ${id}.`);
  if (template.origin !== "user") throw new Error("Built-in templates are read-only; copy it to change it.");
  const mapping = parseMappingDocument(input);
  validateMapping(mapping, null);
  return { versionId: addTemplateVersion(storage, id, mapping, member.memberId) };
}

function addTemplateVersion(storage: DurableObjectStorage, templateId: number, mapping: MappingDocument, by: string): number {
  const sql = storage.sql;
  return storage.transactionSync(() => {
    const version = sql.exec<{ n: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS n FROM template_versions WHERE template_id = ?", templateId).one().n;
    const versionId = sql.exec<{ id: number }>(
      "INSERT INTO template_versions (template_id, version, mapping, header_signatures, created_by, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      templateId, version, JSON.stringify(mapping), JSON.stringify(headerSignatures(mapping)), by, now()).one().id;
    sql.exec("UPDATE templates SET current_version_id = ? WHERE id = ?", versionId, templateId);
    return versionId;
  });
}

function createTemplate(
  storage: DurableObjectStorage, name: string, sourceId: number | null, mapping: MappingDocument, by: string,
): { templateId: number; versionId: number } {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) throw new Error("A template name is 1 to 100 characters.");
  const templateId = storage.sql.exec<{ id: number }>(
    "INSERT INTO templates (name, source_id, origin, created_by) VALUES (?, ?, 'user', ?) RETURNING id",
    trimmed, sourceId, by).one().id;
  return { templateId, versionId: addTemplateVersion(storage, templateId, mapping, by) };
}

/** Copies a template (built-in or user) into a new user template. */
export function copyTemplate(storage: DurableObjectStorage, id: number, name: string, member: Member): { templateId: number } {
  ensureBuiltinTemplates(storage);
  const current = storage.sql.exec<{ mapping: string }>(`
    SELECT v.mapping FROM templates t JOIN template_versions v ON v.id = t.current_version_id WHERE t.id = ?`, id).toArray()[0];
  if (!current) throw new Error(`There is no template ${id}.`);
  return { templateId: createTemplate(storage, name, null, JSON.parse(current.mapping) as MappingDocument, member.memberId).templateId };
}

/** Deletes a user template. The rows it imported stay. */
export function deleteTemplate(storage: DurableObjectStorage, id: number): void {
  const sql = storage.sql;
  const template = sql.exec<{ origin: string }>("SELECT origin FROM templates WHERE id = ?", id).toArray()[0];
  if (!template) throw new Error(`There is no template ${id}.`);
  if (template.origin !== "user") throw new Error("Built-in templates cannot be deleted.");
  storage.transactionSync(() => {
    sql.exec("DELETE FROM template_versions WHERE template_id = ?", id);
    sql.exec("DELETE FROM templates WHERE id = ?", id);
  });
}

/**
 * Re-applies one version of a template (US5): one rebuild run per source, over every raw object a
 * succeeded import of the template stored. Rows are upserted by source key, and rows the template
 * produced before but no longer does are deleted when the rebuild ends.
 */
export async function reapplyTemplate(
  context: DataAreaContext, templateId: number, versionId: number | undefined, member: Member,
): Promise<{ runIds: number[] }> {
  const { storage, bucket } = context;
  const sql = storage.sql;
  ensureBuiltinTemplates(storage);
  const template = sql.exec<{ origin: string; current_version_id: number | null }>(
    "SELECT origin, current_version_id FROM templates WHERE id = ?", templateId).toArray()[0];
  if (!template) throw new Error(`There is no template ${templateId}.`);
  const chosen = versionId ?? template.current_version_id;
  const version = sql.exec<{ mapping: string }>(
    "SELECT mapping FROM template_versions WHERE id = ? AND template_id = ?", chosen, templateId).toArray()[0];
  if (!version) throw new Error(`Version ${chosen} is not a version of template ${templateId}.`);
  const versionMapping = JSON.parse(version.mapping) as MappingDocument;
  const versionIds = sql.exec<{ id: number }>("SELECT id FROM template_versions WHERE template_id = ?", templateId)
    .toArray().map(row => row.id);
  const imports = sql.exec<{ run_id: number; source_id: number; files: string; import_mapping: string | null }>(`
    SELECT r.id AS run_id, r.source_id, s.files, s.import_mapping FROM runs r JOIN staged_imports s ON s.run_id = r.id
    WHERE r.kind = 'import' AND r.status = 'succeeded'
      AND r.template_version_id IN (${versionIds.map(() => "?").join(", ")})
    ORDER BY r.id`, ...versionIds).toArray();
  if (imports.length === 0) throw new Error("No import used this template, so there is nothing to re-apply.");
  const bySource = new Map<number, CursorSet[]>();
  for (const entry of imports) {
    const imported = entry.import_mapping ? JSON.parse(entry.import_mapping) as MappingDocument : null;
    const mapping = mappingForRebuild(versionMapping, imported, template.origin === "builtin");
    const staged = JSON.parse(entry.files) as StagedFile[];
    const files = await resolveCursorFiles(bucket, withRoles(staged, mapping), mapping);
    const sets = bySource.get(entry.source_id) ?? [];
    sets.push({ mapping, files });
    bySource.set(entry.source_id, sets);
  }
  const mappingVersion = versionLabel(sql, chosen!);
  const runIds: number[] = [];
  storage.transactionSync(() => {
    for (const [sourceId, sets] of bySource) {
      const label = sql.exec<{ label: string }>("SELECT label FROM store_sources WHERE id = ?", sourceId).one().label;
      const runId = sql.exec<{ id: number }>(
        "INSERT INTO runs (source_id, kind, status, template_version_id, mapping_version, started_by, started_at, progress) " +
        "VALUES (?, 'rebuild', 'running', ?, ?, ?, ?, ?) RETURNING id",
        sourceId, chosen, mappingVersion, member.memberId, now(),
        JSON.stringify({ phase: "queued", done: 0, total: 0, etaSeconds: null })).one().id;
      const cursor = newCursor(label, sets, { templateVersionIds: versionIds });
      sql.exec("UPDATE runs SET cursor = ?, progress = ? WHERE id = ?", JSON.stringify(cursor),
        JSON.stringify({ phase: "queued", done: 0, total: cursor.bytesTotal, etaSeconds: null }), runId);
      runIds.push(runId);
    }
  });
  await context.wake();
  return { runIds };
}

/**
 * The mapping a rebuild reads one import with: the template version's, keeping the import's own
 * settings (zone, currency, date format, set date) where a built-in's are only defaults.
 */
function mappingForRebuild(version: MappingDocument, imported: MappingDocument | null, builtin: boolean): MappingDocument {
  if (!imported) return version;
  const settings = builtin
    ? { ...version.settings, timezone: imported.settings.timezone, currency: imported.settings.currency,
      dateFormat: imported.settings.dateFormat, decimalMark: imported.settings.decimalMark }
    : { ...version.settings };
  if (imported.settings.fileDate !== undefined) settings.fileDate = imported.settings.fileDate;
  return {
    ...version,
    settings,
    ...(version.parsing ?? imported.parsing ? { parsing: version.parsing ?? imported.parsing } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Staging

/** Expires abandoned staged imports, deleting their raw objects. */
export async function expireStagedImports(context: DataAreaContext): Promise<void> {
  const sql = context.storage.sql;
  const expired = sql.exec<{ id: number; run_id: number }>(
    "SELECT id, run_id FROM staged_imports WHERE status = 'staged' AND expires_at <= ?", now()).toArray();
  for (const entry of expired) await dropStaged(context, entry.id, entry.run_id, "expired");
}

async function dropStaged(context: DataAreaContext, id: number, runId: number, status: "expired" | "discarded"): Promise<void> {
  const sql = context.storage.sql;
  const keys = sql.exec<{ r2_key: string }>("SELECT r2_key FROM raw_objects WHERE run_id = ?", runId).toArray().map(row => row.r2_key);
  if (keys.length > 0) await context.bucket.delete(keys);
  context.storage.transactionSync(() => {
    sql.exec("DELETE FROM raw_objects WHERE run_id = ?", runId);
    if (status === "discarded") {
      sql.exec("DELETE FROM staged_imports WHERE id = ?", id);
      sql.exec("DELETE FROM runs WHERE id = ? AND status = 'staged'", runId);
    } else {
      sql.exec("UPDATE staged_imports SET status = 'expired' WHERE id = ?", id);
      sql.exec("UPDATE runs SET status = 'expired', finished_at = ? WHERE id = ?", now(), runId);
    }
  });
}

/**
 * Stages files the host delivered: each stream is copied into R2 (the raw record) before this
 * returns, sniffed, and matched against templates; the deterministic mapping is stored.
 */
export async function stageImport(
  context: DataAreaContext, target: ImportTarget, files: IncomingFile[], member: Member,
): Promise<{ importId: number }> {
  const { storage, bucket } = context;
  const sql = storage.sql;
  const cancelAll = () => Promise.all(files.map(file => file.stream.cancel().catch(() => {})));
  try {
    if (files.length === 0) throw new Error("Pick at least one file.");
    if (files.length > MAX_IMPORT_FILES) throw new Error(`An import takes at most ${MAX_IMPORT_FILES} files.`);
    for (const file of files) {
      if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`${file.name} is empty.`);
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error(`${file.name} is larger than ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB.`);
    }
  } catch (error) {
    await cancelAll();
    throw error;
  }
  await expireStagedImports(context);
  ensureBuiltinTemplates(storage);
  const created = storage.transactionSync(() => {
    let sourceId: number;
    let newSource = false;
    if (typeof target === "number") {
      const source = sql.exec<{ kind: string }>("SELECT kind FROM store_sources WHERE id = ?", target).toArray()[0];
      if (!source) throw new Error(`There is no source ${target}.`);
      if (source.kind !== "csv" && source.kind !== "toast") throw new Error("Files can be imported only into a CSV source.");
      sourceId = target;
    } else {
      const label = typeof target?.newSourceLabel === "string" ? target.newSourceLabel.trim() : "";
      if (!label || label.length > 100) throw new Error("Name the new source (1 to 100 characters).");
      sourceId = sql.exec<{ id: number }>(
        "INSERT INTO store_sources (kind, label, status, created_by, created_at) VALUES ('csv', ?, 'imported', ?, ?) RETURNING id",
        label, member.memberId, now()).one().id;
      newSource = true;
    }
    const runId = sql.exec<{ id: number }>(
      "INSERT INTO runs (source_id, kind, status, mapping_version, started_by, started_at) " +
      "VALUES (?, 'import', 'staged', 'unmapped', ?, ?) RETURNING id",
      sourceId, member.memberId, now()).one().id;
    return { sourceId, runId, newSource };
  });
  const staged: StagedFile[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const name = typeof file.name === "string" && file.name ? file.name.slice(0, 255) : `file-${index + 1}.csv`;
      const rawObjectId = await context.putRaw(
        { sourceId: created.sourceId, runId: created.runId, kind: "csv_file", fileName: name }, file.stream, file.size);
      const key = sql.exec<{ r2_key: string }>("SELECT r2_key FROM raw_objects WHERE id = ?", rawObjectId).one().r2_key;
      let sniffed;
      try {
        sniffed = await sniffCsv(r2CsvSource(bucket, key, file.size));
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      staged.push({
        rawObjectId, name, bytes: file.size, key, role: null, sniff: sniffed.sniff, headers: sniffed.headers,
        sampleRows: sniffed.sampleRows, dataOffset: sniffed.dataOffset, dataRow: sniffed.dataRow,
      });
    }
  } catch (error) {
    await cancelAll();
    const keys = sql.exec<{ r2_key: string }>("SELECT r2_key FROM raw_objects WHERE run_id = ?", created.runId)
      .toArray().map(row => row.r2_key);
    if (keys.length > 0) await bucket.delete(keys);
    storage.transactionSync(() => {
      sql.exec("DELETE FROM raw_objects WHERE run_id = ?", created.runId);
      sql.exec("DELETE FROM runs WHERE id = ?", created.runId);
      if (created.newSource) sql.exec("DELETE FROM store_sources WHERE id = ?", created.sourceId);
    });
    throw error;
  }
  const source = sql.exec<{ default_timezone: string | null; default_currency: string | null }>(
    "SELECT default_timezone, default_currency FROM store_sources WHERE id = ?", created.sourceId).one();
  const proposal = propose(staged, candidateTemplates(sql), {
    timezone: source.default_timezone, currency: source.default_currency,
  });
  proposal.roles.forEach((role, index) => {
    staged[index]!.role = role;
  });
  const importId = storage.transactionSync(() => {
    for (const file of staged) sql.exec("UPDATE raw_objects SET file_role = ? WHERE id = ?", file.role, file.rawObjectId);
    const builtin = proposal.templateVersionId === null ? null : sql.exec<{ builtin_key: string | null }>(
      "SELECT t.builtin_key FROM template_versions v JOIN templates t ON t.id = v.template_id WHERE v.id = ?",
      proposal.templateVersionId).one().builtin_key;
    if (created.newSource && builtin === "toast") {
      sql.exec("UPDATE store_sources SET kind = 'toast' WHERE id = ?", created.sourceId);
    }
    return sql.exec<{ id: number }>(
      "INSERT INTO staged_imports (source_id, files, status, deterministic_mapping, chosen_template_version_id, run_id, " +
      "created_by, created_at, expires_at, matches, missing_files) VALUES (?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      created.sourceId, JSON.stringify(staged), proposal.mapping ? JSON.stringify(proposal.mapping) : null,
      proposal.templateVersionId, created.runId, member.memberId, now(), now() + STAGED_IMPORT_TTL_SECONDS,
      JSON.stringify(proposal.matches.map(({ roles: _roles, ...match }) => match)),
      JSON.stringify(proposal.missingRequiredFiles)).one().id;
  });
  return { importId };
}

function stagedRow(sql: SqlStorage, id: number): StagedRow {
  const row = sql.exec<StagedRow>("SELECT * FROM staged_imports WHERE id = ?", id).toArray()[0];
  if (!row) throw new Error(`There is no import ${id}.`);
  return row;
}

function sourceLabel(sql: SqlStorage, sourceId: number): string {
  return sql.exec<{ label: string }>("SELECT label FROM store_sources WHERE id = ?", sourceId).toArray()[0]?.label ?? "";
}

/** Staged imports that are not finished, newest first. */
export async function listImports(context: DataAreaContext): Promise<ImportListEntry[]> {
  await expireStagedImports(context);
  const sql = context.storage.sql;
  return sql.exec<StagedRow>(
    "SELECT * FROM staged_imports WHERE status IN ('staged', 'importing') ORDER BY id DESC LIMIT 100").toArray()
    .map(row => ({
      id: row.id, sourceId: row.source_id, sourceLabel: sourceLabel(sql, row.source_id), status: row.status,
      fileNames: (JSON.parse(row.files) as StagedFile[]).map(file => file.name), runId: row.run_id,
      createdBy: row.created_by, expiresAt: isoSeconds(row.expires_at), hasAgentMapping: row.agent_mapping !== null,
    }));
}

/** One staged import, with its files, samples, matches and mappings. */
export function getImport(storage: DurableObjectStorage, id: number): StagedImport {
  const sql = storage.sql;
  const row = stagedRow(sql, id);
  const files = JSON.parse(row.files) as StagedFile[];
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceLabel: sourceLabel(sql, row.source_id),
    status: row.status,
    createdBy: row.created_by,
    expiresAt: isoSeconds(row.expires_at),
    runId: row.run_id,
    files: files.map(file => ({
      rawObjectId: file.rawObjectId, name: file.name, bytes: file.bytes, role: file.role, sniff: file.sniff,
      headers: file.headers, sampleRows: file.sampleRows,
    })),
    templateMatches: JSON.parse(row.matches) as TemplateMatch[],
    deterministicMapping: row.deterministic_mapping ? JSON.parse(row.deterministic_mapping) as MappingDocument : null,
    agentMapping: row.agent_mapping ? JSON.parse(row.agent_mapping) as MappingDocument : null,
    missingRequiredFiles: JSON.parse(row.missing_files) as string[],
    targets: [...TARGET_INFOS],
  };
}

/** Drops a staged import and its files. Members may drop their own; administrators any. */
export async function discardImport(context: DataAreaContext, id: number, member: Member): Promise<void> {
  const row = stagedRow(context.storage.sql, id);
  if (row.status !== "staged") throw new Error(`Import ${id} is ${row.status}; only a waiting import can be discarded.`);
  if (row.created_by !== member.memberId && !member.canManage) {
    throw new Error("Only organization administrators can discard another member's import.");
  }
  await dropStaged(context, id, row.run_id, "discarded");
}

/** The prompt that asks the agent for a mapping. */
export function askAgentPrompt(storage: DurableObjectStorage, id: number): string {
  const row = stagedRow(storage.sql, id);
  if (row.status !== "staged") throw new Error(`Import ${id} is ${row.status}, not waiting for a mapping.`);
  const names = (JSON.parse(row.files) as StagedFile[]).map(file => file.name).join(", ");
  return `Propose a column mapping for pending import ${id} (${names}) in my retail data. ` +
    "Call RETAIL_DATA.pendingImports() to see its columns and sample rows, then " +
    `RETAIL_DATA.proposeImportMapping(${id}, mapping). Ask me about the time zone, currency or date format if the file does not make them clear.`;
}

/**
 * The staged files with their roles in `mapping`'s file set: the roles found at staging when the
 * mapping declares them, otherwise matched again by the mapping's header signatures.
 */
function withRoles(files: StagedFile[], mapping: MappingDocument): StagedFile[] {
  const declared = mapping.files ?? [];
  if (declared.length === 0) {
    if (files.length !== 1) throw new MappingError("This import has several files; use a mapping that declares the file set.");
    return [{ ...files[0]!, role: SINGLE_FILE_ROLE }];
  }
  if (files.every(file => file.role !== null && declared.some(entry => entry.role === file.role))) return files;
  const roles = matchTemplate({
    templateId: 0, versionId: 0, name: "", origin: "user", mapping, lastUsedAt: null,
    signatures: declared.map(entry => ({ role: entry.role, headers: entry.headerSignature })),
  }, files);
  if (!roles) {
    const unmatched = files.filter(file => !declared.some(entry =>
      entry.headerSignature.every(header => file.headers.some(h => h.trim().toLowerCase() === header.trim().toLowerCase()))));
    throw new MappingError(`${unmatched.map(file => file.name).join(", ") || "A file"} matches no file of the set.`);
  }
  return files.map((file, index) => ({ ...file, role: roles[index]! }));
}

/** Validates a mapping against a staged import's files; refuses a set with a required file missing. */
function checkedFiles(row: StagedRow, mapping: MappingDocument): StagedFile[] {
  const files = withRoles(JSON.parse(row.files) as StagedFile[], mapping);
  const present = new Set(files.map(file => file.role));
  const missing = (mapping.files ?? []).filter(file => file.required && !present.has(file.role)).map(file => file.role);
  if (missing.length > 0) {
    throw new MappingError(`The file set is missing ${missing.join(", ")}; add ${missing.length === 1 ? "it" : "them"} to the import.`);
  }
  validateMapping(mapping, files.map(file => ({ role: file.role!, headers: file.headers })));
  return files;
}

/** Previews a mapping over a staged import. Nothing is written. */
export async function previewStaged(context: DataAreaContext, id: number, input: unknown): Promise<ImportPreview> {
  const sql = context.storage.sql;
  const row = stagedRow(sql, id);
  if (row.status !== "staged") throw new Error(`Import ${id} is ${row.status}; it can no longer be previewed.`);
  const mapping = parseMappingDocument(input);
  const files = checkedFiles(row, mapping);
  const resolved = await resolveCursorFiles(context.bucket, files, mapping);
  return previewImport(context.storage, context.bucket, resolved, mapping, sourceLabel(sql, row.source_id));
}

/** Starts the background import of a staged import. */
export async function startImport(
  context: DataAreaContext,
  id: number,
  input: unknown,
  options: { saveAsTemplate?: { name: string } | { templateId: number } } | undefined,
  member: Member,
): Promise<{ runId: number }> {
  const { storage, bucket } = context;
  const sql = storage.sql;
  const row = stagedRow(sql, id);
  if (row.status !== "staged") throw new Error(`Import ${id} is ${row.status}; it can be started only once.`);
  const mapping = parseMappingDocument(input);
  const files = checkedFiles(row, mapping);
  const resolved = await resolveCursorFiles(bucket, files, mapping);
  let templateVersionId: number | null = null;
  const save = options?.saveAsTemplate;
  if (save && "name" in save) {
    templateVersionId = createTemplate(storage, save.name, row.source_id, mapping, member.memberId).versionId;
  } else if (save && "templateId" in save) {
    const template = sql.exec<{ origin: string }>("SELECT origin FROM templates WHERE id = ?", save.templateId).toArray()[0];
    if (!template) throw new Error(`There is no template ${save.templateId}.`);
    if (template.origin !== "user") throw new Error("Built-in templates are read-only; save a copy instead.");
    templateVersionId = addTemplateVersion(storage, save.templateId, mapping, member.memberId);
  } else if (row.chosen_template_version_id !== null && row.deterministic_mapping !== null
    && JSON.stringify(parseMappingDocument(JSON.parse(row.deterministic_mapping))) === JSON.stringify(mapping)) {
    // The template's proposal, unchanged: the import used that template version.
    templateVersionId = row.chosen_template_version_id;
  }
  const mappingVersion = templateVersionId !== null
    ? versionLabel(sql, templateVersionId)
    : `mapping:${(await sha256Hex(JSON.stringify(mapping))).slice(0, 16)}`;
  const cursor = newCursor(sourceLabel(sql, row.source_id), [{ mapping, files: resolved }]);
  const updated = storage.transactionSync(() => {
    const current = sql.exec<{ status: string }>("SELECT status FROM staged_imports WHERE id = ?", id).one();
    if (current.status !== "staged") return false;
    sql.exec(
      "UPDATE runs SET status = 'running', template_version_id = ?, mapping_version = ?, started_by = ?, started_at = ?, " +
      "cursor = ?, progress = ? WHERE id = ?",
      templateVersionId, mappingVersion, member.memberId, now(), JSON.stringify(cursor),
      JSON.stringify({ phase: "queued", done: 0, total: cursor.bytesTotal, etaSeconds: null }), row.run_id);
    sql.exec("UPDATE staged_imports SET status = 'importing', import_mapping = ? WHERE id = ?", JSON.stringify(mapping), id);
    return true;
  });
  if (!updated) throw new Error(`Import ${id} was started meanwhile.`);
  await context.wake();
  return { runId: row.run_id };
}

// ---------------------------------------------------------------------------------------------
// Runs

function runRow(sql: SqlStorage, id: number): RunRow {
  const row = sql.exec<RunRow>("SELECT * FROM runs WHERE id = ?", id).toArray()[0];
  if (!row) throw new Error(`There is no run ${id}.`);
  return row;
}

/** Cancels a running import or rebuild between batches. */
export function cancelRun(storage: DurableObjectStorage, runId: number, member: Member): void {
  const sql = storage.sql;
  const run = runRow(sql, runId);
  if (run.kind !== "import" && run.kind !== "rebuild") throw new Error("Only imports and rebuilds can be cancelled here.");
  if (run.status !== "running") throw new Error(`Run ${runId} is ${run.status}, not running.`);
  if (run.started_by !== member.memberId && !member.canManage) {
    throw new Error("Only organization administrators can cancel another member's import.");
  }
  sql.exec("UPDATE runs SET cancel_requested = 1 WHERE id = ?", runId);
}

/** Undoes an import by restoring its pre-images (FR-011). */
export function undoImport(storage: DurableObjectStorage, runId: number, member: Member): { undoRunId: number } {
  const sql = storage.sql;
  const run = runRow(sql, runId);
  if (run.kind !== "import") throw new Error("Only imports can be undone.");
  if (run.started_by !== member.memberId && !member.canManage) {
    throw new Error("Only organization administrators can undo another member's import.");
  }
  if (!["succeeded", "failed", "cancelled"].includes(run.status)) {
    throw new Error(`Import ${runId} is ${run.status}; it cannot be undone.`);
  }
  try {
    return storage.transactionSync(() => {
      undoImportRun(sql, runId, now());
      recomputeRollups(sql);
      const undoRunId = sql.exec<{ id: number }>(
        "INSERT INTO runs (source_id, kind, status, mapping_version, started_by, started_at, finished_at, undo_of) " +
        "VALUES (?, 'undo', 'succeeded', ?, ?, ?, ?, ?) RETURNING id",
        run.source_id, run.mapping_version, member.memberId, now(), now(), runId).one().id;
      sql.exec("UPDATE runs SET status = 'undone', undone_by = ? WHERE id = ?", undoRunId, runId);
      sql.exec("UPDATE staged_imports SET status = 'undone' WHERE run_id = ?", runId);
      return { undoRunId };
    });
  } catch (error) {
    if (error instanceof UndoRefusedError) throw new Error(error.message, { cause: error });
    throw error;
  }
}

/**
 * Whether `member` may undo `run` now. The full check (later runs changed its rows) runs only when
 * `full`, since it reads every pre-image; the undo itself always runs it.
 */
function undoEligibility(sql: SqlStorage, run: RunRow, member: Member, full: boolean): RunSummary["undo"] {
  if (run.kind !== "import") return { possible: false, reason: null };
  if (run.status === "undone") return { possible: false, reason: "This import was undone." };
  if (!["succeeded", "failed", "cancelled"].includes(run.status)) return { possible: false, reason: null };
  if (run.started_by !== member.memberId && !member.canManage) {
    return { possible: false, reason: "Only organization administrators can undo another member's import." };
  }
  const versions = sql.exec<{ n: number; expired: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(expires_at <= ?), 0) AS expired FROM row_versions WHERE run_id = ?", now(), run.id).one();
  const finished = run.finished_at ?? run.started_at;
  if (versions.expired > 0 || (versions.n === 0 && now() - finished > UNDO_RETENTION_DAYS * 86_400)) {
    return { possible: false, reason: "This import can no longer be undone." };
  }
  if (!full) return { possible: true, reason: null };
  const later = laterChanges(sql, run.id);
  if (later.runs.length === 0 && later.deleted === 0) return { possible: true, reason: null };
  const names = later.runs.map(id => `run ${id}`);
  if (later.deleted > 0) names.push("rows deleted since");
  return { possible: false, reason: `Later runs changed its rows: ${names.join(", ")}.` };
}

function summarize(sql: SqlStorage, run: RunRow, member: Member, full: boolean): RunSummary {
  const warnings = JSON.parse(run.warnings) as Partial<RunSummary["warnings"]>;
  return {
    id: run.id,
    sourceId: run.source_id,
    sourceLabel: sourceLabel(sql, run.source_id),
    kind: run.kind,
    status: run.status,
    templateVersionId: run.template_version_id,
    mappingVersion: run.mapping_version,
    startedBy: run.started_by,
    startedAt: isoSeconds(run.started_at),
    finishedAt: run.finished_at === null ? null : isoSeconds(run.finished_at),
    counts: JSON.parse(run.counts) as RunSummary["counts"],
    progress: run.progress ? JSON.parse(run.progress) as RunSummary["progress"] : null,
    warnings: {
      fingerprintRows: warnings.fingerprintRows ?? 0,
      totalMismatch: warnings.totalMismatch ?? 0,
      quantityRounded: warnings.quantityRounded ?? 0,
    },
    error: run.error,
    undoOf: run.undo_of,
    undoneBy: run.undone_by,
    undo: undoEligibility(sql, run, member, full),
    files: run.kind === "import"
      ? sql.exec<{ file_name: string | null; file_role: string | null; bytes: number }>(
        "SELECT file_name, file_role, bytes FROM raw_objects WHERE run_id = ? ORDER BY id", run.id).toArray()
        .map(file => ({ name: file.file_name ?? "", role: file.file_role, bytes: file.bytes }))
      : [],
  };
}

/** Runs, newest first. */
export function listRuns(
  storage: DurableObjectStorage, options: { sourceId?: number; after?: number; limit?: number } | undefined, member: Member,
): Page<RunSummary> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const rows = storage.sql.exec<RunRow>(`
    SELECT * FROM runs WHERE status NOT IN ('staged', 'expired') AND (?1 IS NULL OR source_id = ?1)
      AND (?2 IS NULL OR id < ?2) AND mapping_version != 'preview'
    ORDER BY id DESC LIMIT ?3`, options?.sourceId ?? null, options?.after ?? null, limit + 1).toArray();
  const items = rows.slice(0, limit).map(row => summarize(storage.sql, row, member, false));
  return { items, nextAfter: rows.length > limit ? items.at(-1)!.id : null };
}

/** One run with its report and full undo eligibility. */
export function getRun(storage: DurableObjectStorage, id: number, member: Member): RunSummary {
  return summarize(storage.sql, runRow(storage.sql, id), member, true);
}

/** Rejected rows of a run, in row order. */
export function listRejections(
  storage: DurableObjectStorage, runId: number, options: { after?: number; limit?: number } | undefined,
): Page<RunRejection> {
  runRow(storage.sql, runId);
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  const rows = storage.sql.exec<{
    id: number; table_name: string; file_name: string | null; row_index: number | null; reason_code: string;
    column_name: string | null; detail: string | null;
  }>(`
    SELECT r.rowid AS id, r.table_name, o.file_name, r.row_index, r.reason_code, r.column_name, r.detail
    FROM run_rejections r LEFT JOIN raw_objects o ON o.id = r.raw_object_id
    WHERE r.run_id = ? AND r.rowid > ? ORDER BY r.rowid LIMIT ?`, runId, options?.after ?? 0, limit + 1).toArray();
  const items = rows.slice(0, limit).map(row => ({
    id: row.id, table: row.table_name, file: row.file_name, row: row.row_index, reason: row.reason_code,
    column: row.column_name, detail: row.detail,
  }));
  return { items, nextAfter: rows.length > limit ? items.at(-1)!.id : null };
}

// ---------------------------------------------------------------------------------------------
// The agent's view (binding `pendingImports()` / `proposeImportMapping()`)

/** Staged imports waiting for a mapping, with masked samples. `suggestions` overlays pending ones. */
export async function pendingImportsForAgent(
  context: DataAreaContext, suggestions: ReadonlyMap<number, MappingDocument>,
): Promise<RetailPendingImport[]> {
  await expireStagedImports(context);
  const rows = context.storage.sql.exec<StagedRow>(
    "SELECT * FROM staged_imports WHERE status = 'staged' ORDER BY id").toArray();
  return rows.map(row => {
    const files = JSON.parse(row.files) as StagedFile[];
    const current = suggestions.get(row.id)
      ?? (row.agent_mapping ? JSON.parse(row.agent_mapping) as MappingDocument : null)
      ?? (row.deterministic_mapping ? JSON.parse(row.deterministic_mapping) as MappingDocument : null);
    const personalColumns = new Set<string>();
    for (const target of current?.targets ?? []) {
      if (TARGETS[target.target]?.personal && target.from !== null) {
        personalColumns.add(resolveRef(target.from, (current?.files?.length ?? 0) > 0).column.trim().toLowerCase());
      }
    }
    return {
      id: row.id,
      files: files.map(file => ({ name: file.name, headers: file.headers, ...(file.role ? { role: file.role } : {}) })),
      samples: files.map(file => ({
        file: file.name,
        rows: file.sampleRows.slice(0, AGENT_SAMPLE_ROWS).map(cells => cells.map((cell, column) =>
          maskSampleCell(cell, file.headers[column] ?? "", personalColumns))),
      })),
      currentMapping: current && !(current.files?.length) ? toAgentMapping(current) : null,
    };
  });
}

/** Masks a sample cell that is, or looks like, personal data (research R12). */
export function maskSampleCell(cell: string | null, header: string, personalColumns: ReadonlySet<string>): string | null {
  if (cell === null || cell.trim() === "") return cell;
  const name = header.trim().toLowerCase();
  if (/\S+@\S+\.\S+/.test(cell)) return maskEmail(cell) ?? "***";
  if (/^\+|^\(?\d{2,4}\)?[\s.-]\d{3}[\s.-]\d{3,4}$/.test(cell.trim()) && (cell.match(/\d/g)?.length ?? 0) >= 7) {
    return maskPhone(cell) ?? "***";
  }
  const personal = personalColumns.has(name) || /\b(name|e-?mail|phone|mobile|customer|guest|address)\b/.test(name)
    && !/\b(item|product|menu|location|store|server|employee|modifier|category|dining|revenue|option|price point|tab|table)\b/.test(name);
  if (!personal) return cell;
  if (/e-?mail/.test(name)) return maskEmail(cell) ?? "***";
  if (/phone|mobile/.test(name)) return maskPhone(cell) ?? "***";
  return cell.trim().split(/\s+/).map(part => maskName(part)).join(" ");
}

/**
 * Checks the agent's mapping for a staged import and returns it as a mapping document. Throws when
 * the import is no longer pending, or the mapping is invalid (e.g. names an unknown target field).
 */
export function checkAgentMapping(storage: DurableObjectStorage, importId: number, input: unknown): MappingDocument {
  const row = stagedRow(storage.sql, importId);
  if (row.status !== "staged") throw new Error(`Import ${importId} is no longer waiting for a mapping.`);
  const base = row.deterministic_mapping ? JSON.parse(row.deterministic_mapping) as MappingDocument : null;
  const mapping = fromAgentMapping(input, base);
  const files = JSON.parse(row.files) as StagedFile[];
  if (files.length !== 1) throw new MappingError("This import is a file set; its mapping is chosen in the Data area.");
  validateMapping(mapping, [{ role: SINGLE_FILE_ROLE, headers: files[0]!.headers }]);
  return mapping;
}

/** Stores the agent's approved suggestion on a staged import (replacing any earlier one). */
export function setAgentMapping(storage: DurableObjectStorage, importId: number, mapping: MappingDocument): void {
  const sql = storage.sql;
  const row = stagedRow(sql, importId);
  if (row.status !== "staged") throw new Error(`Import ${importId} is no longer waiting for a mapping.`);
  sql.exec("UPDATE staged_imports SET agent_mapping = ? WHERE id = ?", JSON.stringify(mapping), importId);
}

function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
