# Tenant files

Every workspace (an organization, or a user's personal workspace) has a flat file area, opened from
the **Files** item in the top navigation. Members add and remove files; everyone in the workspace sees
the same list. It is offered only on deployments that sign users in with Clerk, because the file area
belongs to a tenant (see [Clerk sign-in](clerk-signin.md)).

## Who may do what

- Any member lists, downloads and adds files.
- A file is removed, or replaced by an upload of the same name, by whoever added it or by an
  organization administrator (the verified token's role, as for branding). In a personal workspace the
  owner may do both to anything.
- A member who leaves keeps their files in the organization, under their old name. Erasing an
  organization deletes its files.

## Storage

- Bytes are in the `TENANT_FILES` R2 bucket under `<tenantId>/<fileId>`. The bucket is declared in
  `packages/workshop-backend/cloudflare.config.ts` like any other binding, so the release manifest
  (`$R2_TENANT_FILES_NAME`) and the Terraform instance module create it with no extra configuration.
  Upgrading an existing instance creates the bucket on the next apply. To adopt a bucket you made by
  hand: `terraform import 'module.instance.cloudflare_r2_bucket.r2["workshop-backend:TENANT_FILES"]' <account_id>/<bucket_name>`.
- A deployment without the binding shows Files as unavailable and the rest of the product works.
- The index (name, size, type, uploader, state) and the quota are in the workspace's
  `UserDirectoryDurableObject`, in a `files` table. Its synchronous SQL makes the decisions about room,
  names and permission atomic. File names are display data; they never appear in a storage key.

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `TENANT_FILES_MAX_FILE_BYTES` | 104857600 (100 MB) | Largest single file |
| `TENANT_FILES_QUOTA_BYTES` | 5368709120 (5 GB) | Most a workspace may hold |

Both are positive integers of bytes; anything else falls back to the default. Both are enforced on the
server. Usage counts uploads in progress and removals not yet finished, so it never under-reports bytes
that still exist.

## How a file travels

There is no HTTP route for files: a plain request carries no sign-in. `AuthenticatedApi.getFilesApi()`
mints a `TenantFilesApi` capability from the verified session, and bytes travel as `ReadableStream`s over
the existing Cap'n Web session, with flow control (`uploadFile`, `downloadFile`). No method takes a tenant
or a storage key, and another tenant's file id is answered exactly like an id that does not exist.
Every call re-reads the session, so a removed member or a demoted administrator is refused on the next
call.

An upload is two-phase. `begin` validates and reserves room (a `pending` row); the capability streams the
body into R2 through a stream of exactly the declared length; `commit` makes it `ready` and decides the
final name (reject, replace, or keep both as `name (2).ext`). A failed upload releases its reservation
and bytes; one that never finishes is swept after an hour, and its commit would be refused. A removal
hides the file at once (`removing`), deletes the bytes, then the row; a failed delete is retried by the
next upload or listing.

## What may be stored and shown

A short deny-list refuses executables, installers, scripts and documents that run in a browser (by
extension and by declared type; see `tenant-files.ts`). Names and types are claimed by the sender, so
the rule that keeps content from running in the product is on the way out: only PNG, JPEG, GIF, WebP and
PDF are ever opened inline, and every other file is delivered as `application/octet-stream`.

## Logs

Logger `workshop.tenant.files` and `workshop.user-directory`: `file.uploaded`, `file.removed`,
`file.refused` (with the reason), `file.sweep.failed`, with tenant, user, file id and size. Never names,
contents or headers.
