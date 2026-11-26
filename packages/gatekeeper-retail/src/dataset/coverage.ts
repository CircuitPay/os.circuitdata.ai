// Provenance and completeness (US4): which sources cover which business dates per location, which
// days look like missing data, and where one row came from. Shared by the binding's `coverage()` /
// `lineage()` and the Data area.

import type { CoverageReport, LineageTable, RowLineage, RunKind, SourceKind, SourceStatus } from "../app-api-types.js";
import { isIsoDate } from "./ingest.js";
import { CANONICAL_TABLES, type CanonicalTable } from "./schema.js";

/** At most this many days are scanned for gaps per location. */
export const MAX_GAP_SCAN_DAYS = 3 * 366;

/** A weekday "usually trades" when it had orders in this many of the previous 4 weeks. */
const USUAL_WEEKS = 3;

const DAY_MS = 86_400_000;

/** Coverage filters. */
export type CoverageOptions = { from?: string; to?: string; locationIds?: number[] };

/** Reads coverage: sources, contiguous covered ranges, and possible gaps. */
export function readCoverage(sql: SqlStorage, options: CoverageOptions = {}): CoverageReport {
  for (const [name, value] of [["from", options.from], ["to", options.to]] as const) {
    if (value !== undefined && !isIsoDate(value)) throw new Error(`${name} must be a date written YYYY-MM-DD.`);
  }
  if (options.from && options.to && options.from > options.to) throw new Error("from must not be after to.");
  const locationFilter = options.locationIds?.length ? new Set(options.locationIds) : null;
  const sources = sql.exec<{
    id: number; kind: SourceKind; label: string; status: SourceStatus; last_success_at: number | null;
  }>("SELECT id, kind, label, status, last_success_at FROM store_sources ORDER BY id").toArray();

  const days = sql.exec<{ business_date: string; location_id: number; source_id: number; orders: number }>(`
    SELECT business_date, location_id, source_id, orders FROM store_daily_source_coverage
    WHERE orders > 0 AND business_date >= ? AND business_date <= ?
    ORDER BY location_id, source_id, business_date`,
    options.from ?? "0000-01-01", options.to ?? "9999-12-31").toArray()
    .filter(day => !locationFilter || locationFilter.has(day.location_id));

  // Contiguous runs of covered days per location and source.
  const ranges: CoverageReport["ranges"] = [];
  let open: CoverageReport["ranges"][number] | null = null;
  for (const day of days) {
    if (open && open.locationId === day.location_id && open.sourceId === day.source_id
      && addDays(open.to, 1) === day.business_date) {
      open.to = day.business_date;
      continue;
    }
    open = { locationId: day.location_id, sourceId: day.source_id, from: day.business_date, to: day.business_date };
    ranges.push(open);
  }

  // Days with no orders at a location that usually trades on that weekday.
  const traded = new Map<number, Set<string>>();
  for (const day of sql.exec<{ location_id: number; business_date: string }>(`
    SELECT location_id, business_date FROM store_daily_source_coverage WHERE orders > 0
    GROUP BY location_id, business_date`)) {
    if (locationFilter && !locationFilter.has(day.location_id)) continue;
    let dates = traded.get(day.location_id);
    if (!dates) traded.set(day.location_id, dates = new Set());
    dates.add(day.business_date);
  }
  const possibleGaps: CoverageReport["possibleGaps"] = [];
  for (const [locationId, dates] of [...traded].toSorted((a, b) => a[0] - b[0])) {
    const sorted = [...dates].toSorted();
    let start = options.from && options.from > sorted[0]! ? options.from : sorted[0]!;
    const end = options.to && options.to < sorted.at(-1)! ? options.to : sorted.at(-1)!;
    if (daysBetween(start, end) > MAX_GAP_SCAN_DAYS) start = addDays(end, -MAX_GAP_SCAN_DAYS);
    for (let date = start; date <= end; date = addDays(date, 1)) {
      if (dates.has(date)) continue;
      let weeks = 0;
      for (let week = 1; week <= 4; week++) if (dates.has(addDays(date, -7 * week))) weeks++;
      if (weeks >= USUAL_WEEKS) possibleGaps.push({ locationId, businessDate: date });
    }
  }

  return {
    sources: sources.map(source => ({
      id: source.id, kind: source.kind, label: source.label, status: source.status,
      lastSuccessAt: source.last_success_at === null ? null : isoSeconds(source.last_success_at),
    })),
    ranges,
    possibleGaps,
  };
}

const LINEAGE_TABLES: ReadonlySet<string> = new Set(CANONICAL_TABLES);

/** Where one row came from: its source, the run that last wrote it, and its file and row. */
export function readLineage(sql: SqlStorage, table: LineageTable, id: number): RowLineage {
  if (!LINEAGE_TABLES.has(table)) {
    throw new Error(`${table} rows are computed from other rows or describe sources; trace the rows they summarize.`);
  }
  if (!Number.isSafeInteger(id)) throw new Error("id must be an integer row id.");
  const row = sql.exec<{ source_id: number; source_record_id: string; run_id: number; mapping_version: string }>(
    `SELECT source_id, source_record_id, run_id, mapping_version FROM store_${table as CanonicalTable} WHERE id = ?`, id,
  ).toArray()[0];
  if (!row) throw new Error(`There is no ${table} row ${id}.`);
  const source = sql.exec<{ id: number; kind: SourceKind; label: string }>(
    "SELECT id, kind, label FROM store_sources WHERE id = ?", row.source_id).one();
  const run = sql.exec<{ id: number; kind: RunKind; finished_at: number | null }>(
    "SELECT id, kind, finished_at FROM runs WHERE id = ?", row.run_id).toArray()[0];
  const origin = sql.exec<{ file_name: string | null; row_index: number }>(`
    SELECT o.file_name, r.row_index FROM row_origins r JOIN raw_objects o ON o.id = r.raw_object_id
    WHERE r.table_name = ? AND r.row_id = ?`, table, id).toArray()[0];
  return {
    table,
    id,
    source,
    sourceRecordId: row.source_record_id,
    run: {
      id: row.run_id,
      kind: run?.kind ?? "import",
      finishedAt: run?.finished_at == null ? null : isoSeconds(run.finished_at),
    },
    mappingVersion: row.mapping_version,
    ...(origin?.file_name ? { file: { name: origin.file_name, row: origin.row_index } } : {}),
  };
}

/** The date `days` after `date` (both "YYYY-MM-DD"; negative goes back). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
