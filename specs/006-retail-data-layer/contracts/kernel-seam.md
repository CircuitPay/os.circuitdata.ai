# Contract: tenant-held gatekeeper accounts (kernel PR)

Ships as its own PR (`workshop-shared` + `workshop-backend`), reviewed separately from the
gatekeeper and the UI. Every new exported member gets a doc comment (constitution I). Research R1,
R2 and R20 explain why it has this shape.

## `packages/workshop-shared/src/gatekeeper.ts`

```ts
export interface VendorDescription {
  // ...existing fields
  /**
   * The vendor's auto-provisioned account belongs to a tenant (an organization or a personal
   * workspace) rather than to one user: the Workshop mints it once per tenant, keeps it in the
   * tenant's directory, and offers it to every member's workspaces. This only makes the vendor
   * eligible. The account becomes ambient for a tenant solely when that tenant's administrator
   * enables it (or the deployment operator's mode is "enabled"). Requires autoProvisionsAccount.
   */
  tenantScoped?: boolean;
}

/**
 * The tenant facts a tenant-held account's management UI receives. The role is never a stored
 * flag: call `access.current()` before every action that needs it.
 */
export interface TenantAppContext {
  /** Stable opaque id of the signed-in member within this tenant, for attribution only. */
  memberId: string;
  /** The member's display name, for attribution only. */
  memberName: string | null;
  /** Re-reads the live session on each call. */
  access: RpcStub<TenantAccess>;
}

/** A live view of the signed-in member's standing in the tenant that owns the app. */
export interface TenantAccess extends RpcTarget {
  /**
   * The member's current rights. Throws if the session has ended, the member has left, or the
   * active tenant changed since the app was opened.
   */
  current(): Promise<{ canManage: boolean }>;
}

export interface AppUiContext {
  isAdmin: boolean; // unchanged: deployment operator
  /** Present only when the app belongs to a tenant-held account. */
  tenant?: TenantAppContext;
}

/** One tenant file handed to a gatekeeper app by the Workshop after the member picked it. */
export type TenantFileDelivery = {
  /** The file's name in the tenant file area (display only). */
  name: string;
  /** Exact byte length of `stream`. */
  size: number;
  /** Sanitized MIME type. */
  contentType: string;
  /** The file's bytes. */
  stream: ReadableStream<Uint8Array>;
};
```

## `packages/workshop-shared/src/api.ts`

```ts
/** Creation spec of a capsule installed from a tenant-held account (one per vendor per tenant). */
export type TenantAmbientCreationSpec = { type: "tenantAmbient"; vendorId: string };
// added to the existing creation-spec union beside { type: "ambient"; vendorId; accountId }

/** A tenant-scoped gatekeeper as the tenant's members see it. */
export type TenantGatekeeperInfo = {
  vendorId: string;
  title: string;
  /** Whether this tenant has turned it on. */
  enabled: boolean;
  /** The operator's mode for this vendor; "disabled" means it cannot be enabled. */
  mode: AmbientGatekeeperMode;
  /** Whether the caller may enable or disable it right now. */
  mayManage: boolean;
};

/** Manage the active tenant's tenant-scoped gatekeepers. Tenant fixed at mint; role re-read per call. */
export interface TenantGatekeepersApi extends RpcTarget {
  /** Every tenant-scoped vendor bound to this deployment, with this tenant's state. */
  list(): Promise<TenantGatekeeperInfo[]>;
  /** Mint (first time) and enable the tenant's account. Organization administrators only. */
  enable(vendorId: string): Promise<void>;
  /** Stop offering it to workspaces; the account and its data are kept. Administrators only. */
  disable(vendorId: string): Promise<void>;
}

export interface AuthenticatedApi {
  /**
   * The capability to manage the active tenant's tenant-scoped gatekeepers, or null on a
   * deployment without Clerk. Dispose it when done.
   */
  getTenantGatekeepersApi(): Promise<RpcStub<TenantGatekeepersApi> | null>;
}
```

`listGatekeeperApps()` and `getGatekeeperApp(appId)` also return the tenant's enabled tenant-held
accounts that set `providesUi`. Their `appId` is the vendor id, so `/gatekeepers/retail` is the
Data area. For these apps, `startAppUi` receives
`{ isAdmin: <operator>, tenant: { memberId, memberName, access } }`.

## `packages/workshop-backend`

| File | Change |
|---|---|
| `src/user-directory.ts` (+ its typed-storage schema) | `tenantAccounts` KV collection (data-model §6). Methods, each taking no tenant id because the tenant is the DO's own name: `enableTenantAccount(vendorId, actorProfileId)` (calls `createAccount()` once, deduplicated as in `user.ts:1521-1537`), `disableTenantAccount(vendorId)`, `listTenantAccounts()`, `getTenantSingletonClass(vendorId)`, `startTenantAppUi(vendorId, ctx)`, `getTenantVerifier(vendorId)`. `eraseTenant` calls `account.revoke()` for each record first and throws on failure, so the webhook retries. Every method refuses the unnamed legacy directory (`""`). |
| `src/tenant-gatekeepers.ts` (new) | `TenantGatekeepersApiImpl` (`@validateRpc()`): takes `current: () => TenantContext` like `TenantFilesApiImpl` and refuses a changed tenant. A member manages when the tenant is personal or `isOrganizationAdmin(orgRole)`. Also `TenantAccessImpl` (`@validateRpc()`): the same `current()` re-read, returning `{ canManage }`. |
| `src/server.ts` | `getTenantGatekeepersApi()` is minted from `#clerkTenant()`, and returns null without Clerk. `listGatekeeperApps` / `getGatekeeperApp` merge tenant apps, and pass `tenant` with a fresh `TenantAccessImpl`. |
| `src/user.ts` | `getTenantSingletonGatekeeperClass(vendorId)` calls `#assertResourceEnabled(vendorId)` and then the directory's `getTenantSingletonClass`. `listProvidedAccounts` and `#provisionMissingAccounts` skip `tenantScoped` vendors, so they are never provisioned per user. `#assertResourceEnabled` honours the operator's `disabled` mode for them unchanged. |
| `src/overseer.ts` | `ensureAmbientCapsules` also reads the owner's tenant directory (`tenantOfProfileId(owner)`) and reconciles `tenantAmbient` records by vendor id, removing any that are disabled or gone. `prepareChatBindings` re-checks that a frozen `tenantAmbient` capsule is still enabled on each turn and leaves it out if not. The observer flow: for `tenantAmbient` it takes the verifier from `getTenantVerifier` when `sameTenant(client, owner)`, and refuses otherwise. Blueprint export leaves out `tenantAmbient` bindings, as it does for `ambient` (`overseer.ts:7556-7558`). |
| `src/auth/clerk-webhook.ts` | `user.deleted` also runs `eraseTenant` on directory `u_<userId>` (the personal tenant). |
| `src/env.d.ts`, configs | none (no new binding) |

## Invariants (each covered by a test that attempts the forbidden action)

1. Only a `tenantAccounts` record with `enabled = true`, written through `TenantGatekeepersApi`
   (organization administrator, role re-read on that call) or created by the operator's `enabled`
   mode, makes the account ambient. `tenantScoped` and `describe()` never do.
2. No method takes a tenant id. Organization A's capsule is never installed in organization B's
   workspace, and B's `TenantGatekeepersApi` cannot enable, disable or list A's records.
3. A member who is not an administrator cannot enable or disable. An administrator demoted
   mid-session is refused on their next call, and `TenantAccess.current()` reports
   `canManage: false`.
4. Disabling removes the capsule at the next workspace open and leaves it out of the next chat
   turn. The account and its data survive. Re-enabling restores the same dataset.
5. A member leaving (`endMembership`) does not touch `tenantAccounts`.
6. `organization.deleted` revokes the account and retries until that succeeds. `user.deleted`
   erases the personal directory.
7. The operator's `disabled` mode blocks minting the class (`#assertResourceEnabled`) whatever
   the record says.
8. Deployments without Clerk: `getTenantGatekeepersApi()` returns null, and tenant apps are not
   listed.
