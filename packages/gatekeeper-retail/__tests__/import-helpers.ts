// Helpers for the CSV import suites: stage files the way the host delivers them, run the import
// loop's alarms to the end, and read the outcome.

import { runDurableObjectAlarm } from "cloudflare:test";
import type { ImportTarget, MappingDocument, RunSummary } from "../src/app-api-types.js";
import type { RetailDataset } from "../src/dataset/dataset-do.js";
import type { Member } from "../src/import/data-area.js";
import { inspect } from "./helpers.js";

export const MEMBER: Member = { memberId: "member-1", canManage: false };
export const OTHER_MEMBER: Member = { memberId: "member-2", canManage: false };
export const ADMIN: Member = { memberId: "admin-1", canManage: true };

/** A CSV file as the host delivers it. */
export function csvFile(name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return { name, size: bytes.length, contentType: "text/csv", stream: new Response(bytes).body! };
}

/** Stages files, returning the import id. */
export async function stage(
  dataset: DurableObjectStub<RetailDataset>, datasetId: string, files: { name: string; text: string }[],
  target: ImportTarget = { newSourceLabel: "Front counter" }, member: Member = MEMBER,
): Promise<number> {
  const { importId } = await dataset.stageImport(datasetId, target, files.map(file => csvFile(file.name, file.text)), member);
  return importId;
}

/**
 * Runs the import loop until no import or rebuild is running: alarms run here when they are due,
 * and otherwise this waits for the one workerd may already be running.
 */
export async function drain(dataset: DurableObjectStub<RetailDataset>): Promise<void> {
  for (let steps = 0; steps < 2_000; steps++) {
    const [{ n }] = await inspect<{ n: number }>(dataset, "SELECT COUNT(*) AS n FROM runs WHERE status = 'running'") as [{ n: number }];
    if (n === 0) return;
    if (!(await runDurableObjectAlarm(dataset))) await scheduler.wait(10);
  }
  throw new Error("The import loop did not finish.");
}

/** The message a refused call threw, or null when it succeeded. */
export function refusal(call: Promise<unknown>): Promise<string | null> {
  return call.then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
}

/**
 * Stages files, starts the import with `mapping` (default: the deterministic proposal), runs it to
 * the end and returns the finished run.
 */
export async function importFiles(
  dataset: DurableObjectStub<RetailDataset>,
  datasetId: string,
  files: { name: string; text: string }[],
  options: {
    target?: ImportTarget;
    mapping?: (proposed: MappingDocument | null) => MappingDocument;
    saveAsTemplate?: { name: string } | { templateId: number };
    member?: Member;
  } = {},
): Promise<{ importId: number; run: RunSummary }> {
  const member = options.member ?? MEMBER;
  const importId = await stage(dataset, datasetId, files, options.target, member);
  const staged = await dataset.getImport(datasetId, importId);
  const mapping = options.mapping ? options.mapping(staged.deterministicMapping) : staged.deterministicMapping;
  if (!mapping) throw new Error("No mapping was proposed.");
  const { runId } = await dataset.startImport(
    datasetId, importId, mapping, options.saveAsTemplate ? { saveAsTemplate: options.saveAsTemplate } : undefined, member);
  await drain(dataset);
  return { importId, run: await dataset.getRun(datasetId, runId, member) };
}

/** Row count of a storage table. */
export async function count(dataset: DurableObjectStub<RetailDataset>, table: string): Promise<number> {
  return (await inspect<{ n: number }>(dataset, `SELECT COUNT(*) AS n FROM store_${table}`))[0]!.n;
}
