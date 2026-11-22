import { Banner, Button, Dialog, Input, Loader, Select } from "@cloudflare/kumo";
import { FileCsv, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { ImportTarget, RetailAppClient, SourceSummary } from "../../src/app-api-types";
import { errorMessage } from "../format";
import type { DataAppHost } from "../host";
import { pickCsvFiles } from "./pickCsvFiles";

const NEW_SOURCE = "new";

type Sources = { state: "loading" } | { state: "failed"; message: string } | { state: "loaded"; sources: SourceSummary[] };

/**
 * "Import CSV": choose an existing CSV or Toast source, or name a new one, then pick the files
 * from the tenant's Files through the host.
 */
const ImportCsvDialog = ({
  api,
  host,
  onStaged,
}: {
  api: Pick<RetailAppClient, "getOverview">;
  host: Pick<DataAppHost, "pickTenantFiles">;
  onStaged: (importId: number) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Sources>({ state: "loading" });
  const [choice, setChoice] = useState(NEW_SOURCE);
  const [label, setLabel] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDialog = async () => {
    setOpen(true);
    setError(null);
    setSources({ state: "loading" });
    try {
      const overview = await api.getOverview();
      const fileSources = overview.sources.filter((source) => source.kind === "csv" || source.kind === "toast");
      setSources({ state: "loaded", sources: fileSources });
      setChoice(fileSources[0] ? String(fileSources[0].id) : NEW_SOURCE);
    } catch (thrown) {
      setSources({ state: "failed", message: errorMessage(thrown) });
    }
  };

  const target: ImportTarget | null =
    choice === NEW_SOURCE ? (label.trim() ? { newSourceLabel: label.trim() } : null) : Number(choice);

  const pick = async (to: ImportTarget) => {
    setPicking(true);
    setError(null);
    try {
      const picked = await pickCsvFiles(host, to);
      if (picked) {
        setOpen(false);
        onStaged(picked.importId);
      }
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setPicking(false);
    }
  };

  const sourceItems: Record<string, string> = {};
  if (sources.state === "loaded") {
    for (const source of sources.sources) sourceItems[String(source.id)] = source.label;
  }
  sourceItems[NEW_SOURCE] = "A new source";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next: boolean) => {
        if (picking) return;
        if (next) void openDialog();
        else setOpen(false);
      }}
    >
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="primary" icon={<FileCsv />}>
            Import CSV
          </Button>
        )}
      />
      <Dialog className="flex flex-col gap-4 p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold">Import CSV files</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">
          Choose where the rows go, then pick the files from Files or upload them. A Toast export set
          is picked together.
        </Dialog.Description>
        {sources.state === "loading" && (
          <div className="flex justify-center p-6" role="status" aria-label="Loading sources">
            <Loader />
          </div>
        )}
        {sources.state === "failed" && (
          <Banner
            variant="error"
            icon={<WarningCircle />}
            title="The sources could not be loaded"
            description={sources.message}
          />
        )}
        {sources.state === "loaded" && (
          <>
            <Select
              label="Source"
              items={sourceItems}
              value={choice}
              onValueChange={(value) => setChoice(String(value))}
            />
            {choice === NEW_SOURCE && (
              <Input
                label="Name of the new source"
                placeholder="e.g. Front counter exports"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </>
        )}
        {error !== null && (
          <Banner variant="error" icon={<WarningCircle />} title="The files could not be imported" description={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            disabled={picking}
            render={(props) => (
              <Button {...props} variant="secondary">
                Cancel
              </Button>
            )}
          />
          <Button
            variant="primary"
            disabled={target === null || sources.state !== "loaded"}
            loading={picking}
            onClick={() => target !== null && void pick(target)}
          >
            Choose files
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};

export default ImportCsvDialog;
