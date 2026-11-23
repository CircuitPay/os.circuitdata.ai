import { Tabs, Text } from "@cloudflare/kumo";
import { useState } from "react";
import type { RetailAppClient } from "../src/app-api-types";
import CoveragePage from "./coverage/CoveragePage";
import type { DataAppHost } from "./host";
import ImportsPage from "./imports/ImportsPage";
import OverviewPage from "./overview/OverviewPage";
import SettingsPage from "./settings/SettingsPage";
import SourcesPage from "./sources/SourcesPage";
import TemplatesPage from "./templates/TemplatesPage";

type Tab = "overview" | "imports" | "templates" | "coverage" | "sources" | "settings";

const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "imports", label: "Imports" },
  { value: "templates", label: "Templates" },
  { value: "coverage", label: "Coverage" },
  { value: "sources", label: "Sources" },
  { value: "settings", label: "Settings" },
];

/**
 * The Data app: tabs over the overview, imports, templates, coverage, sources and settings. A tab's panel
 * mounts on its first visit and then stays mounted (hidden), so an import being mapped or a run
 * being followed survives switching tabs.
 */
const App = ({ api, host }: { api: RetailAppClient; host: DataAppHost }) => {
  const [tab, setTab] = useState<Tab>("overview");
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(["overview"]));

  const panel = (value: Tab) => {
    switch (value) {
      case "overview":
        return <OverviewPage api={api} />;
      case "imports":
        return <ImportsPage api={api} host={host} />;
      case "templates":
        return <TemplatesPage api={api} />;
      case "coverage":
        return <CoveragePage api={api} />;
      case "sources":
        return <SourcesPage api={api} host={host} />;
      case "settings":
        return <SettingsPage api={api} />;
    }
  };

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h1">
          Data
        </Text>
        <Text variant="secondary">
          Your organization's sales, products and customers, shared by its workspaces.
        </Text>
      </header>
      <Tabs
        variant="underline"
        tabs={TABS}
        value={tab}
        onValueChange={(value) => {
          const next = TABS.find((entry) => entry.value === value)?.value;
          if (!next) return;
          setTab(next);
          setVisited((previous) => new Set(previous).add(next));
        }}
      />
      {TABS.map(
        ({ value, label }) =>
          visited.has(value) && (
            <div key={value} role="tabpanel" aria-label={label} hidden={value !== tab}>
              {panel(value)}
            </div>
          ),
      )}
    </main>
  );
};

export default App;
