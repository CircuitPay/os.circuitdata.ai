import type { FileNameConflict, UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";
import { createWorkshopLogger } from "./observability";
import {
  hasBranding, validateBrandingColor, validateBrandingLogo, validateBrandingName,
  type StoredBranding,
} from "./tenant-branding.js";
import {
  escapeLike, fileKey, filesLimits, isDeniedFileType, sanitizeContentType, uniqueFileName,
  validateFileName, MAX_FILE_NAME_LENGTH, PENDING_UPLOAD_TTL_MS,
  type FileActor, type FileRecord,
} from "./tenant-files.js";

const logger = createWorkshopLogger("workshop.user-directory");

const SEARCH_RESULT_LIMIT = 10;
// Every authenticated user can reach this one DO, so a search bounds what it is asked to scan.
const MAX_QUERY_LENGTH = 1000;
const MAX_EXCLUDE_IDS = 1000;
// How many members of an erased tenant are erased at once.
const ERASE_BATCH = 10;

/**
 * Deployment-wide directory of user profiles, so a user can find collaborators
 * by name or id. Each user DO mirrors updates to its own profile here
 * (`UserDurableObject.#syncDirectory`).
 */
export class UserDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      search_text TEXT NOT NULL,
      rev INTEGER NOT NULL
    ) STRICT`);
    // The organization's branding: at most one row, and none when nothing is set.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS branding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT,
      logo BLOB,
      accent_color TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT`);
    // The tenant's files: bytes are in R2 under `<tenantId>/<id>`. `pending` is an upload that has
    // reserved room but not arrived, `removing` a file that is gone for members but whose bytes are
    // not yet confirmed deleted; both count toward usage. Only one `ready` file holds a name.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS files (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      uploader_id TEXT NOT NULL,
      uploader_name TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'removing')),
      on_conflict TEXT,
      created_at INTEGER NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS files_ready_name ON files (name) WHERE state = 'ready'`);
    ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS files_state ON files (state, created_at)`);
  }

  /** The saved branding of the tenant this directory belongs to; every part absent when none. */
  getBranding(): StoredBranding {
    const row = this.ctx.storage.sql.exec<{
      name: string | null; logo: ArrayBuffer | null; accent_color: string | null; updated_at: number;
    }>(`SELECT name, logo, accent_color, updated_at FROM branding WHERE id = 1`).toArray()[0];
    if (!row) return {};
    return {
      ...(row.name !== null && { name: row.name }),
      ...(row.logo !== null && { logo: new Uint8Array(row.logo) }),
      ...(row.accent_color !== null && { accentColor: row.accent_color }),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Sets or clears (null) the name and accent color; an omitted field is left alone. Validated
   * before anything is written. Refused on the legacy directory, which is no tenant.
   */
  async updateIdentity(update: { name?: string | null; accentColor?: string | null }): Promise<void> {
    const name = update.name == null ? update.name : validateBrandingName(update.name);
    if (update.accentColor != null) validateBrandingColor(update.accentColor);
    await this.#save(current => ({
      ...current,
      ...(name !== undefined && { name: name ?? undefined }),
      ...(update.accentColor !== undefined && { accentColor: update.accentColor ?? undefined }),
    }));
  }

  /** Sets the logo from PNG bytes, or clears it (null). Validated before anything is written. */
  async updateLogo(png: Uint8Array | null): Promise<void> {
    if (png !== null) validateBrandingLogo(png);
    await this.#save(current => ({ ...current, logo: png ?? undefined }));
  }

  /** Removes all of the tenant's branding. Idempotent. */
  async clearBranding(): Promise<void> {
    await this.#save(() => ({}));
  }

  async #save(change: (current: StoredBranding) => StoredBranding): Promise<void> {
    const tenantId = this.ctx.id.name;
    if (!tenantId) throw new Error("Only a named tenant can have branding.");
    const next = change(this.getBranding());
    const sql = this.ctx.storage.sql;
    let updatedAt: Date | null = null;
    if (hasBranding(next)) {
      updatedAt = new Date();
      sql.exec(
          `INSERT INTO branding (id, name, logo, accent_color, updated_at) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, logo = excluded.logo,
             accent_color = excluded.accent_color, updated_at = excluded.updated_at`,
          next.name ?? null, next.logo ?? null, next.accentColor ?? null, updatedAt.valueOf());
    } else {
      sql.exec(`DELETE FROM branding`);
    }
    // The operator listing is derived from this, so a failure here throws and a retry repairs it.
    await this.ctx.exports.AdminSettings.getByName("").recordTenantBranding(tenantId, updatedAt);
  }

  /**
   * Insert or update one user's record. `rev` is the user DO's profile revision: a record already
   * at a higher revision is left alone, so syncs that arrive out of order still converge on the
   * newest profile.
   */
  syncUser(record: UserDirectoryRecord, rev: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, search_text, rev) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, search_text = excluded.search_text,
         rev = excluded.rev
       WHERE excluded.rev > users.rev`,
      record.id, record.name, `${record.id}\n${record.name}`.toLowerCase(), rev);
  }

  /** Removes one user's record, for an erased account. Idempotent. */
  removeUser(id: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM users WHERE id = ?`, id);
  }

  /** The ids of every user recorded in this directory. */
  listUserIds(): string[] {
    return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM users ORDER BY id`)
        .toArray().map(row => row.id);
  }

  // --- Files ---

  /** The directory's name, which is the tenant id; files exist only for a named tenant. */
  get #tenantId(): string {
    const tenantId = this.ctx.id.name;
    if (!tenantId) throw new Error("Only a named tenant can have files.");
    return tenantId;
  }

  #fileRecords(where: string, ...bindings: (string | number | null)[]): FileRecord[] {
    return this.ctx.storage.sql.exec<{
      seq: number; id: string; name: string; size: number; content_type: string;
      uploader_id: string; uploader_name: string | null; created_at: number;
    }>(`SELECT seq, id, name, size, content_type, uploader_id, uploader_name, created_at
        FROM files WHERE ${where}`, ...bindings).toArray().map(row => ({
      seq: row.seq, id: row.id, name: row.name, size: row.size, contentType: row.content_type,
      uploaderId: row.uploader_id, uploaderName: row.uploader_name, uploadedAt: row.created_at,
    }));
  }

  // Whether `actor` may remove or replace `file`: they uploaded it, or they administer the tenant.
  #mayRemove(file: FileRecord, actor: FileActor): boolean {
    return actor.isAdmin || file.uploaderId === actor.userKey;
  }

  /** Bytes held (pending and removing included) and how many files are listed. */
  getFilesUsage(): { usedBytes: number; fileCount: number } {
    const row = this.ctx.storage.sql.exec<{ used: number; listed: number }>(
        `SELECT COALESCE(SUM(size), 0) AS used, COALESCE(SUM(state = 'ready'), 0) AS listed FROM files`)
        .one();
    return { usedBytes: row.used, fileCount: row.listed };
  }

  /**
   * Validates an upload and reserves room for it, returning the id and R2 key to store it under and
   * the sanitized type. Refuses an invalid or deny-listed name or type, a size over the per-file
   * limit, no room in the quota, a taken name under "reject", and "replace" of a file `actor` may not
   * remove. Nothing is listed until `commitFileUpload`.
   */
  async beginFileUpload(
      upload: { name: string; size: number; contentType: string; onConflict: FileNameConflict },
      actor: FileActor): Promise<{ id: string; key: string; contentType: string }> {
    const tenantId = this.#tenantId;
    const name = validateFileName(upload.name);
    const contentType = sanitizeContentType(upload.contentType);
    if (isDeniedFileType(name, contentType)) throw new Error("This type of file is not accepted.");
    const { maxFileBytes, quotaBytes } = filesLimits(this.env);
    if (!Number.isSafeInteger(upload.size) || upload.size < 0) {
      throw new Error("The file size is not valid.");
    }
    if (upload.size > maxFileBytes) throw new Error(`Files can be at most ${maxFileBytes} bytes.`);

    await this.#sweepFiles();
    const { usedBytes } = this.getFilesUsage();
    if (usedBytes + upload.size > quotaBytes) {
      throw new Error(`Not enough storage: ${usedBytes} of ${quotaBytes} bytes are in use.`);
    }
    const existing = this.#fileRecords(`state = 'ready' AND name = ?`, name)[0];
    if (existing) this.#assertNameUsable(existing, upload.onConflict, actor);

    const id = crypto.randomUUID();
    const uploaderName = this.ctx.storage.sql.exec<{ name: string }>(
        `SELECT name FROM users WHERE id = ?`, actor.userKey).toArray()[0]?.name ?? null;
    this.ctx.storage.sql.exec(
        `INSERT INTO files (id, name, size, content_type, uploader_id, uploader_name, state,
                            on_conflict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id, name, upload.size, contentType, actor.userKey, uploaderName, upload.onConflict, Date.now());
    return { id, key: fileKey(tenantId, id), contentType };
  }

  // Throws unless a new file may take the name of `existing` under `onConflict`.
  #assertNameUsable(existing: FileRecord, onConflict: FileNameConflict, actor: FileActor): void {
    if (onConflict === "reject") throw new Error("A file with this name already exists.");
    if (onConflict === "replace" && !this.#mayRemove(existing, actor)) {
      throw new Error("You can only replace files you uploaded.");
    }
  }

  /**
   * Lists an upload whose bytes are in R2, deciding its final name now: under "replace" the file
   * holding the name is removed in the same step, under "keep-both" the name gets the first free
   * ` (n)`. Refused, leaving the upload to be aborted, if it expired, if the stored size is not the
   * reserved one, or if the name was taken meanwhile under "reject".
   */
  async commitFileUpload(id: string, storedSize: number, actor: FileActor): Promise<FileRecord> {
    const pending = this.ctx.storage.sql.exec<{ name: string; size: number; on_conflict: FileNameConflict }>(
        `SELECT name, size, on_conflict FROM files WHERE id = ? AND state = 'pending'`, id)
        .toArray()[0];
    if (!pending) throw new Error("This upload expired. Try again.");
    if (storedSize !== pending.size) throw new Error("The upload did not arrive in full.");

    const sql = this.ctx.storage.sql;
    let name = pending.name;
    let superseded: FileRecord | undefined;
    const existing = this.#fileRecords(`state = 'ready' AND name = ?`, name)[0];
    if (existing) {
      this.#assertNameUsable(existing, pending.on_conflict, actor);
      if (pending.on_conflict === "replace") {
        superseded = existing;
      } else {
        name = uniqueFileName(name, candidate =>
            this.#fileRecords(`state = 'ready' AND name = ?`, candidate).length > 0);
      }
    }
    // A replaced file leaves the name before the new one takes it, in one synchronous step.
    if (superseded) sql.exec(`UPDATE files SET state = 'removing' WHERE id = ?`, superseded.id);
    sql.exec(`UPDATE files SET state = 'ready', name = ?, on_conflict = NULL, created_at = ? WHERE id = ?`,
        name, Date.now(), id);
    if (superseded) await this.#deleteStored(superseded.id);
    return this.#fileRecords(`id = ?`, id)[0];
  }

  /** Releases an upload that did not complete: its bytes and its reservation. Idempotent. */
  async abortFileUpload(id: string): Promise<void> {
    const pending = this.ctx.storage.sql.exec(
        `SELECT 1 FROM files WHERE id = ? AND state = 'pending'`, id).toArray().length > 0;
    if (pending) await this.#deleteStored(id);
  }

  /** One page of listed files, newest first: those whose name contains `query`, below cursor `after`. */
  async listFiles(options: { query?: string; after?: number; limit: number }):
      Promise<{ files: FileRecord[]; next?: number }> {
    const query = options.query?.trim() ?? "";
    if (query.length > MAX_FILE_NAME_LENGTH) throw new Error("That search is too long.");
    await this.#sweepFilesIfStale();
    const rows = this.#fileRecords(
        `state = 'ready' AND (? IS NULL OR seq < ?) AND name LIKE ? ESCAPE '\\'
         ORDER BY seq DESC LIMIT ?`,
        options.after ?? null, options.after ?? null, `%${escapeLike(query)}%`, options.limit + 1);
    const files = rows.slice(0, options.limit);
    return rows.length > files.length ? { files, next: files[files.length - 1].seq } : { files };
  }

  /** Which of `names` are held by a listed file. */
  findExistingFileNames(names: string[]): string[] {
    return this.ctx.storage.sql.exec<{ name: string }>(
        `SELECT name FROM files WHERE state = 'ready' AND name IN (SELECT value FROM json_each(?))`,
        JSON.stringify(names)).toArray().map(row => row.name);
  }

  /** A listed file, or null: unknown, still uploading, or being removed all look the same. */
  getFile(id: string): FileRecord | null {
    return this.#fileRecords(`state = 'ready' AND id = ?`, id)[0] ?? null;
  }

  /**
   * Removes a listed file: it stops being listed or retrievable at once, and its bytes are deleted
   * before the row is. Throws "File not found." for any other id, and refuses an `actor` who neither
   * uploaded it nor administers the tenant.
   */
  async removeFile(id: string, actor: FileActor): Promise<void> {
    const file = this.getFile(id);
    if (!file) throw new Error("File not found.");
    if (!this.#mayRemove(file, actor)) throw new Error("You can only remove files you uploaded.");
    await this.#deleteStored(id);
  }

  // Hides the file, deletes its bytes, then its row. A failed delete leaves the row hidden and
  // counted, and the next sweep tries again.
  async #deleteStored(id: string): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE files SET state = 'removing' WHERE id = ?`, id);
    try {
      await this.env.TENANT_FILES.delete(fileKey(this.#tenantId, id));
      this.ctx.storage.sql.exec(`DELETE FROM files WHERE id = ?`, id);
    } catch (error) {
      logger.error("failed to delete a stored file", {
        event: "file.sweep.failed", tenantId: this.#tenantId, fileId: id, error,
      });
    }
  }

  // Uploads that never completed, and removals whose delete failed.
  static readonly #STALE = `state = 'removing' OR (state = 'pending' AND created_at < ?)`;

  async #sweepFilesIfStale(): Promise<void> {
    const stale = this.ctx.storage.sql.exec(
        `SELECT 1 FROM files WHERE ${UserDirectoryDurableObject.#STALE} LIMIT 1`,
        Date.now() - PENDING_UPLOAD_TTL_MS).toArray().length > 0;
    if (stale) await this.#sweepFiles();
  }

  async #sweepFiles(): Promise<void> {
    const ids = this.ctx.storage.sql.exec<{ id: string }>(
        `SELECT id FROM files WHERE ${UserDirectoryDurableObject.#STALE} LIMIT 50`,
        Date.now() - PENDING_UPLOAD_TTL_MS).toArray();
    for (const { id } of ids) await this.#deleteStored(id);
  }

  // Deletes every object under the tenant's prefix, then the index. Idempotent.
  async #purgeFiles(): Promise<void> {
    const prefix = `${this.#tenantId}/`;
    let cursor: string | undefined;
    do {
      const page = await this.env.TENANT_FILES.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length > 0) await this.env.TENANT_FILES.delete(page.objects.map(o => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    this.ctx.storage.sql.exec(`DELETE FROM files`);
  }

  /**
   * Erases the tenant this directory belongs to (the Durable Object is named by the tenant id):
   * every user recorded here is erased (see `UserDurableObject.eraseAccount`), leaving each only a
   * membership end at `endedAt`, and then the directory is emptied. Members are found here, so one
   * whose sign-in never reached the directory is not. A failure leaves the directory as it was and
   * throws, so a retry finds the same members; every step is idempotent.
   *
   * Refused on the legacy directory (named ""), which belongs to every account that predates
   * tenants and is not a tenant to erase.
   */
  async eraseTenant(endedAt: number): Promise<void> {
    if (!this.ctx.id.name) throw new Error("Only a named tenant can be erased.");
    await this.#purgeFiles();
    const users = this.ctx.exports.UserDurableObject;
    const ids = this.listUserIds();
    for (let start = 0; start < ids.length; start += ERASE_BATCH) {
      const outcomes = await Promise.allSettled(
          ids.slice(start, start + ERASE_BATCH).map(id => users.getByName(id).eraseAccount(endedAt)));
      const failure = outcomes.find(outcome => outcome.status === "rejected");
      if (failure) throw failure.reason;
    }
    this.ctx.storage.sql.exec(`DELETE FROM users`);
    await this.clearBranding();
  }

  /**
   * Case-insensitive substring search over name and id, excluding every id in `excludeIds`.
   * The id is indexed first so an exact id starts at position one; ties sort by id then name.
   * Rejects a query over `MAX_QUERY_LENGTH` characters or containing a line break, and more than
   * `MAX_EXCLUDE_IDS` distinct exclusions.
   */
  searchUsers(query: string, excludeIds: string[]): UserDirectoryRecord[] {
    // Name and id are joined by a newline in search_text, so a needle containing one could match
    // across the two fields.
    if (query.length > MAX_QUERY_LENGTH || /[\r\n]/.test(query)) {
      throw new Error(
        `Search query must be at most ${MAX_QUERY_LENGTH} characters with no line breaks.`);
    }
    const excluded = [...new Set(excludeIds)];
    if (excluded.length > MAX_EXCLUDE_IDS) {
      throw new Error(`At most ${MAX_EXCLUDE_IDS} users can be excluded from a search.`);
    }
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return this.ctx.storage.sql.exec<UserDirectoryRecord>(
      `SELECT id, name FROM users
       WHERE id NOT IN (SELECT value FROM json_each(?)) AND instr(search_text, ?) > 0
       ORDER BY instr(search_text, ?), id, name COLLATE NOCASE
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      JSON.stringify(excluded), needle, needle,
    ).toArray();
  }
}
