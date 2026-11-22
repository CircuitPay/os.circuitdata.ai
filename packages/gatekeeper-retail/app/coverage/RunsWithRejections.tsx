import { Banner, Button, Loader, Text } from "@cloudflare/kumo";
import { CaretDown, CaretRight, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { RetailAppClient, RunSummary } from "../../src/app-api-types";
import { errorMessage, formatCount, formatDateTime } from "../format";
import RunRejections from "../runs/RunRejections";
import { RUN_KIND_LABELS, rejectedRows } from "../runs/runLabels";

type Load = { state: "loading" } | { state: "failed"; message: string } | { state: "loaded"; runs: RunSummary[] };

/** Recent runs that rejected rows, each opening onto its rejected rows (US4). */
const RunsWithRejections = ({ api }: { api: Pick<RetailAppClient, "listRuns" | "listRejections"> }) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [openRunId, setOpenRunId] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    api.listRuns({ limit: 50 }).then(
      (page) => current && setLoad({ state: "loaded", runs: page.items.filter((run) => rejectedRows(run) > 0) }),
      (error: unknown) => current && setLoad({ state: "failed", message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [api]);

  return (
    <section aria-labelledby="coverage-rejections-heading" className="flex flex-col gap-3">
      <Text variant="heading" as="h3" id="coverage-rejections-heading">
        Runs with rejected rows
      </Text>
      {load.state === "loading" && (
        <div className="flex justify-center p-6" role="status" aria-label="Loading runs">
          <Loader />
        </div>
      )}
      {load.state === "failed" && (
        <Banner variant="error" icon={<WarningCircle />} title="The runs could not be loaded" description={load.message} />
      )}
      {load.state === "loaded" &&
        (load.runs.length === 0 ? (
          <Text variant="secondary">No recent run rejected any rows.</Text>
        ) : (
          <ul className="flex flex-col gap-3">
            {load.runs.map((run) => {
              const open = openRunId === run.id;
              const panelId = `run-${run.id}-rejections`;
              const rejected = rejectedRows(run);
              return (
                <li key={run.id} className="flex flex-col gap-2">
                  <Button
                    variant="ghost"
                    className="self-start"
                    icon={open ? <CaretDown /> : <CaretRight />}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpenRunId(open ? null : run.id)}
                  >
                    {RUN_KIND_LABELS[run.kind]} into {run.sourceLabel}, {formatDateTime(run.startedAt)}:{" "}
                    {formatCount(rejected)} rejected {rejected === 1 ? "row" : "rows"}
                  </Button>
                  {open && (
                    <div id={panelId}>
                      <RunRejections api={api} runId={run.id} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
    </section>
  );
};

export default RunsWithRejections;
