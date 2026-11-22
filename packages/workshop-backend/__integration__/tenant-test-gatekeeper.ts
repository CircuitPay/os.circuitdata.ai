// A tenant-scoped gatekeeper vendor for the tenant-held account suites (tenant-gatekeepers.test.ts),
// run as its own Worker beside the Workshop so its account stubs cross a Worker boundary as a real
// gatekeeper's do. vitest.integration.config.ts registers it as `tenant-test-gatekeeper` and binds:
//
// - TENANT_TEST_VENDOR: the vendor (TenantTestVendor). A suite installs it as GATEKEEPER_TENANTTEST
//   on `env` for its own run, so no other suite sees an extra gatekeeper.
// - TENANT_TEST_CONTROL: what the suite reads and steers (TenantTestControl): the ledger of minted
//   and revoked accounts, and whether an account's revoke() fails.
//
// Each minted account has a random datasetId, as a real tenant-held account (the retail gatekeeper)
// mints its own dataset id. The account's app frame reports that id and the tenant context it was
// opened with as JSON, and its verifier and gatekeeper class carry it, so a suite can tell which
// account a capsule, an app or a verification came from.

/** The fixture Worker's source, a single ES module. */
export const TENANT_TEST_GATEKEEPER_SCRIPT = `
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

// The record of what happened to the fixture's accounts, and its one knob.
export class TenantTestLedger extends DurableObject {
  async record(event) {
    const events = (await this.ctx.storage.get("events")) ?? [];
    events.push(event);
    await this.ctx.storage.put("events", events);
  }
  async events() { return (await this.ctx.storage.get("events")) ?? []; }
  async setFailRevoke(datasetId, fail) { await this.ctx.storage.put("failRevoke:" + datasetId, fail); }
  async failRevoke(datasetId) { return (await this.ctx.storage.get("failRevoke:" + datasetId)) ?? false; }
}

const ledger = env => env.LEDGER.getByName("ledger");

export class TenantTestVendor extends WorkerEntrypoint {
  async describe() {
    return {
      displayName: "Tenant Test", url: "https://tenant.test/",
      autoProvisionsAccount: true, tenantScoped: true,
    };
  }
  async createAccount() {
    const datasetId = crypto.randomUUID();
    await ledger(this.env).record({ type: "created", datasetId });
    return this.ctx.exports.TenantTestAccount({ props: { datasetId } });
  }
}

export class TenantTestAccount extends WorkerEntrypoint {
  async describe() {
    return {
      displayName: "Tenant Test",
      singleton: { tsType: "TenantData" },
      providesUi: { title: "Tenant data" },
    };
  }
  async getSingletonGatekeeperClass() {
    return this.ctx.exports.TenantTestGatekeeper({ props: { datasetId: this.ctx.props.datasetId } });
  }
  async getVerifier() {
    return this.ctx.exports.TenantTestVerifier({ props: { datasetId: this.ctx.props.datasetId } });
  }
  async startAppUi(context) {
    const access = context.tenant ? await context.tenant.access.current() : null;
    return {
      iframeHtml: JSON.stringify({
        datasetId: this.ctx.props.datasetId, isAdmin: context.isAdmin,
        memberId: context.tenant?.memberId ?? null, memberName: context.tenant?.memberName ?? null,
        canManage: access?.canManage ?? null,
      }),
      ui: new TenantTestUi(context.tenant?.access.dup()),
    };
  }
  async revoke() {
    const { datasetId } = this.ctx.props;
    if (await ledger(this.env).failRevoke(datasetId)) throw new Error("revoke failed");
    await ledger(this.env).record({ type: "revoked", datasetId });
  }
}

export class TenantTestVerifier extends WorkerEntrypoint {
  async datasetId() { return this.ctx.props.datasetId; }
}

// The app's capability: asks the member's live standing, as a real app does before each action.
class TenantTestUi extends RpcTarget {
  #access;
  constructor(access) { super(); this.#access = access; }
  async canManage() { return (await this.#access.current()).canManage; }
}

// The account's singleton gatekeeper, installed into workspaces as a facet. It admits an observer
// only with a verifier from the same account.
export class TenantTestGatekeeper extends DurableObject {
  async describe() {
    return {
      title: "Tenant data", url: "https://tenant.test/data",
      suggestedBindingName: "TENANT_DATA", tsType: "TenantData",
    };
  }
  async getAgentCatalog() { return null; }
  async datasetId() { return this.ctx.props.datasetId; }
  async addObserver(observerId, verifier) {
    if (await verifier.datasetId() !== this.ctx.props.datasetId) {
      throw new Error("This verifier is for another dataset.");
    }
    await ledger(this.env).record({ type: "observer", datasetId: this.ctx.props.datasetId, observerId });
  }
  async removeObserver() {}
}

export class TenantTestControl extends WorkerEntrypoint {
  events() { return ledger(this.env).events(); }
  setFailRevoke(datasetId, fail) { return ledger(this.env).setFailRevoke(datasetId, fail); }
}

export default { fetch() { return new Response("Not Found", { status: 404 }); } };
`;
