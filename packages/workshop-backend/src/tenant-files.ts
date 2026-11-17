// Per-tenant files: what a name or a type may be, the limits, and the capability a tenant's members
// manage their files through. A tenant's file index and quota live in its UserDirectoryDurableObject,
// which decides every question of room, names and permission; the bytes live in the TENANT_FILES R2
// bucket under `<tenantId>/<fileId>`. The file's name is display data only and never part of a key.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  FileDownload, FileUploadRequest, TenantFile, TenantFilesApi, TenantFilesUsage,
} from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import { isOrganizationAdmin, type TenantContext } from "./tenant.js";
import type { UserDirectoryDurableObject } from "./user-directory.js";

const logger = createWorkshopLogger("workshop.tenant.files");

/** Default most bytes in one file. */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Default most bytes a tenant may hold. */
export const DEFAULT_TENANT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/** Longest accepted file name, in UTF-16 code units. */
export const MAX_FILE_NAME_LENGTH = 255;

/** How long an upload may take between its start and its end before its reservation is released. */
export const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;

/** Default and largest page of a listing. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Most names `findExisting` takes at once. */
export const MAX_FIND_NAMES = 100;

/** Limits of the variables an operator may set. */
export type FilesEnv = Readonly<{
  TENANT_FILES_MAX_FILE_BYTES?: string;
  TENANT_FILES_QUOTA_BYTES?: string;
}>;

/** The limits in force: the operator's variables where they are positive integers, else the defaults. */
export function filesLimits(env: FilesEnv): { maxFileBytes: number; quotaBytes: number } {
  return {
    maxFileBytes: positiveInteger(env.TENANT_FILES_MAX_FILE_BYTES) ?? DEFAULT_MAX_FILE_BYTES,
    quotaBytes: positiveInteger(env.TENANT_FILES_QUOTA_BYTES) ?? DEFAULT_TENANT_QUOTA_BYTES,
  };
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// Control characters, and the bidirectional overrides that make `evil\u202Egnp.exe` read as `evilexe.png`.
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\u202a-\u202e\u2066-\u2069/\\]/u;

/**
 * The trimmed name, or a thrown error saying what is wrong with it: blank, over
 * MAX_FILE_NAME_LENGTH, `.` or `..`, or containing control characters, bidirectional overrides,
 * `/` or `\`. The name is display data, so this is about what a person reads, not about paths.
 */
export function validateFileName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("A file needs a name.");
  if (trimmed.length > MAX_FILE_NAME_LENGTH) {
    throw new Error(`File names are at most ${MAX_FILE_NAME_LENGTH} characters.`);
  }
  if (trimmed === "." || trimmed === "..") throw new Error("That is not a valid file name.");
  if (FORBIDDEN_NAME_CHARACTERS.test(trimmed)) {
    throw new Error("File names cannot contain slashes or control characters.");
  }
  return trimmed;
}

// Executables, installers, scripts and documents that run in a browser. A short first line of defense:
// extensions and types are claimed by the sender, so what actually keeps a file from running in the
// product is that only PREVIEWABLE_TYPES are ever opened inline.
const DENIED_EXTENSIONS = new Set([
  "exe", "msi", "dll", "bat", "cmd", "com", "scr", "pif", "jar", "app", "apk", "dmg", "pkg", "deb", "rpm",
  "sh", "bash", "zsh", "ps1", "psm1", "vbs", "vbe", "js", "mjs", "cjs", "wsf", "wsh", "hta",
  "html", "htm", "xhtml", "shtml", "svg", "svgz", "xml", "xsl",
]);

const DENIED_TYPES = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml",
  "application/x-msdownload", "application/x-msdos-program", "application/x-msi",
  "application/javascript", "text/javascript", "application/x-sh", "application/x-httpd-php",
]);

/** The types a browser may be asked to display: images that cannot script, and PDF. */
export const PREVIEWABLE_TYPES: ReadonlySet<string> = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
]);

const FALLBACK_TYPE = "application/octet-stream";
const TYPE_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** `type/subtype` in lower case without parameters, or `application/octet-stream` if it is not one. */
export function sanitizeContentType(contentType: string): string {
  const bare = contentType.split(";")[0].trim().toLowerCase();
  return TYPE_TOKEN.test(bare) && bare.length <= 127 ? bare : FALLBACK_TYPE;
}

/** The part of `name` after its last dot, lower case, ignoring trailing dots and spaces; "" if none. */
function extensionOf(name: string): string {
  const stripped = name.replace(/[. ]+$/, "");
  const dot = stripped.lastIndexOf(".");
  return dot <= 0 ? "" : stripped.slice(dot + 1).toLowerCase();
}

/** Whether a file with this name or declared (sanitized) type is refused. */
export function isDeniedFileType(name: string, contentType: string): boolean {
  return DENIED_EXTENSIONS.has(extensionOf(name)) || DENIED_TYPES.has(contentType);
}

/** Whether a file stored as `contentType` may be opened inline in the browser. */
export function isPreviewableType(contentType: string): boolean {
  return PREVIEWABLE_TYPES.has(contentType);
}

/**
 * The first of `name (2).ext`, `name (3).ext`, ... for which `isTaken` is false, shortening the base
 * so the result stays within MAX_FILE_NAME_LENGTH. Returns `name` itself when it is free.
 */
export function uniqueFileName(name: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot <= 0 ? name : name.slice(0, dot);
  const extension = dot <= 0 ? "" : name.slice(dot);
  for (let n = 2; ; n++) {
    const suffix = ` (${n})${extension}`;
    const candidate = `${base.slice(0, MAX_FILE_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** Escapes `%`, `_` and the escape character so `query` is matched literally by `LIKE ... ESCAPE '\'`. */
export function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

/** The cursor in a listing is the sequence number of the last row of the previous page. */
export function parsePageCursor(after: string | undefined): number | undefined {
  if (after === undefined) return undefined;
  if (!/^\d{1,15}$/.test(after)) throw new Error("Invalid page cursor.");
  return Number(after);
}

/** Who is acting on a file, as the directory needs to decide permission. */
export type FileActor = {
  /** The caller's user key, which is the uploader id recorded on their files. */
  userKey: string;
  /** Whether they may remove any file in the tenant: an organization administrator, or the owner of a personal area. */
  isAdmin: boolean;
};

/** A stored file as the directory reports it, before it is shaped for a caller. */
export type FileRecord = {
  seq: number;
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploaderId: string;
  uploaderName: string | null;
  uploadedAt: number;
};

/** The shape members see, for the caller `actor`. */
export function toTenantFile(record: FileRecord, actor: FileActor): TenantFile {
  const isMe = record.uploaderId === actor.userKey;
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    contentType: record.contentType,
    previewable: isPreviewableType(record.contentType),
    uploader: { name: record.uploaderName, isMe },
    uploadedAt: new Date(record.uploadedAt),
    mayRemove: isMe || actor.isAdmin,
  };
}

/** The R2 key of a tenant's file. */
export function fileKey(tenantId: string, fileId: string): string {
  return `${tenantId}/${fileId}`;
}

/**
 * The capability to manage one tenant's files. `current` runs before every method and throws unless
 * the session is still live; it returns the connection's latest verified tenant context, whose role
 * is what decides whether the caller administers the tenant. The tenant itself is fixed here, at
 * mint, and no method takes a tenant or a storage key.
 */
@validateRpc()
export class TenantFilesApiImpl extends RpcTarget implements TenantFilesApi {
  constructor(
      private directory: DurableObjectStub<UserDirectoryDurableObject>,
      private bucket: R2Bucket,
      private tenantId: string,
      private current: () => TenantContext,
      private limits: { maxFileBytes: number; quotaBytes: number }) {
    super();
  }

  // The live context, and who is acting: an organization's administrators may remove any file; in a
  // personal workspace the owner is the only member and may remove any.
  #actor(): FileActor & { userId: string } {
    const tenant = this.current();
    if (tenant.tenantId !== this.tenantId) throw new Error("File access is no longer permitted.");
    return {
      userKey: tenant.userKey, userId: tenant.userId,
      isAdmin: tenant.kind === "personal" || isOrganizationAdmin(tenant.orgRole),
    };
  }

  async getUsage(): Promise<TenantFilesUsage> {
    this.#actor();
    const usage = await this.directory.getFilesUsage();
    return { ...usage, ...this.limits };
  }

  async listFiles(options: { query?: string; after?: string; limit?: number }):
      Promise<{ files: TenantFile[]; next?: string }> {
    const actor = this.#actor();
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
    const page = await this.directory.listFiles(
        { query: options.query, after: parsePageCursor(options.after), limit });
    return {
      files: page.files.map(record => toTenantFile(record, actor)),
      ...(page.next !== undefined && { next: String(page.next) }),
    };
  }

  async findExisting(names: string[]): Promise<string[]> {
    this.#actor();
    if (names.length > MAX_FIND_NAMES) {
      throw new Error(`Ask about at most ${MAX_FIND_NAMES} names at a time.`);
    }
    return await this.directory.findExistingFileNames(names.map(name => name.trim()));
  }

  async uploadFile(request: FileUploadRequest, body: ReadableStream<Uint8Array>): Promise<TenantFile> {
    const actor = this.#actor();
    // The directory validates the request and reserves room; a refusal here has nothing to release.
    const reserved = await this.directory.beginFileUpload(request, actor).catch(async error => {
      this.#refused("upload", actor.userId, error);
      // Nothing will read the body, so let the sender stop pumping it.
      await body.cancel().catch(() => {});
      throw error;
    });
    try {
      // The put needs a length, and the quota was reserved for this one: a body of any other length
      // errors the stream, which fails the put, and nothing is committed.
      const fixed = new FixedLengthStream(request.size);
      const [object] = await Promise.all([
        this.bucket.put(reserved.key, fixed.readable,
            { httpMetadata: { contentType: reserved.contentType } }),
        body.pipeTo(fixed.writable),
      ]);
      const record = await this.directory.commitFileUpload(reserved.id, object.size, actor);
      logger.info("file uploaded", {
        event: "file.uploaded", tenantId: this.tenantId, userId: actor.userId,
        fileId: record.id, size: record.size,
      });
      return toTenantFile(record, actor);
    } catch (error) {
      await this.directory.abortFileUpload(reserved.id).catch(cleanup => logger.error(
          "failed to release a failed upload",
          { event: "file.sweep.failed", tenantId: this.tenantId, fileId: reserved.id, error: cleanup }));
      this.#refused("upload", actor.userId, error);
      throw error;
    }
  }

  async downloadFile(id: string): Promise<FileDownload> {
    const actor = this.#actor();
    const record = await this.directory.getFile(id);
    const object = record && await this.bucket.get(fileKey(this.tenantId, record.id));
    if (!record || !object) {
      this.#refused("download", actor.userId, new Error("File not found."));
      throw new Error("File not found.");
    }
    return {
      name: record.name,
      size: record.size,
      // Anything that is not an image or PDF goes out as opaque bytes, so a blob made from it cannot
      // be rendered as a page in the product's origin.
      contentType: isPreviewableType(record.contentType) ? record.contentType : FALLBACK_TYPE,
      stream: object.body,
    };
  }

  async removeFile(id: string): Promise<void> {
    const actor = this.#actor();
    try {
      await this.directory.removeFile(id, actor);
    } catch (error) {
      this.#refused("remove", actor.userId, error);
      throw error;
    }
    logger.info("file removed", {
      event: "file.removed", tenantId: this.tenantId, userId: actor.userId, fileId: id,
    });
  }

  // The reason is the error's message, which is written for the caller and carries no file content.
  #refused(operation: "upload" | "download" | "remove", userId: string, error: unknown): void {
    logger.warn("file request refused", {
      event: "file.refused", tenantId: this.tenantId, userId, operation,
      refusalReason: error instanceof Error ? error.message : "unknown",
    });
  }
}
