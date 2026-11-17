# Research: Organization File Management

No `NEEDS CLARIFICATION` remained after `/speckit.clarify`; this records the design decisions and what
in the repo they rest on.

## D1. A dedicated R2 bucket

**Decision**: add `TENANT_FILES: bindings.r2({ name: "gadgets-tenant-files" })` to the backend's
`cloudflare.config.ts`.

**Rationale**: `BLUEPRINT_CONTENT` holds git packfiles at `<blueprintId>/<commitId>` and a fixed
`.site-logo` key; user-chosen content in the same bucket would share a namespace and a lifecycle with
code the platform depends on, and a mistake in file handling would sit next to blueprint data. The
binding is data-driven through the release pipeline: `manifest-lib.ts` turns every `r2_buckets` entry
into `$R2_<BINDING>_NAME`, and Terraform's `local.r2_bindings` creates one bucket per such binding, so
nothing but the config changes. `TENANT_FILES` is shorter than `BLUEPRINT_CONTENT`, so the preview
bucket-name arithmetic in `scripts/preview/staging-config.ts` still fits.

**Alternatives**: a prefix in `BLUEPRINT_CONTENT` (rejected above); a bucket per tenant (R2 buckets are
not a per-tenant primitive and cannot be created from a Worker at request time here).

## D2. Bytes travel over RPC streams; no HTTP route

**Decision**: `TenantFilesApi.uploadFile(request, body: ReadableStream)` and
`downloadFile(id): { ..., stream }`.

**Rationale**: the existing branding code states the constraint: "a request for an image carries no
sign-in". Authority here is the Cap'n Web session; a bearer-less URL would need its own token scheme.
`PublicApi.importBlueprint(archive: ReadableStream<Uint8Array>)` and
`AuthenticatedApi.downloadBlueprint(): Promise<ReadableStream<Uint8Array>>` already carry large
payloads as streams, with flow control (capnweb 0.12 README, "Streaming with flow control"), so a 100 MB
file is not a single 32 MiB WebSocket message.

**Alternatives**: presigned R2 URLs (needs R2 S3 credentials in the Worker, a new secret and a new trust
surface); an authenticated HTTP route (needs a cookie or token scheme this app does not have).

## D3. Index and quota in the per-tenant directory Durable Object

**Decision**: add a `files` table to `UserDirectoryDurableObject` (named by tenant id).

**Rationale**: it is already one DO per tenant, it already holds a tenant's branding as the precedent for
tenant-owned data, and `eraseTenant` already empties it, so tenant deletion has one place to hook the
file purge. A DO's synchronous SQL makes "is there room, is the name free" an atomic decision without a
lock. A new DO class would cost a migration tag and a second place to erase.

**Alternatives**: D1/KV index (no atomicity for quota); listing R2 for the index (no per-file uploader,
slow counts, no quota arithmetic).

## D4. Two-phase upload, three-state removal

**Decision**: file rows are `pending` → `ready`, and `ready` → `removing` → deleted.

**Rationale**: spec FR-004 (no partial file visible) and SC-004/SC-005. `pending` rows hold a quota
reservation that expires after one hour and are swept, with their R2 objects, on the next upload or
listing; a commit for a swept row fails, so an expired upload never appears. `removing` hides a file
immediately and still counts toward usage until the R2 object is confirmed gone, so usage never
under-reports bytes that still exist.

## D5. Declared size is the stored size

**Decision**: `begin` reserves `size`; the Worker pipes the body through `new FixedLengthStream(size)`
into `bucket.put`. A body shorter or longer than declared makes the stream error, the put fail, and the
reservation abort.

**Rationale**: `R2Bucket.put` needs a known length for a stream; this gives it one and makes quota
accounting exact. `commit` additionally compares the stored object's size with the reservation.

## D6. Names are display data

**Decision**: the R2 key is `<tenantId>/<fileId>` with a random UUID `fileId`. Names are validated for
display (1–255 chars after trimming, no control characters, no `/` or `\`) and compared exactly.

**Rationale**: path-like names, Unicode tricks and collisions across tenants cannot address another
object. Exact comparison keeps one rule for uniqueness; a partial unique index over `ready` rows makes a
simultaneous same-name upload fail one writer instead of overwriting (spec edge case).

## D7. Conflict resolution at commit

**Decision**: an upload carries `onConflict: "reject" | "replace" | "keep-both"`. The final name is
decided inside the DO at commit. `replace` is allowed only if the caller may remove the existing file
(uploader or administrator).

**Rationale**: otherwise "replace" is a way for a member to delete someone else's file, defeating the
removal rule the clarification set. The UI learns which names collide beforehand from `findExisting`.

## D8. Deny-list and safe serving

**Decision**: refuse by extension and by declared type: executables and installers (`exe msi dll bat cmd
com scr pif jar app apk dmg pkg deb rpm`), scripts (`sh bash zsh ps1 psm1 vbs vbe js mjs cjs wsf wsh
hta`), and active documents (`html htm xhtml shtml svg svgz xml xsl` plus `text/html`,
`application/xhtml+xml`, `image/svg+xml`, `application/x-msdownload`, `application/javascript`,
`text/javascript`). Stored content types are sanitized to a `type/subtype` token or
`application/octet-stream`. Only `image/png`, `image/jpeg`, `image/gif`, `image/webp` and
`application/pdf` are "previewable"; every other file is delivered as `application/octet-stream`, so a
blob URL can only ever display an image or a PDF.

**Rationale**: the clarification chose a short deny-list; the serving rule is what actually guarantees
FR-011, because content-type and extension are client-asserted and the deny-list is only a first line.

## D9. Role and tenant on every call

**Decision**: the capability is constructed with a `current()` function returning the connection's latest
`TenantContext` (after `#assertSessionLive`), and with the tenant id captured at mint. Each method calls
`current()`; removal by an administrator uses `isOrganizationAdmin(current().orgRole)`.

**Rationale**: `renewSession` replaces `clerkSession` every 30 s and closes the connection when Clerk
refuses it, which is what makes a removed member's next action fail (SC-006). This is the pattern
`getTenantAdminApi` already uses.

## D10. Availability

**Decision**: `getFilesApi()` returns null when the session is not a Clerk session or the bucket is not
bound. A personal tenant is allowed and treats its owner as administrator of their own area.

**Rationale**: FR-018. The frontend distinguishes "not offered" (menu hidden when there is no Clerk
bridge) from "storage not configured" (page shown, capability null).

## D11. Limits

**Decision**: defaults 100 MB per file and 5 GB per tenant as exported constants in `tenant-files.ts`,
overridable with `TENANT_FILES_MAX_FILE_BYTES` / `TENANT_FILES_QUOTA_BYTES` (positive integers; anything
else falls back to the default). Both are returned by `getUsage()` so the UI never hard-codes them.

**Rationale**: spec Assumptions: "adjustable by the deployment operator". They are runtime variables, not
`AdminConfig` (soft customizations), and they are not part of authentication, so they do not conflict
with constitution II.

## D12. Organization deletion

**Decision**: `UserDirectoryDurableObject.eraseTenant` also deletes every R2 object under
`<tenantId>/` (listed in pages of 1000) and the `files` table, before the existing user erasure
completes. Every step is idempotent, as `eraseTenant` already requires.
