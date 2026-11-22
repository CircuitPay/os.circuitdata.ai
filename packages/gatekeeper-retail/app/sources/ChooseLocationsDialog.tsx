import { Banner, Button, Checkbox, Dialog, Loader } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { ProviderLocationInfo, RetailAppClient } from "../../src/app-api-types";
import { errorMessage } from "../format";

type Locations =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; locations: ProviderLocationInfo[] };

/**
 * "Choose locations": lists the provider account's locations and starts (or restarts) the history
 * load over the chosen ones. Active locations are pre-selected.
 */
const ChooseLocationsDialog = ({
  api,
  sourceId,
  triggerLabel,
  onChosen,
}: {
  api: Pick<RetailAppClient, "listProviderLocations" | "chooseLocations">;
  sourceId: number;
  triggerLabel: string;
  onChosen: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<Locations>({ state: "loading" });
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLocations({ state: "loading" });
    setError(null);
    try {
      const listed = await api.listProviderLocations(sourceId);
      setLocations({ state: "loaded", locations: listed });
      setChosen(listed.filter((location) => location.active).map((location) => location.id));
    } catch (thrown) {
      setLocations({ state: "failed", message: errorMessage(thrown) });
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.chooseLocations(sourceId, chosen);
      setOpen(false);
      onChosen();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next: boolean) => {
        if (saving) return;
        setOpen(next);
        if (next) void load();
      }}
    >
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="primary">
            {triggerLabel}
          </Button>
        )}
      />
      <Dialog className="flex flex-col gap-4 p-6" size="base">
        <Dialog.Title className="text-lg font-semibold">Choose locations</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">
          Sales of the chosen locations are loaded, newest first, and then kept up to date.
        </Dialog.Description>
        {locations.state === "loading" && (
          <div className="flex justify-center p-6" role="status" aria-label="Loading locations">
            <Loader />
          </div>
        )}
        {locations.state === "failed" && (
          <Banner
            variant="error"
            icon={<WarningCircle />}
            title="The locations could not be loaded"
            description={locations.message}
          />
        )}
        {locations.state === "loaded" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Locations</legend>
            {locations.locations.map((location) => (
              <Checkbox
                key={location.id}
                label={location.active ? location.name : `${location.name} (inactive)`}
                checked={chosen.includes(location.id)}
                onCheckedChange={(checked) =>
                  setChosen(
                    checked ? [...chosen, location.id] : chosen.filter((id) => id !== location.id),
                  )
                }
              />
            ))}
          </fieldset>
        )}
        {error !== null && (
          <Banner variant="error" icon={<WarningCircle />} title="The locations could not be saved" description={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            disabled={saving}
            render={(props) => (
              <Button {...props} variant="secondary">
                Cancel
              </Button>
            )}
          />
          <Button
            variant="primary"
            disabled={locations.state !== "loaded" || chosen.length === 0}
            loading={saving}
            onClick={() => void save()}
          >
            Load sales
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};

export default ChooseLocationsDialog;
