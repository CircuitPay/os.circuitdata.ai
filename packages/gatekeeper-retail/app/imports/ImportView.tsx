import { Banner, Button, Loader, Text } from "@cloudflare/kumo";
import { ArrowLeft, ArrowsClockwise, Robot, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type {
  ImportPreview,
  MappingDocument,
  RetailAppClient,
  StagedImport,
} from "../../src/app-api-types";
import ConfirmDialog from "../components/ConfirmDialog";
import { focusOnMount } from "../focus";
import { errorMessage, formatDateTime } from "../format";
import type { DataAppHost } from "../host";
import FileSample from "./FileSample";
import MappingEditor from "./MappingEditor";
import { blankMapping, missingRequirements } from "./mapping";
import ParsingSettings from "./ParsingSettings";
import { pickCsvFiles } from "./pickCsvFiles";
import PreviewReport from "./PreviewReport";
import StartImportForm, { type SaveAsTemplate } from "./StartImportForm";

export type ImportViewApi = Pick<
  RetailAppClient,
  "getImport" | "discardImport" | "askAgentPrompt" | "preview" | "startImport"
>;

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; staged: StagedImport };

type ImportViewProps = {
  api: ImportViewApi;
  host: Pick<DataAppHost, "openPrompt" | "pickTenantFiles">;
  importId: number;
  onBack: () => void;
  onOpenImport: (importId: number) => void;
  onStarted: (runId: number) => void;
};

/** A staged import: its files, the mapping, the preview and the start (US2). */
const ImportView = ({ api, host, importId, onBack, onOpenImport, onStarted }: ImportViewProps) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let current = true;
    api.getImport(importId).then(
      (staged) => current && setLoad({ state: "loaded", staged }),
      (error: unknown) => current && setLoad({ state: "failed", message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [api, importId]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          Imports
        </Button>
      </div>
      {load.state === "loading" && (
        <div className="flex justify-center p-12" role="status" aria-label="Loading the import">
          <Loader size="lg" />
        </div>
      )}
      {load.state === "failed" && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="The import could not be loaded"
          description={load.message}
        />
      )}
      {load.state === "loaded" && (
        <ImportEditor
          api={api}
          host={host}
          staged={load.staged}
          onReloaded={(staged) => setLoad({ state: "loaded", staged })}
          onDiscarded={onBack}
          onOpenImport={onOpenImport}
          onStarted={onStarted}
        />
      )}
    </div>
  );
};

const ImportEditor = ({
  api,
  host,
  staged,
  onReloaded,
  onDiscarded,
  onOpenImport,
  onStarted,
}: Omit<ImportViewProps, "importId" | "onBack"> & {
  staged: StagedImport;
  onReloaded: (staged: StagedImport) => void;
  onDiscarded: () => void;
}) => {
  // Only the first read seeds the mapping: refreshing for the agent's suggestion keeps the edits.
  const [mapping, setMapping] = useState<MappingDocument>(
    () => staged.deterministicMapping ?? blankMapping(),
  );
  const [preview, setPreview] = useState<{ mapping: string; preview: ImportPreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);

  const missing = missingRequirements(mapping, staged.targets);
  const previewIsCurrent = preview !== null && preview.mapping === JSON.stringify(mapping);
  const { agentMapping, missingRequiredFiles: missingFiles } = staged;
  const blockedBecause =
    missingFiles.length > 0
      ? "Add the missing files first."
      : missing.length > 0
        ? "Map what is still needed first."
        : !previewIsCurrent
          ? "Preview the current mapping first."
          : null;

  const attempt = async (title: string, action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (thrown) {
      setError({ title, message: errorMessage(thrown) });
    }
  };

  const askAgent = () =>
    attempt("The agent could not be asked", async () => {
      await host.openPrompt(await api.askAgentPrompt(staged.id));
    });

  const refresh = async () => {
    setRefreshing(true);
    await attempt("The import could not be refreshed", async () => onReloaded(await api.getImport(staged.id)));
    setRefreshing(false);
  };

  const runPreview = async () => {
    setPreviewing(true);
    const previewed = JSON.stringify(mapping);
    await attempt("The preview failed", async () => {
      setPreview({ mapping: previewed, preview: await api.preview(staged.id, mapping) });
    });
    setPreviewing(false);
  };

  const pickAgain = () =>
    attempt("The files could not be added", async () => {
      const picked = await pickCsvFiles(host, staged.sourceId);
      if (picked) onOpenImport(picked.importId);
    });

  const start = async (saveAsTemplate: SaveAsTemplate | undefined) => {
    const { runId } = await api.startImport(
      staged.id,
      mapping,
      saveAsTemplate ? { saveAsTemplate } : undefined,
    );
    onStarted(runId);
  };

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Text variant="heading" size="lg" as="h2" tabIndex={-1} ref={focusOnMount}>
            Import into {staged.sourceLabel}
          </Text>
          <Text variant="secondary">
            {staged.files.map((file) => file.name).join(", ")} · kept until{" "}
            {formatDateTime(staged.expiresAt)}
          </Text>
        </div>
        <ConfirmDialog
          triggerLabel="Discard"
          title="Discard this import?"
          description="Its files are removed from the Data area. Nothing was imported from them."
          confirmLabel="Discard"
          onConfirm={async () => {
            await api.discardImport(staged.id);
            onDiscarded();
          }}
        />
      </header>
      {error !== null && (
        <Banner variant="error" icon={<WarningCircle />} title={error.title} description={error.message} />
      )}
      {missingFiles.length > 0 && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="Files of the set are missing"
          description={`${missingFiles.join(", ")} must be imported with the other files. Choose the whole set again.`}
          action={
            <Button variant="secondary" onClick={() => void pickAgain()}>
              Choose files
            </Button>
          }
        />
      )}
      {staged.templateMatches.length > 0 && (
        <Text>
          Recognised as{" "}
          {staged.templateMatches
            .map((match) => `${match.name} (${match.origin === "builtin" ? "built-in" : "your template"})`)
            .join(", ")}
          .
        </Text>
      )}
      <section aria-label="The agent" className="flex flex-col gap-3">
        {agentMapping !== null && (
          <Banner
            icon={<Sparkle />}
            title="The agent suggested a mapping"
            description="Review it below before you preview."
            action={
              <Button variant="secondary" onClick={() => setMapping(agentMapping)}>
                Use the agent's suggestion
              </Button>
            }
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Robot />} onClick={() => void askAgent()}>
            Ask the agent
          </Button>
          <Button
            variant="ghost"
            icon={<ArrowsClockwise />}
            loading={refreshing}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </div>
      </section>
      <ParsingSettings
        files={staged.files}
        parsing={mapping.parsing}
        onChange={(parsing) => {
          const { parsing: _previous, ...rest } = mapping;
          setMapping(parsing ? { ...rest, parsing } : rest);
        }}
      />
      {staged.files.map((file, fileIndex) => (
        <FileSample key={file.rawObjectId} importId={staged.id} fileIndex={fileIndex} file={file} />
      ))}
      <MappingEditor
        mapping={mapping}
        files={staged.files}
        targets={staged.targets}
        onChange={setMapping}
      />
      <div>
        <Button
          variant="secondary"
          disabled={missingFiles.length > 0}
          loading={previewing}
          onClick={() => void runPreview()}
        >
          Preview
        </Button>
      </div>
      {preview !== null && (
        <>
          {!previewIsCurrent && (
            <Text variant="secondary">The mapping changed since this preview. Preview it again.</Text>
          )}
          <PreviewReport importId={staged.id} files={staged.files} preview={preview.preview} />
        </>
      )}
      <StartImportForm
        matches={staged.templateMatches}
        blockedBecause={blockedBecause}
        onStart={start}
      />
    </>
  );
};

export default ImportView;
