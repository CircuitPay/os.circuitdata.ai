import { Banner, Button, Dialog, Input } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { ERASE_CONFIRMATION, type RetailAppClient } from "../../src/app-api-types";
import { errorMessage } from "../format";

/** Erasing asks the administrator to type a phrase, since nothing can be restored afterwards. */
const EraseDatasetDialog = ({
  api,
  onErased,
}: {
  api: Pick<RetailAppClient, "eraseDataset">;
  onErased: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const erase = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.eraseDataset({ confirm: typed });
      setOpen(false);
      onErased();
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
        if (next) {
          setTyped("");
          setError(null);
        }
      }}
    >
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="destructive">
            Erase dataset…
          </Button>
        )}
      />
      <Dialog className="flex flex-col gap-4 p-6" size="base">
        <Dialog.Title className="text-lg font-semibold">Erase the whole dataset?</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">
          {`Every row, original file and connection is deleted and cannot be restored. Type "${ERASE_CONFIRMATION}" to confirm.`}
        </Dialog.Description>
        <Input label="Confirmation" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
        {error !== null && (
          <Banner variant="error" icon={<WarningCircle />} title="The dataset was not erased" description={error} />
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
          <Button
            variant="destructive"
            loading={busy}
            disabled={typed !== ERASE_CONFIRMATION}
            onClick={() => void erase()}
          >
            Erase dataset
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};

export default EraseDatasetDialog;
