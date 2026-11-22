import type { SourceKind, SourceStatus } from "../src/app-api-types";

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  square: "Square",
  stripe: "Stripe",
  toast: "Toast export",
  csv: "CSV import",
};

export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  connecting: "Connecting",
  backfilling: "Loading history",
  active: "Up to date",
  syncing: "Syncing",
  retrying: "Retrying",
  needs_reconnect: "Needs reconnect",
  disconnected: "Disconnected",
  imported: "Imported",
};
