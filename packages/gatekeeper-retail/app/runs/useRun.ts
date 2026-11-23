import { useCallback, useEffect, useState } from "react";
import type { RetailAppClient, RunSummary } from "../../src/app-api-types";
import { errorMessage } from "../format";
import { isRunActive } from "./runLabels";

export const RUN_POLL_MS = 2_000;

export type RunLoad =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; run: RunSummary };

/**
 * Reads a run and re-reads it every 2 s while it is active. `onSettled` is called each time a read
 * finds the run no longer active (it must be stable). A null `runId` reads nothing.
 */
export function useRun(
  api: Pick<RetailAppClient, "getRun">,
  runId: number | null,
  onSettled?: (run: RunSummary) => void,
): { load: RunLoad; refresh: () => void } {
  const [load, setLoad] = useState<RunLoad>(runId === null ? { state: "idle" } : { state: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (runId === null) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      api.getRun(runId).then(
        (run) => {
          if (!current) return;
          setLoad({ state: "loaded", run });
          if (isRunActive(run)) timer = setTimeout(read, RUN_POLL_MS);
          else onSettled?.(run);
        },
        (error: unknown) => {
          if (current) setLoad({ state: "failed", message: errorMessage(error) });
        },
      );
    };
    read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, runId, generation, onSettled]);

  // Stable, so it can be passed as another run's `onSettled`.
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { load, refresh };
}
