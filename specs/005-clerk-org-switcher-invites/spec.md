# Feature Specification: Organization Switcher and Member Invitations

**Feature Branch**: `005-clerk-org-switcher-invites`

**Created**: 2026-11-16

**Status**: Draft

**Input**: User description: "Two clerk components need to be included. First is the organization switcher and the ability to add additional organizations. Second is the invite panel to allow us to invite additional users into the organization."

## Context

Spec `001-clerk-tenant-identity` (FR-011, User Stories 2 and 5) established that each organization is its own tenant and that users must be able to switch workspaces, create organizations and invite members from within the Workshop. A workspace switcher already exists in the Workshop header. This feature makes both capabilities first-class, discoverable parts of the Workshop: a switcher that also creates organizations, and a dedicated invitation panel for bringing colleagues into the active organization.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Switch workspace and create an organization (Priority: P1)

A signed-in user sees which workspace is active (their personal workspace or an organization) and, from the Workshop header, can switch to any other workspace they belong to or create a new organization. A newly created organization becomes the active workspace immediately.

**Why this priority**: Nothing else in this feature works without an organization to be in; creating and entering one is the gateway to team use.

**Independent Test**: As a user with only a personal workspace, create an organization from the header, confirm it becomes active and empty, then switch back to the personal workspace and confirm its content reappears.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they open the switcher, **Then** they see their personal workspace and every organization they belong to, with the active one clearly marked.
2. **Given** a signed-in user, **When** they choose "create organization" and give it a name, **Then** the organization is created, becomes the active workspace, and shows no content from any other workspace.
3. **Given** a user who belongs to two or more workspaces, **When** they select a different one, **Then** the Workshop reloads into that workspace and shows only its content.
4. **Given** a user who already belongs to organizations, **When** they create another, **Then** it is added to their list without affecting existing memberships.

---

### User Story 2 - Invite colleagues into the organization (Priority: P2)

An organization administrator opens an invitation panel from within the Workshop, enters one or more email addresses, chooses a role for the invitees, and sends invitations. They can see invitations that are still pending and revoke any of them. An invitee receives an email, accepts, and on signing in finds the organization in their switcher.

**Why this priority**: Organizations deliver value only once more than one person is in them, but this depends on Story 1 having produced an organization.

**Independent Test**: As an organization administrator, invite a second email address; from that account, accept the invitation, sign in, and confirm the organization appears in the switcher and its workspace opens. Separately, revoke a pending invitation and confirm its link no longer grants membership.

**Acceptance Scenarios**:

1. **Given** an organization administrator with the organization active, **When** they open the invitation panel, enter valid email addresses and send, **Then** each address receives an invitation and appears in the pending list.
2. **Given** a pending invitation, **When** the invitee accepts it, **Then** they become a member with the chosen role and can switch into the organization's workspace.
3. **Given** a pending invitation, **When** an administrator revokes it, **Then** it disappears from the pending list and can no longer be accepted.
4. **Given** a member who is not an administrator, **When** they look for the invitation panel, **Then** it is not offered to them, and any attempt to invite is refused.
5. **Given** the personal workspace is active, **When** the user looks for the invitation panel, **Then** it is not offered, since a personal workspace has no other members.

---

### Edge Cases

- An invited address already belongs to a member: the panel reports it rather than sending a duplicate.
- An invalid or malformed email address: rejected with a clear message before sending; valid addresses in the same batch are still sent.
- The invitee signs up with a different email than the one invited: the invitation is not applied to that account.
- An administrator is demoted or removed while the panel is open: further invitations are refused.
- The user switches workspace in one tab while another tab is open: the other tab does not keep acting on the previous workspace (inherits the rule from spec 001).
- A dedicated single-organization deployment: creating additional organizations is not offered, since only the dedicated organization is admitted (spec 001, User Story 3).
- Deployments without organization sign-in (no Clerk configured): neither the switcher nor the invitation panel appears.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Workshop MUST show the active workspace in its header for every signed-in user on a deployment with organization sign-in.
- **FR-002**: Users MUST be able to switch between their personal workspace and every organization they belong to from that header control.
- **FR-003**: Users MUST be able to create a new organization from the same control; the new organization MUST become the active workspace.
- **FR-004**: Switching or creating a workspace MUST result in the Workshop showing only the newly active workspace's content.
- **FR-005**: Organization administrators MUST be able to open an invitation panel within the Workshop while an organization is active.
- **FR-006**: The invitation panel MUST let an administrator invite one or more people by email address and assign each batch a role (administrator or member), defaulting to member.
- **FR-007**: The invitation panel MUST list pending invitations and let an administrator revoke any of them.
- **FR-008**: The invitation panel MUST NOT be offered to non-administrators or when the personal workspace is active, and invitation attempts by non-administrators MUST be refused.
- **FR-009**: An accepted invitation MUST make the invitee a member of the organization with the assigned role, after which the organization appears in their switcher.
- **FR-010**: On a dedicated single-organization deployment, neither creating organizations nor the personal workspace MUST be offered, since the deployment admits only its one organization.
- **FR-011**: Both controls MUST be absent on deployments without organization sign-in.
- **FR-012**: Both controls MUST open within the Workshop, without sending the user to a separate site.

### Key Entities

- **Workspace**: Either a user's personal workspace or an organization; exactly one is active at a time.
- **Organization**: A named group of members that forms its own isolated tenant.
- **Membership**: A user's belonging to an organization, with a role (administrator or member).
- **Invitation**: A pending offer of membership sent to an email address with a role; pending, accepted or revoked.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can create a new organization and be working inside it in under 1 minute from the Workshop header.
- **SC-002**: A user can switch between workspaces in 2 interactions or fewer, and the new workspace's content appears within 3 seconds.
- **SC-003**: An administrator can invite a colleague in under 1 minute without leaving the Workshop.
- **SC-004**: 100% of invitation attempts by non-administrators are refused.
- **SC-005**: After switching workspaces, 0 items from the previously active workspace are visible.

## Assumptions

- Organization sign-in, tenant resolution and workspace isolation from spec 001 are in place and reused unchanged; this feature is presentation and access to existing identity capabilities, not new tenancy rules.
- The identity provider's hosted organization components supply creation, switching, invitation emails and acceptance; the Workshop embeds them rather than reimplementing them.
- Roles are the provider's standard administrator and member roles; custom roles are out of scope.
- Member management beyond invitations (changing roles, removing members) remains available through the existing organization management screen and is not redesigned here.
- Organization deletion, billing, seat limits and domain-based auto-join are out of scope.
- Organizations have no member cap beyond what the identity provider's plan imposes.
