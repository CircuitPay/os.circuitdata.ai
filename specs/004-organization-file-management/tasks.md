# Tasks: Organization File Management

**Input**: `specs/004-organization-file-management/` (plan, spec, research, data-model, contracts, quickstart)

**Tests**: Included (constitution VI: refusal tests for every isolation boundary).

**Commit grouping** (constitution I): (1) kernel: `workshop-shared` + `workshop-backend` + config/release; (2) frontend. Docs with the kernel part.

## Format: `- [ ] [TaskID] [P?] [Story?] Description with file path`

Stories: US1 upload, US2 remove, US3 download/open, US4 isolation and active workspace, US5 usage.

## Phase 1: Setup

- [x] T001 Load the `frontend-conventions` skill before any `packages/*` React work (Phase 8 onward)
- [x] T002 Add the `TENANT_FILES` R2 binding (`bindings.r2({ name: "gadgets-tenant-files" })`) to `packages/workshop-backend/cloudflare.config.ts`; declare `TENANT_FILES: R2Bucket` in `packages/workshop-backend/src/env.d.ts`; add `r2Buckets: ['BLUEPRINT_CONTENT', 'TENANT_FILES']` in `packages/workshop-backend/vitest.config.ts`; run `pnpm configs:generate`
- [x] T003 [P] Update release fixtures for the new binding: expected `r2_buckets` in `scripts/preview/staging-config.test.ts`, regenerate `scripts/release/testdata/golden-manifest.json` with `UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts` and review the diff; update the Terraform fixture manifests under `infra/terraform/modules/instance/tests/fixtures/` only if their tests require it

## Phase 2: Foundational (blocks all stories)

- [x] T004 [P] Shared types with doc comments in `packages/workshop-shared/src/api.ts`: `TenantFile`, `TenantFilesUsage`, `FileNameConflict`, `FileUploadRequest`, `FileDownload`, `TenantFilesApi`, and `AuthenticatedApi.getFilesApi()` per `contracts/rpc-api.md`
- [x] T005 Create `packages/workshop-backend/src/tenant-files.ts` (part 1, pure): default limits, `filesLimits(env)`, `validateFileName`, `sanitizeContentType`, `isDeniedFileType`, `isPreviewableType`, `uniqueFileName` (`name (2).ext`), list-cursor and `LIKE` escaping helpers
- [x] T006 [P] Unit tests in `packages/workshop-backend/__tests__/tenant-files.test.ts` for T005: valid and invalid names (blank, control characters, separators, 256 chars, emoji, trailing dots), deny-list by extension and by type including mixed case and double extensions, sanitized types, previewable allow-list, `uniqueFileName` sequence, malformed env limits fall back to defaults
- [x] T007 Add the `files` table and its operations to `packages/workshop-backend/src/user-directory.ts` per `data-model.md`: `beginFileUpload`, `commitFileUpload`, `abortFileUpload`, `listFiles`, `findExistingFileNames`, `getFile`, `removeFile`, `getFilesUsage`, and the lazy `#sweepFiles` (expired `pending` and `removing` rows, R2 objects deleted first, failures logged and retried next time)
- [x] T008 Create `TenantFilesApiImpl` in `packages/workshop-backend/src/tenant-files.ts` (`@validateRpc()`, `RpcTarget`): constructed with the directory stub, the bucket, the minted tenant id, a `current()` returning the live `TenantContext`, and the limits; `uploadFile` pipes the body through `FixedLengthStream(size)` into `bucket.put`; audit logging through `createWorkshopLogger("workshop.tenant.files")`
- [x] T009 Mint the capability: `AuthenticatedApiImpl.getFilesApi()` in `packages/workshop-backend/src/server.ts`; returns null without a Clerk session or without the bucket; `current` is `this.#clerkTenant()`
- [x] T010 `eraseTenant` purges the tenant's R2 objects (listed by prefix, 1000 at a time) and the `files` table, in `packages/workshop-backend/src/user-directory.ts`

**Checkpoint**: `pnpm --filter @gadgets/workshop-backend build` type-checks, including the generated validators.

## Phase 3: User Story 1 - Upload files (P1) 🎯 MVP

**Independent test**: a member uploads; the list shows it; a second member of the same organization sees it; a failed or oversized upload leaves nothing.

- [x] T011 [US1] Integration tests in `packages/workshop-backend/__integration__/tenant-files.test.ts` (reuse `clerkFixture`): upload then list for two members of one organization; over-limit file refused with the limit named; over-quota refused (use a small `TENANT_FILES_QUOTA_BYTES` through the test environment); deny-listed name and type refused; body shorter and longer than declared refused with nothing listed and usage unchanged; abandoned `pending` row expires and is not listed or counted
- [x] T012 [US1] Integration tests for name conflicts: `reject` refused, `replace` by the uploader and by an administrator succeeds and the old bytes are gone, `replace` by a non-uploader member refused, `keep-both` yields `name (2).ext`, two simultaneous same-name uploads never leave two live files of that name

## Phase 4: User Story 2 - Remove files (P1)

- [x] T013 [US2] Integration tests: uploader removes; administrator removes another's; non-uploader member refused with the message and the file intact; removed file is not listed, not downloadable, usage drops; removing twice reports "File not found."; a `removing` row whose R2 delete failed is retried by the next sweep and stays hidden meanwhile
- [x] T014 [US2] Integration test: a role downgrade delivered with `renewSession` takes effect on the very next `removeFile` without reconnecting

## Phase 5: User Story 4 - Isolation and active workspace (P1)

- [x] T015 [US4] Integration tests: two organizations upload the same name and each lists only its own; the other organization's file id passed to `downloadFile` and `removeFile` yields the same "File not found." as a random id; a personal workspace has its own area and its owner may remove anything in it; a user removed from an organization is refused on the next call (renewal refused closes the connection); `getFilesApi()` is null for a session without Clerk
- [x] T016 [US4] Integration test: `eraseTenant` deletes the tenant's R2 objects and leaves other tenants' objects

## Phase 6: User Story 3 - Download or open (P2)

- [x] T017 [US3] Integration tests: downloaded bytes equal uploaded bytes (multi-MB, byte-for-byte), name and size are returned, a previewable image keeps its type, a `.txt` or unknown type is delivered as `application/octet-stream`

## Phase 7: User Story 5 - Usage (P3)

- [x] T018 [US5] Integration test: `getUsage()` rises with uploads and falls with removals, counts reserved bytes while an upload is pending, and reports the configured limits

**Checkpoint (kernel)**: `pnpm --filter @gadgets/workshop-backend test:run`, `pnpm configs:check`.

## Phase 8: Frontend (all stories)

- [x] T019 Route `packages/workshop-frontend/src/routes/files.tsx` (`createFileRoute('/files')`) and regenerate `routeTree.gen.ts` with the router plugin
- [x] T020 [P] `packages/workshop-frontend/src/files/useTenantFiles.ts` and `useFileUploads.ts`: obtain and dispose the `TenantFilesApi` stub (wrapped in an object for state), load usage and pages (the previous listing stays up while a search or refresh loads), and run the upload queue; distinguish `unavailable` (null capability) from `failed`
- [x] T021 [P] `packages/workshop-frontend/src/files/uploadStream.ts`: a `File` to stream with byte-counting progress callback, so the page shows per-file progress
- [x] T022 `packages/workshop-frontend/src/files/FilesPage.tsx` and `FileList.tsx` (Kumo): empty, loading, error with retry, and unavailable states; list with name search and "load more"; usage meter; upload through button and drag-and-drop, per-file progress and per-file result; remove with confirmation (reuse `components/DeleteConfirmationDialog.tsx`), hidden for files the user may not remove; download and open; keyboard and screen-reader behavior (accessible names, progress announcements, focus return after dialogs)
- [x] T023 `packages/workshop-frontend/src/files/NameConflictDialog.tsx`: replace / keep both / skip, one answer for all the colliding files of a selection
- [x] T024 `packages/workshop-frontend/src/files/openFile.ts`: saves via a blob and `a[download]`, or opens a blob URL only for previewable types; revokes URLs
- [x] T025 Header: a **Files** link in the desktop and mobile nav in `packages/workshop-frontend/src/components/Header.tsx`, shown only when `useClerkBridge()` is truthy
- [x] T026 [P] Tests colocated in `packages/workshop-frontend/src/files/`: `FilesPage.test.tsx` (empty/unavailable/error states, upload progress and per-file failure, conflict choice reaches the request, removal confirm and cancel, remove control absent when `mayRemove` is false, usage shown) and `uploadStream.test.ts` (progress, byte count)

## Phase 9: Polish

- [x] T027 [P] `docs/tenant-files.md`: what it is, the bucket and where it comes from in each deployment path, the two limit variables, serving rules, erasure; link it from `docs/clerk-signin.md` and add the `TENANT_FILES` mention to `infra/terraform/README.md` if that file lists buckets
- [x] T028 [P] Add one short entry for the feature to the `packages/workshop-backend` description in `AGENTS.md` (bucket, directory-DO index, capability, Clerk-only)
- [x] T029 Run `pnpm lint`, the backend and frontend suites, and the quickstart scenarios that need no browser; smoke the page in a browser against `pnpm dev-server` and record what was and was not exercised

## Dependencies

T002 → T007/T008/T009 (binding and types). T004 → T008, T009, T020. T005 → T006, T007, T008. T007 → T008 → T009 → T011–T018. T019–T025 need T004 and a running T009 for the manual smoke. T026 needs T020–T024. T029 last.

## Parallel opportunities

T003, T004, T006 together after T002/T005; T020, T021, T026 together; T027 and T028 any time after T009.
