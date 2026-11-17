# Data Model: Organization File Management

## `files` table (in `UserDirectoryDurableObject`, one directory per tenant)

| Column | Type | Notes |
|---|---|---|
| `seq` | INTEGER PRIMARY KEY AUTOINCREMENT | Monotonic; list order (newest first) and the paging cursor. |
| `id` | TEXT NOT NULL UNIQUE | Random UUID. Public identity; the R2 key is `<tenantId>/<id>`. |
| `name` | TEXT NOT NULL | Display name, validated. For a `pending` row, the requested name. |
| `size` | INTEGER NOT NULL | Bytes. For `pending`, the declared (reserved) size. |
| `content_type` | TEXT NOT NULL | Sanitized `type/subtype`, else `application/octet-stream`. |
| `uploader_id` | TEXT NOT NULL | The uploader's user key (`tenantId NUL userId`). |
| `uploader_name` | TEXT | Display name snapshotted from the directory's `users` table at upload; null if unknown. Kept after the member leaves. |
| `state` | TEXT NOT NULL | `pending`, `ready` or `removing`. |
| `on_conflict` | TEXT | Pending rows only: `reject`, `replace` or `keep-both`. |
| `created_at` | INTEGER NOT NULL | ms; for `pending`, the reservation time (expires after 1 hour). |

Indexes: `UNIQUE (name) WHERE state = 'ready'` (one live file per name); `(state, created_at)` for the
sweep.

## States

```text
(begin)  pending ──commit──▶ ready ──remove──▶ removing ──R2 delete──▶ (row deleted)
            │                  ▲
            └─abort / expiry──▶ (R2 object + row deleted)
   replace: commit also moves the ready row holding the name to removing, in the same synchronous step as the flip
```

- `pending`: counts toward usage (reserved); never listed, never downloadable.
- `ready`: listed, downloadable, counts toward usage.
- `removing`: not listed, not downloadable, counts toward usage until the R2 object is deleted.

## Derived values

- **Usage**: `SUM(size)` over all rows (every state counts) and `COUNT(*)` of `ready` rows. Not stored,
  so it cannot drift (spec: Storage Usage is derived).
- **Quota check at `begin`**: `used + size <= quotaBytes`, and `size <= maxFileBytes`, `size >= 0`.
- **Final name at `commit`**: `reject` fails if a `ready` row has the name; `replace` moves that row to
  `removing` (requires the caller may remove it, checked at `begin` and again at `commit`);
  `keep-both` picks `name (2).ext`, `name (3).ext`, ... — the first free.

## R2 layout (`TENANT_FILES`)

`<tenantId>/<fileId>` → file bytes. `httpMetadata.contentType` is the sanitized type; `customMetadata`
carries nothing user-supplied. Nothing else lives in the bucket.

## Existing entities touched

- **Tenant** (`tenant.ts`): unchanged; its id prefixes every R2 key and names the directory DO.
- **TenantContext.orgRole**: read for the administrator check (`isOrganizationAdmin`); a personal tenant
  has no role and its owner is treated as administrator of their own area.
- **`UserDirectoryDurableObject.eraseTenant`**: now also purges the tenant's files.
