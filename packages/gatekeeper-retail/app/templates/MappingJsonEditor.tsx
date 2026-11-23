import { Banner, Button, InputArea, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { MappingDocument } from "../../src/app-api-types";
import { errorMessage } from "../format";

/**
 * Edits a user template's mapping as JSON and saves it as a new version. The gatekeeper validates
 * the document; its message (naming the field) is shown as thrown.
 */
const MappingJsonEditor = ({
  mapping,
  onSave,
}: {
  /** The current version's mapping; the editor starts from it. */
  mapping: MappingDocument;
  onSave: (mapping: MappingDocument) => Promise<void>;
}) => {
  const [text, setText] = useState(() => JSON.stringify(mapping, null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    let parsed: MappingDocument;
    try {
      parsed = JSON.parse(text) as MappingDocument;
    } catch (thrown) {
      setError(`This is not valid JSON: ${errorMessage(thrown)}`);
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="edit-mapping-heading" className="flex flex-col gap-3">
      <Text variant="heading" as="h3" id="edit-mapping-heading">
        Edit the mapping
      </Text>
      <InputArea
        label="Mapping (JSON)"
        description="Saving creates a new version. Imports made with older versions keep them until you re-apply."
        className="font-mono text-sm"
        rows={16}
        spellCheck={false}
        value={text}
        onValueChange={setText}
      />
      {error !== null && (
        <Banner variant="error" icon={<WarningCircle />} title="The mapping was not saved" description={error} />
      )}
      <div>
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          Save as a new version
        </Button>
      </div>
    </section>
  );
};

export default MappingJsonEditor;
