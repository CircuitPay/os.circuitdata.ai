import { Badge, Banner, Button, LayerCard, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { ConnectFlow, RetailAppClient, SourceSummary } from "../../src/app-api-types";
import ConfirmDialog from "../components/ConfirmDialog";
import { errorMessage, formatDateTime } from "../format";
import RunProgress from "../runs/RunProgress";
import { useRun } from "../runs/useRun";
import { SOURCE_KIND_LABELS, SOURCE_STATUS_LABELS } from "../sourceLabels";
import ChooseLocationsDialog from "./ChooseLocationsDialog";

export type ProviderSourceApi = Pick<
  RetailAppClient,
  "getRun" | "listProviderLocations" | "chooseLocations" | "syncNow" | "reconnect" | "disconnect"
>;

const STATUS_BADGES: Partial<Record<SourceSummary["status"], "red" | "neutral">> = {
  needs_reconnect: "red",
  retrying: "red",
};

/** One connected provider source: its status, the running history load or sync, and its actions. */
const ProviderSourceCard = ({
  api,
  source,
  activeRunId,
  failure,
  canManage,
  onConnect,
  onChanged,
}: {
  api: ProviderSourceApi;
  source: SourceSummary;
  /** The source's running backfill or sync, if any. */
  activeRunId: number | null;
  failure: { code: string; message: string | null } | null;
  canManage: boolean;
  onConnect: (start: () => Promise<ConnectFlow>) => Promise<void>;
  onChanged: () => void;
}) => {
  const { load: run } = useRun(api, activeRunId, onChanged);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnected = source.status === "disconnected";

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <Text variant="heading" as="h3">
            {source.label}
          </Text>
          <Text variant="secondary" size="sm">
            {SOURCE_KIND_LABELS[source.kind]}
            {source.coverageFrom && source.coverageTo
              ? ` · sales from ${source.coverageFrom} to ${source.coverageTo}`
              : ""}
            {source.lastSuccessAt ? ` · last synced ${formatDateTime(source.lastSuccessAt)}` : ""}
          </Text>
        </div>
        <Badge variant={STATUS_BADGES[source.status] ?? "neutral"}>{SOURCE_STATUS_LABELS[source.status]}</Badge>
      </div>
      {failure && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="Syncing stopped"
          description={
            canManage
              ? (failure.message ?? "Reconnect this source to resume syncing.")
              : "Ask an organization administrator to reconnect this source."
          }
        />
      )}
      {run.state === "loaded" && run.run.progress && run.run.status === "running" && (
        <RunProgress
          label={`${source.label}: ${run.run.kind === "backfill" ? "loading history" : "syncing"}`}
          progress={run.run.progress}
        />
      )}
      {source.status === "connecting" && !canManage && (
        <Text variant="secondary" size="sm">
          An organization administrator still has to choose which locations to load.
        </Text>
      )}
      {error !== null && (
        <Banner variant="error" icon={<WarningCircle />} title="That did not work" description={error} />
      )}
      {canManage && !disconnected && (
        <div className="flex flex-wrap gap-2">
          {source.status === "needs_reconnect" ? (
            <Button variant="primary" loading={busy} onClick={() => void onConnect(() => api.reconnect(source.id))}>
              Reconnect
            </Button>
          ) : (
            <ChooseLocationsDialog
              api={api}
              sourceId={source.id}
              triggerLabel={source.status === "connecting" ? "Choose locations" : "Change locations"}
              onChosen={onChanged}
            />
          )}
          {source.status !== "connecting" && source.status !== "needs_reconnect" && (
            <Button variant="secondary" loading={busy} onClick={() => void act(() => api.syncNow(source.id))}>
              Sync now
            </Button>
          )}
          <ConfirmDialog
            triggerLabel="Disconnect"
            title={`Disconnect ${source.label}?`}
            description={`Syncing stops and the ${SOURCE_KIND_LABELS[source.kind]} access is revoked. The data already loaded stays.`}
            confirmLabel="Disconnect"
            onConfirm={async () => {
              await api.disconnect(source.id, { deleteData: false });
              onChanged();
            }}
          />
          <ConfirmDialog
            triggerLabel="Disconnect and delete data"
            title={`Delete ${source.label}'s data?`}
            description="Syncing stops, the access is revoked, and every row this source brought in is deleted, with its raw records. Other sources are not touched. This cannot be undone."
            confirmLabel="Delete data"
            onConfirm={async () => {
              await api.disconnect(source.id, { deleteData: true });
              onChanged();
            }}
          />
        </div>
      )}
    </LayerCard>
  );
};

export default ProviderSourceCard;
