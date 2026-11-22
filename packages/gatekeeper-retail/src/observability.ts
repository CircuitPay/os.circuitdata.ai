import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** The vendor id the Workshop derives from the `GATEKEEPER_RETAIL` binding. */
export const VENDOR_ID = "retail";

/**
 * Observability fields emitted by the retail gatekeeper. Ids, counts, durations and reason codes
 * only: never SQL text or parameters, row values, tokens, headers or bodies.
 */
export type RetailObservabilityFields = {
  vendorId: string;
  datasetId: string;
  operation: string;
  /** Public view names a query read. */
  views: string;
  metric: string;
  rowCount: number;
  durationMs: number;
  refusalReason: string;
  runId: number;
  sourceId: number;
  written: number;
  updated: number;
  skipped: number;
  rejected: number;
  dirtyDays: number;
  sizeBytes: number;
  capBytes: number;
  deletedObjects: number;
  /** Connector events: the provider kind (`square`, `stripe`). */
  provider: string;
};

/** Ambient observability fields for one retail operation. */
export const obsContext = createObservabilityContext<RetailObservabilityFields>();

/** Creates the module logger of one retail component (`gatekeeper.retail.<part>`). */
export function retailLogger(part?: string) {
  return obsContext.createLogger({
    component: part ? `gatekeeper.retail.${part}` : "gatekeeper.retail",
    vendorId: VENDOR_ID,
  });
}
