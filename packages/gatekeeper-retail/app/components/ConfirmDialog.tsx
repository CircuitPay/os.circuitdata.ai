import { Banner, Button, Dialog } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { errorMessage } from "../format";

/**
 * A button that asks for confirmation in an alert dialog before a destructive action. The dialog
 * traps focus and returns it to the button when it closes; a refused action is shown in the dialog.
 */
const ConfirmDialog = ({
  triggerLabel,
  title,
  description,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      role="alertdialog"
      open={open}
      onOpenChange={(next: boolean) => {
        if (busy) return;
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <Dialog.Trigger
        disabled={disabled}
        render={(props) => (
          <Button {...props} variant="secondary">
            {triggerLabel}
          </Button>
        )}
      />
      <Dialog className="flex flex-col gap-4 p-6" size="base">
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
        {error !== null && (
          <Banner
            variant="error"
            icon={<WarningCircle />}
            title={`Could not ${confirmLabel.toLowerCase()}`}
            description={error}
          />
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
          <Button variant="destructive" loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};

export default ConfirmDialog;
