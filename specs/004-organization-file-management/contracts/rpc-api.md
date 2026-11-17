# Contract: RPC additions (`packages/workshop-shared/src/api.ts`)

Every exported member gets a doc comment (constitution I).

## `AuthenticatedApi`

```ts
/**
 * The capability to manage the active tenant's files, or null when the deployment cannot offer
 * them (not a Clerk session, or file storage is not configured). Dispose it when done.
 */
getFilesApi(): Promise<RpcStub<TenantFilesApi> | null>;
```

## Types

```ts
/** One stored file as members see it. */
export type TenantFile = {
  id: string;                 // opaque; the only handle for download / remove
  name: string;
  size: number;               // bytes
  contentType: string;        // sanitized type/subtype
  previewable: boolean;       // may be opened in the browser (image or PDF); else download only
  uploader: { name: string | null; isMe: boolean };
  uploadedAt: Date;
  mayRemove: boolean;         // the caller is the uploader or an administrator, right now
};

/** A tenant's storage, and the limits uploads are held to. */
export type TenantFilesUsage = {
  usedBytes: number;
  quotaBytes: number;
  fileCount: number;
  maxFileBytes: number;
};

/** How an upload treats an existing file with the same name. */
export type FileNameConflict = "reject" | "replace" | "keep-both";

/** The metadata of an upload; the bytes travel in the stream argument. */
export type FileUploadRequest = {
  name: string;
  size: number;               // exact byte length of the stream
  contentType: string;
  onConflict: FileNameConflict;
};

/** A file's bytes with the metadata needed to save or show them. */
export type FileDownload = {
  name: string;
  size: number;
  contentType: string;        // the stored type if previewable, else application/octet-stream
  stream: ReadableStream<Uint8Array>;
};
```

## `TenantFilesApi extends RpcTarget`

| Method | Behavior | Refusals |
|---|---|---|
| `getUsage(): Promise<TenantFilesUsage>` | Current usage and limits. | session no longer live |
| `listFiles(options: { query?: string; after?: string; limit?: number }): Promise<{ files: TenantFile[]; next?: string }>` | `ready` files, newest first, 1–100 per page (default 50), `query` = case-insensitive name substring, `after` = opaque cursor from `next`. | bad cursor |
| `findExisting(names: string[]): Promise<string[]>` | Which of up to 100 names are held by a `ready` file; lets the UI offer replace / keep both before sending bytes. | more than 100 names |
| `uploadFile(request: FileUploadRequest, body: ReadableStream<Uint8Array>): Promise<TenantFile>` | Stores the file and returns it (with its final name). Nothing is listed unless the whole body arrived. | invalid or deny-listed name or type; `size` over `maxFileBytes`; over quota (message states used / quota); body length != `size`; name taken with `reject`; `replace` of a file the caller may not remove; reservation expired |
| `downloadFile(id: string): Promise<FileDownload>` | Streams a `ready` file. | "File not found." for unknown, `removing`, `pending` or other-tenant ids (indistinguishable) |
| `removeFile(id: string): Promise<void>` | Hides then deletes. Idempotent for an already-removed id (throws "File not found."). | "You can only remove files you uploaded." unless uploader or administrator |

Every method first asserts the session is live and the connection's tenant is the one the capability was
minted for, and re-reads the current role. Nothing takes a tenant id or an R2 key.

## Audit events (logger `workshop.tenant.files`)

`file.uploaded`, `file.removed`, `file.refused` (with `refusalReason`), `file.sweep.failed`; fields:
`tenantId`, `userId`, `fileId`, `size`. Never names, contents or headers.
