// The typed-storage part of the UserDirectoryDurableObject: `makeUserDirectoryStorage()` and the
// record types it stores. The directory's other state (users, branding, files) is in SQL tables
// created by the Durable Object itself; what is here holds account stubs, which SQL cannot.
// See overseer-storage.ts for the conventions.

import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type { AccountDescription, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";

/**
 * A tenant-held gatekeeper account (VendorDescription.tenantScoped): minted once per tenant by the
 * vendor's createAccount() and offered to every member's workspaces while `enabled`. Keyed by vendor
 * id; the tenant is the directory's own name.
 */
export type TenantAccountRecord = {
  /** The vendor's id (GATEKEEPER_<ID> suffix, lowercased). */
  vendorId: string;
  /** The account, as returned by createAccount() (a persistent stub). */
  account: Fetcher<GatekeeperUser>;
  /** Cached from account.describe() when the account was minted. */
  description: AccountDescription;
  /** Whether the tenant offers it to workspaces. A disabled account keeps its data. */
  enabled: boolean;
  /** Profile id of the administrator who last enabled it, or "operator" in the "enabled" mode. */
  enabledBy: string;
  /** Epoch ms of the last enable and disable; null when it has not happened. */
  enabledAt: number | null;
  disabledAt: number | null;
};

export function makeUserDirectoryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      tenantAccounts: collection<TenantAccountRecord>()({
        primaryKey: "vendorId",
      }),
    },
    singletons: {},
  });
}

export type UserDirectoryStorage = ReturnType<typeof makeUserDirectoryStorage>;
