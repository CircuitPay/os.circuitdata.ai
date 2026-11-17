# Implementation Plan: Organization File Management

**Branch**: `004-organization-file-management` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-organization-file-management/spec.md`

## Summary

Every tenant (organization, or a user's personal workspace) gets a flat file area. Bytes live in a new
dedicated R2 bucket (`TENANT_FILES`), keyed `<tenantId>/<fileId>`; the index (name, size, type,
uploader, state) and the quota live in the tenant's own `UserDirectoryDurableObject`, the per-tenant
Durable Object that already holds the tenant's branding. Authority comes from a new capability,
`TenantFilesApi`, minted by `AuthenticatedApi.getFilesApi()` from the verified Clerk session (the
`getTenantAdminApi` pattern): the tenant is fixed when the capability is minted and every call re-checks
that the session is live and re-reads the current role. There is no HTTP route, because an HTTP request
for a file carries no sign-in; bytes travel as `ReadableStream`s over the existing RPC session, as
`importBlueprint` / `downloadBlueprint` already do.

Uploads are two-phase so an abandoned upload is never visible or counted for long: `begin` reserves
quota and records a `pending` row, the capability streams the body into R2 through a `FixedLengthStream`
of the declared size (so the size the quota was reserved for is the size stored), and `commit` flips the
row to `ready`. A failed or abandoned upload leaves only an expiring `pending` row, swept lazily with its
R2 object. Removal marks the row `removing` (hidden and unretrievable at once, still counted), deletes the
R2 object and then the row; a failed delete is retried by the same sweep.

The frontend adds a top-level **Files** item (Clerk deployments only), a `/files` route and a
`src/files/` feature folder: a list with name search and paging, multi-file upload with per-file
progress and a replace / keep-both / skip choice on name collisions, download / open, confirmed removal,
and a storage-usage meter.

## Technical Context

**Language/Version**: TypeScript 7 (tsgo), Cloudflare Workers, React 19 SPA.

**Primary Dependencies**: Existing only: capnweb / capnweb-validate (streams as parameters and results),
Kumo, Phosphor, TanStack Router. No new packages.

**Storage**: One new R2 bucket binding `TENANT_FILES` (`bindings.r2({ name: "gadgets-tenant-files" })`);
Durable Object SQLite `files` table in the existing per-tenant `UserDirectoryDurableObject`. **No new
Durable Object class, so no migration tag.** The binding flows through `scripts/release/manifest-lib.ts`
(`$R2_TENANT_FILES_NAME`) and the Terraform instance module (`r2_bindings`) with no code change in either.

**Testing**: vitest in workerd (`__tests__` for validation/limits, `__integration__` for the
two-tenant RPC scenarios, as `tenant-branding.test.ts`); vitest + jsdom for the SPA; release golden
manifest and the staging-config test updated for the new binding.

**Target Platform**: Cloudflare Workers + browser.

**Project Type**: Web application (kernel: `workshop-backend` + `workshop-shared`; UI: `workshop-frontend`).

**Performance Goals**: First page of a 5,000-file list in under 3 s (SC-007): the list is a keyset-paged
indexed query of 50 rows. Uploads stream; the Worker never buffers a file.

**Constraints**: Kernel diffs small (constitution I). A cross-tenant request cannot be expressed: no
method takes a tenant or key. Sizes are enforced on the server (declared size is the stream's fixed
length). Content never runs in the product origin (FR-011): stored `contentType` is sanitized, and only
an allow-list of image types and PDF is ever opened inline.

**Scale/Scope**: 100 MB per file and 5 GB per tenant by default, overridable by the operator with the
`TENANT_FILES_MAX_FILE_BYTES` and `TENANT_FILES_QUOTA_BYTES` variables. One flat list per tenant.

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. Kernel bar | Pass | Reuses the per-tenant directory DO, the `getTenantAdminApi` capability pattern and the existing R2/`ReadableStream` RPC precedent. New backend code is one module (`tenant-files.ts`) plus a `files` section in the directory DO and one mint method; every exported `workshop-shared` member gets a doc comment; no hand-written mirror interface or `as unknown as`. Ships as two reviewable parts: (1) kernel: shared API, `tenant-files.ts`, directory DO, config; (2) frontend. A dedicated bucket rather than a `BLUEPRINT_CONTENT` prefix is justified in research D1. |
| II. Capability security | Pass | Tenant comes from the verified session at mint time and is never a parameter. Role (for removal by an administrator) is re-read on every call. The capability reaches only its tenant's rows and R2 prefix. Nothing ambient is added; no gatekeeper involved; auth config untouched; no `AdminConfig` field. |
| III. RPC discipline | Pass | `TenantFilesApiImpl` is `@validateRpc()`; the minted stub is disposed by the page; download returns a stream, not a stub; no stub is held in `useState` bare. |
| IV. Observability | Pass | `tenant.files` logger events `file.uploaded`, `file.removed`, `file.refused`, `file.sweep.failed` carry tenant id, user id, file id and size, never contents or names beyond the file id. |
| V. Frontend conventions | Pass | `frontend-conventions` skill is loaded before UI work. Kumo components, feature code in `src/files/`, colocated tests; no custom color literals. |
| VI. Tests | Pass | Refusal tests for cross-tenant list/download/remove, non-uploader removal, role removed mid-session, over-limit and deny-listed uploads, abandoned upload, concurrent same-name upload. |
| VII. Config integrity | Pass | Binding added in `cloudflare.config.ts`; `wrangler.jsonc` regenerated with `pnpm configs:generate`; golden manifest regenerated and reviewed; `pnpm configs:check` passes. |

No violations; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-organization-file-management/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── rpc-api.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/workshop-shared/src/
└── api.ts                          # + TenantFile, TenantFilesUsage, FilesPage..., TenantFilesApi,
                                    #   AuthenticatedApi.getFilesApi, doc-commented limits

packages/workshop-backend/
├── cloudflare.config.ts            # + TENANT_FILES R2 binding
├── wrangler.jsonc                  # regenerated
├── vitest.config.ts                # + r2Buckets: TENANT_FILES
├── src/
│   ├── tenant-files.ts             # NEW  validation, deny-list, limits, TenantFilesApiImpl
│   ├── user-directory.ts           # + files table + begin/commit/abort/list/remove/sweep/purge
│   ├── server.ts                   # + getFilesApi() mint
│   └── env.d.ts                    # + TENANT_FILES
├── __tests__/tenant-files.test.ts           # NEW  validation, deny-list, names, limits
└── __integration__/tenant-files.test.ts     # NEW  two tenants over real RPC

packages/workshop-frontend/src/
├── files/                          # NEW  FilesPage, FileList, UploadDialog..., useTenantFiles
├── routes/files.tsx                # NEW  + routeTree.gen.ts regenerated
└── components/Header.tsx           # + Files link (Clerk deployments)

scripts/preview/staging-config.test.ts       # expected r2_buckets
scripts/release/testdata/golden-manifest.json
infra/terraform/modules/instance/tests/fixtures/release*/manifest.json   # only if their tests require it
docs/tenant-files.md                          # NEW  operator and design doc
```

**Structure Decision**: Kernel changes confined to `workshop-backend` + `workshop-shared`, in separate
commits from the UI. The index is in the existing directory DO rather than a new class so there is no
migration and tenant erasure already reaches it.

## Key Design Decisions (details in research.md)

1. **Dedicated `TENANT_FILES` bucket**, not a prefix in `BLUEPRINT_CONTENT`.
2. **Capability over RPC streams, no HTTP route**: a plain request carries no sign-in.
3. **Index and quota in the per-tenant directory DO**; synchronous SQL there makes quota and name
   decisions atomic.
4. **Two-phase upload** with an expiring `pending` reservation; **three-state removal**.
5. **Declared size enforced by `FixedLengthStream`**, so quota accounting is exact.
6. **Names are display data only**; the R2 key is `<tenantId>/<fileId>`, so no name can address another
   tenant or file.
7. **Name conflicts resolved at commit** (reject / replace / keep both); replacing needs the same
   permission as removing.
8. **Inline opening only for an allow-list** (png, jpeg, gif, webp, pdf); everything else downloads as
   `application/octet-stream`.
9. **Clerk deployments only**; unavailable state when the bucket is not bound.
