# Tasks: Organization Switcher and Member Invitations

**Input**: Design documents from `specs/005-clerk-org-switcher-invites/`

## Phase 1: Foundational

- [x] T001 Add documented `singleOrganization: boolean` to `ClerkClientConfig` in packages/workshop-shared/src/api.ts
- [x] T002 Set `singleOrganization: isSingleTenant(env)` in packages/workshop-backend/src/deployment-config.ts
- [x] T003 Add `isOrganizationAdmin` and `openOrganizationMembers` to `ClerkBridge` in packages/workshop-frontend/src/clerk/clerkBridge.ts and implement them in packages/workshop-frontend/src/clerk/ClerkAppProvider.tsx; update the fixture in packages/workshop-frontend/src/clerk/useClerkAuth.test.tsx

## Phase 2: User Story 1 - Switch workspace and create an organization (P1)

- [x] T004 [US1] In packages/workshop-frontend/src/clerk/WorkspaceSwitcher.tsx hide the personal workspace and the create action when `singleOrganization`

## Phase 3: User Story 2 - Invite colleagues (P2)

- [x] T005 [US2] Add "Invite members" to packages/workshop-frontend/src/components/UserMenu.tsx, shown only when `isOrganizationAdmin`
- [x] T006 [P] [US2] Add the same item to the mobile menu in packages/workshop-frontend/src/components/Header.tsx
- [x] T007 [US2] Test in packages/workshop-frontend/src/components/UserMenu.test.tsx: item offered to org admins and opens the panel; absent for members, the personal workspace and non-Clerk deployments

## Phase 4: Polish

- [x] T008 Document the switcher, invite panel and dedicated mode in docs/clerk-signin.md
- [x] T009 Run frontend tests and build both packages (quickstart "Automated")

## Dependencies

T001 → T002, T004. T003 → T005, T006, T007. T008–T009 last.
