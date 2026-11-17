# Quickstart: validating organization file management

## Prerequisites

- `pnpm install`; `pnpm configs:generate` after the binding change.
- A Clerk-enabled dev deployment for the manual run (see `docs/clerk-signin.md`); the dev server creates
  the local R2 bucket from `wrangler.jsonc`.

## Automated

```sh
pnpm --filter @gadgets/workshop-backend test:run -- tenant-files          # unit: validation, deny-list, names
pnpm --filter @gadgets/workshop-backend test:integration -- tenant-files   # two tenants over real RPC
pnpm --filter @gadgets/workshop-frontend test:run -- files                 # page behavior
pnpm configs:check
UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts           # then review the golden diff
node --test scripts/preview/staging-config.test.ts
pnpm lint
```

(Use the repo's actual integration script name from `packages/workshop-backend/package.json`.)

## Manual scenarios (map to spec)

1. **Upload and list (US1)**: sign in to an organization, open **Files**, drop two files. Progress shows;
   both appear with name, size, type, uploader and date. A second member of the organization sees them.
2. **Failed upload (US1.3)**: start a large upload and close the tab. Reopen Files: nothing partial is
   listed; usage is unchanged within the hour.
3. **Limits (US1.5, US5)**: upload a file over the per-file limit, a `.html` file, and enough data to
   pass the quota. Each is refused with the specific reason and nothing is stored.
4. **Name collision (US1.6)**: upload `a.txt` twice: choose Replace, then repeat and choose Keep both
   (`a (2).txt`).
5. **Remove (US2)**: remove your file after the confirmation; it disappears for the other member. As a
   non-uploader member try to remove another's file: refused. As an administrator: allowed.
6. **Download / open (US3)**: download a file and compare bytes; open an image and a PDF inline; a `.txt`
   downloads.
7. **Isolation (US4)**: as a user in two organizations, switch between them: each shows only its own
   files. Remove a member in Clerk: their next action is refused.
8. **Unavailable (FR-018)**: run with the `TENANT_FILES` binding removed: Files explains it is
   unavailable and the rest of the app works.
