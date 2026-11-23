import { Banner, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import type { RetailAppClient } from "../../src/app-api-types";
import RunProgress from "../runs/RunProgress";
import { RUN_STATUS_LABELS, isRunActive } from "../runs/runLabels";
import { useRun } from "../runs/useRun";

/** The rebuild runs a re-apply started (US5), each polled until it settles. */
const RebuildRuns = ({ api, runIds }: { api: Pick<RetailAppClient, "getRun">; runIds: number[] }) => {
  if (runIds.length === 0) {
    return <Text variant="secondary">No imports used this template, so there is nothing to rebuild.</Text>;
  }
  return (
    <ul className="flex flex-col gap-3" aria-label="Rebuilds">
      {runIds.map((runId) => (
        <RebuildRun key={runId} api={api} runId={runId} />
      ))}
    </ul>
  );
};

const RebuildRun = ({ api, runId }: { api: Pick<RetailAppClient, "getRun">; runId: number }) => {
  const { load } = useRun(api, runId);
  return (
    <li className="flex flex-col gap-2">
      {load.state === "failed" ? (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title={`Rebuild ${runId} could not be read`}
          description={load.message}
        />
      ) : load.state === "loaded" ? (
        <>
          <Text bold>
            Rebuild of {load.run.sourceLabel}: <span role="status">{RUN_STATUS_LABELS[load.run.status]}</span>
          </Text>
          {isRunActive(load.run) && load.run.progress && (
            <RunProgress label={`Progress of rebuild ${runId}`} progress={load.run.progress} />
          )}
          {load.run.error !== null && <Text variant="secondary">{load.run.error}</Text>}
        </>
      ) : (
        <Text variant="secondary">Rebuild {runId}: loading…</Text>
      )}
    </li>
  );
};

export default RebuildRuns;
