import {
  MAX_DIRECTORY_TEXT_LENGTH, type AdminUserRecord, type AdminWorkspacePage,
  type AdminWorkspaceRecord, type FileNameConflict, type UserDirectoryRecord,
} from "@gadgets/workshop-shared/api";
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
// A page stops early once its text would pass this many characters, which keeps it far below the
// RPC message limit whatever the directory holds, since ids are stored whole.
const MAX_PAGE_TEXT_LENGTH = 1_000_000;

/** How often a user DO or an Overseer reports activity to the directory at most: an hour, the
 * precision of AdminUserRecord.lastLogin and AdminWorkspaceRecord.lastActive. */
export const DIRECTORY_ACTIVITY_INTERVAL_MS = 60 * 60_000;

/** What a user DO reports of its account beside its profile (see syncUser()). */
export type UserDirectoryActivity = {
  /** When the account was created, if recorded; the first known value is kept. */
  created?: Date;
  /** When the session being reported started; the stored value only moves forward. */
  lastLogin?: Date;
};

/** A workspace as its Overseer reports it to the directory (see syncWorkspace()). */
export type WorkspaceDirectoryEntry = {
  /** The workspace (Overseer Durable Object) id. */
  id: string;
  /** Its title as of the sync's revision, whole; the directory keeps its first
   * MAX_DIRECTORY_TEXT_LENGTH characters. */
  title: string;
  /** The owner's canonical user id. */
  ownerId: string;
  /** When it was initialised, if known. */
  created?: Date;
  /** When it was last active, if this sync reports activity; the stored value only moves forward. */
  lastActive?: Date;
};

/** One page of UserDirectoryDurableObject.listUsers(): AdminUserRecord without `isAdmin`, which
 * AdminApiImpl adds from ADMINS. */
export type UserDirectoryPage = { users: Omit<AdminUserRecord, "isAdmin">[]; nextCursor?: string };

// A display name or title as the directory keeps and lists it: its first MAX_DIRECTORY_TEXT_LENGTH
// characters, one fewer rather than half of a surrogate pair.
function clamp(text: string): string {
  if (text.length <= MAX_DIRECTORY_TEXT_LENGTH) return text;
  const last = text.charCodeAt(MAX_DIRECTORY_TEXT_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff
      ? MAX_DIRECTORY_TEXT_LENGTH - 1 : MAX_DIRECTORY_TEXT_LENGTH;
  return text.slice(0, end);
}

// Name and id are joined by a newline in search_text, so a needle containing one could match
// across the two fields.
function validateQuery(query: string): void {
  if (query.length > MAX_QUERY_LENGTH || /[\r\n]/.test(query)) {
    throw new Error(
      `Search query must be at most ${MAX_QUERY_LENGTH} characters with no line breaks.`);
  }
}

// A time as the directory stores it: epoch ms, NULL for unknown.
function epochMs(date: Date | undefined): number | null {
  return date ? date.getTime() : null;
}

// Collects rows into one page in the order a query yields them: at most `limit` (the query asks
// for one more, to learn whether another page follows), and fewer once their text would pass
// MAX_PAGE_TEXT_LENGTH, though never none while any remain. Rows are read one at a time, so none
// past the first one left out is ever read.
function collectPage<Row, Item extends { id: string }>(
    rows: Iterable<Row>, limit: number, toItem: (row: Row) => Item,
    textLength: (item: Item) => number): { items: Item[]; nextCursor?: string } {
  const items: Item[] = [];
  let text = 0;
  for (const row of rows) {
    const item = toItem(row);
    const length = textLength(item);
    if (items.length >= limit || (items.length > 0 && text + length > MAX_PAGE_TEXT_LENGTH)) {
      return { items, nextCursor: items[items.length - 1].id };
    }
    items.push(item);
    text += length;
  }
  return { items };
}

/**
 * Deployment-wide directory of users and workspaces: users find collaborators in it
 * (AuthenticatedApi.searchUsers()), and admins list the deployment's users and workspaces
 * (AdminApi.listUsers() and listWorkspaces()). Each user DO mirrors its profile and activity here
 * (`UserDurableObject.#syncDirectory`), each Overseer mirrors its workspace
 * (`OverseerImpl.syncDirectory`) and takes it out on deletion (`removeFromDirectory`), and
 * AdminApiImpl removes a workspace it finds gone. Durable Objects cannot be enumerated, so the
 * directory fills as it is used: an account is listed once it has started a session since the
 * directory began recording accounts for user search (one recorded before the admin listings is
 * listed without `lastLogin` until its next session), a workspace when it is next opened.
 *
 * The admin listings live here rather than in a store of their own because this is already the
 * deployment-wide singleton (always `getByName("")`), every user DO already feeds it through a
 * revision protocol that backfills lazily, and it is already migrated and bound in tests: a second
 * store would duplicate the users table, the sync protocol and the per-session writes.
 *
 * It is a finding aid, not a record: display names and titles take any length, so they are kept
 * and listed as their first MAX_DIRECTORY_TEXT_LENGTH characters, as boundAgentCatalog() clamps a
 * catalog (the admin audit log marks its cuts instead, since a record must not pass a fragment off
 * as the whole). Ids are identities and stay whole, and a username has no length limit, so a page
 * is bounded by its text as well as by its count.
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
    // Times are epoch ms; NULL means unknown.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS user_activity (
      id TEXT PRIMARY KEY,
      created INTEGER,
      last_login INTEGER
    ) STRICT`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      search_text TEXT NOT NULL,
      created INTEGER,
      last_active INTEGER,
      rev INTEGER NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS workspaces_by_owner ON workspaces (owner_id, id)");
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
   * Insert or update one user's record: the name clamped to MAX_DIRECTORY_TEXT_LENGTH, the search
   * text built from the clamped name and the id's first MAX_DIRECTORY_TEXT_LENGTH characters, the
   * id whole. `rev` is the user DO's profile revision: a record already at a higher revision is
   * left alone, so syncs that arrive out of order still converge on the newest profile.
   * `activity` is merged whatever `rev` is, as UserDirectoryActivity says.
   */
  syncUser(record: UserDirectoryRecord, rev: number, activity?: UserDirectoryActivity): void {
    const name = clamp(record.name);
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, search_text, rev) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, search_text = excluded.search_text,
         rev = excluded.rev
       WHERE excluded.rev > users.rev`,
      record.id, name, `${clamp(record.id)}\n${name}`.toLowerCase(), rev);
    if (activity?.created || activity?.lastLogin) {
      this.ctx.storage.sql.exec(
        `INSERT INTO user_activity (id, created, last_login) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           created = coalesce(user_activity.created, excluded.created),
           last_login = max(coalesce(user_activity.last_login, excluded.last_login),
                            coalesce(excluded.last_login, user_activity.last_login))`,
        record.id, epochMs(activity.created), epochMs(activity.lastLogin));
    }
  }

  /**
   * Insert or update one workspace, its title clamped and its search text bounded as syncUser()'s
   * are. `rev` is the Overseer's time-based directory revision, so a workspace reinitialised under
   * the same id outranks what its earlier life reported: a higher `rev` replaces the title, the
   * owner and (when the sync carries one) `created`; a lower or equal one changes none of them but
   * fills a `created` the row lacks. `lastActive` only moves forward.
   */
  syncWorkspace(entry: WorkspaceDirectoryEntry, rev: number): void {
    const title = clamp(entry.title);
    // Every expression in the SET list reads the row as it was before the update.
    this.ctx.storage.sql.exec(
      `INSERT INTO workspaces (id, title, owner_id, search_text, created, last_active, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = iif(excluded.rev > workspaces.rev, excluded.title, workspaces.title),
         owner_id = iif(excluded.rev > workspaces.rev, excluded.owner_id, workspaces.owner_id),
         search_text = iif(excluded.rev > workspaces.rev, excluded.search_text,
                           workspaces.search_text),
         created = iif(excluded.rev > workspaces.rev,
                       coalesce(excluded.created, workspaces.created),
                       coalesce(workspaces.created, excluded.created)),
         last_active = max(coalesce(workspaces.last_active, excluded.last_active),
                           coalesce(excluded.last_active, workspaces.last_active)),
         rev = max(workspaces.rev, excluded.rev)`,
      entry.id, title, entry.ownerId,
      `${entry.id}\n${title}\n${clamp(entry.ownerId)}`.toLowerCase(),
      epochMs(entry.created), epochMs(entry.lastActive), rev);
  }

  /** Forget a workspace: its Overseer, deleting it, or AdminApiImpl on finding it gone. */
  removeWorkspace(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE id = ?", id);
  }

  /**
   * The title (clamped) and owner the directory lists for a workspace, or null when it lists none:
   * what AdminApiImpl records for an open refused before reaching the workspace.
   * Rejects an id over 1000 characters (workspace ids are 64).
   */
  workspaceListing(id: string): { title: string; ownerId: string } | null {
    if (id.length > MAX_QUERY_LENGTH) {
      throw new Error(`Workspace id must be at most ${MAX_QUERY_LENGTH} characters.`);
    }
    const row = this.ctx.storage.sql.exec<{ title: string; owner_id: string }>(
      "SELECT title, owner_id FROM workspaces WHERE id = ?", id).toArray()[0];
    return row ? { title: clamp(row.title), ownerId: row.owner_id } : null;
  }

  /** Removes one user's record, for an erased account. Idempotent. */
  removeUser(id: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM users WHERE id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM user_activity WHERE id = ?`, id);
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
    this.ctx.storage.sql.exec(`DELETE FROM user_activity`);
    await this.clearBranding();
  }

  /**
   * Case-insensitive substring search over name and id, excluding every id in `excludeIds`.
   * The id is indexed first so an exact id starts at position one; ties sort by id then name.
   * Rejects a query over `MAX_QUERY_LENGTH` characters or containing a line break, and more than
   * `MAX_EXCLUDE_IDS` distinct exclusions. Names are clamped as every read clamps them, since a
   * row stored before the directory clamped may hold more.
   */
  searchUsers(query: string, excludeIds: string[]): UserDirectoryRecord[] {
    validateQuery(query);
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
    ).toArray().map(({ id, name }) => ({ id, name: clamp(name) }));
  }

  /**
   * Users in id order after `cursor` (the previous page's last id, of any length), matching
   * `query` as searchUsers() matches (blank matches all), with their activity and clamped names:
   * at most `limit`, and fewer once the page's ids and names would pass a million characters
   * (never none while any remain). Rejects a `query` over 1000 characters or with a line break;
   * `limit` is validated by the caller (see adminListLimit()).
   */
  listUsers(options: { query?: string; cursor?: string; limit: number }): UserDirectoryPage {
    const { query = "", cursor, limit } = options;
    validateQuery(query);
    const needle = query.trim().toLowerCase();
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (cursor !== undefined) {
      conditions.push("users.id > ?");
      bindings.push(cursor);
    }
    if (needle !== "") {
      conditions.push("instr(users.search_text, ?) > 0");
      bindings.push(needle);
    }
    const rows = this.ctx.storage.sql.exec<{
      id: string; name: string; created: number | null; last_login: number | null;
    }>(
      `SELECT users.id AS id, users.name AS name, user_activity.created AS created,
         user_activity.last_login AS last_login
       FROM users LEFT JOIN user_activity ON user_activity.id = users.id
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY users.id LIMIT ?`,
      ...bindings, limit + 1);
    const { items, nextCursor } = collectPage(rows, limit, row => ({
      id: row.id,
      name: clamp(row.name),
      ...row.created !== null && { created: new Date(row.created) },
      ...row.last_login !== null && { lastLogin: new Date(row.last_login) },
    }), user => user.id.length + user.name.length);
    return nextCursor === undefined ? { users: items } : { users: items, nextCursor };
  }

  /**
   * Workspaces in id order after `cursor`, of `owner` (matched exactly, any length) if given,
   * matching `query` against id, title and owner id, each owner's display name joined from the
   * users table and clamped (their id, clamped, while it has none); paged and bounded as
   * listUsers() is, counting ids, titles and owners. Rejects what listUsers() rejects.
   */
  listWorkspaces(options: { owner?: string; query?: string; cursor?: string; limit: number })
      : AdminWorkspacePage {
    const { owner, query = "", cursor, limit } = options;
    validateQuery(query);
    const needle = query.trim().toLowerCase();
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (owner !== undefined) {
      conditions.push("workspaces.owner_id = ?");
      bindings.push(owner);
    }
    if (cursor !== undefined) {
      conditions.push("workspaces.id > ?");
      bindings.push(cursor);
    }
    if (needle !== "") {
      conditions.push("instr(workspaces.search_text, ?) > 0");
      bindings.push(needle);
    }
    const rows = this.ctx.storage.sql.exec<{
      id: string; title: string; owner_id: string; owner_name: string | null;
      created: number | null; last_active: number | null;
    }>(
      `SELECT workspaces.id AS id, workspaces.title AS title, workspaces.owner_id AS owner_id,
         users.name AS owner_name, workspaces.created AS created,
         workspaces.last_active AS last_active
       FROM workspaces LEFT JOIN users ON users.id = workspaces.owner_id
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY workspaces.id LIMIT ?`,
      ...bindings, limit + 1);
    const { items, nextCursor } = collectPage(rows, limit, (row): AdminWorkspaceRecord => ({
      id: row.id,
      title: clamp(row.title),
      owner: { id: row.owner_id, name: clamp(row.owner_name ?? row.owner_id) },
      ...row.created !== null && { created: new Date(row.created) },
      ...row.last_active !== null && { lastActive: new Date(row.last_active) },
    }), workspace => workspace.id.length + workspace.title.length + workspace.owner.id.length
        + workspace.owner.name.length);
    return nextCursor === undefined ? { workspaces: items } : { workspaces: items, nextCursor };
  }
}
