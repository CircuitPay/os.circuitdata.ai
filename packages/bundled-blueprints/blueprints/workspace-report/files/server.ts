import { DurableObject, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import {
  type DataStatus,
  type DateRangeFilter,
  type QueryOutcome,
  type QueryResult,
  type ResolvedFilters,
  type RetailReader,
  type VisualSpec,
  anchorDate,
  columnHeading,
  describeRange,
  formatDate,
  formatValue,
  isConnectionGone,
  isNumericColumn,
  plainError,
  readDataStatus,
  resolveRange,
  runSavedQuery,
  validateDateRange,
  validateFilters,
  validateSavedQuery,
  validateVisual,
} from "@gadgets/bundled-blueprints/libraries/data/server";
import { MutationQueue, SubscriberRegistry } from "@gadgets/bundled-blueprints/libraries/sync/server";
import { ALL_PINNED, EDITION_TOO_LONG, type EditionDigest, buildEdition, currentBlocks, digestOf, isFailure, planRetention, reviewFlags, staleSections, summaryOf } from "./lib/editions.ts";
import {
  type Changed,
  type DataDescription,
  type DataMode,
  type DataSection,
  type DataState,
  type Edition,
  type EditionAuthor,
  type EditionSummary,
  type ExportGadgetStub,
  type GenerateResult,
  type HandledRun,
  type HeadingLevel,
  LIMITS,
  type Letterhead,
  type Meta,
  type Opened,
  type ReportView,
  type RestoreParams,
  type Revised,
  type ScheduledFiring,
  type ScheduledTaskHook,
  type Section,
  type SectionInput,
  type SectionPatch,
  type SectionWidth,
  type Sender,
  type SubscriberCallbacks,
} from "./lib/protocol.ts";
import { STARTER_PERIOD, STARTER_TITLE, starterSections } from "./lib/starter.ts";

// The runtime exports the name of a Durable Object's restore method from `cloudflare:workers`
// (see "Persistent Stubs" in the agent's instructions), but `@cloudflare/workers-types` does not
// declare it. Declared here as the unique symbol it is, so `[restore]()` is a typed member of the
// class. Remove this once the package declares it.
declare global {
  namespace CloudflareWorkersModule {
    export const restore: unique symbol;
  }
}

// ---------------------------------------------------------------------------
// Report: a written document whose numbers are frozen as of the day they were generated.
//
// Storage layout (key-value only):
//   "meta"          -> Meta: revision, title, period, locations, letterhead, section order, and a
//                      summary of every edition (newest first), which is where `pinned` lives
//   "s:<sectionId>" -> one Section (heading, text or data)
//   "e:<editionId>" -> one Edition, written once: a copy of every section as it was, each data
//                      section with what its query returned. Only deleteEdition and retention
//                      remove one, and nothing rewrites one.
//   "status"        -> the last DataStatus and when it was read
//   "undo"          -> { past, future } snapshots of structure and text (never editions)
//   "runs"          -> the last 50 schedule runs handled, with the edition each produced
//
// How the gadget reaches data is read from its environment on every call:
//   GADGET and RETAIL_DATA  "live"      reads allowed
//   GADGET only             "off"       editions are withheld, and nothing is deleted
//   neither                 "snapshot"  a view-only copy: stored editions are served, nothing is
//                                       read from the dataset and nothing is written
//
// Every change runs in one MutationQueue, bumps meta.revision and is broadcast as `changed`.
// ---------------------------------------------------------------------------

/** The bindings a report's Durable Object is given. `GADGET` is absent in a view-only copy. */
interface GadgetEnv {
  RETAIL_DATA?: RetailReader;
  GADGET?: unknown;
}

const OFF_MESSAGE = "Retail data is not turned on for this organization. An administrator can turn it on from Data in the navigation.";
const EMPTY_MESSAGE = "No sales data yet. Import a CSV or connect a source in Data, then generate this report.";
const READ_ONLY_MESSAGE = "This is a read-only copy of the report.";
const NOT_GENERATED_MESSAGE = "This report has not been generated yet. Generate it first.";
const NO_DATA_SECTIONS_MESSAGE = "This report has no data section to compute. Add one, then generate.";
const NO_SUCH_EDITION_MESSAGE = "That edition no longer exists.";

/** How long a stored data status is trusted before the next open reads it again. */
const STATUS_MAX_AGE_MS = 15 * 60_000;
/** How many data sections run at once while generating. */
const MAX_IN_FLIGHT = 4;
/**
 * The most characters the undo history holds once serialized. It is one stored value (at most
 * 2 MiB, with up to two bytes a character), so the oldest steps go first when it is over.
 */
const UNDO_MAX_CHARS = 800_000;

const AUTHORS: readonly EditionAuthor[] = ["member", "agent", "schedule"];
const WIDTHS: readonly SectionWidth[] = ["full", "half", "third"];
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A report as the server works on it: its meta and its sections, in order. */
interface Report {
  meta: Meta;
  sections: Section[];
}
/** A report being changed, with the stored keys the change removes beyond its sections. */
interface Draft extends Report {
  drop: string[];
}
/** What undo restores: structure and text. Editions and the letterhead are not part of it. */
interface Snapshot {
  title: string;
  period: DateRangeFilter;
  locations: number[];
  sections: Section[];
}
interface UndoHistory {
  past: Snapshot[];
  future: Snapshot[];
}
interface StoredStatus {
  status: DataStatus;
  readAt: number;
}
/** The client's RpcTarget as the server holds it: its callbacks, plus what the RPC layer adds. */
type SubscriberStub = SubscriberCallbacks & {
  dup(): SubscriberStub;
  onRpcBroken(handler: (error: unknown) => void): void;
  [Symbol.dispose]?(): void;
};

/**
 * Why a generation did not start, when asking again would not help: the data is off or empty, the
 * report has nothing to compute, or every edition is pinned. A schedule lets these pass quietly
 * rather than be retried.
 */
class Refusal extends Error {}

function fail(message: string): never {
  throw new Error(message);
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

const sectionKey = (id: string) => "s:" + id;
const editionKey = (id: string) => "e:" + id;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- Input checks. Arguments arrive over RPC from the page and from the agent, so each is read
// as unknown and refused in plain language.

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function asId(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) fail(`${what} must be an id.`);
  return value;
}

function senderOf(args: unknown): string | undefined {
  const clientId = args && typeof args === "object" ? (args as Sender).clientId : undefined;
  return typeof clientId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(clientId) ? clientId : undefined;
}

/** One line of text between 1 and `max` characters. */
function cleanLine(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") fail(`${what} must be text.`);
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) fail(`${what} cannot be empty.`);
  if (line.length > max) fail(`${what} can be at most ${max} characters.`);
  return line;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") fail("A text section's text must be text.");
  if (value.length > LIMITS.text) fail(`A text section can be at most ${LIMITS.text.toLocaleString("en-US")} characters.`);
  return value;
}

function cleanLevel(value: unknown): HeadingLevel {
  if (value === 1 || value === 2 || value === 3) return value;
  return fail("A heading's level must be 1, 2 or 3.");
}

function cleanWidth(value: unknown): SectionWidth {
  const width = WIDTHS.find((known) => known === value);
  if (!width) fail('A data section\'s width must be "full", "half" or "third".');
  return width;
}

function cleanDataVisual(value: unknown): DataSection["visual"] {
  const visual = validateVisual(value);
  if (visual.type === "text") fail('A data section shows a single value, a chart or a table. Use a text section for text.');
  return visual;
}

function cleanSection(value: unknown, id: string): Section {
  const input = asRecord(value, "section");
  if (input.kind === "heading") {
    return { id, version: 1, kind: "heading", level: input.level === undefined ? 2 : cleanLevel(input.level), text: cleanLine(input.text, "A heading", LIMITS.heading) };
  }
  if (input.kind === "text") return { id, version: 1, kind: "text", text: cleanText(input.text), reviewedEdition: null };
  if (input.kind === "data") {
    return {
      id,
      version: 1,
      kind: "data",
      title: cleanLine(input.title, "A data section's title", LIMITS.blockTitle),
      visual: cleanDataVisual(input.visual),
      query: validateSavedQuery(input.query),
      width: input.width === undefined ? "full" : cleanWidth(input.width),
    };
  }
  return fail('A section\'s kind must be "heading", "text" or "data".');
}

const PATCH_FIELDS: Record<Section["kind"], readonly string[]> = {
  heading: ["level", "text"],
  text: ["text"],
  data: ["title", "visual", "query", "width"],
};

/**
 * `section` with the given fields changed, or `section` itself when they change nothing. New text
 * in a text section is text written against the latest edition, which is what clears its review
 * flag.
 */
function patchSection(section: Section, fields: Record<string, unknown>, latestEdition: string | null): Section {
  if (fields.kind !== undefined && fields.kind !== section.kind) fail("A section's kind cannot change. Remove the section and add a new one.");
  const next = copy(section);
  for (const [key, value] of Object.entries(fields)) {
    if (key === "kind" || value === undefined) continue;
    if (!PATCH_FIELDS[section.kind].includes(key)) fail(`A ${section.kind} section has no "${key}" to change.`);
    if (next.kind === "heading") {
      if (key === "level") next.level = cleanLevel(value);
      else next.text = cleanLine(value, "A heading", LIMITS.heading);
    } else if (next.kind === "text") {
      next.text = cleanText(value);
    } else if (key === "title") next.title = cleanLine(value, "A data section's title", LIMITS.blockTitle);
    else if (key === "visual") next.visual = cleanDataVisual(value);
    else if (key === "query") next.query = validateSavedQuery(value);
    else next.width = cleanWidth(value);
  }
  if (JSON.stringify(next) === JSON.stringify(section)) return section;
  if (next.kind === "text" && section.kind === "text" && next.text !== section.text) next.reviewedEdition = latestEdition;
  next.version = section.version + 1;
  return next;
}

// A logo is stored as given and only ever drawn as an <img>, so what is checked is that it is one
// of the three image types it says it is, and small.
function cleanLogo(value: unknown): string {
  if (typeof value !== "string") fail("The logo must be an image as a data URL.");
  if (value.length > LIMITS.logo) fail("The logo is too large. Use an image of at most 200 KB.");
  const match = /^data:image\/(png|jpeg|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) fail("The logo must be a PNG, JPEG or SVG image as a base64 data URL.");
  let bytes: string;
  try {
    bytes = atob(match[2]);
  } catch {
    return fail("The logo's data is not valid base64.");
  }
  const matches = match[1] === "png" ? bytes.startsWith("\x89PNG\r\n\x1a\n")
    : match[1] === "jpeg" ? bytes.startsWith("\xff\xd8\xff")
    : /<svg[\s>]/i.test(bytes);
  if (!matches) fail("The logo's contents are not the kind of image it says it is.");
  return value;
}

function cleanLetterhead(value: unknown): Letterhead {
  const input = asRecord(value, "letterhead");
  for (const key of Object.keys(input)) {
    if (key !== "name" && key !== "logo" && key !== "accent") fail(`A letterhead has a name, a logo and an accent colour. "${key}" is not one of them.`);
  }
  const letterhead: Letterhead = {};
  if (input.name !== undefined && input.name !== null && input.name !== "") {
    letterhead.name = cleanLine(input.name, "The letterhead's name", LIMITS.letterheadName);
  }
  if (input.logo !== undefined && input.logo !== null && input.logo !== "") letterhead.logo = cleanLogo(input.logo);
  const accent = input.accent;
  if (accent !== undefined && accent !== null && accent !== "") {
    if (typeof accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(accent)) return fail("The accent colour must be written #rrggbb.");
    letterhead.accent = accent.toLowerCase();
  }
  return letterhead;
}

/** Where a section added or moved "after" another lands in `sections` (null: first). */
function indexAfter(sections: Section[], after: unknown): number {
  if (after === null) return 0;
  const index = sections.findIndex((section) => section.id === after);
  if (index < 0) fail(`No section has the id "${String(after)}".`);
  return index + 1;
}

function snapshotOf(report: Report): Snapshot {
  return copy({ title: report.meta.title, period: report.meta.period, locations: report.meta.locations, sections: report.sections });
}

// Keeps the history inside its step count and inside one stored value, oldest steps first.
function trimHistory(history: UndoHistory): void {
  while (history.past.length > LIMITS.undo) history.past.shift();
  while (history.future.length > LIMITS.undo) history.future.shift();
  let size = JSON.stringify(history).length;
  while (size > UNDO_MAX_CHARS && history.past.length + history.future.length > 0) {
    const dropped = history.past.length ? history.past.shift() : history.future.shift();
    size -= JSON.stringify(dropped).length + 1;
  }
}

/** The day of the month an instant falls on in a time zone. */
function localDayOfMonth(time: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" }).format(new Date(time)));
}

/**
 * The target of a schedule's persistent stub. It is a separate object from the gadget and has none
 * of its state, so it is given the two things it needs: the gadget's storage, to see which runs
 * were handled, and the function that generates an edition for a run.
 */
class RegenerateHook extends RpcTarget implements ScheduledTaskHook {
  readonly #storage: DurableObjectStorage;
  readonly #generate: (runId: string) => Promise<void>;
  readonly #monthly: "first" | undefined;

  constructor(storage: DurableObjectStorage, generate: (runId: string) => Promise<void>, monthly: "first" | undefined) {
    super();
    this.#storage = storage;
    this.#generate = generate;
    this.#monthly = monthly;
  }

  async onSchedule(firing: ScheduledFiring): Promise<void> {
    if (!firing || typeof firing.runId !== "string" || !firing.runId) throw new TypeError("A scheduled firing must carry its runId.");
    // A retry of a run that already produced its edition.
    const runs = (await this.#storage.get<HandledRun[]>("runs")) ?? [];
    if (runs.some((run) => run.runId === firing.runId)) return;
    // The scheduler has weekly rules and no monthly one: "the first Monday of the month" is every
    // Monday, taken only when it falls in the month's first seven days where the schedule runs.
    if (this.#monthly === "first" && localDayOfMonth(firing.actualTime, firing.timeZone) > 7) return;
    await this.#generate(firing.runId);
  }
}

export class Gadget extends DurableObject<GadgetEnv, unknown> {
  readonly #subscribers = new SubscriberRegistry<SubscriberCallbacks, Sender>();
  // Overlapping RPC calls are serialized so each change sees the state the last one left.
  readonly #queue = new MutationQueue();
  /** Editions are immutable, so what the review and stale rules read of one is kept once read. */
  readonly #digests = new Map<string, EditionDigest>();
  #initialized: Promise<void> | null = null;
  /** The starter report of a view-only copy that has nothing stored; it cannot be written. */
  #unsaved: Report | null = null;
  #statusRead: Promise<DataStatus> | null = null;
  #generation: Promise<GenerateResult> | null = null;

  // ---- Modes and data status

  #mode(): DataMode {
    if (this.env.GADGET === undefined) return "snapshot";
    return this.env.RETAIL_DATA === undefined ? "off" : "live";
  }

  /** The mode a call runs in: the environment's, or "off" once a read found the connection gone. */
  async #effectiveMode(): Promise<DataMode> {
    const mode = this.#mode();
    if (mode !== "live") return mode;
    const stored = await this.ctx.storage.get<StoredStatus>("status");
    return stored?.status.status === "off" ? "off" : "live";
  }

  #stateOf(status: DataStatus, mode: DataMode): DataState {
    if (status.status !== "ok") return { ...status, mode };
    return { ...status, mode, anchor: anchorDate(todayIso(), status.dateRange.to) };
  }

  /**
   * The dataset's state. Read from the dataset when nothing recent is stored (or `fresh` is asked),
   * and stored; a view-only copy serves what was stored with it, and a report with no data binding
   * is "off" without touching what is stored.
   */
  async #dataState(fresh = false): Promise<DataState> {
    const mode = this.#mode();
    if (mode === "off") return { status: "off", mode };
    const stored = await this.ctx.storage.get<StoredStatus>("status");
    if (mode === "snapshot") return stored ? this.#stateOf(stored.status, mode) : { status: "off", mode };
    if (!fresh && stored && stored.status.status === "ok" && Date.now() - stored.readAt < STATUS_MAX_AGE_MS) {
      return this.#stateOf(stored.status, mode);
    }
    this.#statusRead ??= readDataStatus(this.env.RETAIL_DATA).finally(() => { this.#statusRead = null; });
    const status = await this.#statusRead;
    await this.ctx.storage.put("status", { status, readAt: Date.now() } satisfies StoredStatus);
    return this.#stateOf(status, status.status === "off" ? "off" : "live");
  }

  /** Records that a read found the connection gone, which withholds editions until it is back. */
  async #connectionGone(): Promise<Refusal> {
    await this.ctx.storage.put("status", { status: { status: "off" }, readAt: Date.now() } satisfies StoredStatus);
    return new Refusal(OFF_MESSAGE);
  }

  /** The reader and the dataset's state for a call that reads, or the reason it cannot read. */
  async #reader(fresh: boolean): Promise<{ retail: RetailReader; data: Extract<DataState, { status: "ok" }>; anchor: string }> {
    const mode = this.#mode();
    if (mode === "snapshot") throw new Refusal(READ_ONLY_MESSAGE);
    const retail = this.env.RETAIL_DATA;
    if (!retail) throw new Refusal(OFF_MESSAGE);
    const data = await this.#dataState(fresh);
    if (data.status === "off") throw new Refusal(OFF_MESSAGE);
    if (data.status === "empty") throw new Refusal(EMPTY_MESSAGE);
    if (data.status === "error") throw new Error("The data could not be read: " + data.error);
    return { retail, data, anchor: anchorDate(todayIso(), data.dateRange.to) };
  }

  // ---- Loading

  // The starter report is written the first time anything reads the report. One promise for every
  // caller, so two first reads cannot each write a starter.
  #initialize(): Promise<void> {
    this.#initialized ??= (async () => {
      if (await this.ctx.storage.get<Meta>("meta")) return;
      const sections = starterSections(newId);
      const meta: Meta = {
        revision: 0,
        title: STARTER_TITLE,
        period: STARTER_PERIOD,
        locations: [],
        letterhead: {},
        sectionOrder: sections.map((section) => section.id),
        editions: [],
        lastModified: Date.now(),
      };
      if (this.#mode() === "snapshot") {
        this.#unsaved = { meta, sections };
        return;
      }
      const entries: Record<string, unknown> = { meta };
      for (const section of sections) entries[sectionKey(section.id)] = section;
      await this.ctx.storage.put(entries);
    })().catch((error: unknown) => {
      this.#initialized = null;
      throw error;
    });
    return this.#initialized;
  }

  async #load(): Promise<Report> {
    await this.#initialize();
    if (this.#unsaved) return copy(this.#unsaved);
    // Both reads are issued together, so they see the same stored state.
    const [meta, stored] = await Promise.all([
      this.ctx.storage.get<Meta>("meta"),
      this.ctx.storage.list<Section>({ prefix: "s:" }),
    ]);
    if (!meta) throw new Error("The report's stored state is missing.");
    const sections: Section[] = [];
    for (const id of meta.sectionOrder) {
      const section = stored.get(sectionKey(id));
      if (section) sections.push(section);
    }
    return { meta, sections };
  }

  async #history(): Promise<UndoHistory> {
    return (await this.ctx.storage.get<UndoHistory>("undo")) ?? { past: [], future: [] };
  }

  async #digest(id: string): Promise<EditionDigest | null> {
    const known = this.#digests.get(id);
    if (known) return known;
    const edition = await this.ctx.storage.get<Edition>(editionKey(id));
    if (!edition) return null;
    const digest = digestOf(edition);
    this.#digests.set(id, digest);
    return digest;
  }

  /** `review` and `stale`: derived on every read from the sections and the editions they name. */
  async #derive(report: Report): Promise<{ review: string[]; stale: string[] }> {
    const editions = report.meta.editions;
    if (!editions.length) return { review: [], stale: [] };
    const known = new Set(editions.map((edition) => edition.id));
    const wanted = new Set([editions[0].id, editions[editions.length - 1].id]);
    for (const section of report.sections) {
      if (section.kind === "text" && section.reviewedEdition && known.has(section.reviewedEdition)) wanted.add(section.reviewedEdition);
    }
    const digests: EditionDigest[] = [];
    for (const digest of await Promise.all(Array.from(wanted, (id) => this.#digest(id)))) if (digest) digests.push(digest);
    const latest = digests.find((digest) => digest.id === editions[0].id) ?? null;
    return { review: reviewFlags(report.sections, digests), stale: staleSections(report.sections, latest) };
  }

  /** The report as a caller in `mode` may see it: with data off, as if it had no edition. */
  async #view(report: Report, mode: DataMode): Promise<{ meta: Meta; sections: Section[]; review: string[]; stale: string[] }> {
    if (mode === "off") return { meta: { ...report.meta, editions: [] }, sections: report.sections, review: [], stale: [] };
    return { meta: report.meta, sections: report.sections, ...(await this.#derive(report)) };
  }

  async #edition(id: string | undefined): Promise<Edition> {
    if ((await this.#effectiveMode()) === "off") throw new Error(OFF_MESSAGE);
    const { meta } = await this.#load();
    if (!meta.editions.length) throw new Error(NOT_GENERATED_MESSAGE);
    const summary = id === undefined ? meta.editions[0] : meta.editions.find((edition) => edition.id === id);
    const edition = summary && (await this.ctx.storage.get<Edition>(editionKey(summary.id)));
    if (!summary || !edition) throw new Error(NO_SUCH_EDITION_MESSAGE);
    // An edition is never rewritten: whether it is pinned is the summary's to say.
    return { ...edition, pinned: summary.pinned };
  }

  // ---- Changing

  /** Tells every open page what the report now is. Called inside the queue, so events stay in order. */
  async #announce(report: Report, senderId: string | undefined): Promise<Changed> {
    const history = await this.#history();
    const event: Changed = {
      revision: report.meta.revision,
      ...(await this.#view(report, await this.#effectiveMode())),
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      ...(senderId ? { senderId } : {}),
    };
    this.#subscribers.broadcast((subscriber) => subscriber.changed(event));
    return event;
  }

  /**
   * Stores `after` in place of `before`: the sections that differ, the meta with its revision
   * bumped, and `extra` keys, in one write; then removes what is gone.
   */
  async #store(before: Report, after: Report, extra: Record<string, unknown>, drop: string[]): Promise<void> {
    const was = new Map(before.sections.map((section) => [section.id, JSON.stringify(section)]));
    const entries: Record<string, unknown> = { ...extra };
    for (const section of after.sections) {
      if (was.get(section.id) !== JSON.stringify(section)) entries[sectionKey(section.id)] = section;
      was.delete(section.id);
    }
    after.meta.sectionOrder = after.sections.map((section) => section.id);
    after.meta.revision = before.meta.revision + 1;
    after.meta.lastModified = Date.now();
    entries.meta = after.meta;
    await this.ctx.storage.put(entries);
    const gone = [...Array.from(was.keys(), sectionKey), ...drop];
    if (gone.length) await this.ctx.storage.delete(gone);
  }

  /**
   * Runs one change in the queue: `work` edits the draft, and when that changed anything it is
   * stored, recorded for undo (when `undoable`) and broadcast. Returns what `work` returned with
   * the report's revision.
   */
  #mutate<T>(args: unknown, undoable: boolean, work: (draft: Draft) => T | Promise<T>): Promise<{ result: T; revision: number }> {
    const senderId = senderOf(args);
    return this.#queue.run(async () => {
      if (this.#mode() === "snapshot") throw new Error(READ_ONLY_MESSAGE);
      const before = await this.#load();
      const draft: Draft = { ...copy(before), drop: [] };
      const result = await work(draft);
      draft.meta.sectionOrder = draft.sections.map((section) => section.id);
      if (!draft.drop.length && JSON.stringify(draft.meta) === JSON.stringify(before.meta) && JSON.stringify(draft.sections) === JSON.stringify(before.sections)) {
        return { result, revision: before.meta.revision };
      }
      const extra: Record<string, unknown> = {};
      if (undoable) {
        const history = await this.#history();
        history.past.push(snapshotOf(before));
        history.future = [];
        trimHistory(history);
        extra.undo = history;
      }
      await this.#store(before, draft, extra, draft.drop);
      await this.#announce(draft, senderId);
      return { result, revision: draft.meta.revision };
    });
  }

  /** Steps the history: the newest snapshot of `from` is restored and the present goes onto `to`. */
  #step(args: unknown, from: "past" | "future", to: "past" | "future"): Promise<Changed | null> {
    const senderId = senderOf(args);
    return this.#queue.run(async () => {
      if (this.#mode() === "snapshot") throw new Error(READ_ONLY_MESSAGE);
      const history = await this.#history();
      const snapshot = history[from].pop();
      if (!snapshot) return null;
      const before = await this.#load();
      history[to].push(snapshotOf(before));
      trimHistory(history);
      const current = new Map(before.sections.map((section) => [section.id, section]));
      const sections = snapshot.sections.map((restored): Section => {
        const now = current.get(restored.id);
        if (!now) return { ...restored, version: restored.version + 1 };
        // Text that reads the same keeps what it was last confirmed against: reviewing it since
        // is not undone by undoing something else.
        const kept: Section = restored.kind === "text" && now.kind === "text" && restored.text === now.text
          ? { ...restored, reviewedEdition: now.reviewedEdition }
          : restored;
        const same = JSON.stringify({ ...kept, version: 0 }) === JSON.stringify({ ...now, version: 0 });
        return same ? now : { ...kept, version: Math.max(now.version, kept.version) + 1 };
      });
      const after: Report = {
        meta: { ...before.meta, title: snapshot.title, period: snapshot.period, locations: snapshot.locations },
        sections,
      };
      await this.#store(before, after, { undo: history }, []);
      return this.#announce(after, senderId);
    });
  }

  // ---- For the page

  async subscribe(callback: SubscriberStub, client: Sender | null = {}): Promise<Opened> {
    const handle = this.#subscribers.add(callback, { clientId: senderOf(client) });
    try {
      return await this.open();
    } catch (error) {
      this.#subscribers.remove(handle);
      throw error;
    }
  }

  async open(args: { editionId?: string } | null = {}): Promise<Opened> {
    const data = await this.#dataState();
    const report = await this.#load();
    const view = await this.#view(report, data.mode);
    // The edition asked for when the report still has it, and otherwise the latest. Read with the
    // summary in hand, so an edition deleted meanwhile opens as "none" rather than as an error.
    const summary = view.meta.editions.find((known) => known.id === args?.editionId) ?? view.meta.editions[0];
    const stored = summary && (await this.ctx.storage.get<Edition>(editionKey(summary.id)));
    const edition: Edition | null = summary && stored ? { ...stored, pinned: summary.pinned } : null;
    const history: UndoHistory = data.mode === "snapshot" ? { past: [], future: [] } : await this.#history();
    return { ...view, data, edition, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
  }

  async getEdition(args: { id: string }): Promise<Edition> {
    return this.#edition(asId(asRecord(args, "The argument").id, "id"));
  }

  async undo(args: Sender | null = {}): Promise<Changed | null> {
    return this.#step(args, "past", "future");
  }

  async redo(args: Sender | null = {}): Promise<Changed | null> {
    return this.#step(args, "future", "past");
  }

  // ---- For the agent (and the page)

  async describeData(): Promise<DataDescription> {
    const { retail, data } = await this.#reader(true);
    try {
      const description = await retail.describe();
      const { mode: _mode, anchor: _anchor, ...status } = data;
      return { data: status, tables: description.tables, metrics: description.metrics, limits: description.limits };
    } catch (error) {
      if (isConnectionGone(error)) throw await this.#connectionGone();
      throw new Error(plainError(error));
    }
  }

  async getReport(): Promise<ReportView> {
    const mode = await this.#effectiveMode();
    const view = await this.#view(await this.#load(), mode);
    return { ...view, latestEdition: view.meta.editions[0] ?? null };
  }

  async readEdition(args: { id?: string } | null = {}): Promise<Edition> {
    const id = args?.id;
    return this.#edition(id === undefined || id === null ? undefined : asId(id, "id"));
  }

  async addSection(args: { section: SectionInput; after?: string | null } & Sender): Promise<{ sectionId: string; revision: number }> {
    const input = asRecord(args, "The argument");
    const section = cleanSection(input.section, newId());
    const { revision } = await this.#mutate(args, true, (draft) => {
      if (draft.sections.length >= LIMITS.sections) fail(`A report holds at most ${LIMITS.sections} sections. Remove one before adding another.`);
      const index = input.after === undefined ? draft.sections.length : indexAfter(draft.sections, input.after);
      draft.sections.splice(index, 0, section);
    });
    return { sectionId: section.id, revision };
  }

  async updateSection(args: SectionPatch): Promise<{ revision: number; before: Section; after: Section }> {
    const { id, clientId: _clientId, ...fields } = asRecord(args, "The argument");
    const sectionId = asId(id, "id");
    const { result, revision } = await this.#mutate(args, true, (draft) => {
      const index = draft.sections.findIndex((section) => section.id === sectionId);
      if (index < 0) fail(`No section has the id "${sectionId}".`);
      const before = draft.sections[index];
      const after = patchSection(before, fields, draft.meta.editions[0]?.id ?? null);
      draft.sections[index] = after;
      return { before, after };
    });
    return { revision, ...result };
  }

  async removeSection(args: { id: string } & Sender): Promise<Revised> {
    const id = asId(asRecord(args, "The argument").id, "id");
    const { revision } = await this.#mutate(args, true, (draft) => {
      const index = draft.sections.findIndex((section) => section.id === id);
      if (index < 0) fail(`No section has the id "${id}".`);
      draft.sections.splice(index, 1);
    });
    return { revision };
  }

  async moveSection(args: { id: string; after: string | null } & Sender): Promise<Revised> {
    const input = asRecord(args, "The argument");
    const id = asId(input.id, "id");
    if (input.after === undefined) fail("after must be the id of the section to move after, or null to move first.");
    if (input.after === id) fail("A section cannot be moved after itself.");
    const { revision } = await this.#mutate(args, true, (draft) => {
      const index = draft.sections.findIndex((section) => section.id === id);
      if (index < 0) fail(`No section has the id "${id}".`);
      const [section] = draft.sections.splice(index, 1);
      draft.sections.splice(indexAfter(draft.sections, input.after), 0, section);
    });
    return { revision };
  }

  async setTitle(args: { title: string } & Sender): Promise<Revised> {
    const title = cleanLine(asRecord(args, "The argument").title, "The title", LIMITS.title);
    const { revision } = await this.#mutate(args, true, (draft) => {
      draft.meta.title = title;
    });
    return { revision };
  }

  async setPeriod(args: { period: DateRangeFilter; locations?: number[] } & Sender): Promise<Revised> {
    const input = asRecord(args, "The argument");
    if (input.period === undefined) fail('period must be a preset such as { preset: "lastMonth" } or a range { from, to }.');
    const { revision } = await this.#mutate(args, true, (draft) => {
      // The library's validator is the one place a period and a location list are checked: dates
      // must be real dates and locations whole numbers, so nothing else can reach a query.
      const filters = validateFilters({ dateRange: input.period, locations: input.locations === undefined ? draft.meta.locations : input.locations });
      draft.meta.period = filters.dateRange;
      draft.meta.locations = filters.locations;
    });
    return { revision };
  }

  async setLetterhead(args: { letterhead: Letterhead } & Sender): Promise<Revised> {
    const letterhead = cleanLetterhead(asRecord(args, "The argument").letterhead);
    const { revision } = await this.#mutate(args, false, (draft) => {
      draft.meta.letterhead = letterhead;
    });
    return { revision };
  }

  async markReviewed(args: { ids: string[] } & Sender): Promise<Revised> {
    const ids = asRecord(args, "The argument").ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) fail("ids must be a list of text section ids.");
    const { revision } = await this.#mutate(args, false, (draft) => {
      const latest = draft.meta.editions[0]?.id ?? null;
      for (const id of ids as string[]) {
        const index = draft.sections.findIndex((section) => section.id === id);
        const section = draft.sections[index];
        if (!section || section.kind !== "text") fail(`"${id}" is not a text section of this report.`);
        if (section.reviewedEdition !== latest) draft.sections[index] = { ...section, reviewedEdition: latest, version: section.version + 1 };
      }
    });
    return { revision };
  }

  async generate(args: { createdBy?: EditionAuthor } | null = {}): Promise<GenerateResult> {
    const createdBy = args?.createdBy ?? "agent";
    if (!AUTHORS.includes(createdBy)) fail('createdBy must be "member", "agent" or "schedule".');
    return this.#generate(createdBy);
  }

  async pinEdition(args: { id: string; pinned: boolean } & Sender): Promise<Revised> {
    const input = asRecord(args, "The argument");
    const id = asId(input.id, "id");
    const pinned = input.pinned;
    if (typeof pinned !== "boolean") return fail("pinned must be true or false.");
    if ((await this.#effectiveMode()) === "off") throw new Error(OFF_MESSAGE);
    const { revision } = await this.#mutate(args, false, (draft) => {
      const summary = draft.meta.editions.find((edition) => edition.id === id);
      if (!summary) fail(NO_SUCH_EDITION_MESSAGE);
      summary.pinned = pinned;
    });
    return { revision };
  }

  async deleteEdition(args: { id: string } & Sender): Promise<Revised> {
    const id = asId(asRecord(args, "The argument").id, "id");
    if ((await this.#effectiveMode()) === "off") throw new Error(OFF_MESSAGE);
    const { revision } = await this.#mutate(args, false, (draft) => {
      const index = draft.meta.editions.findIndex((edition) => edition.id === id);
      if (index < 0) fail(NO_SUCH_EDITION_MESSAGE);
      draft.meta.editions.splice(index, 1);
      draft.drop.push(editionKey(id));
    });
    this.#digests.delete(id);
    return { revision };
  }

  async previewQuery(args: { query: unknown; visual?: unknown; period?: unknown }): Promise<QueryOutcome> {
    const input = asRecord(args, "The argument");
    const query = validateSavedQuery(input.query);
    const visual: VisualSpec = input.visual === undefined ? { type: "table" } : validateVisual(input.visual);
    const { retail, data, anchor } = await this.#reader(false);
    const { meta } = await this.#load();
    const period = input.period === undefined ? meta.period : validateDateRange(input.period);
    const filters: ResolvedFilters = { ...resolveRange(period, anchor), locations: meta.locations };
    try {
      return await runSavedQuery(retail, query, { sort: visual.sort, limit: visual.limit }, filters, { locations: data.locations });
    } catch (error) {
      if (isConnectionGone(error)) throw await this.#connectionGone();
      throw new Error(plainError(error));
    }
  }

  // ---- Generating

  // One generation at a time: a second request while one runs gets the edition being made, so a
  // double click or a schedule firing during a manual run cannot make two editions of one moment.
  async #generate(createdBy: EditionAuthor, runId?: string): Promise<GenerateResult> {
    if (this.#generation) {
      const result = await this.#generation;
      if (runId) await this.#queue.run(async () => this.ctx.storage.put("runs", await this.#runsWith(runId, result.edition.id)));
      return result;
    }
    this.#generation = this.#runGeneration(createdBy, runId).finally(() => { this.#generation = null; });
    return this.#generation;
  }

  async #runsWith(runId: string, editionId: string): Promise<HandledRun[]> {
    const runs = (await this.ctx.storage.get<HandledRun[]>("runs")) ?? [];
    if (!runs.some((run) => run.runId === runId)) runs.push({ runId, editionId });
    return runs.slice(-LIMITS.runs);
  }

  async #runGeneration(createdBy: EditionAuthor, runId: string | undefined): Promise<GenerateResult> {
    const { retail, data, anchor } = await this.#reader(true);
    // The sections as they stand between two changes, never halfway through one.
    const report = await this.#queue.run(() => this.#load());
    const dataSections: DataSection[] = [];
    for (const section of report.sections) if (section.kind === "data") dataSections.push(section);
    if (!dataSections.length) throw new Refusal(NO_DATA_SECTIONS_MESSAGE);
    this.#retention(report.meta.editions);

    const range = resolveRange(report.meta.period, anchor);
    const filters: ResolvedFilters = { from: range.from, to: range.to, locations: report.meta.locations };
    let outcomes: Record<string, QueryOutcome>;
    try {
      outcomes = await this.#runAll(retail, dataSections, filters, data.locations);
    } catch (error) {
      if (isConnectionGone(error)) throw await this.#connectionGone();
      throw error;
    }

    return this.#queue.run(async () => {
      const before = await this.#load();
      const removed = this.#retention(before.meta.editions);
      const newest = before.meta.editions[0];
      let edition: Edition;
      try {
        edition = buildEdition({
          id: newId(),
          // Editions are ordered by when they were made, whatever the clock did in between.
          asOf: Math.max(Date.now(), newest ? newest.asOf + 1 : 0),
          period: range,
          createdBy,
          title: report.meta.title,
          letterhead: report.meta.letterhead,
          completeThrough: data.completeThrough,
          sections: report.sections,
          outcomes,
        });
      } catch (error) {
        throw error instanceof Error && error.message === EDITION_TOO_LONG ? new Refusal(EDITION_TOO_LONG) : error;
      }
      const summary = summaryOf(edition);
      const after: Report = {
        meta: { ...before.meta, editions: [summary, ...before.meta.editions.filter((known) => !removed.includes(known.id))] },
        sections: before.sections,
      };
      const extra: Record<string, unknown> = { [editionKey(edition.id)]: edition };
      if (runId) extra.runs = await this.#runsWith(runId, edition.id);
      await this.#store(before, after, extra, removed.map(editionKey));
      for (const id of removed) this.#digests.delete(id);
      this.#digests.set(edition.id, digestOf(edition));
      const { review } = await this.#announce(after, undefined);
      this.#subscribers.broadcast((subscriber) => subscriber.generated({ edition: summary, review }));
      const failed = dataSections.filter((section) => isFailure(outcomes[section.id])).map((section) => section.id);
      return { edition: summary, review, failed };
    });
  }

  /** The editions retention removes to make room for one more; refuses when all are pinned. */
  #retention(editions: EditionSummary[]): string[] {
    try {
      return planRetention(editions);
    } catch (error) {
      throw error instanceof Error && error.message === ALL_PINNED ? new Refusal(ALL_PINNED) : error;
    }
  }

  async #runAll(retail: RetailReader, sections: DataSection[], filters: ResolvedFilters, locations: { id: number; name: string }[]): Promise<Record<string, QueryOutcome>> {
    const outcomes: Record<string, QueryOutcome> = {};
    let next = 0;
    const worker = async () => {
      while (next < sections.length) {
        const section = sections[next++];
        const started = Date.now();
        try {
          outcomes[section.id] = await runSavedQuery(retail, section.query, { sort: section.visual.sort, limit: section.visual.limit }, filters, { locations });
        } catch (error) {
          // Only a removed connection stops the generation; anything else is this block's failure.
          if (isConnectionGone(error)) throw error;
          outcomes[section.id] = { error: plainError(error), ranAt: started, durationMs: Date.now() - started, period: { from: filters.from, to: filters.to } };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, sections.length) }, worker));
    return outcomes;
  }

  // ---- Scheduling

  /**
   * Recreates the target of a schedule's persistent stub. The agent registers the stub with the
   * Scheduled Tasks binding from `executeCode` (README.md has the recipe) and a person enables it;
   * the gadget itself never calls the scheduler.
   */
  async [restore](params: RestoreParams): Promise<ScheduledTaskHook> {
    const given: { type?: unknown; monthly?: unknown } = params ?? {};
    if (given.type !== "regenerate") throw new TypeError(`Unknown restore type: ${String(given.type)}`);
    if (given.monthly !== undefined && given.monthly !== "first") throw new TypeError('monthly must be "first" when given.');
    return new RegenerateHook(this.ctx.storage, (runId) => this.#scheduled(runId), given.monthly === "first" ? "first" : undefined);
  }

  // A firing that cannot produce an edition for a reason a retry would not change (data off or
  // empty, nothing to compute, every edition pinned) ends quietly; any other failure is thrown,
  // which is what makes the scheduler try the run again.
  async #scheduled(runId: string): Promise<void> {
    try {
      await this.#generate("schedule", runId);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
    }
  }
}

// ---- Export

/** An export format as the Workshop lists it. */
interface ExportFormat {
  id: string;
  label: string;
  mode: "server" | "browser";
  contentType: string;
  fileExtension: string;
}

function markdownCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

// One Markdown table of the values as the page shows them. A column that only names another
// column's currency is left out: the amounts already carry it.
function markdownTable(result: QueryResult, rows: QueryResult["rows"]): string[] {
  const currencies = new Set(result.columns.map((column) => column.currencyColumn));
  const shown = result.columns.map((column, index) => ({ column, index })).filter(({ column }) => !currencies.has(column.name));
  const lines = [
    "| " + shown.map(({ column }) => markdownCell(columnHeading(column))).join(" | ") + " |",
    "| " + shown.map(({ column }) => (isNumericColumn(column) ? "---:" : "---")).join(" | ") + " |",
  ];
  for (const row of rows) {
    lines.push("| " + shown.map(({ column, index }) => markdownCell(formatValue(row[index], column, row, result.columns))).join(" | ") + " |");
  }
  return lines;
}

/**
 * The report as the page shows its latest edition, in Markdown: headings and text as written, and
 * each data block the edition holds as a table of the values as displayed.
 */
function reportToMarkdown(report: ReportView, edition: Edition): string {
  const asOf = new Date(edition.asOf).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const { title, letterhead } = report.meta;
  const blocks = currentBlocks(report.sections, report.stale, edition);
  const first = blocks[0];
  // A report that opens with its own title as a level-1 heading is not given the title twice.
  const titled = first !== undefined && first.kind === "heading" && first.level === 1 && first.text.trim().toLowerCase() === title.trim().toLowerCase();
  const parts: string[] = [];
  if (letterhead.name) parts.push(letterhead.name);
  parts.push("# " + title, `As of ${asOf} · ${describeRange(edition.period)}`);
  for (const block of titled ? blocks.slice(1) : blocks) {
    if (block.kind === "heading") parts.push("#".repeat(block.level) + " " + block.text);
    else if (block.kind === "text") parts.push(block.text);
    else if (block.outcome) {
      const lines = ["**" + block.title + "**", ""];
      const outcome = block.outcome;
      if (isFailure(outcome)) lines.push("_Could not be computed: " + outcome.error + "_");
      else {
        lines.push(...markdownTable(outcome, outcome.rows));
        if (outcome.previous) lines.push("", `Previous period (${describeRange(outcome.previous)}):`, "", ...markdownTable(outcome, outcome.previous.rows));
        if (outcome.truncated) lines.push("", `_Showing the first ${outcome.rows.length} rows._`);
        if (outcome.partial) {
          const share = outcome.costCoverage === undefined ? "" : `: covers ${Math.round(outcome.costCoverage * 100)}% of units`;
          lines.push("", `_Partial${share}._`);
        }
        if (edition.completeThrough !== null && outcome.period.to > edition.completeThrough) {
          lines.push("", `_Data is complete through ${formatDate(edition.completeThrough)}; later days may be missing._`);
        }
      }
      parts.push(lines.join("\n"));
    }
  }
  return parts.join("\n\n") + "\n";
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(_gadget: ExportGadgetStub): Promise<ExportFormat[]> {
    return [
      // The page prints the latest edition from stored results (see client.ts).
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
      { id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown; charset=utf-8", fileExtension: ".md" },
    ];
  }

  async export(gadget: ExportGadgetStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "markdown") throw new Error("Unsupported report export format: " + id);
    // Read first: it is what refuses when data is off or nothing was generated yet.
    const edition = await gadget.readEdition();
    const report = await gadget.getReport();
    // Both are plain data; releasing the RPC results leaves them readable.
    (edition as Partial<Disposable>)[Symbol.dispose]?.();
    (report as Partial<Disposable>)[Symbol.dispose]?.();
    const bytes = new TextEncoder().encode(reportToMarkdown(report, edition));
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}
