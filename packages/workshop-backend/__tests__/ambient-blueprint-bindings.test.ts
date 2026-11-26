// Ambient blueprint bindings (specs/007-data-output-formats/contracts/kernel-seam.md): a blueprint
// may declare a binding that is "the workspace's own always-available resource of this vendor", and
// the Overseer binds a gadget made from it to that resource, when the workspace has one and
// whenever one returns. Nobody picks an account for it, and declaring it creates nothing.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) over real storage. The
// owner's user DO is faked, with a list of singleton accounts a test connects and disconnects, and
// so are the capsules' facets and the BLUEPRINTS namespace. The tenant-held kind of resource, and
// newWorkspaceFromBlueprint itself, are exercised against the real Workshop in
// __integration__/ambient-blueprint-bindings.test.ts.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, BlueprintBinding, BlueprintMetadata, BlueprintOutput, Overseer, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { listFormatOffers } from "../src/admin-config.js";
import { blueprintContentKey } from "../src/blueprint-archive.js";
import { buildReleasePack, buildSnapshotRelease } from "../src/blueprint-release.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";
import { parseBlueprintKvRecord } from "../src/storage-schema/blueprints-kv.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const VENDOR = "library";
const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = {
  type: "user", id: "olive@example.com", name: "Olive", commitEmail: "olive@commits.example",
};
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER_META = { profile: OWNER };
const CHAT = 1;

const FILES = new Map([["client.js", "document.body.textContent = 'ready';\n"]]);
const OUTPUT: BlueprintOutput = { id: "report", noun: "Report", plural: "Reports", icon: "fileText" };

/** What a blueprint declares to be given the workspace's resource of `vendorId`. */
function ambient(vendorId = VENDOR): BlueprintBinding {
  return { title: "Library", description: "What the figures are read from.", type: "ambient", vendorId };
}

/** A binding a person fills with a resource of their own. */
const PICKED: BlueprintBinding = {
  title: "Tracker", description: "", type: "gatekeeper", gatekeeperName: "testvendor",
  typeUrlPattern: "https://*",
};

// Stands in for the BLUEPRINTS namespace, which the suites' Worker does not bind (see
// blueprints.test.ts).
const kv = new Map<string, string>();
const BLUEPRINTS = {
  get: async (key: string) => kv.get(key) ?? null,
  put: async (key: string, value: string) => { kv.set(key, value); },
  delete: async (key: string) => { kv.delete(key); },
} as unknown as KVNamespace;

interface Workspace {
  instance: OverseerDurableObject;
  impl: any;
  client: Overseer;

  /**
   * The owner's singleton accounts, as their user DO lists them. A test connects, disconnects or
   * replaces one by changing this, then reconciles the workspace's capsules as an open does.
   */
  accounts: { vendorId: string, accountId: number }[];

  /** The reason of each restart of collaborators' sessions that the workspace scheduled. */
  restarts: string[];
}

let counter = 0;

// Opens the real OverseerClientInterface (as the owner) over a fresh Overseer, as blueprints.test.ts
// does. The capsule reconcile that an owner's open leaves running in the background is held back,
// so that each test runs it when it means to (see reconcile()).
async function withWorkspace(fn: (workspace: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`ambient-blueprint-bindings-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.env = { ...impl.env, BLUEPRINTS };
    impl.ownerId = OWNER_USER_ID;
    impl.markOutputsDirty = () => {};
    // A real ctx.abort() would kill the test DO (see observer-scope-restart.test.ts).
    let restarts: string[] = [];
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
    // The fake accounts have no gatekeeper behind them to describe a capsule.
    impl.getGatekeeperFacet = async () => ({
      describe: async () => ({ title: "Team library", url: "https://library.example/" }),
    });
    // A gadget's env is read back as what each name is bound to.
    impl.makeBindingLoopback = (target: unknown) => target;

    let accounts: Workspace["accounts"] = [];
    let owner = {
      id: OWNER_USER_ID,
      whoami: async () => OWNER,
      listProvidedAccounts: async () => accounts.map(account => ({
        ...account, description: { displayName: "Library", singleton: { tsType: "Library" } },
      })),
      getSingletonGatekeeperClass: async () => ({}),
      listBlueprints: async () => [],
      listLibraryBlueprints: async () => [],
      updateBlueprint: async () => false,  // not featured
      setWorkspaceLastActive: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, idFromName: () => OWNER_USER_ID, get: () => owner };

    impl.ensureAmbientCapsules = async () => {};
    // Disposed with the session: the session holds a duplicate of the stub until then.
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    delete impl.ensureAmbientCapsules;  // back to the Overseer's own

    await fn({ instance, impl, client, accounts, restarts });
  });
}

/** Reconciles the workspace's capsules with the owner's accounts, as every open does. */
async function reconcile({ impl }: Workspace): Promise<void> {
  await impl.ensureAmbientCapsules();
}

/** Publishes a blueprint of FILES that declares `bindings`, as a deployment's own, and returns its id. */
async function storeBlueprint(bindings: Record<string, BlueprintBinding>): Promise<string> {
  let blueprintId = `ambient-blueprint-${++counter}`;
  let { commitId, objects } = buildSnapshotRelease(FILES);
  let metadata: BlueprintMetadata = {
    title: "Figures", description: "", author: OWNER, created: new Date(0), version: 1,
    lastUpdated: new Date(0), commitId, output: OUTPUT, bindings,
  };
  await env.BLUEPRINT_CONTENT.put(blueprintContentKey(blueprintId, metadata),
      await buildReleasePack(oid => objects.get(oid), commitId));
  kv.set(blueprintId, JSON.stringify({ metadata }));
  return blueprintId;
}

function publishedMetadata(blueprintId: string): BlueprintMetadata {
  return parseBlueprintKvRecord(kv.get(blueprintId)!).metadata;
}

/**
 * Makes the workspace's gadget from a blueprint as AuthenticatedApi.newWorkspaceFromBlueprint() has
 * the Overseer do it, after the open that reconciled the capsules, and returns the gadget's id.
 */
async function instantiate(workspace: Workspace, blueprintId: string): Promise<WorkpieceId> {
  await reconcile(workspace);
  await workspace.instance.initializeFromBlueprint(blueprintId, publishedMetadata(blueprintId));
  let [gadget, ...others] = [...workspace.impl.storage.gadgets.list()];
  expect(others).toEqual([]);
  return gadget.id;
}

/**
 * Creates a gadget from a blueprint in CHAT as the agent's createGadget tool does: it fetches the
 * blueprint, then creates the gadget with what it fetched. Returns the gadget's id and what the
 * agent is told.
 */
async function createInChat({ impl }: Workspace, blueprintId: string, bindingName = "FIGURES") {
  if (!impl.storage.chatMeta.get(CHAT)) {
    impl.storage.chatMeta.put(
        { id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  }
  let blueprint = await impl.fetchBlueprint(blueprintId);
  let created = impl.createGadget("Figures", bindingName, CHAT, blueprint);
  return { gadgetId: created.id as WorkpieceId, blueprint };
}

/** Records the creation on a "changes" message, as the step's barrier does, and accepts the chat. */
async function acceptCreation({ impl }: Workspace, gadgetId: WorkpieceId, bindingName = "FIGURES")
    : Promise<void> {
  await impl.commitAgentStep(CHAT, AGENT, [{ type: "message", message: "created a gadget" }], {
    changes: [],
    createdGadgets: [{ gadgetId, title: "Figures", bindingName }],
    addedBindings: [],
    createdWorktrees: [],
    worktreeCommits: [],
  });
  expect(await impl.mergeChanges(CHAT, USER_META, OWNER_USER_ID)).toEqual({ outcome: "merged" });
}

/**
 * What the gadget's code finds in its `env` besides GADGET and GIT: each name, with the id of the
 * connection it is bound to. With `chatId`, as the gadget runs in that chat's preview.
 */
function boundEnv({ impl }: Workspace, gadgetId: WorkpieceId, chatId?: number): Record<string, number> {
  let { GADGET: _gadget, GIT: _git, ...bound } =
      impl.getEnvForLoader(gadgetId, { from: "gadget", gadgetId }, chatId) as
          Record<string, { type: string, id: number }>;
  return Object.fromEntries(Object.entries(bound).map(([name, target]) => [name, target.id]));
}

/** The ids of the workspace's always-available capsules of VENDOR. */
function capsules({ impl }: Workspace): number[] {
  return [...impl.storage.gatekeepers.list()]
      .filter(gk => gk.creationSpec?.type === "ambient" && gk.creationSpec.vendorId === VENDOR)
      .map(gk => gk.id);
}

/**
 * The workspace's one capsule of VENDOR. Asserted, since a missing id would read as a missing
 * binding in the comparisons below.
 */
function theCapsule(workspace: Workspace): number {
  let ids = capsules(workspace);
  expect(ids).toEqual([expect.any(Number)]);
  return ids[0];
}

/** The connections a "use" collaborator of the gadget is verified against. */
function verifiedAgainst({ impl }: Workspace, gadgetId: WorkpieceId): number[] {
  return impl.listObserverRequirements({ gadgetId })
      .map((need: { gatekeeperId: number }) => need.gatekeeperId);
}

// A connection a person made, to stand where a declared resource would.
function seedConnection({ impl }: Workspace, id: number): void {
  impl.storage.gatekeepers.put({
    id, resourceTitle: `Connection ${id}`, class: {} as any,
    creationSpec: {
      type: "gatekeeper", vendorId: "testvendor", resourceUrl: `https://example.com/${id}`,
      typeUrlPattern: "https://*",
    },
  });
}

describe("a gadget made from a blueprint that declares an always-available resource", () => {
  it("is bound to the workspace's capsule when it is instantiated from the New menu", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      let gadgetId = await instantiate(workspace, blueprintId);

      let capsule = theCapsule(workspace);
      expect(boundEnv(workspace, gadgetId)).toEqual({ LIBRARY: capsule });
      // An ordinary accepted edge, as the Connections panel lists it.
      let gadget = await workspace.client.getGadget(gadgetId);
      expect(await gadget.listBindings()).toEqual([
        { name: "LIBRARY", target: capsule, resourceTitle: "Team library", vendorId: undefined },
      ]);
    });
  });

  it("is bound when the agent creates it in a chat, before the creation is accepted", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      await reconcile(workspace);
      let capsule = theCapsule(workspace);
      // Somebody is using another gadget of the workspace meanwhile.
      workspace.impl.storage.gadgets.put({
        type: "gadget", id: 900, title: "Other", created: new Date(0), bindingName: "OTHER",
        bindings: {},
      });
      workspace.impl.joinSession({ kind: "use", profileId: "alice" }, 900);

      let { gadgetId, blueprint } = await createInChat(workspace, blueprintId);

      // The chat's preview of the gadget has the resource at once, and the agent is told that it
      // has nothing to wire.
      expect(boundEnv(workspace, gadgetId, CHAT)).toEqual({ LIBRARY: capsule });
      expect(blueprint.ambientBindings).toEqual({ LIBRARY: VENDOR });
      expect(blueprint.notes).toContain("The blueprint's bindings were connected automatically.");
      expect(blueprint.notes).not.toContain("LIBRARY");
      expect(blueprint.merge.missingBindings).toBeUndefined();
      // Nobody can hold a gadget that is still pending, so binding it severs no session.
      expect(() => verifiedAgainst(workspace, gadgetId)).toThrow(/No such gadget/);
      expect(workspace.restarts).toEqual([]);

      // Accepted, the gadget keeps the resource, which is in its scope and nobody else's.
      await acceptCreation(workspace, gadgetId);
      expect(workspace.impl.storage.gadgets.get(gadgetId).pending).toBeUndefined();
      expect(boundEnv(workspace, gadgetId)).toEqual({ LIBRARY: capsule });
      expect(verifiedAgainst(workspace, gadgetId)).toEqual([capsule]);
      expect(verifiedAgainst(workspace, 900)).toEqual([]);
      expect(workspace.restarts).toEqual([]);
    });
  });

  it("loses the binding with the gadget when its creation in a chat is never recorded", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      await reconcile(workspace);
      let capsule = theCapsule(workspace);
      let { gadgetId } = await createInChat(workspace, blueprintId);
      expect(boundEnv(workspace, gadgetId, CHAT)).toEqual({ LIBRARY: capsule });

      // The step that created it died before its barrier: with no turn running, the record is an
      // orphan. Reaping it takes its edge along and leaves the capsule to the workspace.
      await workspace.impl.reconcilePendingGadgets(CHAT);
      expect(workspace.impl.storage.gadgets.get(gadgetId)).toBeUndefined();
      expect(capsules(workspace)).toEqual([capsule]);

      // Nothing of it is left to bind, and its name is free for the turn that tries again.
      await reconcile(workspace);
      let again = await createInChat(workspace, blueprintId);
      expect(boundEnv(workspace, again.gadgetId, CHAT)).toEqual({ LIBRARY: capsule });
    });
  });

  it("is created without the resource in a workspace that has none, and makes no capsule", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });

    await withWorkspace(async workspace => {
      let gadgetId = await instantiate(workspace, blueprintId);
      expect(boundEnv(workspace, gadgetId)).toEqual({});

      // The agent's path binds nothing either, and says why there is nothing to wire.
      let created = await createInChat(workspace, blueprintId);
      expect(boundEnv(workspace, created.gadgetId, CHAT)).toEqual({});
      expect(created.blueprint.notes).toContain(
          `* LIBRARY — "Library" (the workspace's always-available "library" resource; this ` +
          `workspace does not have it, so the gadget runs without it until it is enabled ` +
          `(nothing for you to wire)): What the figures are read from.`);
      expect(created.blueprint.merge.missingBindings).toEqual({ LIBRARY: ambient() });

      // Declaring the resource is not a way to get one.
      await reconcile(workspace);
      expect(capsules(workspace)).toEqual([]);
      expect(boundEnv(workspace, gadgetId)).toEqual({});
    });
  });

  it("is not given another vendor's resource", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient("otherlibrary") });

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      let gadgetId = await instantiate(workspace, blueprintId);
      expect(capsules(workspace)).toHaveLength(1);
      expect(boundEnv(workspace, gadgetId)).toEqual({});
    });
  });

  it("gains the resource at the reconcile after it appears, and again after it is replaced",
      async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });

    await withWorkspace(async workspace => {
      let gadgetId = await instantiate(workspace, blueprintId);
      expect(boundEnv(workspace, gadgetId)).toEqual({});

      // The owner connects the account: the next open's reconcile makes the capsule and binds it.
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      await reconcile(workspace);
      let first = theCapsule(workspace);
      expect(boundEnv(workspace, gadgetId)).toEqual({ LIBRARY: first });

      // Disconnected, the capsule goes and takes the edge with it.
      workspace.accounts.length = 0;
      await reconcile(workspace);
      expect(capsules(workspace)).toEqual([]);
      expect(boundEnv(workspace, gadgetId)).toEqual({});

      // Connected again it is another account and another capsule, which the gadget is bound to.
      workspace.accounts.push({ vendorId: VENDOR, accountId: 4 });
      await reconcile(workspace);
      let second = theCapsule(workspace);
      expect(second).not.toBe(first);
      expect(boundEnv(workspace, gadgetId)).toEqual({ LIBRARY: second });

      // A reconcile with nothing to do leaves it as it is.
      await reconcile(workspace);
      expect(boundEnv(workspace, gadgetId)).toEqual({ LIBRARY: second });
    });
  });

  it("has a collaborator who holds the gadget verified again when the resource arrives", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });

    await withWorkspace(async workspace => {
      let gadgetId = await instantiate(workspace, blueprintId);
      expect(verifiedAgainst(workspace, gadgetId)).toEqual([]);
      workspace.impl.joinSession({ kind: "use", profileId: "alice" }, gadgetId);

      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      await reconcile(workspace);

      // The gadget they drive can now read the resource, which they were never verified against.
      let capsule = theCapsule(workspace);
      expect(verifiedAgainst(workspace, gadgetId)).toEqual([capsule]);
      expect(workspace.restarts).toHaveLength(1);
    });
  });

  it("stays unbound once a person unbinds it", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      let gadgetId = await instantiate(workspace, blueprintId);
      let gadget = await workspace.client.getGadget(gadgetId);
      await gadget.unbind("LIBRARY");
      expect(boundEnv(workspace, gadgetId)).toEqual({});

      // Neither the next open nor a new capsule of the vendor puts it back.
      await reconcile(workspace);
      expect(boundEnv(workspace, gadgetId)).toEqual({});
      workspace.accounts[0].accountId = 4;
      await reconcile(workspace);
      expect(capsules(workspace)).toHaveLength(1);
      expect(boundEnv(workspace, gadgetId)).toEqual({});
    });
  });

  it("keeps the binding under the name a person renames it to", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      let gadgetId = await instantiate(workspace, blueprintId);
      let gadget = await workspace.client.getGadget(gadgetId);
      await gadget.renameBinding("LIBRARY", "DOCS");

      // The capsule is replaced: the gadget is bound to the new one under the new name only.
      workspace.accounts[0].accountId = 4;
      await reconcile(workspace);
      let capsule = theCapsule(workspace);
      expect(boundEnv(workspace, gadgetId)).toEqual({ DOCS: capsule });
    });
  });

  it("leaves a declared name alone that already holds something else", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient(), NOTES: ambient() });

    await withWorkspace(async workspace => {
      let gadgetId = await instantiate(workspace, blueprintId);
      seedConnection(workspace, 500);
      seedConnection(workspace, 501);
      workspace.impl.storage.chatMeta.put(
          { id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
      // A person bound one declared name to a connection of their own, and a chat proposes
      // another.
      let gadget = await workspace.client.getGadget(gadgetId);
      await gadget.bind("LIBRARY", 500);
      workspace.impl.bindWorkpiece(gadgetId, "NOTES", 501, CHAT);

      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      await reconcile(workspace);

      expect(capsules(workspace)).toHaveLength(1);
      expect(boundEnv(workspace, gadgetId)).toEqual({ LIBRARY: 500 });
      expect(boundEnv(workspace, gadgetId, CHAT)).toEqual({ LIBRARY: 500, NOTES: 501 });
    });
  });

  it("skips a declared name that cannot be a binding, and binds the others", async () => {
    let blueprintId = await storeBlueprint({
      GADGET: ambient(), "not a name": ambient(), LIBRARY: ambient(),
    });

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      let gadgetId = await instantiate(workspace, blueprintId);
      let capsule = theCapsule(workspace);
      expect(workspace.impl.getEnvForLoader(gadgetId, { from: "gadget", gadgetId })).toEqual({
        GADGET: { type: "gadget", id: gadgetId },
        GIT: { type: "git" },
        LIBRARY: { type: "gatekeeper", id: capsule },
      });

      // The same blueprint through the agent's path.
      let created = await createInChat(workspace, blueprintId);
      expect(boundEnv(workspace, created.gadgetId, CHAT)).toEqual({ LIBRARY: capsule });
    });
  });

  it("tells the agent only of the bindings left for it to wire", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient(), TRACKER: PICKED });

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      await reconcile(workspace);
      let capsule = theCapsule(workspace);

      let { gadgetId, blueprint } = await createInChat(workspace, blueprintId);
      expect(boundEnv(workspace, gadgetId, CHAT)).toEqual({ LIBRARY: capsule });
      expect(blueprint.notes).toContain(`* TRACKER — "Tracker" (external resource via the "testvendor" gatekeeper`);
      expect(blueprint.notes).not.toContain("LIBRARY");
      expect(blueprint.notes).not.toContain("connected automatically");
      expect(blueprint.merge.missingBindings).toEqual({ TRACKER: PICKED });
    });
  });

  it("is listed for the agent as needing an always-available resource", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient(), TRACKER: PICKED });

    await withWorkspace(async ({ impl }) => {
      let owner = impl.users.get();
      owner.listLibraryBlueprints = async () =>
          [{ id: blueprintId, metadata: publishedMetadata(blueprintId) }];
      expect(await impl.listAvailableBlueprints(OWNER)).toContain(
          "Bindings required: LIBRARY (always-available resource: library), " +
          "TRACKER (external resource: testvendor)");
    });
  });
});

describe("publishing a gadget that is bound to an always-available resource", () => {
  it("publishes the binding by vendor alone, and a gadget made from it is bound in turn", async () => {
    let blueprintId = await storeBlueprint({ LIBRARY: ambient() });
    let republished!: string;

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      let gadgetId = await instantiate(workspace, blueprintId);
      let gadget = await workspace.client.getGadget(gadgetId);

      // What the capsule calls itself, and what the publisher says the gadget uses it for. The
      // title and the suggestion a person's binding could carry do not apply.
      await gadget.setBlueprintAnnotation("LIBRARY",
          { title: "A title for it", description: "Where the figures come from.", suggestValue: true });
      republished = (await gadget.createBlueprint("Figures, again", "A copy")).id;
      expect(publishedMetadata(republished).bindings).toStrictEqual({
        LIBRARY: {
          title: "Team library", description: "Where the figures come from.", type: "ambient",
          vendorId: VENDOR,
        },
      });
      // Nothing of this workspace's account or capsule travels.
      let record = kv.get(republished)!;
      expect(record).not.toContain("accountId");
      expect(record).not.toContain("library.example");
      expect(publishedMetadata(republished).bindings.LIBRARY).not.toHaveProperty("resourceUrl");
    });

    // In a workspace with the resource, a gadget made from the published blueprint is bound to
    // that workspace's own; in one without, to nothing.
    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 8 });
      let gadgetId = await instantiate(workspace, republished);
      expect(boundEnv(workspace, gadgetId)).toEqual({ LIBRARY: theCapsule(workspace) });
    });
    await withWorkspace(async workspace => {
      let gadgetId = await instantiate(workspace, republished);
      expect(boundEnv(workspace, gadgetId)).toEqual({});
    });
  });

  it("publishes a capsule that was bound by hand the same way, beside a person's own binding",
      async () => {
    let blueprintId = await storeBlueprint({});

    await withWorkspace(async workspace => {
      workspace.accounts.push({ vendorId: VENDOR, accountId: 3 });
      let gadgetId = await instantiate(workspace, blueprintId);
      let capsule = theCapsule(workspace);
      seedConnection(workspace, 500);
      let gadget = await workspace.client.getGadget(gadgetId);
      await gadget.bind("DOCS", capsule);
      await gadget.bind("TRACKER", 500);

      let { id } = await gadget.createBlueprint("Bound by hand", "");
      expect(publishedMetadata(id).bindings).toStrictEqual({
        DOCS: { title: "Team library", description: "", type: "ambient", vendorId: VENDOR },
        TRACKER: {
          title: "Connection 500", description: "", type: "gatekeeper",
          gatekeeperName: "testvendor", typeUrlPattern: "https://*",
        },
      });
    });
  });
});

describe("a format's setup step", () => {
  // The New menu creates a format at once unless it says a person has something to fill in first.
  async function requiresSetup(bindings: Record<string, BlueprintBinding>): Promise<boolean> {
    let blueprintId = await storeBlueprint(bindings);
    let config = { ...DEFAULT_ADMIN_CONFIG, formats: [{ blueprintId, enabled: true }] };
    let [offer, ...others] = await listFormatOffers({ BLUEPRINTS }, config);
    expect(others).toEqual([]);
    expect(offer).toMatchObject({ blueprintId, output: OUTPUT });
    return offer.requiresSetup;
  }

  it("is skipped when every binding the blueprint declares is connected automatically", async () => {
    expect(await requiresSetup({ LIBRARY: ambient() })).toBe(false);
    expect(await requiresSetup({ LIBRARY: ambient(), ARCHIVE: ambient("archive") })).toBe(false);
    expect(await requiresSetup({})).toBe(false);
  });

  it("is kept when the blueprint also declares a binding a person fills", async () => {
    expect(await requiresSetup({ LIBRARY: ambient(), TRACKER: PICKED })).toBe(true);
    expect(await requiresSetup({ TRACKER: PICKED })).toBe(true);
    expect(await requiresSetup({
      LIBRARY: ambient(), LLM: { title: "Model", description: "", type: "aiModel" },
    })).toBe(true);
  });
});
