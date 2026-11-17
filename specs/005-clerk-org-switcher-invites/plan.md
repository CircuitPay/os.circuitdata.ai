# Implementation Plan: Organization Switcher and Member Invitations

**Branch**: `005-clerk-org-switcher-invites` | **Date**: 2026-11-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-clerk-org-switcher-invites/spec.md`

## Summary

Embed two Clerk components in the Workshop. The header's existing `OrganizationSwitcher` already switches workspaces and creates organizations; it gains a dedicated-deployment mode (no personal workspace, no "Create organization"). The invitation panel is Clerk's `OrganizationProfile`, opened as a modal on its Members page (invite by email with role, pending invitations, revoke), offered from the profile menu and the mobile menu only to administrators of the active organization. The one kernel change is a documented `ClerkClientConfig.singleOrganization` flag so the browser knows the deployment is dedicated.

## Technical Context

**Language/Version**: TypeScript 5 (strict), React 19

**Primary Dependencies**: `@clerk/react` 6.17.8 (already installed), Kumo `DropdownMenu`, TanStack Router

**Storage**: None new; organizations, memberships and invitations live in Clerk

**Testing**: Vitest (jsdom) in `packages/workshop-frontend`; Vitest in `packages/workshop-backend`

**Target Platform**: Browser SPA + Cloudflare Workers backend

**Project Type**: Web application (frontend + backend kernel)

**Performance Goals**: No extra round trips; the flag rides on the existing `getServerConfig()`

**Constraints**: Kernel diff minimal (one field + one line); the rest of the app reaches Clerk only through `ClerkBridge`

**Scale/Scope**: 2 UI entry points, 1 config field, ~6 files

## Constitution Check

| Principle | Status |
|-----------|--------|
| I. Kernel bar: small, every exported shared member documented | Pass: one documented field on `ClerkClientConfig`, one line in `deployment-config.ts` |
| Tenant/Clerk config is env-driven, never `AdminConfig` | Pass: derived from existing `TENANT_MODE` via `isSingleTenant()` |
| Organization role never grants deployment admin | Pass: the org-admin signal only gates showing a Clerk modal; Clerk enforces invite permission server-side |
| Reuse existing mechanisms | Pass: reuses `ClerkBridge` (alongside `openUserProfile`) and the existing switcher |
| Frontend conventions (Kumo, file naming, no speculative surface) | Pass: menu items use existing Kumo `DropdownMenu` styles; no new components beyond need |

Post-design re-check: unchanged, all pass. No complexity tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/005-clerk-org-switcher-invites/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/ui-and-config.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/workshop-shared/src/api.ts                    # ClerkClientConfig.singleOrganization
packages/workshop-backend/src/deployment-config.ts     # sets it from isSingleTenant(env)
packages/workshop-frontend/src/clerk/clerkBridge.ts    # isOrganizationAdmin, openOrganizationMembers
packages/workshop-frontend/src/clerk/ClerkAppProvider.tsx
packages/workshop-frontend/src/clerk/WorkspaceSwitcher.tsx
packages/workshop-frontend/src/components/UserMenu.tsx # "Invite members" item
packages/workshop-frontend/src/components/Header.tsx   # mobile "Invite members"
docs/clerk-signin.md
```

**Structure Decision**: Existing web-app layout; all new frontend behavior stays in `src/clerk/` behind the bridge.

## Complexity Tracking

None.
