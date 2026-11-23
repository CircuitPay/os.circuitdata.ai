import type { RunKind, RunStatus, RunSummary } from "../../src/app-api-types";

export const RUN_KIND_LABELS: Record<RunKind, string> = {
  backfill: "History load",
  sync: "Sync",
  import: "Import",
  rebuild: "Rebuild",
  undo: "Undo",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  staged: "Waiting to start",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  undone: "Undone",
  expired: "Expired",
};

/** Statuses the Data area polls `getRun` for, every 2 s. */
export function isRunActive(run: RunSummary): boolean {
  return run.status === "running" || run.status === "staged";
}

export function rejectedRows(run: Pick<RunSummary, "counts">): number {
  let rejected = 0;
  for (const counts of Object.values(run.counts)) rejected += counts?.rejected ?? 0;
  return rejected;
}
