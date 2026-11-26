import type { ImportTarget, SourceSummary } from "../../src/app-api-types";
import type { DataAppHost } from "../host";
import { pickCsvFiles } from "../imports/pickCsvFiles";

/** The source a first upload creates. */
export const NEW_UPLOAD_SOURCE = "CSV uploads";

/**
 * Where Home's one-step upload goes (research R4): the CSV source whose import last succeeded (a
 * source's last success is its newest succeeded run), else a new source.
 */
export function uploadTarget(sources: SourceSummary[]): ImportTarget {
  let newest: { id: number; at: string } | null = null;
  for (const source of sources) {
    if (source.kind !== "csv" || source.lastSuccessAt === null) continue;
    if (newest === null || source.lastSuccessAt > newest.at) newest = { id: source.id, at: source.lastSuccessAt };
  }
  return newest === null ? { newSourceLabel: NEW_UPLOAD_SOURCE } : newest.id;
}

/** Picks CSV files into the default target; null when the member cancels. */
export function uploadCsv(
  host: Pick<DataAppHost, "pickTenantFiles">,
  sources: SourceSummary[],
): Promise<{ importId: number } | null> {
  return pickCsvFiles(host, uploadTarget(sources));
}
