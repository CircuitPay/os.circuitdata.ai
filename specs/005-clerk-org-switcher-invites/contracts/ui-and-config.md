# Contracts

## Server config (`packages/workshop-shared/src/api.ts`)

```ts
export type ClerkClientConfig = {
  publishableKey: string;
  /** True on a deployment dedicated to one organization (TENANT_MODE=single). */
  singleOrganization: boolean;
};
```

## Clerk bridge (`packages/workshop-frontend/src/clerk/clerkBridge.ts`)

| Member | Type | Contract |
|--------|------|----------|
| `isOrganizationAdmin` | `boolean` | True only when an organization is active and the user's role in it is `org:admin`. |
| `openOrganizationMembers` | `() => void` | Opens Clerk's organization profile modal on its Members page. |

## UI

| Surface | Shown when | Action |
|---------|-----------|--------|
| Header workspace switcher | Clerk deployment, signed in | Switch workspace; create organization unless `singleOrganization`; personal workspace listed unless `singleOrganization`. |
| Profile menu "Invite members" | `isOrganizationAdmin` | `openOrganizationMembers()` |
| Mobile menu "Invite members" | `isOrganizationAdmin` | `openOrganizationMembers()` and close the menu |
