import { Banner, Button, LayerCard, Link, Loader, Table, Text } from "@cloudflare/kumo";
import { Rows, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type {
  BrowseCatalog,
  ImportListEntry,
  RetailAppClient,
  RetailOverview,
  RunSummary,
} from "../../src/app-api-types";
import { errorMessage, formatCount, formatDate, formatDateTime } from "../format";
import type { DataAppHost } from "../host";
import type { BrowseTarget } from "../navigation";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS } from "../runs/runLabels";
import DatasetStatus from "./DatasetStatus";
import { uploadCsv } from "./uploadCsv";

export type HomeApi = Pick<RetailAppClient, "getOverview" | "getBrowseCatalog" | "listRuns" | "listImports">;

export type HomeProps = {
  api: HomeApi;
  host: Pick<DataAppHost, "pickTenantFiles">;
  onOpenImport: (importId: number) => void;
  onOpenRun: (runId: number) => void;
  onBrowse: (target: BrowseTarget) => void;
  onOpenSources: () => void;
};

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | {
      state: "loaded";
      overview: RetailOverview;
      catalog: BrowseCatalog;
      runs: RunSummary[];
      staged: ImportListEntry[];
    };

/**
 * The Data home (research R10): the way in for a dataset with nothing in it, or what it holds and
 * the latest runs, then the dataset's storage and sources.
 */
const HomePage = ({ api, ...actions }: HomeProps) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let current = true;
    Promise.all([api.getOverview(), api.getBrowseCatalog(), api.listRuns({ limit: 5 }), api.listImports()]).then(
      ([overview, catalog, runs, imports]) =>
        current &&
        setLoad({
          state: "loaded",
          overview,
          catalog,
          runs: runs.items,
          staged: imports.filter((entry) => entry.status === "staged"),
        }),
      (error: unknown) => current && setLoad({ state: "failed", message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [api]);

  return (
    <div className="flex flex-col gap-6">
      {load.state === "loading" && (
        <div className="flex justify-center p-12" role="status" aria-label="Loading the data overview">
          <Loader size="lg" />
        </div>
      )}
      {load.state === "failed" && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="The data overview could not be loaded"
          description={load.message}
        />
      )}
      {load.state === "loaded" && (
        <Home
          {...actions}
          overview={load.overview}
          catalog={load.catalog}
          runs={load.runs}
          staged={load.staged}
        />
      )}
    </div>
  );
};

const Home = ({
  host,
  overview,
  catalog,
  runs,
  staged,
  onOpenImport,
  onOpenRun,
  onBrowse,
  onOpenSources,
}: Omit<HomeProps, "api"> & {
  overview: RetailOverview;
  catalog: BrowseCatalog;
  runs: RunSummary[];
  staged: ImportListEntry[];
}) => {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const orders = catalog.tables.find((table) => table.name === "orders")?.rows ?? 0;
  const empty = orders === 0 && staged.length === 0;

  const upload = async () => {
    setUploading(true);
    setUploadError(null);
    try {
      const picked = await uploadCsv(host, overview.sources);
      if (picked) onOpenImport(picked.importId);
    } catch (thrown) {
      setUploadError(errorMessage(thrown));
    } finally {
      setUploading(false);
    }
  };

  const uploadButton = (
    <Button variant="primary" icon={<UploadSimple />} loading={uploading} onClick={() => void upload()}>
      Upload a CSV
    </Button>
  );

  return (
    <>
      {uploadError !== null && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="The files could not be imported"
          description={uploadError}
        />
      )}
      {empty ? (
        <section aria-labelledby="home-start-heading" className="flex flex-col items-start gap-3">
          <Text variant="heading" size="lg" as="h2" id="home-start-heading">
            Get your sales data in
          </Text>
          <Text>
            Upload a CSV export from your point-of-sale system with one row per order or one row per item
            sold. Toast, Square and Shopify exports are recognised.
          </Text>
          <div className="flex flex-wrap items-center gap-4">
            {uploadButton}
            <Link render={<button type="button" onClick={onOpenSources} />}>or connect Square or Stripe</Link>
          </div>
        </section>
      ) : (
        <>
          {staged.length > 0 && (
            <section aria-labelledby="home-staged-heading" className="flex flex-col gap-3">
              <Text variant="heading" as="h2" id="home-staged-heading">
                Waiting for a mapping
              </Text>
              <ul className="flex flex-col gap-2">
                {staged.map((entry) => {
                  const files = entry.fileNames.join(", ");
                  return (
                    <li key={entry.id}>
                      <LayerCard className="flex flex-wrap items-center justify-between gap-3 p-3">
                        <div className="flex flex-col">
                          <Text bold>{files}</Text>
                          <Text variant="secondary" size="sm">
                            Into {entry.sourceLabel} · kept until {formatDateTime(entry.expiresAt)}
                          </Text>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Continue the import of ${files}`}
                          onClick={() => onOpenImport(entry.id)}
                        >
                          Continue
                        </Button>
                      </LayerCard>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <section aria-labelledby="home-summary-heading" className="flex flex-col gap-3">
            <Text variant="heading" size="lg" as="h2" id="home-summary-heading">
              Your data
            </Text>
            <Text>
              {catalog.dateRange === null
                ? "No sales yet."
                : `Sales from ${formatDate(catalog.dateRange.from)} to ${formatDate(catalog.dateRange.to)}${
                    catalog.completeThrough !== null && catalog.completeThrough < catalog.dateRange.to
                      ? `, complete through ${formatDate(catalog.completeThrough)}`
                      : ""
                  }.`}
            </Text>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {catalog.tables.map((table) => (
                <li key={table.name}>
                  <LayerCard className="flex h-full flex-col items-start gap-1 p-3">
                    <Text bold>{table.label}</Text>
                    <Text variant="secondary">
                      {table.rows === 0 ? "No rows yet" : `${formatCount(table.rows)} ${table.rows === 1 ? "row" : "rows"}`}
                    </Text>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Browse ${table.label}`}
                      onClick={() => onBrowse({ table: table.name })}
                    >
                      Browse
                    </Button>
                  </LayerCard>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              {uploadButton}
              <Button variant="secondary" icon={<Rows />} onClick={() => onBrowse({ table: "orders" })}>
                Browse data
              </Button>
            </div>
          </section>
          <RecentRuns runs={runs} onOpenRun={onOpenRun} onBrowse={onBrowse} />
        </>
      )}
      <DatasetStatus overview={overview} />
    </>
  );
};

const RecentRuns = ({
  runs,
  onOpenRun,
  onBrowse,
}: {
  runs: RunSummary[];
  onOpenRun: (runId: number) => void;
  onBrowse: (target: BrowseTarget) => void;
}) => (
  <section aria-labelledby="home-runs-heading" className="flex flex-col gap-3">
    <Text variant="heading" as="h2" id="home-runs-heading">
      Recent runs
    </Text>
    {runs.length === 0 ? (
      <Text variant="secondary">Nothing has run yet.</Text>
    ) : (
      <LayerCard className="overflow-x-auto p-0">
        <Table>
          <caption className="sr-only">The five most recent runs</caption>
          <Table.Header>
            <Table.Row>
              <Table.Head>Run</Table.Head>
              <Table.Head>Started</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Rows written</Table.Head>
              <Table.Head>
                <span className="sr-only">Actions</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {runs.map((run) => {
              const kind = RUN_KIND_LABELS[run.kind];
              let written = 0;
              for (const counts of Object.values(run.counts)) written += counts?.written ?? 0;
              return (
                <Table.Row key={run.id}>
                  <Table.Head>
                    {kind}: {run.files.length > 0 ? run.files.map((file) => file.name).join(", ") : run.sourceLabel}
                  </Table.Head>
                  <Table.Cell>{formatDateTime(run.startedAt)}</Table.Cell>
                  <Table.Cell>{RUN_STATUS_LABELS[run.status]}</Table.Cell>
                  <Table.Cell>{formatCount(written)}</Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Report of ${kind.toLowerCase()} ${run.id}`}
                        onClick={() => onOpenRun(run.id)}
                      >
                        Report
                      </Button>
                      {run.kind === "import" && run.status === "succeeded" && (
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`View rows of import ${run.id}`}
                          onClick={() => onBrowse({ table: "orders", runId: run.id })}
                        >
                          View rows
                        </Button>
                      )}
                    </div>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </LayerCard>
    )}
  </section>
);

export default HomePage;
