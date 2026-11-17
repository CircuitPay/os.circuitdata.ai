# Research: Organization Switcher and Member Invitations

## R1. Invitation panel component

- **Decision**: Clerk `OrganizationProfile`, opened as a modal with `clerk.openOrganizationProfile()`; its first (index) page is Members, which holds Invite, the pending Invitations tab and Revoke.
- **Rationale**: Clerk has no standalone invite component. The profile's Members page is Clerk's invite panel, enforces `org:sys_memberships:manage` itself, sends the emails and handles acceptance. A modal mirrors the existing `openUserProfile` ("Manage account") pattern.
- **Alternatives**: Custom Kumo panel over `useOrganization({ invitations: true })` + `organization.inviteMembers()` (rejected: reimplements Clerk's form, the user asked for the Clerk component); a routed page with `<OrganizationProfile routing="hash">` (rejected: adds a route and fights TanStack Router over the URL for no gain).

## R2. Who is offered the panel

- **Decision**: Active organization role `org:admin` from `useAuth().orgRole`, exposed as `ClerkBridge.isOrganizationAdmin`.
- **Rationale**: Matches the backend's definition of organization administrator (`docs/clerk-signin.md`: token role `admin`/`org:admin`). `has({ permission: 'org:sys_memberships:manage' })` is unreliable client-side because system permissions are not in session-token claims. False with no active organization, so the personal workspace never offers it.
- **Alternatives**: `useTenantBranding().canManage` (rejected: switched off when operators disable branding).

## R3. Dedicated deployments in the switcher

- **Decision**: New `ClerkClientConfig.singleOrganization` (from `isSingleTenant(env)`); when true the switcher sets `hidePersonal` and hides the create action with the appearance element `organizationSwitcherPopoverActionButton__createOrganization`.
- **Rationale**: `OrganizationSwitcher` has no prop to hide creation (it follows the Clerk instance's "users can create organizations" setting, which a shared Clerk instance cannot turn off per deployment). The backend already refuses every other tenant, so this is presentation only.
- **Alternatives**: Clerk dashboard setting only (rejected: instance-wide, not per deployment).

## R4. Creating an organization

- **Decision**: Keep the switcher's built-in create flow (modal, followed by Clerk's invite-members step); `afterCreateOrganizationUrl="/"` already reconnects the Workshop into the new tenant.
- **Rationale**: Already in place and meets FR-003/FR-004.
