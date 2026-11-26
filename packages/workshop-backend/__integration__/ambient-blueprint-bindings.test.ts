// The invariants of ambient blueprint bindings (specs/007-data-output-formats/contracts/
// kernel-seam.md) that need the real Workshop: a blueprint declares "the workspace's own resource
// of this vendor", and a gadget made from it is bound to the organization's capsule when the
// organization has enabled the vendor, and to nothing otherwise. Tried with the tenant-scoped
// fixture vendor in tenant-test-gatekeeper.ts, as tenant-gatekeepers.test.ts tries the capsules
// themselves. The reconcile, the export and the format offer are covered piece by piece in
// __tests__/ambient-blueprint-bindings.test.ts.

import { DurableObject, env, exports, restore } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { RpcStub } from "capnweb";
import {
  getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES,
  type AmbientGatekeeperMode, type AuthenticatedApi, type BlueprintBinding, type BlueprintMetadata,
  type TenantGatekeepersApi, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, failure, fresh, installClerkIssuer, signIn, useClerkInDurableObjects } from "./clerkFixture";
import { blueprintContentKey } from "../src/blueprint-archive";
import { buildReleasePack, buildSnapshotRelease } from "../src/blueprint-release";
import { parseBlueprintKvRecord } from "../src/storage-schema/blueprints-kv";

const VENDOR = "tenanttest";
const bindings = env as unknown as Record<string, unknown>;

type Ledger = { type: "created" | "revoked" | "observer"; datasetId: string; observerId?: string };
const control = () => bindings.TENANT_TEST_CONTROL as { events(): Promise<Ledger[]> };

/** What a blueprint declares to be given the organization's fixture account. */
const DECLARED: BlueprintBinding = {
  title: "Tenant data", description: "The figures the gadget shows.", type: "ambient",
  vendorId: VENDOR,
};

/** How the agent is told of a declared resource the workspace cannot fill. */
const NOTHING_TO_WIRE =
    `the workspace's always-available "${VENDOR}" resource; this workspace does not have it, so ` +
    `the gadget runs without it until it is enabled (nothing for you to wire)`;

let undoClerk: () => void;

// As in tenant-gatekeepers.test.ts: the pool's Durable Object wrapper hides the overseer's
// `[restore]()`, which reaching a capsule's facet needs, so an overseer is registered whenever a
// helper below runs inside it.
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

// The operator's mode for the fixture vendor, set as the admin UI sets it.
async function setMode(mode: AmbientGatekeeperMode): Promise<void> {
  await exports.AdminSettings.getByName("").setGatekeeperMode(VENDOR, mode, {
    admin: "admin", sessionId: "ambient-blueprint-bindings", via: "api", method: "setGatekeeperMode",
  });
}

type Member = {
  id: string;
  api: RpcStub<AuthenticatedApi>;
  gatekeepers: RpcStub<TenantGatekeepersApi>;
};

async function member(sub: string, org: string, role = "admin"): Promise<Member> {
  const api = await signIn(await connect(), { sub, org, role, name: `Name of ${sub}` });
  return { id: (await api.whoami()).id, api, gatekeepers: (await api.getTenantGatekeepersApi())! };
}

/** The dataset of the organization's fixture account, as its own app reports it. */
async function datasetOf(who: Member): Promise<string> {
  const frame = (await who.api.getGatekeeperApp(VENDOR))!;
  return (JSON.parse(frame.iframeHtml) as { datasetId: string }).datasetId;
}

// Publishes a blueprint that declares `declared`, as one the deployment installed: it has no
// owner, so every organization may read it. Its code is never run here.
async function seedBlueprint(declared: Record<string, BlueprintBinding>): Promise<string> {
  const blueprintId = fresh("blueprint");
  const { commitId, objects } = buildSnapshotRelease(
      new Map([["client.js", "document.body.textContent = 'ready';\n"]]));
  const metadata: BlueprintMetadata = {
    title: "Figures", description: "", author: { type: "user", id: "seed", name: "Seed" },
    created: new Date(0), version: 1, lastUpdated: new Date(0), commitId, bindings: declared,
  };
  await env.BLUEPRINT_CONTENT.put(blueprintContentKey(blueprintId, metadata),
      await buildReleasePack(oid => objects.get(oid), commitId));
  await env.BLUEPRINTS.put(blueprintId, JSON.stringify({ metadata }));
  return blueprintId;
}

/** Makes a workspace from the blueprint as the New menu does, with nothing assigned. */
async function create(who: Member, blueprintId: string) {
  const workspace = await who.api.newWorkspaceFromBlueprint(blueprintId, {});
  const { id: workspaceId, defaultGadgetId } = await workspace.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("The new workspace has no gadget.");
  return { workspace, workspaceId, gadgetId: defaultGadgetId };
}

const overseer = (workspaceId: string) =>
    exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(workspaceId));

/**
 * What a gadget's code finds in its `env` besides GADGET and GIT, each name with the id of the
 * capsule it is bound to, beside the workspace's capsules of the fixture vendor, each with the
 * dataset its gatekeeper is for. With `reconcile`, after reconciling the capsules as an open does;
 * with `chatId`, the env of that chat's preview of the gadget.
 */
async function look(workspaceId: string, gadgetId: WorkpieceId,
                    options: { reconcile?: boolean; chatId?: number } = {}) {
  return await runInDurableObject(overseer(workspaceId), async (instance: any, state) => {
    restoreTargets.set(state, instance);
    const impl = instance.impl;
    if (options.reconcile) await impl.ensureAmbientCapsules();
    const names = Object.keys(impl.getEnvForLoader(
        gadgetId, { from: "gadget", gadgetId, chatId: options.chatId }, options.chatId))
        .filter(name => name !== "GADGET" && name !== "GIT");
    const edges = impl.getGadgetRecord(gadgetId).bindings;
    const records = [...impl.storage.gatekeepers.list()].filter((gk: any) =>
        gk.creationSpec?.type === "tenantAmbient" && gk.creationSpec.vendorId === VENDOR);
    return {
      env: Object.fromEntries(names.map(name => [name, edges[name].target as number])),
      capsules: await Promise.all(records.map(async (gk: any) => ({
        id: gk.id as number,
        datasetId: await (await impl.getGatekeeperFacet(gk.id)).datasetId() as string,
      }))),
    };
  });
}

/**
 * Creates a gadget from the blueprint in a chat as the agent's createGadget tool does: it fetches
 * the blueprint, then creates the gadget with what it fetched. Returns the gadget's id and what
 * the agent is told.
 */
async function createAsAgent(workspaceId: string, chatId: number, blueprintId: string) {
  return await runInDurableObject(overseer(workspaceId), async (instance: any, state) => {
    restoreTargets.set(state, instance);
    const blueprint = await instance.impl.fetchBlueprint(blueprintId);
    const created = instance.impl.createGadget("Figures", "FIGURES", chatId, blueprint);
    return {
      gadgetId: created.id as WorkpieceId,
      notes: blueprint.notes as string,
      missingBindings: blueprint.merge.missingBindings as Record<string, BlueprintBinding> | undefined,
    };
  });
}

describe("1. a gadget made from the blueprint has the organization's resource, on both paths", () => {
  it("binds the organization's capsule from the New menu and from the agent's createGadget",
      async () => {
    const ann = await member(fresh("ann"), fresh("org"));
    await ann.gatekeepers.enable(VENDOR);
    const datasetId = await datasetOf(ann);
    const blueprintId = await seedBlueprint({ DATA: DECLARED });

    // The New menu: created with nothing assigned, and read back before anything else reconciles.
    const { workspace, workspaceId, gadgetId } = await create(ann, blueprintId);
    using _workspace = workspace;
    using gadget = await workspace.getGadget(gadgetId);
    const [edge, ...others] = await gadget.listBindings();
    expect(others).toEqual([]);
    expect(edge).toMatchObject({ name: "DATA", target: expect.any(Number), resourceTitle: "Tenant data" });
    expect(edge).not.toHaveProperty("chatId");
    expect(await look(workspaceId, gadgetId)).toEqual(
        { env: { DATA: edge.target }, capsules: [{ id: edge.target, datasetId }] });

    // The agent: the gadget it creates in a chat has the capsule before the chat is accepted,
    // and the agent is told there is nothing to wire.
    const chatId = await workspace.newChat("hello", null);
    const created = await createAsAgent(workspaceId, chatId, blueprintId);
    expect((await look(workspaceId, created.gadgetId, { chatId })).env).toEqual({ DATA: edge.target });
    expect(created.notes).toContain("The blueprint's bindings were connected automatically.");
    expect(created.missingBindings).toBeUndefined();
  });

  it("binds nothing where the organization has not enabled the vendor, and says so to the agent",
      async () => {
    const bob = await member(fresh("bob"), fresh("org"));
    const blueprintId = await seedBlueprint({ DATA: DECLARED });

    const { workspace, workspaceId, gadgetId } = await create(bob, blueprintId);
    using _workspace = workspace;
    using gadget = await workspace.getGadget(gadgetId);
    expect(await gadget.listBindings()).toEqual([]);

    const chatId = await workspace.newChat("hello", null);
    const created = await createAsAgent(workspaceId, chatId, blueprintId);
    expect((await look(workspaceId, created.gadgetId, { chatId })).env).toEqual({});
    expect(created.notes).toContain(NOTHING_TO_WIRE);
    expect(created.missingBindings).toEqual({ DATA: DECLARED });
  });
});

describe("2. the binding follows the organization's capsule", () => {
  it("is made at the reconcile after the vendor is enabled, and again after it is re-enabled",
      async () => {
    const ann = await member(fresh("ann"), fresh("org"));
    const blueprintId = await seedBlueprint({ DATA: DECLARED });
    const { workspace, workspaceId, gadgetId } = await create(ann, blueprintId);
    using _workspace = workspace;
    expect(await look(workspaceId, gadgetId, { reconcile: true })).toEqual({ env: {}, capsules: [] });

    await ann.gatekeepers.enable(VENDOR);
    const datasetId = await datasetOf(ann);
    const enabled = await look(workspaceId, gadgetId, { reconcile: true });
    expect(enabled.capsules).toEqual([{ id: expect.any(Number), datasetId }]);
    const first = enabled.capsules[0].id;
    expect(enabled.env).toEqual({ DATA: first });

    // Turned off, the capsule leaves the workspace at its next open and the gadget's env with it.
    await ann.gatekeepers.disable(VENDOR);
    expect(await look(workspaceId, gadgetId, { reconcile: true })).toEqual({ env: {}, capsules: [] });

    // Turned on again it is a new capsule for the same dataset, and the gadget is bound to it.
    await ann.gatekeepers.enable(VENDOR);
    const again = await look(workspaceId, gadgetId, { reconcile: true });
    expect(again.capsules).toEqual([{ id: expect.any(Number), datasetId }]);
    const second = again.capsules[0].id;
    expect(second).not.toBe(first);
    expect(again.env).toEqual({ DATA: second });
  });
});

describe("3. declaring the binding never makes a capsule", () => {
  it("leaves the name out of the env while the organization has not enabled the vendor", async () => {
    const bob = await member(fresh("bob"), fresh("org"));
    const blueprintId = await seedBlueprint({ DATA: DECLARED });
    const { workspace, workspaceId, gadgetId } = await create(bob, blueprintId);
    using _workspace = workspace;

    expect(await look(workspaceId, gadgetId, { reconcile: true })).toEqual({ env: {}, capsules: [] });
    expect((await bob.gatekeepers.list()).find(info => info.vendorId === VENDOR)?.enabled).toBe(false);
    expect(await bob.api.getGatekeeperApp(VENDOR)).toBeNull();
  });

  it("leaves the name out of the env while the operator's mode is disabled", async () => {
    const ann = await member(fresh("ann"), fresh("org"));
    await ann.gatekeepers.enable(VENDOR);
    const blueprintId = await seedBlueprint({ DATA: DECLARED });
    const before = await create(ann, blueprintId);
    using _before = before.workspace;
    const bound = await look(before.workspaceId, before.gadgetId, { reconcile: true });
    expect(bound.env).toEqual({ DATA: bound.capsules[0].id });

    await setMode("disabled");
    // A gadget made now has no capsule to be bound to, and one bound before loses it.
    const during = await create(ann, blueprintId);
    using _during = during.workspace;
    expect(await look(during.workspaceId, during.gadgetId, { reconcile: true }))
        .toEqual({ env: {}, capsules: [] });
    expect(await look(before.workspaceId, before.gadgetId, { reconcile: true }))
        .toEqual({ env: {}, capsules: [] });
  });
});

describe("4. a person's unbind stands", () => {
  it("is not undone by a reconcile, nor by the capsule being replaced", async () => {
    const ann = await member(fresh("ann"), fresh("org"));
    await ann.gatekeepers.enable(VENDOR);
    const blueprintId = await seedBlueprint({ DATA: DECLARED });
    const { workspace, workspaceId, gadgetId } = await create(ann, blueprintId);
    using _workspace = workspace;
    using gadget = await workspace.getGadget(gadgetId);
    expect((await gadget.listBindings()).map(edge => edge.name)).toEqual(["DATA"]);

    await gadget.unbind("DATA");
    const unbound = await look(workspaceId, gadgetId, { reconcile: true });
    expect(unbound.env).toEqual({});
    expect(unbound.capsules).toHaveLength(1);

    await ann.gatekeepers.disable(VENDOR);
    await look(workspaceId, gadgetId, { reconcile: true });
    await ann.gatekeepers.enable(VENDOR);
    const replaced = await look(workspaceId, gadgetId, { reconcile: true });
    expect(replaced.capsules).toHaveLength(1);
    expect(replaced.capsules[0].id).not.toBe(unbound.capsules[0].id);
    expect(replaced.env).toEqual({});
  });
});

describe("6. nobody assigns an ambient binding", () => {
  it("refuses a workspace whose assignments name it, whatever they would put there", async () => {
    const ann = await member(fresh("ann"), fresh("org"));
    await ann.gatekeepers.enable(VENDOR);
    const blueprintId = await seedBlueprint({ DATA: DECLARED });

    const refused = await failure(ann.api.newWorkspaceFromBlueprint(blueprintId, {
      DATA: { type: "gatekeeper", accountId: 1, resourceUrl: "https://tenant.test/data" },
    }));
    expect(refused.message).toBe('Binding "DATA" is connected automatically and cannot be assigned.');

    // In an organization without the vendor too, where the name would otherwise be free to fill.
    const bob = await member(fresh("bob"), fresh("org"));
    const alsoRefused = await failure(bob.api.newWorkspaceFromBlueprint(blueprintId, {
      DATA: { type: "aiModel", modelId: "any-model" },
    }));
    expect(alsoRefused.message).toBe('Binding "DATA" is connected automatically and cannot be assigned.');
  });
});

describe("7. publishing a bound gadget", () => {
  it("publishes the binding by vendor alone, and a teammate's gadget made from it is bound", async () => {
    const org = fresh("org");
    const ann = await member(fresh("ann"), org);
    const tom = await member(fresh("tom"), org, "basic_member");
    await ann.gatekeepers.enable(VENDOR);
    const datasetId = await datasetOf(ann);
    const { workspace, workspaceId, gadgetId } = await create(ann, await seedBlueprint({ DATA: DECLARED }));
    using _workspace = workspace;
    using gadget = await workspace.getGadget(gadgetId);
    const { capsules } = await look(workspaceId, gadgetId);

    const published = await gadget.createBlueprint("Our figures", "The organization's figures.");
    const raw = (await env.BLUEPRINTS.get(published.id))!;
    expect(parseBlueprintKvRecord(raw).metadata.bindings).toEqual({
      DATA: { title: "Tenant data", description: "", type: "ambient", vendorId: VENDOR },
    });
    // No dataset, account or capsule of the publishing workspace is in what was published.
    expect(capsules).toEqual([{ id: expect.any(Number), datasetId }]);
    expect(raw).not.toContain(datasetId);
    expect(raw).not.toContain("accountId");
    expect(raw).not.toContain("resourceUrl");

    // A teammate's gadget made from it gets the capsule of the teammate's own workspace.
    const theirs = await create(tom, published.id);
    using _theirs = theirs.workspace;
    const seen = await look(theirs.workspaceId, theirs.gadgetId);
    expect(seen.capsules).toEqual([{ id: expect.any(Number), datasetId }]);
    expect(seen.env).toEqual({ DATA: seen.capsules[0].id });
  });
});

describe("8. only the organization's members reach a gadget bound this way", () => {
  it("verifies a teammate who is given the gadget against the organization's account", async () => {
    const org = fresh("org");
    const ann = await member(fresh("ann"), org);
    const tom = await member(fresh("tom"), org, "basic_member");
    await ann.gatekeepers.enable(VENDOR);
    const datasetId = await datasetOf(ann);
    const { workspace, workspaceId, gadgetId } = await create(ann, await seedBlueprint({ DATA: DECLARED }));
    using _workspace = workspace;
    expect((await look(workspaceId, gadgetId)).env).toHaveProperty("DATA");
    const before = (await control().events())
        .filter(event => event.type === "observer" && event.datasetId === datasetId).length;

    // The gadget alone, which reaches the capsule only through the binding the Workshop made.
    expect(await workspace.addCollaborator(tom.id, { gadgetId })).not.toBeNull();
    using shared = tom.api.openWorkspace(workspaceId);
    using theirs = await shared.getGadget(gadgetId);
    expect(await theirs.getId()).toBe(gadgetId);
    const after = (await control().events())
        .filter(event => event.type === "observer" && event.datasetId === datasetId).length;
    expect(after).toBeGreaterThan(before);
  });

  it("refuses a person from another organization at the open and at the observer check", async () => {
    const ann = await member(fresh("ann"), fresh("org"));
    const eve = await member(fresh("eve"), fresh("org"));
    await ann.gatekeepers.enable(VENDOR);
    await eve.gatekeepers.enable(VENDOR);
    const blueprintId = await seedBlueprint({ DATA: DECLARED });
    const { workspace, workspaceId, gadgetId } = await create(ann, blueprintId);
    using _workspace = workspace;
    expect((await look(workspaceId, gadgetId)).env).toHaveProperty("DATA");

    // No grant can be made to them, and no open succeeds.
    expect(await workspace.addCollaborator(eve.id, { gadgetId })).toBeNull();
    using attempt = eve.api.openWorkspace(workspaceId);
    expect(getOpenWorkspaceErrorCode(await failure(attempt.getMetadata())))
        .toBe(OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied);

    // Belt and braces: the check a holder of the gadget passes, asked inside the workspace so
    // that its refusal is a value. Having the vendor in their own organization does not help.
    const observerCheck = (id: string, gadget: WorkpieceId) => runInDurableObject(
        overseer(id), async (instance: any, state) => {
          restoreTargets.set(state, instance);
          const users = instance.impl.users;
          return await instance.impl.ensureObserver(
              eve.id, users.get(users.idFromName(eve.id)), { gadgetId: gadget })
              .then(() => null, (error: Error) => error.message);
        });
    expect(await observerCheck(workspaceId, gadgetId))
        .toBe("This workspace uses data that belongs to an organization you are not in.");

    // It is the binding that puts the capsule in the gadget's reach: unbound, the gadget has
    // nothing to verify anyone against.
    const plain = await create(ann, blueprintId);
    using _plain = plain.workspace;
    using gadget = await plain.workspace.getGadget(plain.gadgetId);
    await gadget.unbind("DATA");
    expect(await observerCheck(plain.workspaceId, plain.gadgetId)).toBeNull();
  });
});
