// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RetailOverview } from "../../src/app-api-types";
import OverviewPage from "./OverviewPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const overview: RetailOverview = {
  canManage: false,
  connectableProviders: ["square", "stripe"],
  sources: [{
    id: 1,
    kind: "csv",
    label: "Front counter exports",
    status: "imported",
    lastSuccessAt: "2026-11-01T10:00:00Z",
    coverageFrom: "2026-10-01",
    coverageTo: "2026-10-31",
  }],
  storage: { usedBytes: 7_500_000_000, capBytes: 10_000_000_000, rawUsedBytes: 0, rawQuotaBytes: 1, warn: true },
  settings: { piiUnmasked: false, backfillYears: 3 },
  failuresNeedingAdmin: [],
};

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

async function render(getOverview: () => Promise<RetailOverview>): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<OverviewPage api={{ getOverview }} />);
  });
  return container;
}

describe("OverviewPage", () => {
  it("lists sources with their coverage and warns when the dataset is nearly full", async () => {
    const page = await render(async () => overview);

    expect(page.textContent).toContain("Front counter exports");
    expect(page.textContent).toContain("2026-10-01 – 2026-10-31");
    expect(page.textContent).toContain("The dataset is nearly full");
    expect(page.textContent).toContain("7.5 GB of 10 GB");
  });

  it("tells a member who cannot manage that administrators manage sources", async () => {
    const page = await render(async () => overview);
    expect(page.textContent).toContain("Organization administrators manage sources and settings.");

    act(() => root!.unmount());
    const adminPage = await render(async () => ({ ...overview, canManage: true }));
    expect(adminPage.textContent).not.toContain("Organization administrators manage");
  });

  it("shows why the overview failed, such as a refused session", async () => {
    const page = await render(async () => {
      throw new Error("The active tenant changed.");
    });

    expect(page.textContent).toContain("The data overview could not be loaded");
    expect(page.textContent).toContain("The active tenant changed.");
  });
});
