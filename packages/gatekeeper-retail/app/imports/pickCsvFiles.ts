import type { ImportTarget } from "../../src/app-api-types";
import type { DataAppHost } from "../host";

/** Asks the host for CSV files from the tenant's Files and stages them as one import. */
export function pickCsvFiles(
  host: Pick<DataAppHost, "pickTenantFiles">,
  target: ImportTarget,
): Promise<{ importId: number } | null> {
  return host.pickTenantFiles({ accept: [".csv", "text/csv"], multiple: true, target });
}
