import { Banner, Button, Empty, LayerCard, Loader, Table, Text } from "@cloudflare/kumo";
import { FileCsv, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { ImportListEntry, RetailAppClient, RunSummary } from "../../src/app-api-types";
import { focusOnMount } from "../focus";
import { errorMessage, formatDateTime } from "../format";
import type { DataAppHost } from "../host";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS } from "../runs/runLabels";
import ImportCsvDialog from "./ImportCsvDialog";
import ImportView, { type ImportViewApi } from "./ImportView";
import RunReport, { type RunReportApi } from "./RunReport";

export type ImportsApi = ImportViewApi &
  RunReportApi &
  Pick<RetailAppClient, "getOverview" | "listImports" | "listRuns">;

// `returned`: the list was reached with Back, so its heading takes focus (not on first show, where
// focus stays on the tab).
type View =
  | { kind: "list"; returned: boolean }
  | { kind: "import"; importId: number }
  | { kind: "run"; runId: number };

/** The Imports tab: staged imports and recent runs, the import flow and run reports (US2). */
const ImportsPage = ({
  api,
  host,
}: {
  api: ImportsApi;
  host: Pick<DataAppHost, "openPrompt" | "pickTenantFiles">;
}) => {
  const [view, setView] = useState<View>({ kind: "list", returned: false });
  const showList = () => setView({ kind: "list", returned: true });
  const openImport = (importId: number) => setView({ kind: "import", importId });
  const openRun = (runId: number) => setView({ kind: "run", runId });

  if (view.kind === "import") {
    return (
      <ImportView
        key={view.importId}
        api={api}
        host={host}
        importId={view.importId}
        onBack={showList}
        onOpenImport={openImport}
        onStarted={openRun}
      />
    );
  }
  if (view.kind === "run") {
    return <RunReport key={view.runId} api={api} runId={view.runId} onBack={showList} />;
  }
  return (
    <ImportsList
      api={api}
      host={host}
      focusHeading={view.returned}
      onOpenImport={openImport}
      onOpenRun={openRun}
    />
  );
};

type Lists =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; imports: ImportListEntry[]; runs: RunSummary[] };

const ImportsList = ({
  api,
  host,
  focusHeading,
  onOpenImport,
  onOpenRun,
}: {
  api: Pick<RetailAppClient, "getOverview" | "listImports" | "listRuns">;
  host: Pick<DataAppHost, "pickTenantFiles">;
  focusHeading: boolean;
  onOpenImport: (importId: number) => void;
  onOpenRun: (runId: number) => void;
}) => {
  const [lists, setLists] = useState<Lists>({ state: "loading" });

  useEffect(() => {
    let current = true;
    Promise.all([api.listImports(), api.listRuns({ limit: 20 })]).then(
      ([imports, runs]) => current && setLists({ state: "loaded", imports, runs: runs.items }),
      (error: unknown) => current && setLists({ state: "failed", message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [api]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Text
          variant="heading"
          size="lg"
          as="h2"
          tabIndex={-1}
          ref={focusHeading ? focusOnMount : undefined}
        >
          Imports
        </Text>
        <ImportCsvDialog api={api} host={host} onStaged={onOpenImport} />
      </header>
      {lists.state === "loading" && (
        <div className="flex justify-center p-12" role="status" aria-label="Loading imports">
          <Loader size="lg" />
        </div>
      )}
      {lists.state === "failed" && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="The imports could not be loaded"
          description={lists.message}
        />
      )}
      {lists.state === "loaded" && (
        <>
          <section aria-labelledby="staged-heading" className="flex flex-col gap-3">
            <Text variant="heading" as="h3" id="staged-heading">
              Waiting for a mapping
            </Text>
            {lists.imports.length === 0 ? (
              <Empty
                icon={<FileCsv size={48} />}
                title="No pending imports"
                description="Import a CSV export from your point-of-sale system to add its sales."
              />
            ) : (
              <LayerCard className="overflow-x-auto p-0">
                <Table>
                  <caption className="sr-only">Pending imports</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Files</Table.Head>
                      <Table.Head>Source</Table.Head>
                      <Table.Head>Kept until</Table.Head>
                      <Table.Head>Agent suggestion</Table.Head>
                      <Table.Head>
                        <span className="sr-only">Actions</span>
                      </Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {lists.imports.map((entry) => {
                      const files = entry.fileNames.join(", ");
                      return (
                        <Table.Row key={entry.id}>
                          <Table.Head>{files}</Table.Head>
                          <Table.Cell>{entry.sourceLabel}</Table.Cell>
                          <Table.Cell>{formatDateTime(entry.expiresAt)}</Table.Cell>
                          <Table.Cell>{entry.hasAgentMapping ? "Ready" : "—"}</Table.Cell>
                          <Table.Cell>
                            <Button
                              variant="secondary"
                              size="sm"
                              aria-label={`Open the import of ${files}`}
                              onClick={() =>
                                entry.status === "staged" ? onOpenImport(entry.id) : onOpenRun(entry.runId)
                              }
                            >
                              Open
                            </Button>
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table>
              </LayerCard>
            )}
          </section>
          <section aria-labelledby="runs-heading" className="flex flex-col gap-3">
            <Text variant="heading" as="h3" id="runs-heading">
              Recent runs
            </Text>
            {lists.runs.length === 0 ? (
              <Text variant="secondary">Nothing has run yet.</Text>
            ) : (
              <LayerCard className="overflow-x-auto p-0">
                <Table>
                  <caption className="sr-only">Recent runs</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Started</Table.Head>
                      <Table.Head>Kind</Table.Head>
                      <Table.Head>Source</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>
                        <span className="sr-only">Actions</span>
                      </Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {lists.runs.map((run) => (
                      <Table.Row key={run.id}>
                        <Table.Head>{formatDateTime(run.startedAt)}</Table.Head>
                        <Table.Cell>{RUN_KIND_LABELS[run.kind]}</Table.Cell>
                        <Table.Cell>{run.sourceLabel}</Table.Cell>
                        <Table.Cell>{RUN_STATUS_LABELS[run.status]}</Table.Cell>
                        <Table.Cell>
                          <Button
                            variant="secondary"
                            size="sm"
                            aria-label={`Report of ${RUN_KIND_LABELS[run.kind].toLowerCase()} ${run.id}`}
                            onClick={() => onOpenRun(run.id)}
                          >
                            Report
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </LayerCard>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default ImportsPage;
