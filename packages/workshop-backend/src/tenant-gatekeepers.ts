// Tenant-held gatekeeper accounts (VendorDescription.tenantScoped): one account per vendor per tenant,
// minted by the vendor's createAccount() and kept in the tenant's UserDirectoryDurableObject, which
// offers it to every member's workspaces while the tenant has it enabled. This module holds the
// capabilities a signed-in member reaches them through. The tenant is fixed when a capability is
// minted and no method takes one; the member's role is re-read from the live session on every call.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { TenantGatekeeperInfo, TenantGatekeepersApi } from "@gadgets/workshop-shared/api";
import type { GatekeeperVendor, TenantAccess, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { readAdminConfig } from "./admin-config.js";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";
import { createWorkshopLogger } from "./observability";
import { ambientGatekeeperMode } from "./provisioning-policy.js";
import { isOrganizationAdmin, type TenantContext } from "./tenant.js";
import type { UserDirectoryDurableObject } from "./user-directory.js";

const logger = createWorkshopLogger("workshop.tenant.gatekeepers");

/** The `enabledBy` of a record created by the deployment operator's "enabled" mode. */
export const OPERATOR_ENABLED_BY = "operator";

/** A bound vendor that may hold tenant accounts: it auto-provisions and is tenant-scoped. */
export type TenantScopedVendor = {
  vendorId: string;
  vendor: Service<GatekeeperVendor>;
  description: VendorDescription;
};

/** Whether a vendor's description makes it eligible for tenant-held accounts. */
export function isTenantScoped(description: VendorDescription): boolean {
  return description.tenantScoped === true && description.autoProvisionsAccount === true;
}

/**
 * Every bound tenant-scoped vendor, described in parallel; one whose describe() fails is left out.
 * `only`, when given, restricts the vendors asked to those ids.
 */
export async function tenantScopedVendors(
    env: Cloudflare.Env, only?: (vendorId: string) => boolean): Promise<TenantScopedVendor[]> {
  const described = await Promise.all([...buildGatekeeperVendorMap(env)]
      .filter(([vendorId]) => only?.(vendorId) ?? true)
      .map(async ([vendorId, vendor]) => {
        try {
          const description = await vendor.describe();
          return isTenantScoped(description) ? { vendorId, vendor, description } : null;
        } catch (error) {
          logger.warn("failed to describe vendor", { event: "vendor.describe.failed", vendorId, error });
          return null;
        }
      }));
  return described.filter(vendor => vendor !== null);
}

/** Whether a member with this live context may enable or disable the tenant's gatekeepers. */
function mayManage(tenant: TenantContext): boolean {
  return tenant.kind === "personal" || isOrganizationAdmin(tenant.orgRole);
}

/**
 * The capability to manage one tenant's tenant-held gatekeeper accounts. `current` runs before every
 * method and throws unless the session is still live; its role decides whether the caller manages.
 */
@validateRpc()
export class TenantGatekeepersApiImpl extends RpcTarget implements TenantGatekeepersApi {
  constructor(
      private directory: DurableObjectStub<UserDirectoryDurableObject>,
      private env: Cloudflare.Env,
      private tenantId: string,
      private current: () => TenantContext) {
    super();
  }

  #actor(): { profileId: string; userId: string; canManage: boolean } {
    const tenant = this.current();
    if (tenant.tenantId !== this.tenantId) {
      throw new Error("Managing this organization's gatekeepers is no longer permitted.");
    }
    return { profileId: tenant.userKey, userId: tenant.userId, canManage: mayManage(tenant) };
  }

  async list(): Promise<TenantGatekeeperInfo[]> {
    const actor = this.#actor();
    const [vendors, config, accounts] = await Promise.all([
      tenantScopedVendors(this.env), readAdminConfig(this.env), this.directory.listTenantAccounts(),
    ]);
    const enabled = new Set(accounts.filter(account => account.enabled).map(account => account.vendorId));
    return vendors.map(({ vendorId, description }) => {
      const mode = ambientGatekeeperMode(config, vendorId);
      return {
        vendorId, title: description.displayName, enabled: enabled.has(vendorId), mode,
        mayManage: actor.canManage && mode === "optional",
      };
    });
  }

  async enable(vendorId: string): Promise<void> {
    const actor = this.#manager("enable", vendorId);
    await this.#refusing("enable", actor.userId, vendorId,
        () => this.directory.enableTenantAccount(vendorId, actor.profileId));
    logger.info("tenant gatekeeper enabled", {
      event: "tenant.gatekeeper.enabled", tenantId: this.tenantId, userId: actor.userId, vendorId,
    });
  }

  async disable(vendorId: string): Promise<void> {
    const actor = this.#manager("disable", vendorId);
    await this.#refusing("disable", actor.userId, vendorId,
        () => this.directory.disableTenantAccount(vendorId));
    logger.info("tenant gatekeeper disabled", {
      event: "tenant.gatekeeper.disabled", tenantId: this.tenantId, userId: actor.userId, vendorId,
    });
  }

  // The actor, refused unless they may manage right now.
  #manager(operation: "enable" | "disable", vendorId: string) {
    const actor = this.#actor();
    if (!actor.canManage) {
      const error = new Error("Only an administrator of this organization can do that.");
      this.#refused(operation, actor.userId, vendorId, error);
      throw error;
    }
    return actor;
  }

  async #refusing(operation: "enable" | "disable", userId: string, vendorId: string,
      action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.#refused(operation, userId, vendorId, error);
      throw error;
    }
  }

  #refused(operation: "enable" | "disable", userId: string, vendorId: string, error: unknown): void {
    logger.warn("tenant gatekeeper request refused", {
      event: "tenant.gatekeeper.refused", tenantId: this.tenantId, userId, vendorId, operation,
      refusalReason: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * The live view of a member's standing that a tenant-held account's management UI receives
 * (AppUiContext.tenant.access). Re-reads the session on every call, like TenantGatekeepersApiImpl.
 */
@validateRpc()
export class TenantAccessImpl extends RpcTarget implements TenantAccess {
  constructor(private tenantId: string, private session: () => TenantContext) {
    super();
  }

  async current(): Promise<{ canManage: boolean }> {
    const tenant = this.session();
    if (tenant.tenantId !== this.tenantId) {
      throw new Error("The active organization changed. Open the app again.");
    }
    return { canManage: mayManage(tenant) };
  }
}
