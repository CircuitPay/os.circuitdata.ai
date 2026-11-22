// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantFile, TenantFilesApi } from "@gadgets/workshop-shared/api";
import type { GatekeeperUiFrame, TenantFileDelivery } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import SandboxedGatekeeperApp from "./SandboxedGatekeeperApp";

vi.mock("./ThemeContext", () => ({
  useTheme: () => ({ resolvedThemeMode: "light" }),
}));

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: () => ({ accentColor: "#7c3aed" }),
}));

vi.mock("./errorReporting", () => ({
  forwardTrustedFrameError: () => false,
}));

const WORKSPACE_ID = "a".repeat(64);

const listGadgets = vi.fn<() => Promise<{ id: string; title: string }[]>>(async () => [
  { id: WORKSPACE_ID, title: "Daily Brief" },
]);

const csvFile: TenantFile = {
  id: "file-1",
  name: "march.csv",
  size: 7,
  contentType: "text/csv",
  previewable: false,
  uploader: { name: "Ann", isMe: true },
  uploadedAt: new Date("2026-11-01T10:00:00Z"),
  mayRemove: true,
};

// A real local capability, so the host's pipelined download resolves the way it does over RPC.
class TestFilesApi extends RpcTarget {
  async getUsage() {
    return { usedBytes: 7, quotaBytes: 1_000, fileCount: 1, maxFileBytes: 100 };
  }
  async listFiles() {
    return { files: [csvFile] };
  }
  async downloadFile(id: string) {
    if (id !== csvFile.id) throw new Error("File not found.");
    return {
      name: csvFile.name,
      size: csvFile.size,
      contentType: "application/octet-stream",
      stream: new Response("a,b\n1,2").body!,
    };
  }
}

const filesApi = new RpcStub(new TestFilesApi()) as unknown as RpcStub<TenantFilesApi>;
// Each caller gets its own duplicate, as each `getFilesApi()` call does, and disposes it.
const getFilesApi = vi.fn<() => Promise<RpcStub<TenantFilesApi>>>(async () => filesApi.dup());
const authenticatedApi = { listGadgets, getFilesApi };

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TestHost extends RpcTarget {
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  setPresenting(active: boolean): Promise<{
    rect: { left: number; top: number; width: number; height: number } | null;
    willResize: boolean;
  }>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
  pickTenantFiles(request: unknown): Promise<unknown>;
  openConnectPopup(flow: unknown): Promise<void>;
}

class EmptyUi extends RpcTarget {}

class FileReceivingUi extends RpcTarget {
  received: { target: unknown; files: { name: string; size: number; contentType: string; text: string }[] }[] = [];

  async receiveTenantFiles(target: unknown, files: TenantFileDelivery[]) {
    this.received.push({
      target,
      files: await Promise.all(files.map(async ({ name, size, contentType, stream }) => ({
        name, size, contentType, text: await new Response(stream).text(),
      }))),
    });
    return { importId: "import-1" };
  }
}

class TestThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(_theme: GatekeeperAppTheme): void {}
}

describe("SandboxedGatekeeperApp navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;

  beforeEach(() => {
    listGadgets.mockClear();
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  async function mount(ui: RpcTarget) {
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(ui),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="scheduler" />,
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const gadgetRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspace/$id",
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routeTree: rootRoute.addChildren([indexRoute, gadgetRoute]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    const session = newMessagePortRpcSession<TestHost>(port1);
    host = session;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );
    return { router, iframe, host: session };
  }

  // The picker dialog, once the host has opened it and its files have loaded.
  const openedPicker = () => vi.waitFor(() => {
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog?.textContent?.includes(csvFile.name)) throw new Error("The picker is not open");
    return dialog;
  });

  const pickerButton = (dialog: HTMLElement, name: string) => {
    const button = [...dialog.querySelectorAll("button")].find((item) => item.textContent?.trim() === name);
    if (!button) throw new Error(`No button named ${name}`);
    return button;
  };

  it("provides the deployment theme and routes bounded iframe requests", async () => {
    const { router, iframe, host } = await mount(new EmptyUi());

    const themeReceiver = new TestThemeReceiver();
    await expect(host.subscribeTheme(themeReceiver)).resolves.toEqual({
      mode: "light",
      accentColor: "#7c3aed",
    });

    await act(async () => {
      await host!.setPresenting(true);
    });
    expect(iframe.style.position).toBe("fixed");
    expect(iframe.style.top).toBe("calc(var(--app-top) + env(safe-area-inset-top))");
    expect(iframe.style.bottom).toBe("calc(var(--app-bottom) + env(safe-area-inset-bottom))");
    expect(iframe.style.width).toBe(
      "calc(100vw - (env(safe-area-inset-left) + env(safe-area-inset-right)))",
    );
    expect(iframe.style.height).toBe(
      "calc(100vh - var(--app-top) - var(--app-bottom) - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
    );

    await act(async () => {
      await host!.setPresenting(false);
    });
    expect(iframe.style.position).toBe("");
    expect(iframe.style.width).toBe("100%");
    expect(iframe.style.height).toBe("100%");

    await act(async () => {
      await host!.openWorkspace(WORKSPACE_ID, 2);
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`),
      );
    });
    expect(router.state.location.search).toEqual({ w: 2 });

    // Live titles come from the user's own gadget list, never from the app's snapshot. Concurrent
    // and repeated frame requests share a bounded-lifetime host-side index.
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    listGadgets
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Daily Brief" }])
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Renamed Brief" }]);
    await expect(
      Promise.all([
        host.resolveWorkspaceTitles([WORKSPACE_ID, "b".repeat(64)]),
        host.resolveWorkspaceTitles([WORKSPACE_ID]),
      ]),
    ).resolves.toEqual([["Daily Brief", null], ["Daily Brief"]]);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Daily Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30_000);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Renamed Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(2);

    await expect(host.openWorkspace("../evil")).rejects.toThrow(
      "Invalid gatekeeper app workspace target",
    );
    expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`);

    await act(async () => {
      await host!.openPrompt("  Create a daily brief.  ");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
    expect(router.state.location.search).toEqual({ prompt: "Create a daily brief." });
  });

  it("hands the files the member picks to the gatekeeper and returns its reply to the app", async () => {
    const ui = new FileReceivingUi();
    const { host } = await mount(ui);
    const target = { newSourceLabel: "Main street" };

    const result = host.pickTenantFiles({ accept: [".csv", "text/csv"], multiple: true, target });
    const dialog = await openedPicker();
    // The input the checkbox forwards its clicks to: jsdom has no PointerEvent to forward them with.
    const choice = [...dialog.querySelectorAll("label")]
      .find((label) => label.textContent?.includes(csvFile.name))
      ?.querySelector('[role="checkbox"]')?.nextElementSibling;
    if (!(choice instanceof HTMLInputElement)) throw new Error("No choice for the file");
    await act(async () => choice.click());
    await act(async () => pickerButton(dialog, "Use files").click());

    await expect(result).resolves.toEqual({ importId: "import-1" });
    // The listing's type, and the bytes of the download the host pipelined into the call.
    expect(ui.received).toEqual([{
      target,
      files: [{ name: "march.csv", size: 7, contentType: "text/csv", text: "a,b\n1,2" }],
    }]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("returns null when the member cancels, and refuses a malformed request", async () => {
    const ui = new FileReceivingUi();
    const { host } = await mount(ui);

    await expect(host.pickTenantFiles({ accept: "csv", multiple: true, target: "source-1" }))
      .rejects.toThrow("Invalid tenant file pick request.");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    const result = host.pickTenantFiles({ accept: [".csv"], multiple: false, target: "source-1" });
    const dialog = await openedPicker();
    await act(async () => pickerButton(dialog, "Cancel").click());

    await expect(result).resolves.toBeNull();
    expect(ui.received).toEqual([]);
  });

  it("opens the app's provider-connect popup with an app handoff record, and refuses non-https URLs", async () => {
    const { host } = await mount(new EmptyUi());
    const store = new Map<string, string>();
    const popup = {
      opener: window as Window | null,
      close: vi.fn<() => void>(),
      sessionStorage: { setItem: (key: string, value: string) => { store.set(key, value); } },
      location: { replace: vi.fn<(url: string) => void>() },
    };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const nonce = "c".repeat(64);

    await host.openConnectPopup({ url: "https://connect.squareup.com/oauth2/authorize?state=s", nonce });
    expect(JSON.parse(store.get("gadgets.handoff")!)).toEqual({ kind: "app", appId: "scheduler", nonce });
    expect(popup.opener).toBeNull();
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith("https://connect.squareup.com/oauth2/authorize?state=s");

    open.mockClear();
    await expect(host.openConnectPopup({ url: "javascript:alert(1)", nonce })).rejects.toThrow("https");
    expect(open).not.toHaveBeenCalled();
  });
});
