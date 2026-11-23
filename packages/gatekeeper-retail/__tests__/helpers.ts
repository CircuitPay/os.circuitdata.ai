// Shared fixtures for the workerd suite: fresh datasets, ingest runs, and canonical records.

import { env, runInDurableObject } from "cloudflare:test";
import { datasetObjectName, type RetailDataset } from "../src/dataset/dataset-do.js";
import type {
  IngestBatch, IngestResult, LineItemRecord, LocationRecord, OrderRecord, RunKind, TransactionRecord,
} from "../src/dataset/ingest.js";
import type { RetailAccountProps } from "../src/vendor.js";

/** The sharing domain every test dataset lives in. */
export const DOMAIN = "test";

/** A new, empty dataset: its account props and its Durable Object. */
export function newDataset(): { props: RetailAccountProps; dataset: DurableObjectStub<RetailDataset> } {
  const props = { sharingDomain: DOMAIN, datasetId: crypto.randomUUID() };
  return { props, dataset: env.RETAIL_DATASET.getByName(datasetObjectName(DOMAIN, props.datasetId)) };
}

/** Creates a source of `kind`. */
export function createSource(
  dataset: DurableObjectStub<RetailDataset>, datasetId: string, label = "Front counter", kind: "csv" | "square" = "csv",
): Promise<number> {
  return dataset.createSource(datasetId, { kind, label, createdBy: "member-1" });
}

/** Ingests one batch as one complete run of `kind` from `sourceId`. */
export async function ingestRun(
  dataset: DurableObjectStub<RetailDataset>,
  datasetId: string,
  sourceId: number,
  batch: IngestBatch,
  kind: RunKind = "import",
  mappingVersion = "test-v1",
): Promise<{ runId: number; result: IngestResult }> {
  const runId = await dataset.startRun(datasetId, { sourceId, kind, mappingVersion, startedBy: "member-1" });
  const result = await dataset.ingestBatch(datasetId, runId, batch);
  await dataset.finishRun(datasetId, runId, "succeeded");
  return { runId, result };
}

/** Rows of an internal query, run inside the dataset object. */
export function inspect<T extends Record<string, SqlStorageValue>>(
  dataset: DurableObjectStub<RetailDataset>, sql: string, ...bindings: SqlStorageValue[]
): Promise<T[]> {
  return runInDurableObject(dataset, (_instance, state) => state.storage.sql.exec<T>(sql, ...bindings).toArray());
}

/** Epoch seconds of an ISO 8601 instant. */
export function at(iso: string): number {
  return Date.parse(iso) / 1000;
}

export function location(overrides: Partial<LocationRecord> = {}): LocationRecord {
  return {
    sourceRecordId: "loc-1", name: "Main Street", kind: "store", timezone: "America/New_York",
    currency: "USD", ...overrides,
  };
}

export function order(overrides: Partial<OrderRecord> & Pick<OrderRecord, "sourceRecordId">): OrderRecord {
  return {
    locationRef: "loc-1", status: "completed", channel: "in_store", currency: "USD",
    closedAt: at("2026-10-05T16:00:00Z"), totalAmount: 0, ...overrides,
  };
}

export function line(overrides: Partial<LineItemRecord> & Pick<LineItemRecord, "sourceRecordId" | "orderRef">): LineItemRecord {
  return { name: "Latte", quantityE4: 10_000, unitPriceAmount: 500, ...overrides };
}

export function payment(overrides: Partial<TransactionRecord> & Pick<TransactionRecord, "sourceRecordId">): TransactionRecord {
  return {
    kind: "payment", tender: "card", amount: 0, currency: "USD", occurredAt: at("2026-10-05T16:00:00Z"),
    ...overrides,
  };
}
