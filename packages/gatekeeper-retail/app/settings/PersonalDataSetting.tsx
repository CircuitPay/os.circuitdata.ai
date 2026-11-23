import { Banner, Switch, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { RetailAppClient } from "../../src/app-api-types";
import { errorMessage } from "../format";

/** Whether the agent and data consumers see customers' names, emails and phone numbers. */
const PersonalDataSetting = ({
  api,
  unmasked,
  onChanged,
}: {
  api: Pick<RetailAppClient, "setPersonalDataUnmasked">;
  unmasked: boolean;
  onChanged: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.setPersonalDataUnmasked(on);
      onChanged();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="pii-heading" className="flex flex-col gap-3">
      <Text variant="heading" as="h2" id="pii-heading">
        Personal data
      </Text>
      <Text variant="secondary">
        Customers' names, emails and phone numbers are masked for the agent and for apps that read the data.
        Hashed emails and phone numbers stay available for joins either way. The change is recorded.
      </Text>
      <Switch
        label="Show personal data unmasked"
        checked={unmasked}
        disabled={busy}
        onCheckedChange={(on) => void change(on)}
      />
      {error !== null && (
        <Banner variant="error" icon={<WarningCircle />} title="The setting was not changed" description={error} />
      )}
    </section>
  );
};

export default PersonalDataSetting;
