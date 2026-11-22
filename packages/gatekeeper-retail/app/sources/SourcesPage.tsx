import { Banner, Button, Empty, Loader, Select, Text } from "@cloudflare/kumo";
import { Plugs, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type {
  ConnectFlow, ProviderKind, RetailAppClient, RetailOverview, RunSummary,
} from "../../src/app-api-types";
import { errorMessage } from "../format";
import type { DataAppHost } from "../host";
import ProviderSourceCard from "./ProviderSourceCard";

/** While a source is moving, or a connect popup is open, the list is re-read this often. */
const POLL_MS = 5_000;
/** How long the page waits for a connect popup to finish. */
const CONNECT_WAIT_MS = 10 * 60_000;

const MOVING: Readonly<Record<string, true>> = { connecting: true, backfilling: true, syncing: true, retrying: true };

const isProvider = (source: { kind: string }) => source.kind === "square" || source.kind === "stripe";

const YEARS: Record<string, string> = { "1": "1 year", "2": "2 years", "3": "3 years" };

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; overview: RetailOverview; runs: RunSummary[] };

type SourcesApi = Pick<
  RetailAppClient,
  | "getOverview" | "listRuns" | "getRun" | "beginConnect" | "listProviderLocations" | "chooseLocations"
  | "setBackfillYears" | "syncNow" | "reconnect" | "disconnect"
>;

/**
 * Sources: connect Square or Stripe, choose locations, follow the history load and syncs, and
 * reconnect or disconnect. Members see the same list without the administrator's actions.
 */
const SourcesPage = ({ api, host }: { api: SourcesApi; host: Pick<DataAppHost, "openConnectPopup"> }) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  // A connect popup is open: since when, and how many provider sources there were then.
  const [connecting, setConnecting] = useState<{ since: number; sources: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    Promise.all([api.getOverview(), api.listRuns({ limit: 50 })]).then(
      ([overview, runs]) => {
        if (!current) return;
        setLoad({ state: "loaded", overview, runs: runs.items });
        const providers = overview.sources.filter(isProvider).length;
        const moving = overview.sources.some((source) => MOVING[source.status]);
        const waiting = connecting !== null && providers <= connecting.sources && Date.now() - connecting.since < CONNECT_WAIT_MS;
        if (connecting !== null && !waiting) setConnecting(null);
        if (moving || waiting) timer = setTimeout(() => setGeneration((value) => value + 1), POLL_MS);
      },
      (thrown: unknown) => current && setLoad({ state: "failed", message: errorMessage(thrown) }),
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, generation, connecting]);

  /** Starts a provider flow and hands it to the Workshop, which opens the consent popup. */
  const connect = async (start: () => Promise<ConnectFlow>) => {
    setError(null);
    try {
      await host.openConnectPopup(await start());
      setConnecting({
        since: Date.now(),
        sources: load.state === "loaded" ? load.overview.sources.filter(isProvider).length : 0,
      });
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  };

  const changeYears = async (years: number) => {
    setError(null);
    try {
      await api.setBackfillYears(years);
      refresh();
    } catch (thrown) {
      setError(errorMessage(thrown));
    }
  };

  if (load.state === "loading") {
    return (
      <div className="flex justify-center p-12" role="status" aria-label="Loading sources">
        <Loader size="lg" />
      </div>
    );
  }
  if (load.state === "failed") {
    return (
      <Banner variant="error" icon={<WarningCircle />} title="The sources could not be loaded" description={load.message} />
    );
  }

  const { overview, runs } = load;
  const providers = overview.sources.filter(isProvider);
  const failures = new Map(overview.failuresNeedingAdmin.map((failure) => [failure.sourceId, failure]));
  const activeRun = (sourceId: number) =>
    runs.find((run) => run.sourceId === sourceId && run.status === "running" && (run.kind === "backfill" || run.kind === "sync"))
      ?.id ?? null;
  const providerButton = (provider: ProviderKind, label: string) => (
    <Button variant="primary" icon={<Plugs />} onClick={() => void connect(() => api.beginConnect(provider))}>
      {label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="connect-heading" className="flex flex-col gap-3">
        <Text variant="heading" as="h2" id="connect-heading">
          Connected systems
        </Text>
        {overview.canManage ? (
          <div className="flex flex-wrap items-end gap-3">
            {overview.connectableProviders.includes("square") && providerButton("square", "Connect Square")}
            {overview.connectableProviders.includes("stripe") && providerButton("stripe", "Connect Stripe")}
            <Select
              label="History to load"
              items={YEARS}
              value={String(overview.settings.backfillYears)}
              onValueChange={(value) => void changeYears(Number(value))}
            />
          </div>
        ) : (
          <Text variant="secondary">Only organization administrators can connect or disconnect systems.</Text>
        )}
        {connecting !== null && (
          <Text variant="secondary" size="sm" role="status">
            Finish signing in to the provider in the window that opened. The new source appears here.
          </Text>
        )}
        {error !== null && <Banner variant="error" icon={<WarningCircle />} title="That did not work" description={error} />}
      </section>
      <section aria-label="Connected sources" className="flex flex-col gap-3">
        {providers.length === 0 ? (
          <Empty
            icon={<Plugs size={48} />}
            title="Nothing connected yet"
            description="Connect Square or Stripe to load sales automatically, or import CSV exports."
          />
        ) : (
          providers.map((source) => (
            <ProviderSourceCard
              key={source.id}
              api={api}
              source={source}
              activeRunId={activeRun(source.id)}
              failure={failures.get(source.id) ?? null}
              canManage={overview.canManage}
              onConnect={connect}
              onChanged={refresh}
            />
          ))
        )}
      </section>
    </div>
  );
};

export default SourcesPage;
