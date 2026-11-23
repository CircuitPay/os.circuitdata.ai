// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantFile, TenantFilesApi } from "@gadgets/workshop-shared/api";
import type {
  GatekeeperAppNavigateOptions,
  GatekeeperAppPathReceiver,
} from "@gadgets/workshop-shared/gatekeeper-app";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import type {
  GatekeeperUiFrame,
  TenantFileDelivery,
  GatekeeperUserSelection,
  GatekeeperUserSelectionReceiver,
} from "@gadgets/workshop-shared/gatekeeper";
import SandboxedGatekeeperApp from "./SandboxedGatekeeperApp";
import type GatekeeperUserPickerDialog from "./features/gatekeeper-sharing/GatekeeperUserPickerDialog";
import type * as Kumo from "@cloudflare/kumo";

// Most host cases use callback controls; the replacement race exercises the real picker state.
type PickerProps = ComponentProps<typeof GatekeeperUserPickerDialog>;
const picker = vi.hoisted(() => ({ props: null as PickerProps | null, real: false }));
vi.mock("./features/gatekeeper-sharing/GatekeeperUserPickerDialog", async (importOriginal) => {
  const { default: RealPicker } = await importOriginal<{
    default: typeof GatekeeperUserPickerDialog;
  }>();
  return {
    default: (props: PickerProps) => {
      picker.props = props;
      if (picker.real) return <RealPicker {...props} />;
      return <>
        <button type="button" aria-label="Close person picker" onClick={props.onClose} />
        <button type="button" aria-label="Cancel person picker" onClick={props.onCancel} />
      </>;
    },
  };
});

// The mock factory is hoisted; defer JSX until rendering, after its imports are initialized.
function DialogPart({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

vi.mock("@cloudflare/kumo", async (importOriginal) => {
  const actual = await importOriginal<typeof Kumo>();
  return {
    ...actual,
    Dialog: Object.assign(DialogPart, { Root: DialogPart, Title: DialogPart, Description: DialogPart }),
  };
});

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

const listWorkspaces = vi.fn<() => Promise<{ id: string; title: string }[]>>(async () => [
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
const authenticatedApi = { listWorkspaces, getFilesApi };

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
  selectUsers(receiver: GatekeeperUserSelectionReceiver | string): Promise<void>;
  subscribePath(receiver: GatekeeperAppPathReceiver): Promise<void>;
  navigatePath(path: unknown, options?: GatekeeperAppNavigateOptions): Promise<void>;
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

/**
 * An app's receiver that behaves like an "immediate" one: each selection is sent to a simulated
 * backend (`backend`, released by the test) before it counts as accepted, and a ticket of "reject"
 * is refused with a user-facing message.
 */
class TestReceiver extends RpcTarget implements GatekeeperUserSelectionReceiver {
  received: GatekeeperUserSelection[] = [];
  backend: Promise<void> = Promise.resolve();
  disposed = false;
  disposeCount = 0;

  async receive(selection: GatekeeperUserSelection): Promise<void> {
    this.received.push(selection);
    if (selection.ticket === "reject") throw new Error("Collection not found.");
    await this.backend;
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.disposeCount++;
  }
}

class TestPathReceiver extends RpcTarget implements GatekeeperAppPathReceiver {
  paths: string[] = [];
  disposeCount = 0;

  setPath(path: string): void {
    this.paths.push(path);
  }

  [Symbol.dispose](): void {
    this.disposeCount++;
  }
}

const ALICE: GatekeeperUserSelection = { ticket: "a".repeat(64), profile: { displayName: "Alice" } };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SandboxedGatekeeperApp navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;

  beforeEach(() => {
    listWorkspaces.mockClear();
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
    picker.props = null;
    picker.real = false;
  });

  async function render(router: AnyRouter) {
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
    return iframe;
  }

  // Mount the host under a router and complete the iframe's handshake, leaving `host` connected.
  async function mountApp(ui: RpcTarget = new EmptyUi()) {
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(ui),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => (
        <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="scheduler" path="/" />
      ),
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
    const iframe = await render(router);
    return { iframe, router };
  }

  // Mount the host the way routes/gatekeepers_.$appId.$.tsx does: one splat route hosts it and reads
  // the app-local path from its own params.
  async function mountRoutedApp(initialPath: string) {
    const frame = {
      iframeHtml: "<!doctype html><title>Context</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({ component: Outlet });
    const AppHost = () => {
      const { _splat } = appRoute.useParams();
      return <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="context" path={`/${_splat ?? ""}`} />;
    };
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/gatekeepers/$appId/$",
      component: AppHost,
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [initialPath] }),
      routeTree: rootRoute.addChildren([appRoute]),
    });
    const iframe = await render(router);
    return { iframe, router };
  }

  // Whether `promise` has settled by the next macrotask, without waiting for it.
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    await tick();
    return done;
  }

  it("delivers each pick to the app's receiver while the picker is open, one picker at a time", async () => {
    await mountApp();
    const receiver = new TestReceiver();

    let pendingPick!: Promise<void>;
    await act(async () => {
      pendingPick = host!.selectUsers(receiver);
      await tick();
    });
    expect(picker.props).not.toBeNull();
    const refusedReceiver = new TestReceiver();
    await expect(host!.selectUsers(refusedReceiver)).rejects.toThrow("A person picker is already open.");
    await vi.waitFor(() => expect(refusedReceiver.disposeCount).toBe(1));
    await expect(host!.selectUsers("collection-1")).rejects.toThrow(TypeError);

    // The receiver decides when a selection counts as taken: it awaits its own backend call, and
    // the picker's delivery stays pending until then, while selectUsers() itself stays pending.
    let releaseBackend!: () => void;
    receiver.backend = new Promise<void>((resolve) => { releaseBackend = resolve; });
    const delivery = picker.props!.onSelected(ALICE);
    await vi.waitFor(() => expect(receiver.received).toEqual([ALICE]));
    expect(await settled(delivery)).toBe(false);
    releaseBackend();
    await expect(delivery).resolves.toBeUndefined();
    expect(await settled(pendingPick)).toBe(false);

    // A refused selection fails only that delivery; the picker and its session stay up.
    const refused: GatekeeperUserSelection = { ticket: "reject", profile: { displayName: "Bob" } };
    await expect(picker.props!.onSelected(refused)).rejects.toThrow("Collection not found.");
    expect(receiver.received).toEqual([ALICE, refused]);
    expect(await settled(pendingPick)).toBe(false);
    await expect(picker.props!.onSelected(ALICE)).resolves.toBeUndefined();

    // Closing resolves selectUsers() and releases the host's hold on the receiver.
    const closePicker = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close person picker"]',
    );
    if (!closePicker) throw new Error("Missing person picker close button");
    await act(async () => closePicker.click());
    await expect(pendingPick).resolves.toBeUndefined();
    await vi.waitFor(() => expect(receiver.disposed).toBe(true));

    // A new picker can open now, with a fresh receiver.
    const again = new TestReceiver();
    let secondPick!: Promise<void>;
    await act(async () => {
      secondPick = host!.selectUsers(again);
      await tick();
    });
    await expect(picker.props!.onSelected(ALICE)).resolves.toBeUndefined();
    expect(again.received).toEqual([ALICE]);
    await act(async () => picker.props!.onClose());
    await expect(secondPick).resolves.toBeUndefined();
  });

  it("starts a usable, empty picker when closing and reopening are batched", async () => {
    picker.real = true;
    await mountApp();
    let first!: Promise<void>;
    await act(async () => {
      first = host!.selectUsers(new TestReceiver());
      await tick();
    });
    const input = container!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'previous@example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const done = () => [...container!.querySelectorAll('button')].find(button => button.textContent === 'Done')!;
    let second!: Promise<void>;
    await act(async () => {
      done().click();
      picker.props!.onClose();
      second = host!.selectUsers(new TestReceiver());
      await tick();
    });
    await first;
    expect(container!.querySelector('input')?.value).toBe('');
    expect(done().disabled).toBe(false);
    expect(await settled(second)).toBe(false);
    await act(async () => done().click());
    await expect(second).resolves.toBeUndefined();
  });

  it("cancels a stalled delivery and ignores its late callbacks after reopening", async () => {
    await mountApp();
    const receiver = new TestReceiver();
    let releaseBackend!: () => void;
    receiver.backend = new Promise<void>((resolve) => { releaseBackend = resolve; });
    let pendingPick!: Promise<void>;
    await act(async () => {
      pendingPick = host!.selectUsers(receiver);
      await tick();
    });
    const oldPicker = picker.props!;
    const delivery = oldPicker.onSelected(ALICE);
    // Disposal need not retract a call already accepted by the app.
    const deliveryOutcome = delivery.catch(() => {});
    await vi.waitFor(() => expect(receiver.received).toEqual([ALICE]));
    expect(await settled(delivery)).toBe(false);

    const cancelPicker = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Cancel person picker"]',
    );
    if (!cancelPicker) throw new Error("Missing person picker cancel button");
    await act(async () => cancelPicker.click());
    // Cancelling resolves at once, while the delivery is still running.
    await expect(pendingPick).resolves.toBeUndefined();
    expect(document.querySelector('button[aria-label="Cancel person picker"]')).toBeNull();
    // Closing must release the call itself, without waiting for the app's backend.
    await vi.waitFor(async () => expect(await settled(delivery)).toBe(true));
    await expect(delivery).rejects.toThrow(/RpcPromise was disposed/);
    await vi.waitFor(() => expect(receiver.disposeCount).toBe(1));

    const again = new TestReceiver();
    let secondPick!: Promise<void>;
    await act(async () => {
      secondPick = host!.selectUsers(again);
      await tick();
    });
    const newPicker = picker.props!;
    await act(async () => {
      oldPicker.onClose();
      oldPicker.onCancel();
    });
    await expect(oldPicker.onSelected(ALICE)).rejects.toThrow("Person selection cancelled.");
    releaseBackend();
    await deliveryOutcome;
    expect(await settled(secondPick)).toBe(false);
    expect(again.disposeCount).toBe(0);
    expect(receiver.disposeCount).toBe(1);
    await expect(newPicker.onSelected(ALICE)).resolves.toBeUndefined();
    expect(again.received).toEqual([ALICE]);
    await act(async () => newPicker.onClose());
    await expect(secondPick).resolves.toBeUndefined();
    await vi.waitFor(() => expect(again.disposeCount).toBe(1));
  });

  it("releases a stalled receiver and picker when the host unmounts", async () => {
    await mountApp();
    const receiver = new TestReceiver();
    let releaseBackend!: () => void;
    receiver.backend = new Promise<void>((resolve) => { releaseBackend = resolve; });
    let pendingPick!: Promise<void>;
    await act(async () => {
      pendingPick = host!.selectUsers(receiver);
      await tick();
    });
    const oldPicker = picker.props!;
    const delivery = oldPicker.onSelected(ALICE).catch(() => {});
    await vi.waitFor(() => expect(receiver.received).toEqual([ALICE]));
    // Teardown closes the app's connection, so the client sees a transport failure, not a cancel.
    await act(async () => root!.unmount());
    root = undefined;
    await expect(pendingPick).rejects.toThrow("Peer closed");
    await vi.waitFor(() => expect(receiver.disposeCount).toBe(1));
    oldPicker.onClose();
    oldPicker.onCancel();
    releaseBackend();
    await delivery;
    expect(receiver.disposeCount).toBe(1);
    expect(document.querySelector('button[aria-label="Close person picker"]')).toBeNull();
  });

  it("provides the deployment theme and routes bounded iframe requests", async () => {
    const { iframe, router } = await mountApp();

    const themeReceiver = new TestThemeReceiver();
    await expect(host!.subscribeTheme(themeReceiver)).resolves.toEqual({
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
    listWorkspaces
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Daily Brief" }])
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Renamed Brief" }]);
    await expect(
      Promise.all([
        host!.resolveWorkspaceTitles([WORKSPACE_ID, "b".repeat(64)]),
        host!.resolveWorkspaceTitles([WORKSPACE_ID]),
      ]),
    ).resolves.toEqual([["Daily Brief", null], ["Daily Brief"]]);
    await expect(host!.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Daily Brief"]);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30_000);
    await expect(host!.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Renamed Brief"]);
    expect(listWorkspaces).toHaveBeenCalledTimes(2);

    await expect(host!.openWorkspace("../evil")).rejects.toThrow(
      "Invalid gatekeeper app workspace target",
    );
    expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`);

    await act(async () => {
      await host!.openPrompt("  Create a daily brief.  ");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
    expect(router.state.location.search).toEqual({ prompt: "Create a daily brief." });
  });

  // The file picker, once the host has opened it and its files have loaded. Kumo's Dialog is
  // mocked to render inline, so the picker's content lands in the container.
  const openedPicker = () => vi.waitFor(() => {
    if (!container?.textContent?.includes(csvFile.name)) throw new Error("The picker is not open");
    return container;
  });

  const pickerButton = (dialog: HTMLElement, name: string) => {
    const button = [...dialog.querySelectorAll("button")].find((item) => item.textContent?.trim() === name);
    if (!button) throw new Error(`No button named ${name}`);
    return button;
  };

  it("hands the files the member picks to the gatekeeper and returns its reply to the app", async () => {
    const ui = new FileReceivingUi();
    await mountApp(ui);
    const target = { newSourceLabel: "Main street" };

    const result = host!.pickTenantFiles({ accept: [".csv", "text/csv"], multiple: true, target });
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
    expect(container!.textContent).not.toContain(csvFile.name);
  });

  it("returns null when the member cancels, and refuses a malformed request", async () => {
    const ui = new FileReceivingUi();
    await mountApp(ui);

    await expect(host!.pickTenantFiles({ accept: "csv", multiple: true, target: "source-1" }))
      .rejects.toThrow("Invalid tenant file pick request.");
    expect(container!.textContent).not.toContain(csvFile.name);

    const result = host!.pickTenantFiles({ accept: [".csv"], multiple: false, target: "source-1" });
    const dialog = await openedPicker();
    await act(async () => pickerButton(dialog, "Cancel").click());

    await expect(result).resolves.toBeNull();
    expect(ui.received).toEqual([]);
  });

  it("opens the app's provider-connect popup with an app handoff record, and refuses non-https URLs", async () => {
    await mountApp();
    const store = new Map<string, string>();
    const popup = {
      opener: window as Window | null,
      close: vi.fn<() => void>(),
      sessionStorage: {
        removeItem: (key: string) => { store.delete(key); },
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
      location: { replace: vi.fn<(url: string) => void>() },
    };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const nonce = "c".repeat(64);

    await host!.openConnectPopup({ url: "https://connect.squareup.com/oauth2/authorize?state=s", nonce });
    expect(JSON.parse(store.get("gadgets.handoff")!)).toEqual({ kind: "app", appId: "scheduler", nonce });
    expect(popup.opener).toBeNull();
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith("https://connect.squareup.com/oauth2/authorize?state=s");

    open.mockClear();
    await expect(host!.openConnectPopup({ url: "javascript:alert(1)", nonce })).rejects.toThrow("https");
    expect(open).not.toHaveBeenCalled();
  });

  it("syncs the app-local path with the URL and browser history without remounting", async () => {
    const { iframe, router } = await mountRoutedApp("/gatekeepers/context/collections/c1");
    const receiver = new TestPathReceiver();
    // The current path arrives through setPath() before subscribePath() resolves.
    await host!.subscribePath(receiver);
    expect(receiver.paths).toEqual(["/collections/c1"]);
    const lastPath = () => receiver.paths.at(-1);

    // Segments carry any character but "/"; the URL percent-encodes them.
    const filePath = "/collections/c1/files/guides/a b#?%.md";
    await act(async () => {
      await host!.navigatePath(filePath);
    });
    expect(router.state.location.href).toBe(
      "/gatekeepers/context/collections/c1/files/guides/a%20b%23%3F%25.md",
    );
    await vi.waitFor(() => expect(lastPath()).toBe(filePath));
    const pushed = router.history.length;

    // The current path is a no-op; replace swaps the entry rather than pushing one.
    await act(async () => {
      await host!.navigatePath(filePath);
      await host!.navigatePath("/collections/c1/files/renamed.md", { replace: true });
    });
    await vi.waitFor(() => expect(lastPath()).toBe("/collections/c1/files/renamed.md"));
    expect(router.history.length).toBe(pushed);

    // Back/Forward reach the live app through the same session, and the iframe stays mounted.
    await act(async () => router.history.back());
    await vi.waitFor(() => expect(lastPath()).toBe("/collections/c1"));
    await act(async () => router.history.forward());
    await vi.waitFor(() => expect(lastPath()).toBe("/collections/c1/files/renamed.md"));
    expect(container!.querySelector("iframe")).toBe(iframe);

    await act(async () => {
      await host!.navigatePath("/");
    });
    expect(router.state.location.href).toBe("/gatekeepers/context");
    await vi.waitFor(() => expect(lastPath()).toBe("/"));
  });

  it.each([
    ["a relative path", "collections/c1"],
    ["an empty segment", "/collections//c1"],
    ["a trailing slash", "/collections/c1/"],
    ["a parent segment", "/collections/../admin"],
    ["a control character", "/collections/c1\n"],
    ["an oversized path", `/${"x".repeat(4_096)}`],
    ["a non-string", 42],
  ])("rejects navigation to %s without moving", async (_name, path) => {
    const { router } = await mountRoutedApp("/gatekeepers/context/collections/c1");
    await expect(host!.navigatePath(path)).rejects.toThrow(/gatekeeper app path/i);
    expect(router.state.location.href).toBe("/gatekeepers/context/collections/c1");
  });

  it("releases a replaced path receiver and the current one on unmount", async () => {
    const { router } = await mountRoutedApp("/gatekeepers/context");
    const first = new TestPathReceiver();
    const second = new TestPathReceiver();
    await host!.subscribePath(first);
    await host!.subscribePath(second);
    await vi.waitFor(() => expect(first.disposeCount).toBe(1));

    await act(async () => {
      await host!.navigatePath("/collections/c2");
    });
    await vi.waitFor(() => expect(second.paths).toEqual(["/", "/collections/c2"]));
    expect(first.paths).toEqual(["/"]);
    expect(router.state.location.href).toBe("/gatekeepers/context/collections/c2");

    await act(async () => root!.unmount());
    root = undefined;
    await vi.waitFor(() => expect(second.disposeCount).toBe(1));
  });

  it("delivers the current path ahead of a change that commits while the app subscribes", async () => {
    const { router } = await mountRoutedApp("/gatekeepers/context/collections/c1");
    const receiver = new TestPathReceiver();
    // Until the app awaits the call, capnweb never pulls its result: this holds the window open
    // between the host running subscribePath() and the app learning the call's outcome.
    const subscription = host!.subscribePath(receiver);
    await vi.waitFor(() => expect(receiver.paths).toEqual(["/collections/c1"]));

    await act(async () => router.history.push("/gatekeepers/context/collections/c2"));
    await vi.waitFor(() => expect(receiver.paths).toEqual(["/collections/c1", "/collections/c2"]));
    await subscription;
    expect(receiver.paths).toEqual(["/collections/c1", "/collections/c2"]);
  });

  it("keeps the Workshop's own controls out of the frame's reach", async () => {
    await mountRoutedApp("/gatekeepers/context");
    const pathReceiver = new TestPathReceiver();
    await host!.subscribePath(pathReceiver);
    const theme = await host!.subscribeTheme(new TestThemeReceiver());

    // A stub forwards any name, so the frame can attempt these; the host must refuse them. An RpcPromise
    // is callable, and expect().rejects calls a function, so wrap it in a real promise first.
    const frameHost = host as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const refusal = (call: Promise<unknown>) =>
      expect(Promise.resolve(call)).rejects.toThrow("is not a function");
    await refusal(frameHost.updatePath!("/collections/forged"));
    await refusal(frameHost.updateTheme!({ mode: "dark", accentColor: null }));
    await refusal(frameHost.dispose!());

    await host!.subscribePath(pathReceiver);
    await expect(host!.subscribeTheme(new TestThemeReceiver())).resolves.toEqual(theme);
    expect(pathReceiver.paths).toEqual(["/", "/"]);
  });
});
