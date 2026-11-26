import { Tabs, Text } from "@cloudflare/kumo";
import { useState } from "react";
import type { RetailAppClient } from "../src/app-api-types";
import BrowsePage, { type BrowseRequest } from "./browse/BrowsePage";
import CoveragePage from "./coverage/CoveragePage";
import HomePage from "./home/HomePage";
import type { DataAppHost } from "./host";
import ImportsPage, { type ImportsRequest } from "./imports/ImportsPage";
import type { BrowseTarget } from "./navigation";
import SettingsPage from "./settings/SettingsPage";
import SourcesPage from "./sources/SourcesPage";
import TemplatesPage from "./templates/TemplatesPage";

type Tab = "home" | "browse" | "imports" | "templates" | "coverage" | "sources" | "settings";

const TABS: { value: Tab; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "browse", label: "Browse" },
  { value: "imports", label: "Imports" },
  { value: "templates", label: "Templates" },
  { value: "coverage", label: "Coverage" },
  { value: "sources", label: "Sources" },
  { value: "settings", label: "Settings" },
];

/**
 * The Data app: tabs over home, browse, imports, templates, coverage, sources and settings. A tab's
 * panel mounts on its first visit and then stays mounted (hidden), so an import being mapped or a
 * run being followed survives switching tabs. One panel sends the member to another through
 * requests the target panel opens when their `seq` changes.
 */
const App = ({ api, host }: { api: RetailAppClient; host: DataAppHost }) => {
  const [tab, setTab] = useState<Tab>("home");
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(["home"]));
  const [importsRequest, setImportsRequest] = useState<ImportsRequest>();
  const [browseRequest, setBrowseRequest] = useState<BrowseRequest>();
  // Home is read again on each visit, so it shows what imports and syncs changed meanwhile.
  const [homeVisits, setHomeVisits] = useState(0);

  const show = (next: Tab) => {
    if (next === "home" && tab !== "home") setHomeVisits(homeVisits + 1);
    setTab(next);
    setVisited((previous) => (previous.has(next) ? previous : new Set(previous).add(next)));
  };
  const openImports = (kind: ImportsRequest["kind"], id: number) => {
    setImportsRequest({ kind, id, seq: (importsRequest?.seq ?? 0) + 1 });
    show("imports");
  };
  const openImport = (importId: number) => openImports("import", importId);
  const openRun = (runId: number) => openImports("run", runId);
  const browse = (target: BrowseTarget) => {
    setBrowseRequest({ ...target, seq: (browseRequest?.seq ?? 0) + 1 });
    show("browse");
  };

  const panel = (value: Tab) => {
    switch (value) {
      case "home":
        return (
          <HomePage
            key={homeVisits}
            api={api}
            host={host}
            onOpenImport={openImport}
            onOpenRun={openRun}
            onBrowse={browse}
            onOpenSources={() => show("sources")}
          />
        );
      case "browse":
        return <BrowsePage api={api} request={browseRequest} />;
      case "imports":
        return <ImportsPage api={api} host={host} request={importsRequest} onBrowse={browse} />;
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
          if (next) show(next);
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
