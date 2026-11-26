import { Badge, Banner, Button, Loader, Text } from "@cloudflare/kumo";
import { ArrowLeft, Rows, Warning, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { RetailAppClient, RunSummary } from "../../src/app-api-types";
import ConfirmDialog from "../components/ConfirmDialog";
import { focusOnMount } from "../focus";
import { errorMessage, formatBytes, formatDateTime } from "../format";
import type { BrowseTarget } from "../navigation";
import RunCountsTable from "../runs/RunCountsTable";
import RunProgress from "../runs/RunProgress";
import RunRejections from "../runs/RunRejections";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS, isRunActive, rejectedRows } from "../runs/runLabels";
import { useRun } from "../runs/useRun";
import { warningMessages } from "./warnings";

export type RunReportApi = Pick<RetailAppClient, "getRun" | "listRejections" | "cancelRun" | "undoImport">;

/** A run's report: progress while it runs, then counts, warnings, rejections and undo (FR-011). */
const RunReport = ({
  api,
  runId,
  onBack,
  onBrowse,
}: {
  api: RunReportApi;
  runId: number;
  onBack: () => void;
  onBrowse: (target: BrowseTarget) => void;
}) => {
  const { load, refresh } = useRun(api, runId);
  const [undoRunId, setUndoRunId] = useState<number | null>(null);
  // When the undo run settles, read this run again so it shows "Undone".
  const undo = useRun(api, undoRunId, refresh);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    setError(null);
    try {
      await api.cancelRun(runId);
      refresh();
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          Imports
        </Button>
      </div>
      {load.state === "loading" && (
        <div className="flex justify-center p-12" role="status" aria-label="Loading the report">
          <Loader size="lg" />
        </div>
      )}
      {load.state === "failed" && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="The report could not be loaded"
          description={load.message}
        />
      )}
      {load.state === "loaded" && (
        <Report
          api={api}
          run={load.run}
          error={error}
          undo={undo.load.state === "loaded" ? undo.load.run : null}
          onCancel={() => void cancel()}
          onBrowse={onBrowse}
          onUndo={async () => {
            setUndoRunId((await api.undoImport(runId)).undoRunId);
          }}
        />
      )}
    </div>
  );
};

const Report = ({
  api,
  run,
  error,
  undo,
  onCancel,
  onBrowse,
  onUndo,
}: {
  api: RunReportApi;
  run: RunSummary;
  error: string | null;
  undo: RunSummary | null;
  onCancel: () => void;
  onBrowse: (target: BrowseTarget) => void;
  onUndo: () => Promise<void>;
}) => {
  const active = isRunActive(run);
  const orders = run.counts.orders;
  // An import of items alone (no order rows written) is browsed by its line items.
  const wroteOrders = (orders?.written ?? 0) + (orders?.updated ?? 0) > 0;
  const warnings = warningMessages(run.warnings);
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Text variant="heading" size="lg" as="h2" tabIndex={-1} ref={focusOnMount}>
            {RUN_KIND_LABELS[run.kind]} into {run.sourceLabel}
          </Text>
          <Text variant="secondary">
            Started {formatDateTime(run.startedAt)}
            {run.finishedAt ? ` · finished ${formatDateTime(run.finishedAt)}` : ""} · mapping{" "}
            {run.mappingVersion}
          </Text>
        </div>
        <Badge variant={run.status === "failed" ? "red" : "neutral"}>
          <span role="status">{RUN_STATUS_LABELS[run.status]}</span>
        </Badge>
      </header>
      {error !== null && (
        <Banner variant="error" icon={<WarningCircle />} title="The run could not be cancelled" description={error} />
      )}
      {run.error !== null && (
        <Banner variant="error" icon={<WarningCircle />} title="The run failed" description={run.error} />
      )}
      {active && (
        <div className="flex flex-col gap-3">
          {run.progress ? (
            <RunProgress label={`Progress of ${RUN_KIND_LABELS[run.kind].toLowerCase()} ${run.id}`} progress={run.progress} />
          ) : (
            <Text variant="secondary">Starting…</Text>
          )}
          <div>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {undo !== null && isRunActive(undo) && (
        <div className="flex flex-col gap-2">
          <Text bold>Undoing</Text>
          {undo.progress && <RunProgress label={`Progress of undo ${undo.id}`} progress={undo.progress} />}
        </div>
      )}
      {undo !== null && undo.status === "failed" && (
        <Banner variant="error" icon={<WarningCircle />} title="The undo failed" description={undo.error ?? ""} />
      )}
      <section aria-labelledby="counts-heading" className="flex flex-col gap-3">
        <Text variant="heading" as="h3" id="counts-heading">
          Rows
        </Text>
        <RunCountsTable caption="Rows per table" counts={run.counts} />
        {run.kind === "import" && run.status === "succeeded" && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              icon={<Rows />}
              aria-describedby="imported-rows-note"
              onClick={() => onBrowse({ table: wroteOrders ? "orders" : "line_items", runId: run.id })}
            >
              View the imported rows
            </Button>
            <Text variant="secondary" id="imported-rows-note">
              Rows last written by this import.
            </Text>
          </div>
        )}
      </section>
      {warnings.length > 0 && (
        <Banner
          variant="alert"
          icon={<Warning />}
          title="Warnings"
          description={
            <ul className="list-disc pl-5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          }
        />
      )}
      {run.files.length > 0 && (
        <section aria-labelledby="files-heading" className="flex flex-col gap-2">
          <Text variant="heading" as="h3" id="files-heading">
            Files
          </Text>
          <ul className="list-disc pl-5">
            {run.files.map((file) => (
              <li key={file.name}>
                {file.name}
                {file.role ? ` (${file.role})` : ""} · {formatBytes(file.bytes)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {rejectedRows(run) > 0 && (
        <section aria-labelledby="rejections-heading" className="flex flex-col gap-3">
          <Text variant="heading" as="h3" id="rejections-heading">
            Rejected rows
          </Text>
          <RunRejections api={api} runId={run.id} />
        </section>
      )}
      {run.kind === "import" && !active && run.status !== "undone" && (
        <section aria-labelledby="undo-heading" className="flex flex-col gap-2">
          <Text variant="heading" as="h3" id="undo-heading">
            Undo
          </Text>
          {run.undo.possible ? (
            <div>
              <ConfirmDialog
                triggerLabel="Undo import"
                title="Undo this import?"
                description="Every row it wrote or changed returns to its earlier state, and the totals are recomputed."
                confirmLabel="Undo import"
                disabled={undo !== null && isRunActive(undo)}
                onConfirm={onUndo}
              />
            </div>
          ) : (
            <Text variant="secondary">{run.undo.reason ?? "This import cannot be undone."}</Text>
          )}
        </section>
      )}
    </>
  );
};

export default RunReport;
