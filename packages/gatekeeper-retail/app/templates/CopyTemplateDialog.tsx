import { Banner, Button, Dialog, Input } from "@cloudflare/kumo";
import { Copy, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { errorMessage } from "../format";

/** Copies a template (built-ins are read-only) under a new name. */
const CopyTemplateDialog = ({
  templateName,
  onCopy,
}: {
  templateName: string;
  onCopy: (name: string) => Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCopy(name.trim());
      setOpen(false);
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next: boolean) => {
        if (busy) return;
        setOpen(next);
        if (next) {
          setName(`${templateName} (copy)`);
          setError(null);
        }
      }}
    >
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="secondary" icon={<Copy />}>
            Copy
          </Button>
        )}
      />
      <Dialog className="flex flex-col gap-4 p-6" size="base">
        <Dialog.Title className="text-lg font-semibold">Copy {templateName}</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">
          The copy is yours to edit. Imports keep using the template they were made with.
        </Dialog.Description>
        <Input label="Name of the copy" value={name} onChange={(event) => setName(event.target.value)} />
        {error !== null && (
          <Banner variant="error" icon={<WarningCircle />} title="The template could not be copied" description={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            disabled={busy}
            render={(props) => (
              <Button {...props} variant="secondary">
                Cancel
              </Button>
            )}
          />
          <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={() => void copy()}>
            Copy
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};

export default CopyTemplateDialog;
