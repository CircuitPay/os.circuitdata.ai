# Quickstart: validate the switcher and invitation panel

Prerequisites: a Clerk dev instance with Organizations enabled and personal accounts allowed; `CLERK_ISSUER` and `CLERK_PUBLISHABLE_KEY` set (see `docs/clerk-signin.md`); `pnpm dev-server`.

## Automated

```sh
pnpm --filter @gadgets/workshop-frontend test:run -- src/components/UserMenu.test.tsx
pnpm exec vp run -F @gadgets/workshop-frontend build
pnpm exec vp run -F @gadgets/workshop-backend build
```

## Manual (Story 1)

1. Sign in as a user with no organization. The header switcher shows "Personal account".
2. Switcher → Create organization → name it. Expect the Workshop to reload into an empty workspace.
3. Switch back to the personal workspace. Expect its earlier content.

## Manual (Story 2)

1. With the new organization active, open the profile menu → **Invite members**. Expect Clerk's organization modal on Members.
2. Invite a second email as Member. Expect it under Invitations; revoke one and expect it gone.
3. Accept an invitation from the second account, sign in, and expect the organization in its switcher.
4. As that member (not admin), expect no **Invite members** item. In the personal workspace, expect none either.

## Dedicated deployment

Set `TENANT_MODE=single` and `TENANT_ID=<org id>`. Expect the switcher to list neither the personal workspace nor "Create organization".
