// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetailAppClient, RetailOverview } from "../src/app-api-types";
import App from "./App";
import type { DataAppHost } from "./host";
import { byRole, cleanup, click, render } from "./testDom";

const overview: RetailOverview = {
  canManage: true,
  connectableProviders: ["square", "stripe"],
  sources: [],
  storage: { usedBytes: 0, capBytes: 1, rawUsedBytes: 0, rawQuotaBytes: 1, warn: false },
  settings: { piiUnmasked: false, backfillYears: 3 },
  failuresNeedingAdmin: [],
};

// Every capability method resolves to something empty; the tests only follow navigation.
function fakeApi() {
  const empty = { items: [], nextAfter: null };
  const api: Partial<RetailAppClient> = {
    getOverview: vi.fn<RetailAppClient["getOverview"]>(async () => overview),
    listImports: vi.fn<RetailAppClient["listImports"]>(async () => []),
    listRuns: vi.fn<RetailAppClient["listRuns"]>(async () => empty),
    listTemplates: vi.fn<RetailAppClient["listTemplates"]>(async () => []),
    getCoverage: vi.fn<RetailAppClient["getCoverage"]>(async () => ({ sources: [], ranges: [], possibleGaps: [] })),
  };
  return new Proxy(api, {
    get: (target, key: string) => target[key as keyof RetailAppClient] ?? (async () => empty),
  }) as RetailAppClient;
}

const host: DataAppHost = {
  openPrompt: async () => {},
  pickTenantFiles: async () => null,
  openConnectPopup: async () => {},
};

afterEach(cleanup);

describe("App", () => {
  it("navigates between the Data tabs, loading each panel on its first visit", async () => {
    const api = fakeApi();
    await render(<App api={api} host={host} />);

    const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Overview", "Imports", "Templates", "Coverage", "Sources", "Settings"]);
    expect(byRole("tabpanel", "Overview").hidden).toBe(false);
    expect(api.getCoverage).not.toHaveBeenCalled();

    await click(byRole("tab", "Coverage"));
    expect(byRole("tab", "Coverage").getAttribute("aria-selected")).toBe("true");
    expect(byRole("tabpanel", "Coverage").hidden).toBe(false);
    expect(byRole("tabpanel", "Overview").hidden).toBe(true);
    expect(api.getCoverage).toHaveBeenCalledOnce();

    await click(byRole("tab", "Overview"));
    await click(byRole("tab", "Coverage"));
    // The panel stayed mounted, so returning does not load it again.
    expect(api.getCoverage).toHaveBeenCalledOnce();
  });
});
