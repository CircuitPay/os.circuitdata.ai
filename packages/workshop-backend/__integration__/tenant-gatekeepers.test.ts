// The invariants of tenant-held gatekeeper accounts (specs/006-retail-data-layer/contracts/
// kernel-seam.md), each tried against the real Workshop and the tenant-scoped fixture vendor in
// tenant-test-gatekeeper.ts.

import { DurableObject, env, exports, restore } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  AmbientGatekeeperMode, AuthenticatedApi, PublicApi, TenantGatekeepersApi,
} from "@gadgets/workshop-shared/api";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, failure, fresh, installClerkIssuer, mint, signIn, useClerkInDurableObjects } from "./clerkFixture";
import { applyClerkEvent } from "../src/auth/clerk-webhook";
import { makeUserKey, personalTenantId } from "../src/tenant";
import server from "../src/server";

const VENDOR = "tenanttest";
const bindings = env as unknown as Record<string, unknown>;

type Ledger = { type: "created" | "revoked" | "observer"; datasetId: string; observerId?: string };
const control = () => bindings.TENANT_TEST_CONTROL as {
  events(): Promise<Ledger[]>;
  setFailRevoke(datasetId: string, fail: boolean): Promise<void>;
};

let undoClerk: () => void;

// The pool's Durable Object wrapper hides the overseer's `[restore]()`, which `ctx.restore()` (how the
// overseer reaches a capsule's facet) needs. As in __tests__/test-worker.ts, a `[restore]()` on
// `DurableObject.prototype` routes by `ctx` to the instance; an overseer is registered whenever a
// helper below runs inside it, which every test does before its capsules are reached.
const restoreTargets = new WeakMap<DurableObjectState, { [restore]?(params: unknown): unknown }>();
(DurableObject.prototype as unknown as Record<symbol, unknown>)[restore] =
    function (this: { ctx: DurableObjectState }, params: unknown): unknown {
      const target = restoreTargets.get(this.ctx);
      if (!target?.[restore]) throw new TypeError("This Durable Object is not registered for [restore]().");
      return target[restore](params);
    };

beforeAll(async () => {
  await installClerkIssuer();
  undoClerk = useClerkInDurableObjects();
  // Installed for this suite only (see the fixture's header).
  bindings.GATEKEEPER_TENANTTEST = bindings.TENANT_TEST_VENDOR;
}, 120_000);

afterEach(async () => {
  await setMode("optional");
});

afterAll(() => {
  delete bindings.GATEKEEPER_TENANTTEST;
  undoClerk();
  vi.restoreAllMocks();
});

// The operator's mode for the fixture vendor, set as the admin UI sets it. Through the AdminSettings
// object, whose config is the authority: a write to its KV mirror alone is undone by its next write
// (such as promoting the bundled formats once the first connection triggers their install).
async function setMode(mode: AmbientGatekeeperMode): Promise<void> {
  await exports.AdminSettings.getByName("").setGatekeeperMode(VENDOR, mode, {
    admin: "admin", sessionId: "tenant-gatekeepers", via: "api", method: "setGatekeeperMode",
  });
}

type Member = {
  sub: string;
  org?: string;
  api: RpcStub<AuthenticatedApi>;
  gatekeepers: RpcStub<TenantGatekeepersApi>;
};

async function member(sub: string, org?: string, role?: string): Promise<Member> {
  const api = await signIn(await connect(), { sub, org, role, name: `Name of ${sub}` });
  return { sub, org, api, gatekeepers: (await api.getTenantGatekeepersApi())! };
}

const stateOf = async (who: Member) =>
    (await who.gatekeepers.list()).find(info => info.vendorId === VENDOR);

// What the fixture's app reports: the account it belongs to and the tenant context it was opened in.
async function app(who: Member) {
  const frame = await who.api.getGatekeeperApp(VENDOR);
  return frame && {
    ...JSON.parse(frame.iframeHtml) as {
      datasetId: string; isAdmin: boolean; memberId: string | null; memberName: string | null;
      canManage: boolean | null;
    },
    ui: frame.ui as unknown as RpcStub<{ canManage(): Promise<boolean> }>,
  };
}

const overseer = (workspaceId: string) =>
    exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(workspaceId));

// Reconciles the workspace's capsules as an open does, then reports its tenant-held ones with the
// dataset each one's gatekeeper is for.
async function tenantCapsules(workspaceId: string) {
  return await runInDurableObject(overseer(workspaceId), async (instance: any, state) => {
    restoreTargets.set(state, instance);
    await instance.impl.ensureAmbientCapsules();
    const records = [...instance.impl.storage.gatekeepers.list()]
        .filter((gk: any) => gk.creationSpec?.type === "tenantAmbient");
    return await Promise.all(records.map(async (gk: any) => ({
      id: gk.id as number,
      vendorId: gk.creationSpec.vendorId as string,
      datasetId: await (await instance.impl.getGatekeeperFacet(gk.id)).datasetId() as string,
    })));
  });
}

// The names a chat's next turn binds, without reconciling capsules first.
async function nextTurnBindings(workspaceId: string, chatId: number): Promise<string[]> {
  return await runInDurableObject(overseer(workspaceId), async (instance: any, state) => {
    restoreTargets.set(state, instance);
    return (await instance.impl.prepareChatBindings(chatId, [])).map((seed: { name: string }) => seed.name);
  });
}

async function newWorkspace(who: Member): Promise<string> {
  using workspace = await who.api.newWorkspace();
  return (await workspace.getMetadata()).id;
}

const directory = (tenantId: string) => exports.UserDirectoryDurableObject.getByName(tenantId);
const STORES = { users: exports.UserDurableObject, directories: exports.UserDirectoryDurableObject };

describe("1. only an enabled record makes the account ambient", () => {
  it("offers nothing until an administrator enables it, then a capsule and an app", async () => {
    const org = fresh("org");
    const ann = await member(fresh("ann"), org, "admin");
    const workspaceId = await newWorkspace(ann);

    expect(await stateOf(ann)).toEqual(
        { vendorId: VENDOR, title: "Tenant Test", enabled: false, mode: "optional", mayManage: true });
    expect(await tenantCapsules(workspaceId)).toEqual([]);
    expect(await ann.api.getGatekeeperApp(VENDOR)).toBeNull();
    expect((await ann.api.listGatekeeperApps()).map(entry => entry.id)).not.toContain(VENDOR);

    await ann.gatekeepers.enable(VENDOR);
    expect((await stateOf(ann))?.enabled).toBe(true);
    const opened = (await app(ann))!;
    expect(opened).toMatchObject({
      isAdmin: false, memberId: makeUserKey(org, ann.sub), memberName: `Name of ${ann.sub}`,
      canManage: true,
    });
    expect(await tenantCapsules(workspaceId)).toEqual(
        [{ id: expect.any(Number), vendorId: VENDOR, datasetId: opened.datasetId }]);
    expect(await ann.api.listGatekeeperApps()).toContainEqual(
        expect.objectContaining({ id: VENDOR, title: "Tenant data" }));
  });

  it("is never provisioned per user, and enabling twice mints one account", async () => {
    const ann = await member(fresh("ann"), fresh("org"), "admin");
    expect((await ann.api.listAddableGatekeepers()).map(vendor => vendor.id)).not.toContain(VENDOR);
    await expect(ann.api.provisionAmbientAccount(VENDOR)).rejects.toThrow("can't be added this way");

    await Promise.all([ann.gatekeepers.enable(VENDOR), ann.gatekeepers.enable(VENDOR)]);
    const { datasetId } = (await app(ann))!;
    const created = (await control().events()).filter(event => event.type === "created");
    expect(created.filter(event => event.datasetId === datasetId)).toHaveLength(1);
  });

  it("is enabled for every tenant on first use in the operator's enabled mode, and stays on", async () => {
    await setMode("enabled");
    const ann = await member(fresh("ann"), fresh("org"), "admin");
    expect(await stateOf(ann)).toMatchObject({ enabled: true, mode: "enabled", mayManage: false });
    expect(await tenantCapsules(await newWorkspace(ann))).toHaveLength(1);
    await expect(ann.gatekeepers.disable(VENDOR)).rejects.toThrow("can't be turned off");
  });
});

describe("2. no method takes a tenant, and tenants never see each other's account", () => {
  it("keeps organization A's account out of organization B", async () => {
    const annA = await member(fresh("ann"), fresh("orgA"), "admin");
    const bobB = await member(fresh("bob"), fresh("orgB"), "admin");
    await annA.gatekeepers.enable(VENDOR);
    const datasetA = (await app(annA))!.datasetId;

    const workspaceB = await newWorkspace(bobB);
    expect((await stateOf(bobB))?.enabled).toBe(false);
    expect(await tenantCapsules(workspaceB)).toEqual([]);
    expect(await bobB.api.getGatekeeperApp(VENDOR)).toBeNull();

    // B's own capability acts on B alone: disabling there leaves A's on, and enabling mints B's own.
    await bobB.gatekeepers.disable(VENDOR);
    expect((await stateOf(annA))?.enabled).toBe(true);
    await bobB.gatekeepers.enable(VENDOR);
    const datasetB = (await app(bobB))!.datasetId;
    expect(datasetB).not.toBe(datasetA);
    expect((await tenantCapsules(workspaceB)).map(capsule => capsule.datasetId)).toEqual([datasetB]);
  });

  it("verifies a teammate who opens the workspace through the tenant's own account", async () => {
    const org = fresh("org");
    const ann = await member(fresh("ann"), org, "admin");
    const tom = await member(fresh("tom"), org, "basic_member");
    await ann.gatekeepers.enable(VENDOR);
    const { datasetId } = (await app(ann))!;

    using workspace = await ann.api.newWorkspace();
    const workspaceId = (await workspace.getMetadata()).id;
    expect(await tenantCapsules(workspaceId)).toHaveLength(1);
    const tomId = (await tom.api.whoami()).id;
    expect(await workspace.addCollaborator(tomId, "workspace")).not.toBeNull();
    using shared = tom.api.openWorkspace(workspaceId);
    expect((await shared.getMetadata()).id).toBe(workspaceId);
    expect(await control().events()).toContainEqual(
        expect.objectContaining({ type: "observer", datasetId }));
  });
});

describe("3. only an administrator manages, judged on every call", () => {
  it("refuses a member who is not an administrator", async () => {
    const org = fresh("org");
    const tom = await member(fresh("tom"), org, "basic_member");
    expect(await stateOf(tom)).toMatchObject({ enabled: false, mayManage: false });
    expect((await failure(tom.gatekeepers.enable(VENDOR))).message)
        .toBe("Only an administrator of this organization can do that.");
    expect((await stateOf(tom))?.enabled).toBe(false);

    const ann = await member(fresh("ann"), org, "admin");
    await ann.gatekeepers.enable(VENDOR);
    await expect(tom.gatekeepers.disable(VENDOR)).rejects.toThrow("Only an administrator");
    expect((await stateOf(ann))?.enabled).toBe(true);
    expect((await app(tom))?.canManage).toBe(false);
  });

  it("refuses an administrator demoted mid-session on their next call", async () => {
    const org = fresh("org");
    const ann = await member(fresh("ann"), org, "admin");
    await ann.gatekeepers.enable(VENDOR);
    const opened = (await app(ann))!;
    expect(await opened.ui.canManage()).toBe(true);

    await ann.api.renewSession(await mint({ sub: ann.sub, org, role: "basic_member" }));
    await expect(ann.gatekeepers.disable(VENDOR)).rejects.toThrow("Only an administrator");
    expect(await opened.ui.canManage()).toBe(false);
    expect((await stateOf(ann))?.enabled).toBe(true);
  });
});

describe("4. disabling stops offering it and keeps its data", () => {
  it("leaves it out of the next turn and the next open, and re-enabling restores the same dataset", async () => {
    const ann = await member(fresh("ann"), fresh("org"), "admin");
    await ann.gatekeepers.enable(VENDOR);
    const { datasetId } = (await app(ann))!;

    using workspace = await ann.api.newWorkspace();
    const workspaceId = (await workspace.getMetadata()).id;
    expect(await tenantCapsules(workspaceId)).toHaveLength(1);
    const chatId = await workspace.newChat("hello", null);
    expect(await nextTurnBindings(workspaceId, chatId)).toContain("TENANT_DATA");

    await ann.gatekeepers.disable(VENDOR);
    expect(await nextTurnBindings(workspaceId, chatId)).not.toContain("TENANT_DATA");
    expect(await tenantCapsules(workspaceId)).toEqual([]);
    expect(await ann.api.getGatekeeperApp(VENDOR)).toBeNull();
    expect(await control().events()).not.toContainEqual({ type: "revoked", datasetId });

    await ann.gatekeepers.enable(VENDOR);
    expect((await app(ann))!.datasetId).toBe(datasetId);
    expect((await tenantCapsules(workspaceId)).map(capsule => capsule.datasetId)).toEqual([datasetId]);
  });
});

describe("5. a member leaving does not touch the tenant's accounts", () => {
  it("keeps the account enabled when its administrator leaves", async () => {
    const org = fresh("org");
    const ann = await member(fresh("ann"), org, "admin");
    const eve = await member(fresh("eve"), org, "admin");
    await ann.gatekeepers.enable(VENDOR);
    const { datasetId } = (await app(ann))!;

    await applyClerkEvent({
      type: "organizationMembership.deleted",
      data: { organization: { id: org }, public_user_data: { user_id: ann.sub } },
    }, STORES);

    expect((await stateOf(eve))?.enabled).toBe(true);
    expect((await app(eve))!.datasetId).toBe(datasetId);
    expect(await control().events()).not.toContainEqual({ type: "revoked", datasetId });
  });
});

describe("6. erasing a tenant revokes its accounts", () => {
  it("revokes on organization.deleted, failing until the revoke succeeds", async () => {
    const org = fresh("org");
    const ann = await member(fresh("ann"), org, "admin");
    await ann.gatekeepers.enable(VENDOR);
    const { datasetId } = (await app(ann))!;

    await control().setFailRevoke(datasetId, true);
    const deleted = { type: "organization.deleted", data: { id: org } };
    await expect(applyClerkEvent(deleted, STORES)).rejects.toThrow("revoke failed");
    expect(await directory(org).listTenantAccounts()).toHaveLength(1);

    await control().setFailRevoke(datasetId, false);
    await applyClerkEvent(deleted, STORES);
    expect(await control().events()).toContainEqual({ type: "revoked", datasetId });
    expect(await directory(org).listTenantAccounts()).toEqual([]);
  });

  it("erases the personal workspace's accounts on user.deleted", async () => {
    const sub = fresh("solo");
    const solo = await member(sub);
    expect((await stateOf(solo))?.mayManage).toBe(true);
    await solo.gatekeepers.enable(VENDOR);
    const { datasetId } = (await app(solo))!;

    await applyClerkEvent({ type: "user.deleted", data: { id: sub } }, STORES);
    expect(await control().events()).toContainEqual({ type: "revoked", datasetId });
    expect(await directory(personalTenantId(sub)).listTenantAccounts()).toEqual([]);
  });
});

describe("7. the operator's disabled mode overrides the tenant's record", () => {
  it("blocks enabling, the capsule, the app and the class", async () => {
    const org = fresh("org");
    const ann = await member(fresh("ann"), org, "admin");
    await ann.gatekeepers.enable(VENDOR);
    const workspaceId = await newWorkspace(ann);
    expect(await tenantCapsules(workspaceId)).toHaveLength(1);

    await setMode("disabled");
    expect(await stateOf(ann)).toMatchObject({ enabled: true, mode: "disabled", mayManage: false });
    expect(await tenantCapsules(workspaceId)).toEqual([]);
    expect(await ann.api.getGatekeeperApp(VENDOR)).toBeNull();
    // The chokepoint itself, asked inside the user object so its refusal is not an RPC rejection.
    expect(await runInDurableObject(exports.UserDurableObject.getByName(makeUserKey(org, ann.sub)),
        async (instance: any) => await instance.getTenantSingletonGatekeeperClass(VENDOR)
            .then(() => null, (error: Error) => error.message)))
        .toBe('The "tenanttest" gatekeeper is disabled on this deployment by an administrator.');

    const other = await member(fresh("bob"), fresh("org"), "admin");
    await expect(other.gatekeepers.enable(VENDOR)).rejects.toThrow("disabled");
  });
});

describe("8. deployments without Clerk", () => {
  it("offer no capability and list no tenant app", async () => {
    undoClerk();
    try {
      const response = await server.fetch(new Request("https://workshop.invalid/api", {
        headers: { Upgrade: "websocket" },
      }), env, createExecutionContext());
      const socket = response.webSocket!;
      socket.accept();
      using publicApi = newWebSocketRpcSession<PublicApi>(socket);
      const name = fresh("legacy");
      const token = await publicApi.createAccount(name, name, new Uint8Array([1, 2, 3]));
      using api = await publicApi.authenticate(token!);
      expect(await api.getTenantGatekeepersApi()).toBeNull();
      expect((await api.listGatekeeperApps()).map(entry => entry.id)).not.toContain(VENDOR);
      expect(await api.getGatekeeperApp(VENDOR)).toBeNull();
      // The legacy directory is no tenant. Asked inside the object, so the refusal is not an RPC one.
      expect(await runInDurableObject(directory(""), async (instance: any) =>
          await instance.listTenantAccounts().then(() => null, (error: Error) => error.message)))
          .toBe("Only a named tenant can hold gatekeeper accounts.");
    } finally {
      undoClerk = useClerkInDurableObjects();
    }
  });
});
