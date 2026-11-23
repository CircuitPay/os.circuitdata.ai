import { Banner, Button, LayerCard, Loader, Select, Table, Text } from "@cloudflare/kumo";
import { ArrowLeft, ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { RetailAppClient, TemplateDetail } from "../../src/app-api-types";
import ConfirmDialog from "../components/ConfirmDialog";
import { focusOnMount } from "../focus";
import { errorMessage, formatCount, formatDateTime } from "../format";
import CopyTemplateDialog from "./CopyTemplateDialog";
import MappingJsonEditor from "./MappingJsonEditor";
import RebuildRuns from "./RebuildRuns";

export type TemplateDetailApi = Pick<
  RetailAppClient,
  "getTemplate" | "saveTemplateVersion" | "copyTemplate" | "deleteTemplate" | "reapplyTemplate" | "getRun"
>;

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; template: TemplateDetail };

/** One template: its versions, editing, copying, deleting and re-applying (FR-010, US5). */
const TemplateDetailView = ({
  api,
  templateId,
  onBack,
  onOpenTemplate,
}: {
  api: TemplateDetailApi;
  templateId: number;
  onBack: () => void;
  onOpenTemplate: (templateId: number) => void;
}) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let current = true;
    api.getTemplate(templateId).then(
      (template) => current && setLoad({ state: "loaded", template }),
      (error: unknown) => current && setLoad({ state: "failed", message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [api, templateId]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          Templates
        </Button>
      </div>
      {load.state === "loading" && (
        <div className="flex justify-center p-12" role="status" aria-label="Loading the template">
          <Loader size="lg" />
        </div>
      )}
      {load.state === "failed" && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="The template could not be loaded"
          description={load.message}
        />
      )}
      {load.state === "loaded" && (
        <Template
          api={api}
          template={load.template}
          onChanged={(template) => setLoad({ state: "loaded", template })}
          onDeleted={onBack}
          onOpenTemplate={onOpenTemplate}
        />
      )}
    </div>
  );
};

const Template = ({
  api,
  template,
  onChanged,
  onDeleted,
  onOpenTemplate,
}: {
  api: TemplateDetailApi;
  template: TemplateDetail;
  onChanged: (template: TemplateDetail) => void;
  onDeleted: () => void;
  onOpenTemplate: (templateId: number) => void;
}) => {
  const current = template.versions.find((version) => version.id === template.currentVersionId);
  const [reapplying, setReapplying] = useState(false);
  const [rebuilds, setRebuilds] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Null: the current version, which is also what `reapplyTemplate` uses by default.
  const [versionId, setVersionId] = useState<number | null>(null);
  const shownVersionId = versionId ?? template.currentVersionId;
  const versionItems: Record<string, string> = {};
  for (const version of template.versions) {
    versionItems[String(version.id)] =
      `Version ${version.version}${version.id === template.currentVersionId ? " (current)" : ""}`;
  }

  const reapply = async () => {
    setReapplying(true);
    setError(null);
    try {
      const { runIds } = await api.reapplyTemplate(
        template.id,
        versionId === null ? undefined : { versionId },
      );
      setRebuilds(runIds);
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setReapplying(false);
    }
  };

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Text variant="heading" size="lg" as="h2" tabIndex={-1} ref={focusOnMount}>
            {template.name}
          </Text>
          <Text variant="secondary">
            {template.origin === "builtin" ? "Built-in, read-only" : "Your template"}
            {template.currentVersion !== null ? ` · version ${template.currentVersion}` : ""} · used by{" "}
            {formatCount(template.runs)} {template.runs === 1 ? "run" : "runs"}
          </Text>
        </div>
        <div className="flex gap-2">
          <CopyTemplateDialog
            templateName={template.name}
            onCopy={async (name) => onOpenTemplate((await api.copyTemplate(template.id, name)).templateId)}
          />
          {template.origin === "user" && (
            <ConfirmDialog
              triggerLabel="Delete"
              title={`Delete ${template.name}?`}
              description="Later files are no longer recognised by it. The data it imported stays."
              confirmLabel="Delete template"
              onConfirm={async () => {
                await api.deleteTemplate(template.id);
                onDeleted();
              }}
            />
          )}
        </div>
      </header>
      {template.rebuildOffered && (
        <Banner
          variant="alert"
          icon={<ArrowsClockwise />}
          title="Imports used an older version"
          description="Re-apply the current version to rebuild their rows from the kept files."
        />
      )}
      <section aria-labelledby="versions-heading" className="flex flex-col gap-3">
        <Text variant="heading" as="h3" id="versions-heading">
          Versions
        </Text>
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <caption className="sr-only">Versions of {template.name}</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Version</Table.Head>
                <Table.Head>Created</Table.Head>
                <Table.Head>Runs</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {template.versions.map((version) => (
                <Table.Row key={version.id}>
                  <Table.Head>
                    {version.version}
                    {version.id === template.currentVersionId ? " (current)" : ""}
                  </Table.Head>
                  <Table.Cell>{formatDateTime(version.createdAt)}</Table.Cell>
                  <Table.Cell>{formatCount(version.runs)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      </section>
      <section aria-labelledby="reapply-heading" className="flex flex-col gap-3">
        <Text variant="heading" as="h3" id="reapply-heading">
          Re-apply
        </Text>
        <Text variant="secondary">
          Rebuilds every import made with this template from its kept files, with the version you choose.
        </Text>
        <div className="flex flex-wrap items-end gap-3">
          {template.versions.length > 0 && (
            <Select
              label="Version"
              items={versionItems}
              value={shownVersionId === null ? null : String(shownVersionId)}
              onValueChange={(value) => setVersionId(value === null ? null : Number(value))}
            />
          )}
          <Button
            variant={template.rebuildOffered ? "primary" : "secondary"}
            loading={reapplying}
            onClick={() => void reapply()}
          >
            Re-apply
          </Button>
        </div>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircle />} title="The template could not be re-applied" description={error} />
        )}
        {rebuilds !== null && <RebuildRuns api={api} runIds={rebuilds} />}
      </section>
      {template.origin === "user" && current && (
        <MappingJsonEditor
          key={current.id}
          mapping={current.mapping}
          onSave={async (mapping) => {
            await api.saveTemplateVersion(template.id, mapping);
            onChanged(await api.getTemplate(template.id));
          }}
        />
      )}
    </>
  );
};

export default TemplateDetailView;
