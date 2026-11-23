// The `RETAIL_DATA` session handed to agents and gadgets. Every read is computed by the dataset
// Durable Object and authorized as an observation after the read and before the return (research
// R6). Observation text names views, row counts and the SQL, never row values. The one write, a
// suggested import mapping, goes through the approval queue and is simulated until applied
// (research R7).

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ObservationGate } from "@gadgets/gatekeeper-kit/observers";
import type { MappingDocument } from "./app-api-types.js";
import type {
  RetailCoverage, RetailData, RetailDatasetDescription, RetailMapping, RetailMetricName, RetailMetricQuery,
  RetailMetricResult, RetailPendingImport, RetailQueryResult, RetailRowLineage, RetailTable,
} from "./types.js";
import type { RetailDataset } from "./dataset/dataset-do.js";

/** The `RetailData` methods this session serves. */
export type RetailDataApi = Pick<
  RetailData, "describe" | "run" | "metric" | "coverage" | "lineage" | "pendingImports" | "proposeImportMapping"
>;

/** Mapping suggestions submitted through the approval queue and not yet applied or rejected. */
export interface MappingSuggestions {
  /** The latest pending suggestion per import (the simulation of `proposeImportMapping`). */
  pending(): { importId: number; mapping: MappingDocument }[];
  /** Submits a suggestion for approval; it replaces any earlier one for the same import. */
  submit(importId: number, mapping: MappingDocument): Promise<void>;
}

/** What a session needs: the dataset, the gate its reads are authorized through, and its actions. */
export type RetailSessionDependencies = {
  dataset: DurableObjectStub<RetailDataset>;
  datasetId: string;
  observations: ObservationGate;
  suggestions: MappingSuggestions;
};

// The binding is one ACL unit (observer strategy B), so every read discloses the admission baseline.
const BASELINE = { kind: "baseline" } as const;

@validateRpc()
export class RetailDataSession extends RpcTarget implements RetailDataApi {
  readonly #dataset: DurableObjectStub<RetailDataset>;
  readonly #datasetId: string;
  readonly #observations: ObservationGate;
  readonly #suggestions: MappingSuggestions;

  constructor(dependencies: RetailSessionDependencies) {
    super();
    this.#dataset = dependencies.dataset;
    this.#datasetId = dependencies.datasetId;
    this.#observations = dependencies.observations;
    this.#suggestions = dependencies.suggestions;
  }

  /** Tables, columns, metric definitions, date coverage and limits. */
  async describe(): Promise<RetailDatasetDescription> {
    const description = await this.#dataset.describe(this.#datasetId);
    await this.#observations.authorize({
      title: "Described retail dataset",
      description: `Read the retail dataset's ${description.tables.length} tables, ` +
        `${description.metrics.length} metric definitions and date coverage.`,
    }, BASELINE);
    return description;
  }

  /** Runs one guarded read-only query. */
  async run(
    sql: string,
    params?: (string | number | boolean | null)[],
    options?: { maxRows?: number; maxBytes?: number },
  ): Promise<RetailQueryResult> {
    const { views, ...result } = await this.#dataset.query(this.#datasetId, sql, params, options);
    const tables = views.length ? views.join(", ") : "no tables";
    await this.#observations.authorize({
      title: `Queried retail data: ${tables}`.slice(0, 120),
      description: `Ran a read-only SQL query over ${tables} and received ${result.rows.length} ` +
        `row${result.rows.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}.\n\n` +
        fenced(sql),
    }, BASELINE);
    return result;
  }

  /** Computes one standard metric. */
  async metric(name: RetailMetricName, query: RetailMetricQuery): Promise<RetailMetricResult> {
    const result = await this.#dataset.metric(this.#datasetId, name, query);
    const groups = query.groupBy?.length ? ` by ${query.groupBy.join(", ")}` : "";
    await this.#observations.authorize({
      title: `Computed ${name} for ${query.from} to ${query.to}`,
      description: `Computed the standard metric ${name} for business dates ${query.from} to ` +
        `${query.to}${groups}${query.locationIds?.length ? ` at ${query.locationIds.length} locations` : ""}` +
        `${query.currency ? ` in ${query.currency}` : ""}: ${result.rows.length} rows.`,
    }, BASELINE);
    return result;
  }

  /** Which sources cover which dates and locations, and which days look like missing data. */
  async coverage(options?: { from?: string; to?: string; locationIds?: number[] }): Promise<RetailCoverage> {
    const coverage = await this.#dataset.coverage(this.#datasetId, options);
    const range = options?.from || options?.to ? ` for ${options.from ?? "the start"} to ${options.to ?? "today"}` : "";
    await this.#observations.authorize({
      title: "Read retail data coverage",
      description: `Read which of ${coverage.sources.length} sources cover which business dates${range}: ` +
        `${coverage.ranges.length} covered ranges and ${coverage.possibleGaps.length} possible gaps.`,
    }, BASELINE);
    return coverage;
  }

  /** Where one row came from. */
  async lineage(table: RetailTable, id: number): Promise<RetailRowLineage> {
    const lineage = await this.#dataset.lineage(this.#datasetId, table, id);
    await this.#observations.authorize({
      title: `Traced ${table} row ${id}`,
      description: `Read where ${table} row ${id} came from: source ${lineage.source.id}, run ${lineage.run.id}` +
        `${lineage.file ? `, a file row` : ""}.`,
    }, BASELINE);
    return lineage;
  }

  /** CSV imports waiting for a mapping, with masked samples and the current (or suggested) mapping. */
  async pendingImports(): Promise<RetailPendingImport[]> {
    const imports = await this.#dataset.pendingImports(this.#datasetId, this.#suggestions.pending());
    const rows = imports.reduce((sum, entry) => sum + entry.samples.reduce((n, sample) => n + sample.rows.length, 0), 0);
    await this.#observations.authorize({
      title: `Read ${imports.length} pending CSV import${imports.length === 1 ? "" : "s"}`,
      description: `Read the columns of ${imports.length} uploaded CSV import${imports.length === 1 ? "" : "s"} ` +
        `waiting for a mapping and ${rows} sample row${rows === 1 ? "" : "s"} (personal data masked).`,
    }, BASELINE);
    return imports;
  }

  /**
   * Suggests a mapping for a pending import. It is checked now and stored as a draft once the
   * action is applied; nothing is imported until a member confirms it after a preview.
   */
  async proposeImportMapping(importId: number, mapping: RetailMapping): Promise<void> {
    const document = await this.#dataset.checkAgentMapping(this.#datasetId, importId, mapping);
    await this.#suggestions.submit(importId, document);
  }
}

/** A Markdown code block that the SQL text cannot close early. */
function fenced(sql: string): string {
  const longest = Math.max(2, ...Array.from(sql.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}sql\n${sql}\n${fence}`;
}
