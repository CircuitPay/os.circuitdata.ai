import { Badge, Banner, Button, Empty, LayerCard, Loader, Table, Text } from "@cloudflare/kumo";
import { Table as TableIcon, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { RetailAppClient, TemplateSummary } from "../../src/app-api-types";
import { focusOnMount } from "../focus";
import { errorMessage, formatCount } from "../format";
import TemplateDetailView, { type TemplateDetailApi } from "./TemplateDetailView";

export type TemplatesApi = TemplateDetailApi & Pick<RetailAppClient, "listTemplates">;

// `returned`: the list was reached with Back, so its heading takes focus.
type View = { kind: "list"; returned: boolean } | { kind: "template"; templateId: number };

/** The Templates tab: saved and built-in mappings (FR-010) and re-applying them (US5). */
const TemplatesPage = ({ api }: { api: TemplatesApi }) => {
  const [view, setView] = useState<View>({ kind: "list", returned: false });
  const openTemplate = (templateId: number) => setView({ kind: "template", templateId });

  if (view.kind === "template") {
    return (
      <TemplateDetailView
        key={view.templateId}
        api={api}
        templateId={view.templateId}
        onBack={() => setView({ kind: "list", returned: true })}
        onOpenTemplate={openTemplate}
      />
    );
  }
  return <TemplateList api={api} focusHeading={view.returned} onOpen={openTemplate} />;
};

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; templates: TemplateSummary[] };

const TemplateList = ({
  api,
  focusHeading,
  onOpen,
}: {
  api: Pick<RetailAppClient, "listTemplates">;
  focusHeading: boolean;
  onOpen: (templateId: number) => void;
}) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let current = true;
    api.listTemplates().then(
      (templates) => current && setLoad({ state: "loaded", templates }),
      (error: unknown) => current && setLoad({ state: "failed", message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [api]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Text
          variant="heading"
          size="lg"
          as="h2"
          tabIndex={-1}
          ref={focusHeading ? focusOnMount : undefined}
        >
          Templates
        </Text>
        <Text variant="secondary">
          Mappings that are offered again when a later file has the same columns.
        </Text>
      </header>
      {load.state === "loading" && (
        <div className="flex justify-center p-12" role="status" aria-label="Loading templates">
          <Loader size="lg" />
        </div>
      )}
      {load.state === "failed" && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="The templates could not be loaded"
          description={load.message}
        />
      )}
      {load.state === "loaded" &&
        (load.templates.length === 0 ? (
          <Empty
            icon={<TableIcon size={48} />}
            title="No templates yet"
            description="Save a mapping as a template when you import a file."
          />
        ) : (
          <LayerCard className="overflow-x-auto p-0">
            <Table>
              <caption className="sr-only">Templates</caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Name</Table.Head>
                  <Table.Head>Kind</Table.Head>
                  <Table.Head>Version</Table.Head>
                  <Table.Head>Runs</Table.Head>
                  <Table.Head>
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {load.templates.map((template) => (
                  <Table.Row key={template.id}>
                    <Table.Head>
                      <span className="flex items-center gap-2">
                        {template.name}
                        {template.rebuildOffered && <Badge variant="orange">Rebuild offered</Badge>}
                      </span>
                    </Table.Head>
                    <Table.Cell>{template.origin === "builtin" ? "Built-in" : "Yours"}</Table.Cell>
                    <Table.Cell>{template.currentVersion ?? "—"}</Table.Cell>
                    <Table.Cell>{formatCount(template.runs)}</Table.Cell>
                    <Table.Cell>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Open ${template.name}`}
                        onClick={() => onOpen(template.id)}
                      >
                        Open
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        ))}
    </div>
  );
};

export default TemplatesPage;
