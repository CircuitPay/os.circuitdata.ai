import { Banner, Button, Checkbox, Input, Select, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { TemplateMatch } from "../../src/app-api-types";
import { errorMessage } from "../format";

export type SaveAsTemplate = { name: string } | { templateId: number };

const NEW_TEMPLATE = "new";

/** Starts the import, optionally saving the mapping as a new template or a new version (FR-010). */
const StartImportForm = ({
  matches,
  blockedBecause,
  onStart,
}: {
  matches: TemplateMatch[];
  /** Why the import cannot start yet, or null when it can. */
  blockedBecause: string | null;
  onStart: (saveAsTemplate: SaveAsTemplate | undefined) => Promise<void>;
}) => {
  const userTemplates = matches.filter((match) => match.origin === "user");
  const [save, setSave] = useState(false);
  const [choice, setChoice] = useState(NEW_TEMPLATE);
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templateItems: Record<string, string> = { [NEW_TEMPLATE]: "A new template" };
  for (const match of userTemplates) {
    templateItems[String(match.templateId)] = `A new version of ${match.name}`;
  }
  const saveAsTemplate: SaveAsTemplate | undefined = !save
    ? undefined
    : choice === NEW_TEMPLATE
      ? { name: name.trim() }
      : { templateId: Number(choice) };
  const reason =
    blockedBecause ??
    (saveAsTemplate && "name" in saveAsTemplate && !saveAsTemplate.name ? "Name the template." : null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await onStart(saveAsTemplate);
    } catch (thrown) {
      setError(errorMessage(thrown));
      setStarting(false);
    }
  };

  return (
    <section aria-labelledby="start-heading" className="flex flex-col gap-3">
      <Text variant="heading" as="h3" id="start-heading">
        Import
      </Text>
      <Checkbox
        label="Save this mapping as a template"
        checked={save}
        onCheckedChange={(checked) => setSave(checked)}
      />
      {save && (
        <div className="grid gap-3 sm:grid-cols-2">
          {userTemplates.length > 0 && (
            <Select
              label="Save as"
              items={templateItems}
              value={choice}
              onValueChange={(value) => setChoice(String(value))}
            />
          )}
          {choice === NEW_TEMPLATE && (
            <Input label="Template name" value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </div>
      )}
      {error !== null && (
        <Banner variant="error" icon={<WarningCircle />} title="The import could not start" description={error} />
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={reason !== null}
          loading={starting}
          onClick={() => void start()}
          aria-describedby={reason === null ? undefined : "start-blocked"}
        >
          Start import
        </Button>
        {reason !== null && (
          <Text variant="secondary" id="start-blocked">
            {reason}
          </Text>
        )}
      </div>
    </section>
  );
};

export default StartImportForm;
