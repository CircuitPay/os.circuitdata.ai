# Data Model: Organization Switcher and Member Invitations

No Workshop-owned storage. Every entity below lives in Clerk; the Workshop reads it through Clerk's components and session.

| Entity | Owner | Fields used | Notes |
|--------|-------|-------------|-------|
| Workspace | Workshop (derived) | `orgId` (null = personal) | Exactly one active; the tenant (spec 001). |
| Organization | Clerk | id, name | Created via the switcher. |
| Membership | Clerk | role (`org:admin`, `org:member`) | `org:admin` gates the invite menu item. |
| Invitation | Clerk | email, role, status | `pending` → `accepted` or `revoked`; managed in the Members page. |

## Configuration

| Field | Type | Source | Meaning |
|-------|------|--------|---------|
| `ClerkClientConfig.singleOrganization` | `boolean` | `TENANT_MODE=single` | Dedicated deployment: no personal workspace, no organization creation in the switcher. |
