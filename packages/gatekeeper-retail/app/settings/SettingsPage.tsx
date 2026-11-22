import { Banner, Loader, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { RetailAppClient, RetailOverview } from "../../src/app-api-types";
import { errorMessage } from "../format";
import EraseDatasetDialog from "./EraseDatasetDialog";
import MatchReview from "./MatchReview";
import PersonalDataSetting from "./PersonalDataSetting";

type SettingsApi = Pick<
  RetailAppClient,
  "getOverview" | "setPersonalDataUnmasked" | "eraseDataset" | "listMatchProposals" | "confirmMatch" | "rejectMatch" | "undoMatch"
>;

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; overview: RetailOverview };

/**
 * Settings (administrators): who sees personal data, cross-source matches, and erasing the
 * dataset. The history depth lives with the connected systems on the Sources tab.
 */
const SettingsPage = ({ api }: { api: SettingsApi }) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let current = true;
    api.getOverview().then(
      (overview) => current && setLoad({ state: "loaded", overview }),
      (thrown: unknown) => current && setLoad({ state: "failed", message: errorMessage(thrown) }),
    );
    return () => {
      current = false;
    };
  }, [api, generation]);

  if (load.state === "loading") {
    return (
      <div className="flex justify-center p-12" role="status" aria-label="Loading settings">
        <Loader size="lg" />
      </div>
    );
  }
  if (load.state === "failed") {
    return <Banner variant="error" icon={<WarningCircle />} title="The settings could not be loaded" description={load.message} />;
  }
  if (!load.overview.canManage) {
    return <Text variant="secondary">Only organization administrators can change these settings.</Text>;
  }

  const refresh = () => setGeneration((value) => value + 1);
  return (
    <div className="flex flex-col gap-8">
      <PersonalDataSetting api={api} unmasked={load.overview.settings.piiUnmasked} onChanged={refresh} />
      <section aria-labelledby="matches-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Text variant="heading" as="h2" id="matches-heading">
            Matches across sources
          </Text>
          <Text variant="secondary">
            Customers with the same email and products with the same SKU in two sources are ticked for you.
            Products or customers that share only a name are never linked unless you tick them.
          </Text>
        </div>
        <MatchReview api={api} kind="customer" />
        <MatchReview api={api} kind="product" />
      </section>
      <section aria-labelledby="erase-heading" className="flex flex-col gap-3">
        <Text variant="heading" as="h2" id="erase-heading">
          Erase the dataset
        </Text>
        <Text variant="secondary">
          Deletes every row, every original file and page, and disconnects every connected system. The Data
          area stays enabled and empty.
        </Text>
        <div>
          <EraseDatasetDialog api={api} onErased={refresh} />
        </div>
      </section>
    </div>
  );
};

export default SettingsPage;
