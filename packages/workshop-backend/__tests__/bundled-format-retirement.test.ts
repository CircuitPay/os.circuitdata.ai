// What the bundled-blueprint installer does to the deployment's curated formats when the bundle
// changes (specs/007-data-output-formats/contracts/kernel-seam.md, sections 3 and 5): a blueprint
// the deployment stops bundling is withdrawn from the formats and the featured list while its
// record stays, and a format promoted for the first time starts with the hint its manifest gives.
//
// Runs the real AdminSettings over fresh storage, as admin-settings-audit.test.ts builds it, with
// the BLUEPRINTS namespace, the content bucket and the audit log faked. The bundle a deployment
// ships is the generated module's array, which the installer reads at run time, so a test stands
// in for a release by replacing its entries (see withBundle).

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AdminAuditRecord, AdminSettingRecord, BlueprintMetadata, BlueprintOutput,
} from "@gadgets/workshop-shared/api";
import type { AdminSettingActor } from "../src/admin-access.js";
import { listFormatOffers, parseAdminConfig } from "../src/admin-config.js";
import { AdminSettings } from "../src/admin-settings.js";
import { BUNDLED_BLUEPRINTS, type BundledBlueprint } from "../src/generated/bundled-blueprints.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminSettingsStorage, type FormatCuration,
} from "../src/storage-schema/admin-settings-storage.js";
import {
  ADMIN_CONFIG_KEY, FEATURED_BLUEPRINTS_KEY, listFeaturedBlueprintsFromKv,
} from "../src/storage-schema/blueprints-kv.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

const OUTPUT: BlueprintOutput = { id: "sample", noun: "Sample", plural: "Samples", icon: "table" };

function actor(method: string): AdminSettingActor {
  return { admin: "admin@example.test", sessionId: "session-1", via: "cli", method };
}

/** A blueprint as a release bundles it. */
function bundled(blueprintId: string, agentHint?: string): BundledBlueprint {
  return {
    blueprintId, title: `Title of ${blueprintId}`, description: "A sample format.",
    ...(agentHint !== undefined ? { agentHint } : {}),
    output: OUTPUT, author: { type: "user", id: "bundled", name: "Bundled" },
    revision: 1, created: "2026-01-01T00:00:00.000Z", version: 1,
    lastUpdated: "2026-01-01T00:00:00.000Z", bindings: {}, contentHash: `hash of ${blueprintId}`,
    files: [["client.js", "document.body.textContent = 'ready';\n"]],
  };
}

/** The metadata of a blueprint somebody published, which no release ever bundled. */
function published(title: string): BlueprintMetadata {
  return {
    title, description: "", author: { type: "user", id: "pat", name: "Pat" },
    created: new Date(0), version: 1, lastUpdated: new Date(0), output: OUTPUT, bindings: {},
  };
}

// Runs `fn` as a deployment whose release bundles exactly `entries`, then puts the real bundle
// back.
async function withBundle(entries: BundledBlueprint[], fn: () => Promise<void>): Promise<void> {
  let shipped = BUNDLED_BLUEPRINTS.splice(0, BUNDLED_BLUEPRINTS.length, ...entries);
  try {
    await fn();
  } finally {
    BUNDLED_BLUEPRINTS.splice(0, BUNDLED_BLUEPRINTS.length, ...shipped);
  }
}

let counter = 0;

/**
 * A deployment's AdminSettings over fresh storage. `kv` is its BLUEPRINTS namespace and `writes`
 * the keys written to it, in order; `failNext`, when set, makes the next write it accepts throw.
 * `appended` holds the audit log.
 */
function deployment() {
  const stub = env.TEST_USER_DIRECTORY.getByName(`bundled-format-retirement-${++counter}`);
  const kv = new Map<string, string>();
  const writes: string[] = [];
  const failure: { failNext?: (key: string, value: string) => boolean } = {};
  const appended: AdminAuditRecord[] = [];
  const BLUEPRINTS = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      if (failure.failNext?.(key, value)) {
        failure.failNext = undefined;
        throw new Error("KV unavailable");
      }
      writes.push(key);
      kv.set(key, value);
    },
  } as unknown as KVNamespace;
  const audits = { getByName: () => ({
    append: async (record: AdminAuditRecord) => { appended.push(record); },
  }) };

  const inDo = <T>(f: (admin: AdminSettings) => T | Promise<T>) => runInDurableObject(
      stub, (_host, state) => {
        const settingsEnv = { BLUEPRINTS, BLUEPRINT_CONTENT: { put: async () => {} } };
        const admin = new AdminSettings(state, settingsEnv as unknown as Cloudflare.Env);
        Object.assign(admin, { audits });
        return f(admin);
      });

  return {
    inDo, kv, writes, failure, appended,

    /** Runs the installer, as the first request to reach a newly deployed release does. */
    install: () => inDo(admin => admin.ensureBundledBlueprintsInstalled()),

    /** Writes the curated formats directly, as an earlier admin left them. */
    seedFormats: (formats: FormatCuration[]) => inDo(admin => {
      (admin as unknown as { storage: AdminSettingsStorage }).storage.adminConfig.put(
          { ...DEFAULT_ADMIN_CONFIG, formats });
    }),

    /** The curated formats, as the admin panel's authority holds them. */
    formats: () => inDo(admin => admin.getAdminConfig().formats),

    /** The ids the New menu and the agent are offered, read as they read them: from the mirror. */
    offered: async () => (await listFormatOffers(
        { BLUEPRINTS }, parseAdminConfig(kv.get(ADMIN_CONFIG_KEY) ?? null)))
        .map(offer => offer.blueprintId),

    /** The ids of the featured blueprints, as every reader lists them. */
    featured: async () =>
        (await listFeaturedBlueprintsFromKv({ BLUEPRINTS })).map(info => info.id).toSorted(),
  };
}

describe("AdminSettings withdraws a bundled format the deployment has dropped", () => {
  it("takes it out of the formats and the featured list, keeps its blueprint, and then rests",
      async () => {
    const site = deployment();
    await withBundle([bundled("format.kept"), bundled("format.dropped")], async () => {
      expect(await site.install()).toBe(true);
    });
    expect(await site.offered()).toEqual(["format.kept", "format.dropped"]);
    expect(await site.featured()).toEqual(["format.dropped", "format.kept"]);
    const record = site.kv.get("format.dropped");
    expect(record).toBeDefined();

    // The release after it bundles one blueprint fewer.
    await withBundle([bundled("format.kept")], async () => {
      expect(await site.install()).toBe(true);
      expect(await site.offered()).toEqual(["format.kept"]);
      expect(await site.featured()).toEqual(["format.kept"]);
      expect(await site.formats()).toStrictEqual([{ blueprintId: "format.kept", enabled: true }]);
      // The blueprint itself is still published: gadgets made from it follow it, and it can be
      // instantiated by id.
      expect(site.kv.get("format.dropped")).toBe(record);

      // A second run finds nothing to do.
      const written = site.writes.length;
      expect(await site.install()).toBe(true);
      expect(site.writes).toHaveLength(written);
      expect(await site.offered()).toEqual(["format.kept"]);
      expect(await site.featured()).toEqual(["format.kept"]);
    });
    // The deployment's own doing, like promotion: no admin did it, so none is recorded.
    expect(site.appended).toEqual([]);
  });

  it("leaves alone what an admin promoted or featured that was never bundled", async () => {
    const site = deployment();
    site.kv.set("bp-hand", JSON.stringify({ metadata: published("Promoted by hand") }));
    await withBundle([bundled("format.kept"), bundled("format.dropped")], async () => {
      expect(await site.install()).toBe(true);
      await site.inDo(admin => admin.promoteFormat("bp-hand", actor("promoteFormat")));
      await site.inDo(admin => admin.updateFormat(
          "bp-hand", { agentHint: "Prefer for memos." }, actor("updateFormat")));
      await site.inDo(admin => admin.syncFeaturedBlueprint(
          { id: "bp-featured", metadata: published("Featured") }));
    });
    expect(await site.offered()).toEqual(["format.kept", "format.dropped", "bp-hand"]);

    await withBundle([bundled("format.kept")], async () => {
      expect(await site.install()).toBe(true);
      expect(await site.install()).toBe(true);
    });
    expect(await site.formats()).toStrictEqual([
      { blueprintId: "format.kept", enabled: true },
      { blueprintId: "bp-hand", enabled: true, agentHint: "Prefer for memos." },
    ]);
    expect(await site.offered()).toEqual(["format.kept", "bp-hand"]);
    expect(await site.featured()).toEqual(["bp-featured", "format.kept"]);
    // Only the admin's own changes are in the audit log.
    expect(site.appended.map(entry => (entry as AdminSettingRecord).method))
        .toEqual(["promoteFormat", "updateFormat"]);
  });

  it("lets an admin offer the dropped blueprint again, and does not withdraw it a second time",
      async () => {
    const site = deployment();
    await withBundle([bundled("format.kept"), bundled("format.dropped")], async () => {
      expect(await site.install()).toBe(true);
    });

    await withBundle([bundled("format.kept")], async () => {
      expect(await site.install()).toBe(true);
      expect(await site.offered()).toEqual(["format.kept"]);

      // Its record is still there to promote, now as any blueprint an admin chooses.
      await site.inDo(admin => admin.promoteFormat("format.dropped", actor("promoteFormat")));
      expect(await site.install()).toBe(true);
      expect(await site.offered()).toEqual(["format.kept", "format.dropped"]);
    });
  });

  it("withdraws a disabled entry too, with whatever the admin had set on it", async () => {
    const site = deployment();
    await withBundle([bundled("format.kept"), bundled("format.dropped")], async () => {
      expect(await site.install()).toBe(true);
      await site.inDo(admin => admin.updateFormat("format.dropped",
          { enabled: false, agentHint: "Not for now.", overrides: { noun: "Memo" } },
          actor("updateFormat")));
    });

    await withBundle([bundled("format.kept")], async () => {
      expect(await site.install()).toBe(true);
    });
    expect(await site.formats()).toStrictEqual([{ blueprintId: "format.kept", enabled: true }]);
  });

  it("finishes on the next run a withdrawal that failed partway", async () => {
    const site = deployment();
    await withBundle([bundled("format.kept"), bundled("format.dropped")], async () => {
      expect(await site.install()).toBe(true);
    });

    await withBundle([bundled("format.kept")], async () => {
      // The formats are rewritten, and then the featured list cannot be.
      site.failure.failNext = (key, value) =>
          key === FEATURED_BLUEPRINTS_KEY && !value.includes("format.dropped");
      // (Caught inside the object, so that the failure is a value and not a rejection of it.)
      expect(await site.inDo(admin => admin.ensureBundledBlueprintsInstalled()
          .then(() => null, (error: Error) => error.message))).toBe("KV unavailable");
      expect(await site.offered()).toEqual(["format.kept"]);
      expect(await site.featured()).toEqual(["format.dropped", "format.kept"]);

      // The step is not marked done until all of it is, so the next run repeats it.
      expect(await site.install()).toBe(true);
      expect(await site.offered()).toEqual(["format.kept"]);
      expect(await site.featured()).toEqual(["format.kept"]);
    });
  });
});

describe("AdminSettings seeds a bundled format's hint for the agent", () => {
  it("gives a format promoted for the first time the hint its manifest carries", async () => {
    const site = deployment();
    await withBundle([
      bundled("format.hinted", "Use for monthly figures."), bundled("format.plain"),
    ], async () => {
      expect(await site.install()).toBe(true);
    });
    expect(await site.formats()).toStrictEqual([
      { blueprintId: "format.hinted", enabled: true, agentHint: "Use for monthly figures." },
      { blueprintId: "format.plain", enabled: true },
    ]);
  });

  it("never changes the hint of a format that is already curated", async () => {
    const site = deployment();
    // An admin had promoted one of the bundle's blueprints by hand before the installer got to it.
    await site.seedFormats(
        [{ blueprintId: "format.curated", enabled: false, agentHint: "The admin's own." }]);
    await withBundle([
      bundled("format.curated", "The manifest's."),
      bundled("format.hinted", "Use for monthly figures."),
      bundled("format.plain"),
    ], async () => {
      expect(await site.install()).toBe(true);
      await site.inDo(admin => admin.updateFormat(
          "format.hinted", { agentHint: "Prefer for board packs." }, actor("updateFormat")));
    });

    // The next release rewords one hint, adds one where there was none, and bundles a new format.
    await withBundle([
      bundled("format.curated", "The manifest's, reworded."),
      bundled("format.hinted", "Use for quarterly figures."),
      bundled("format.plain", "Use for lists."),
      bundled("format.added", "Use for charts."),
    ], async () => {
      expect(await site.install()).toBe(true);
    });
    expect(await site.formats()).toStrictEqual([
      { blueprintId: "format.curated", enabled: false, agentHint: "The admin's own." },
      { blueprintId: "format.hinted", enabled: true, agentHint: "Prefer for board packs." },
      { blueprintId: "format.plain", enabled: true },
      { blueprintId: "format.added", enabled: true, agentHint: "Use for charts." },
    ]);
  });
});
