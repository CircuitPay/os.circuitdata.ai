// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetailAppClient, RetailOverview, RunSummary } from "../../src/app-api-types";
import SourcesPage from "./SourcesPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const square = {
  id: 7, kind: "square" as const, label: "Corner Cafe", status: "needs_reconnect" as const,
  lastSuccessAt: null, coverageFrom: null, coverageTo: null,
};

function overview(canManage: boolean): RetailOverview {
  return {
    canManage,
    connectableProviders: ["square", "stripe"],
    sources: [square],
    storage: { usedBytes: 1, capBytes: 10, rawUsedBytes: 0, rawQuotaBytes: 1, warn: false },
    settings: { piiUnmasked: false, backfillYears: 3 },
    failuresNeedingAdmin: [{ sourceId: 7, label: "Corner Cafe", code: "UNAUTHORIZED", message: "Square no longer accepts this connection's access. Reconnect it." }],
  };
}

function fakeApi(canManage: boolean) {
  return {
    getOverview: vi.fn<RetailAppClient["getOverview"]>(async () => overview(canManage)),
    listRuns: vi.fn<RetailAppClient["listRuns"]>(async () => ({ items: [] as RunSummary[], nextAfter: null })),
    getRun: vi.fn<RetailAppClient["getRun"]>(),
    beginConnect: vi.fn<RetailAppClient["beginConnect"]>(async () => ({ url: "https://connect.squareup.com/oauth2/authorize", nonce: "n".repeat(64) })),
    listProviderLocations: vi.fn<RetailAppClient["listProviderLocations"]>(async () => []),
    chooseLocations: vi.fn<RetailAppClient["chooseLocations"]>(async () => {}),
    setBackfillYears: vi.fn<RetailAppClient["setBackfillYears"]>(async () => {}),
    syncNow: vi.fn<RetailAppClient["syncNow"]>(async () => {}),
    reconnect: vi.fn<RetailAppClient["reconnect"]>(async () => ({ url: "https://connect.squareup.com/oauth2/authorize?re", nonce: "r".repeat(64) })),
    disconnect: vi.fn<RetailAppClient["disconnect"]>(async () => {}),
  };
}

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

async function render(api: ReturnType<typeof fakeApi>, openConnectPopup = vi.fn<(flow: { url: string; nonce: string }) => Promise<void>>(async () => {})) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SourcesPage api={api} host={{ openConnectPopup }} />);
  });
  return { page: container, openConnectPopup };
}

function button(page: HTMLElement, name: string): HTMLButtonElement {
  const found = [...page.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name);
  if (!found) throw new Error(`No button "${name}"`);
  return found;
}

describe("SourcesPage", () => {
  it("offers only the providers the deployment has credentials for", async () => {
    const api = fakeApi(true);
    api.getOverview.mockResolvedValue({ ...overview(true), connectableProviders: ["square"] });
    const { page } = await render(api);

    expect(button(page, "Connect Square")).toBeDefined();
    expect(page.textContent).not.toContain("Connect Stripe");
  });

  it("starts a provider connection and hands the flow to the host's popup", async () => {
    const api = fakeApi(true);
    const { page, openConnectPopup } = await render(api);

    await act(async () => button(page, "Connect Square").click());

    expect(api.beginConnect).toHaveBeenCalledExactlyOnceWith("square");
    expect(openConnectPopup).toHaveBeenCalledExactlyOnceWith({
      url: "https://connect.squareup.com/oauth2/authorize", nonce: "n".repeat(64),
    });
    expect(page.textContent).toContain("Finish signing in to the provider");
  });

  it("offers a reconnect for a source that needs one, through the same popup", async () => {
    const api = fakeApi(true);
    const { page, openConnectPopup } = await render(api);

    expect(page.textContent).toContain("Square no longer accepts this connection's access.");
    await act(async () => button(page, "Reconnect").click());

    expect(api.reconnect).toHaveBeenCalledExactlyOnceWith(7);
    expect(openConnectPopup).toHaveBeenCalledOnce();
  });

  it("shows members the sources without the administrator's actions", async () => {
    const { page } = await render(fakeApi(false));

    expect(page.textContent).toContain("Corner Cafe");
    expect(page.textContent).toContain("Only organization administrators can connect");
    expect(page.textContent).toContain("Ask an organization administrator to reconnect");
    expect([...page.querySelectorAll("button")].map((candidate) => candidate.textContent)).not.toContain("Connect Square");
    expect([...page.querySelectorAll("button")].map((candidate) => candidate.textContent)).not.toContain("Disconnect");
  });

  it("deletes a source's data only after the member confirms", async () => {
    const api = fakeApi(true);
    const { page } = await render(api);

    await act(async () => button(page, "Disconnect and delete data").click());
    const dialog = document.body.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Other sources are not touched.");
    expect(api.disconnect).not.toHaveBeenCalled();
    await act(async () => button(dialog, "Delete data").click());

    expect(api.disconnect).toHaveBeenCalledExactlyOnceWith(7, { deleteData: true });
  });
});
