// The retail vendor, its tenant-held account and the account's verifier. The Workshop calls the
// argument-free `createAccount()` once per tenant (VendorDescription.tenantScoped) and keeps the
// account in the tenant's directory; the account mints a random dataset id, so no tenant id ever
// reaches this worker (contracts/kernel-seam.md, research R1).

import { RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, AppUiContext, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions,
  GatekeeperUiFrame, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { RetailAppApi } from "./app-ui.js";
import type { ProviderKind } from "./app-api-types.js";
import { baseUrl } from "./connectors/http.js";
import { datasetObjectName } from "./dataset/dataset-do.js";
import { retailLogger } from "./observability.js";
import type { RetailDataApi } from "./session.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "./generated/app.txt";

const logger = retailLogger("account");

/** Used when the binding carries no sharing domain (local tools); deployments always set one. */
export const DEFAULT_SHARING_DOMAIN = "default";

/** The Phosphor "ChartBar" glyph as a self-contained SVG data URI. */
export const RETAIL_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z'/></svg>",
    ),
};

/** Props of a retail account and everything minted from it. */
export type RetailAccountProps = {
  sharingDomain: string;
  datasetId: string;
};

/** The vendor-specific verifier: whether the collaborator's own tenant account holds a dataset. */
export interface RetailVerifierApi extends GatekeeperUserVerifier {
  hasDatasetAccess(datasetId: string): Promise<boolean>;
}

/** The tenant-held account: an ambient `RetailData` singleton and the Data area app. */
@validateRpc()
export class RetailAccount extends WorkerEntrypoint<Cloudflare.Env, RetailAccountProps> implements GatekeeperUser {
  /** Describes the ambient binding and the "Data" app. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Retail data",
      avatar: RETAIL_ICON,
      singleton: { tsType: "RetailData" },
      providesUi: { title: "Data", icon: RETAIL_ICON },
    };
  }

  /** The account-imbued facet class the Workshop installs as the ambient `RETAIL_DATA` capsule. */
  @skipRpcValidation()
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<RetailDataApi>>> {
    return this.ctx.exports.RetailGatekeeper({ props: this.ctx.props });
  }

  /** Opens the Data area. Tenant-held accounts always receive the tenant context. */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    if (!context.tenant) throw new Error("The Data area opens only from a tenant's workspace.");
    const { sharingDomain, datasetId } = this.ctx.props;
    const dataset = this.ctx.exports.RetailDataset.getByName(datasetObjectName(sharingDomain, datasetId));
    // The kernel's stub is released when this call returns, so the capability keeps its own.
    const ui = new RpcStub(new RetailAppApi({
      dataset, datasetId, access: context.tenant.access.dup(), memberId: context.tenant.memberId,
      connections: this.ctx.exports.RetailConnection, sharingDomain, baseUrl: baseUrl(this.env),
      providers: configuredProviders(this.env),
    }));
    return { iframeHtml: APP_HTML, ui };
  }

  /** The dataset is one ambient resource; there is nothing to address by URL. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Retail data has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Retail data has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Erases the dataset (FR-022). The kernel calls this when the tenant is deleted. */
  async revoke(): Promise<void> {
    const { sharingDomain, datasetId } = this.ctx.props;
    const dataset = this.ctx.exports.RetailDataset.getByName(datasetObjectName(sharingDomain, datasetId));
    // Provider grants are revoked before the data goes (research R20).
    for (const name of await dataset.connectionNames(datasetId)) {
      await this.ctx.exports.RetailConnection.getByName(name).revokeForErasure(datasetId);
    }
    await dataset.erase(datasetId);
    logger.info("account revoked", { event: "account.revoked", datasetId });
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Retail data has no account-level connect flow; connect providers from the Data area.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Retail data has no account-level connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the verifier the overseer hands to this vendor's gatekeepers for observer checks. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.RetailVerifier({ props: this.ctx.props });
  }
}

/** Answers for the account it was minted from (observer strategy B, research R6). */
@validateRpc()
export class RetailVerifier extends WorkerEntrypoint<Cloudflare.Env, RetailAccountProps> implements RetailVerifierApi {
  /** Whether this account's tenant holds `datasetId`. */
  async hasDatasetAccess(datasetId: string): Promise<boolean> {
    return datasetId === this.ctx.props.datasetId;
  }
}

/** Binding props set by the Workshop's service binding. */
type GatekeeperVendorProps = { sharingDomain?: string };

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env, GatekeeperVendorProps> {
  /** A tenant-scoped, auto-provisioned vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Retail data",
      url: "https://workers.cloudflare.com/",
      logo: RETAIL_ICON,
      tagline: "Your organization's sales, products and customers in one place",
      description:
        "Brings sales from Square, Stripe and CSV exports (Toast, Square, Shopify) into one " +
        "dataset per organization that agents and gadgets can query read-only.",
      autoProvisionsAccount: true,
      tenantScoped: true,
      providesAuth: false,
    };
  }

  /**
   * Mints a tenant's account with a fresh random dataset id. Takes no identity: the kernel decides
   * which tenant holds the result.
   */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const sharingDomain = this.ctx.props.sharingDomain ?? DEFAULT_SHARING_DOMAIN;
    const datasetId = crypto.randomUUID();
    logger.info("account created", { event: "account.created", datasetId });
    return this.ctx.exports.RetailAccount({ props: { sharingDomain, datasetId } }) as unknown as
      Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Retail data is provisioned per tenant and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** The complete agent-facing `RETAIL_DATA` declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

/** Providers whose app credentials the deployment supplied; the others cannot be connected. */
function configuredProviders(env: Cloudflare.Env): ProviderKind[] {
  const providers: ProviderKind[] = [];
  if (env.SQUARE_CLIENT_ID && env.SQUARE_CLIENT_SECRET) providers.push("square");
  if (env.STRIPE_CLIENT_ID && env.STRIPE_APP_SECRET) providers.push("stripe");
  return providers;
}
