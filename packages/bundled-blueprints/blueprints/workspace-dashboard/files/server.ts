import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { MutationQueue, SubscriberRegistry } from "@gadgets/bundled-blueprints/libraries/sync/server";
import {
  type DataStatus,
  type FilterName,
  type FilterValues,
  type QueryOutcome,
  type ResolvedFilters,
  type RetailDatasetDescription,
  type RetailReader,
  type SavedQuery,
  type Scalar,
  type VisualSpec,
  anchorDate,
  columnHeading,
  describeRange,
  formatValue,
  isConnectionGone,
  plainError,
  readDataStatus,
  resolveRange,
  runSavedQuery,
  usesFilter,
  validateFilters,
  validateSavedQuery,
  validateVisual,
} from "@gadgets/bundled-blueprints/libraries/data/server";
import { clampLayout, defaultSize, firstFreeSlot, settleLayout } from "./lib/layout.ts";
import { STARTER_FRESHNESS_MINUTES, STARTER_TITLE, starterFilters, starterTiles } from "./lib/starter.ts";
import type {
  AddTileArgs,
  Changed,
  DashboardContent,
  DataDescription,
  DataMode,
  DataState,
  ExportGadgetStub,
  Layout,
  Meta,
  Opened,
  PreviewQueryArgs,
  RunResult,
  RunTilesArgs,
  Sender,
  Snapshot,
  StoredResults,
  StoredStatus,
  SubscriberCallbacks,
  Tile,
  UndoHistory,
  UpdateTileArgs,
} from "./lib/protocol.ts";

// ---------------------------------------------------------------------------
// Dashboard: a grid of tiles, each drawn from a saved query against the organization's retail
// dataset.
//
// Storage layout:
//   "meta"        -> { revision, title, freshnessMinutes, defaultFilters, tileOrder, lastModified }
//   "t:<tileId>"  -> the tile: title, visual, saved query, the filters it uses, its place
//   "r:<tileId>"  -> the tile's cached outcomes: the one for the default filters first (its key
//                    starts with "default:"), then up to 8 recent ones for other filter values
//   "status"      -> the dataset's status (date coverage, locations) and when it was read
//   "undo"        -> { past, future } snapshots of the structure
//
// The structure (meta and tiles) is shared, edited through the mutation queue and undoable.
// Results are a cache: they are never part of undo, they are dropped when the query behind them
// changes, and all of them are deleted as soon as the gadget finds it has no data connection.
//
// A viewer's filter choice is never stored. It arrives as the `filters` argument of runTiles, is
// validated, and reaches a query only as bound parameters.
//
// Every public method is callable by the page and by the agent, so everything that is not part
// of that surface is a #private member.
// ---------------------------------------------------------------------------

/** What the loader gives this gadget: itself, and the retail dataset when the organization has it on. */
interface GadgetEnv {
  RETAIL_DATA?: RetailReader;
  GADGET?: unknown;
}

/** The structure as a mutation works on it. `meta.tileOrder` is the reading order of `tiles`. */
interface State {
  meta: Meta;
  tiles: Map<string, Tile>;
}

/** One tile's part of a runTiles call: the filters it is bound to and where its outcome is cached. */
interface TileRun {
  tile: Tile & { query: SavedQuery };
  filters: ResolvedFilters;
  key: string;
  /** Whether these are the dashboard's default filters, as this tile sees them. */
  isDefault: boolean;
}

const MAX_TILES = 40;
const MAX_TITLE = 200;
const MAX_TILE_TITLE = 120;
const MIN_FRESHNESS = 1;
const MAX_FRESHNESS = 1440;
const MAX_UNDO = 50;
// The whole history is one stored value, which the runtime caps at 2 MB.
const MAX_UNDO_CHARS = 1_000_000;
/** Cached outcomes a tile keeps for filter values other than the default ones. */
const MAX_OTHER_ENTRIES = 8;
const MAX_IN_FLIGHT = 4;
const MAX_STORAGE_KEYS = 128;
const DEFAULT_MARK = "default:";
const FILTER_NAMES: FilterName[] = ["dateRange", "locations"];

const READ_ONLY = "This is a read-only copy of the dashboard.";
const DATA_OFF = "Retail data is not turned on for this organization. An administrator can turn it on under Connectors → Data.";
const DATA_EMPTY = "No sales data yet. Import a CSV or connect a source in Data, then refresh.";
const COPY_WITHOUT_DATA = "This copy was made before the dashboard had loaded any data.";

const tileKey = (id: string) => "t:" + id;
const resultsKey = (id: string) => "r:" + id;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Gadget extends DurableObject<GadgetEnv, unknown> {
  readonly #subscribers = new SubscriberRegistry<SubscriberCallbacks, Sender>();
  // Overlapping calls are serialized so each structure change sees the state the last one left,
  // and so a cache write never lands on a tile that changed underneath it. Queries never run
  // inside the queue: only the short reads and writes around them do.
  readonly #queue = new MutationQueue();
  /** The status read in progress, shared by the calls that arrive while it runs. */
  #statusRead: Promise<DataStatus> | null = null;
  /** Queries in flight, so two pages asking for the same tile and filters cost one read. */
  readonly #running = new Map<string, Promise<QueryOutcome>>();
  /** Whether cached results have been deleted since this instance found it has no data connection. */
  #purged = false;
  /** The starter content of a read-only copy made before anything was stored. */
  #unsaved: State | null = null;

  // --- For the page -------------------------------------------------------

  async subscribe(callback: SubscriberCallbacks, client?: Sender | null): Promise<Opened> {
    // Registered before the read, so no change committed meanwhile goes unheard; a failed read
    // forgets it again (the page then subscribes anew).
    const handle = this.#subscribers.add(callback, { clientId: senderId(client?.clientId) });
    try {
      return await this.open();
    } catch (error) {
      this.#subscribers.remove(handle);
      throw error;
    }
  }

  // Returns what is cached and reads the dataset's status when the stored one is old. It never
  // runs a tile: the page asks for that with runTiles once it has drawn what it was given.
  async open(): Promise<Opened> {
    const { meta, tiles } = await this.#state();
    const data = await this.#dataState(meta);
    const results = data.mode === "off" ? {} : defaultOutcomes(await this.#cached(meta.tileOrder));
    const history = data.mode === "snapshot" ? null : await this.ctx.storage.get<UndoHistory>("undo");
    return {
      meta,
      tiles: inOrder(meta, tiles),
      data,
      results,
      ...(data.anchor ? { resolved: resolveFilters(meta.defaultFilters, data.anchor) } : {}),
      canUndo: !!history?.past.length,
      canRedo: !!history?.future.length,
    };
  }

  async runTiles(args: RunTilesArgs | null = {}): Promise<RunResult> {
    const input: Record<string, unknown> = args === null ? {} : record(args, "runTiles takes { ids, filters, force }, all optional.");
    const ids = input.ids === undefined ? null : idList(input.ids);
    const chosen = input.filters === undefined ? null : validateFilters(input.filters);
    const force = input.force === true;

    const { meta, tiles } = await this.#state();
    // A forced run trusts nothing cached, the dataset's status included: Refresh is how a
    // person picks up an import that has just landed.
    const data = await this.#dataState(meta, force);
    const anchor = data.anchor ?? anchorDate(isoDay(Date.now()), null);
    const defaults = resolveFilters(meta.defaultFilters, anchor);
    const resolved = chosen ? resolveFilters(chosen, anchor) : defaults;
    if (data.mode === "off") return { resolved, results: {}, data };

    const defaultKey = entryKey(defaults);
    const runs: TileRun[] = [];
    for (const id of new Set(ids ?? meta.tileOrder)) {
      const tile = tiles.get(id);
      if (!tile || !hasQuery(tile)) continue;
      // A filter the tile does not use stays at the dashboard's default, so a viewer changing it
      // leaves this tile's question, and its cached answer, exactly as they were.
      const filters: ResolvedFilters = {
        from: tile.uses.includes("dateRange") ? resolved.from : defaults.from,
        to: tile.uses.includes("dateRange") ? resolved.to : defaults.to,
        locations: tile.uses.includes("locations") ? resolved.locations : defaults.locations,
      };
      const key = entryKey(filters);
      runs.push({ tile, filters, key, isDefault: key === defaultKey });
    }
    const cached = await this.#cached(runs.map((run) => run.tile.id));
    const results: Record<string, QueryOutcome> = {};

    // A read-only copy, and a dataset that is empty or could not be read, serve what is stored
    // and read nothing.
    const retail = this.env.RETAIL_DATA;
    if (data.mode !== "live" || data.status !== "ok" || !retail) {
      for (const run of runs) {
        const entries = cached.get(run.tile.id)?.entries ?? [];
        const entry = run.isDefault ? entries.find((each) => each.key.startsWith(DEFAULT_MARK)) : entries.find((each) => each.key === run.key);
        if (entry) results[run.tile.id] = entry.outcome;
      }
      return { resolved, results, data };
    }

    const freshFor = meta.freshnessMinutes * 60_000;
    const now = Date.now();
    const toRun: TileRun[] = [];
    const toStore: (TileRun & { outcome: QueryOutcome })[] = [];
    for (const run of runs) {
      const entries = cached.get(run.tile.id)?.entries ?? [];
      const marked = run.isDefault ? entries.find((each) => each.key === DEFAULT_MARK + run.key) : undefined;
      const entry = marked ?? entries.find((each) => each.key === run.key);
      if (!entry || force || now - entry.outcome.ranAt >= freshFor) {
        toRun.push(run);
        continue;
      }
      results[run.tile.id] = entry.outcome;
      // A fresh outcome cached under a viewer's filters answers the default filters too once the
      // defaults are changed to match: it becomes the default entry rather than being read again.
      if (run.isDefault && !marked) toStore.push({ ...run, outcome: entry.outcome });
    }

    let outcomes: QueryOutcome[];
    try {
      outcomes = await inParallel(toRun, MAX_IN_FLIGHT, (run) => this.#run(retail, run, data.locations));
    } catch (error) {
      if (!isConnectionGone(error)) throw new Error(plainError(error));
      return { resolved, results: {}, data: await this.#off(true) };
    }
    toRun.forEach((run, index) => {
      results[run.tile.id] = outcomes[index];
      toStore.push({ ...run, outcome: outcomes[index] });
    });

    const fresh = await this.#store(toStore);
    if (Object.keys(fresh).length) this.#subscribers.broadcast((subscriber) => subscriber.results({ results: fresh, resolved: defaults }));
    return { resolved, results, data };
  }

  undo(sender?: Sender | null): Promise<Changed | null> {
    return this.#travel("past", "future", sender?.clientId);
  }

  redo(sender?: Sender | null): Promise<Changed | null> {
    return this.#travel("future", "past", sender?.clientId);
  }

  // --- For the agent, and the page's edit mode ---------------------------

  async describeData(): Promise<DataDescription> {
    const retail = await this.#reader();
    const { meta } = await this.#state();
    let description: RetailDatasetDescription;
    try {
      description = await retail.describe();
    } catch (error) {
      throw await this.#readFailure(error);
    }
    disposeResult(description);
    const data = await this.#dataState(meta);
    if (data.mode === "off") throw new Error(DATA_OFF);
    return { data, tables: description.tables, metrics: description.metrics, limits: description.limits };
  }

  async getDashboard(): Promise<DashboardContent> {
    const { meta, tiles } = await this.#state();
    const mode = this.#mode();
    if (mode === "off") await this.#off();
    const results = mode === "off" ? {} : defaultOutcomes(await this.#cached(meta.tileOrder));
    return { meta, tiles: inOrder(meta, tiles), results };
  }

  async addTile(args: AddTileArgs): Promise<{ tileId: string; revision: number }> {
    const input = record(args, "addTile needs { title, visual, query }.");
    const fields = tileFields(input, null);
    const { value: created, changed } = await this.#commit(input.clientId, (draft) => {
      if (draft.tiles.size >= MAX_TILES) throw new Error(`A dashboard holds at most ${MAX_TILES} tiles. Remove one before adding another.`);
      const id = newId(draft.tiles);
      const taken = Array.from(draft.tiles.values(), (tile) => tile.layout);
      const layout = fields.layout ?? firstFreeSlot(taken, defaultSize(fields.visual.type));
      draft.tiles.set(id, buildTile(id, 0, fields, layout));
      draft.meta.tileOrder.push(id);
      settle(draft, [id]);
      return id;
    });
    return { tileId: created, revision: changed.revision };
  }

  async updateTile(args: UpdateTileArgs): Promise<{ revision: number; before: Tile; after: Tile }> {
    const input = record(args, "updateTile needs { id } and the fields to change.");
    const id = tileId(input.id);
    const { value: before, changed } = await this.#commit(input.clientId, (draft) => {
      const tile = draft.tiles.get(id);
      if (!tile) throw noTile(id);
      const fields = tileFields(input, tile);
      draft.tiles.set(id, buildTile(id, tile.version, fields, fields.layout ?? tile.layout));
      if (fields.layout) settle(draft, [id]);
      return tile;
    });
    const after = changed.tiles.find((tile) => tile.id === id) ?? before;
    return { revision: changed.revision, before, after };
  }

  async removeTile(args: Sender & { id: string }): Promise<{ revision: number }> {
    const input = record(args, "removeTile needs { id }.");
    const id = tileId(input.id);
    const { changed } = await this.#commit(input.clientId, (draft) => {
      if (!draft.tiles.delete(id)) throw noTile(id);
    });
    return { revision: changed.revision };
  }

  async setLayout(args: Sender & { tiles: ({ id: string } & Layout)[] }): Promise<{ revision: number }> {
    const input = record(args, "setLayout needs { tiles: [{ id, x, y, w, h }] }.");
    if (!Array.isArray(input.tiles) || !input.tiles.length || input.tiles.length > MAX_TILES) {
      throw new Error("setLayout needs { tiles: [{ id, x, y, w, h }] } with at least one tile.");
    }
    const moves = input.tiles.map((item: unknown) => {
      const move = record(item, "Each tile in setLayout is { id, x, y, w, h }.");
      return { id: tileId(move.id), layout: layoutOf(move) };
    });
    const { changed } = await this.#commit(input.clientId, (draft) => {
      for (const move of moves) {
        const tile = draft.tiles.get(move.id);
        if (!tile) throw noTile(move.id);
        draft.tiles.set(move.id, { ...tile, layout: move.layout });
      }
      settle(draft, moves.map((move) => move.id));
    });
    return { revision: changed.revision };
  }

  async setTitle(args: Sender & { title: string }): Promise<{ revision: number }> {
    const input = record(args, "setTitle needs { title }.");
    const title = textOf(input.title, MAX_TITLE, `The dashboard title must be 1 to ${MAX_TITLE} characters.`);
    const { changed } = await this.#commit(input.clientId, (draft) => { draft.meta.title = title; });
    return { revision: changed.revision };
  }

  async setDefaultFilters(args: Sender & { filters: FilterValues }): Promise<{ revision: number }> {
    const input = record(args, "setDefaultFilters needs { filters: { dateRange, locations } }.");
    const filters = validateFilters(input.filters);
    const { changed } = await this.#commit(input.clientId, (draft) => { draft.meta.defaultFilters = filters; });
    return { revision: changed.revision };
  }

  async setFreshness(args: Sender & { minutes: number }): Promise<{ revision: number }> {
    const input = record(args, "setFreshness needs { minutes }.");
    const minutes = input.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_FRESHNESS || minutes > MAX_FRESHNESS) {
      throw new Error(`Freshness is a whole number of minutes from ${MIN_FRESHNESS} to ${MAX_FRESHNESS}.`);
    }
    const { changed } = await this.#commit(input.clientId, (draft) => { draft.meta.freshnessMinutes = minutes; });
    return { revision: changed.revision };
  }

  // Runs a query without saving it. The query is validated exactly as a saved one is, so a
  // statement that is not a single read is refused here and never reaches the dataset.
  async previewQuery(args: PreviewQueryArgs): Promise<QueryOutcome> {
    const input = record(args, "previewQuery needs { query }.");
    const query = validateSavedQuery(input.query);
    const visual: VisualSpec = input.visual === undefined ? { type: "table" } : validateVisual(input.visual);
    const chosen = input.filters === undefined ? null : validateFilters(input.filters);
    const retail = await this.#reader();
    const { meta } = await this.#state();
    const data = await this.#dataState(meta);
    if (data.status === "off") throw new Error(DATA_OFF);
    if (data.status === "empty") throw new Error(DATA_EMPTY);
    if (data.status === "error") throw new Error(data.error);
    const resolved = resolveFilters(chosen ?? meta.defaultFilters, data.anchor ?? anchorDate(isoDay(Date.now()), data.dateRange.to));
    try {
      return await runSavedQuery(retail, query, visual, resolved, { locations: data.locations });
    } catch (error) {
      throw await this.#readFailure(error);
    }
  }

  // --- Data access ---------------------------------------------------------

  // Computed on every call. A view-only share runs this code with an empty environment, so the
  // gadget's own binding being absent is what marks a read-only copy; with it present, the
  // dataset's binding being absent means the organization's data is off.
  #mode(): DataMode {
    if (!this.env.GADGET) return "snapshot";
    return this.env.RETAIL_DATA ? "live" : "off";
  }

  /** The dataset, for a call that has to read it. Refuses in a read-only copy and when data is off. */
  async #reader(): Promise<RetailReader> {
    if (this.#mode() === "snapshot") throw new Error(READ_ONLY);
    const retail = this.env.RETAIL_DATA;
    if (!retail) {
      await this.#off();
      throw new Error(DATA_OFF);
    }
    return retail;
  }

  /**
   * What a failed read is reported as. A connection that is gone is the data being off, so what
   * was cached from it goes too.
   */
  async #readFailure(error: unknown): Promise<Error> {
    if (!isConnectionGone(error)) return new Error(plainError(error));
    await this.#off(true);
    return new Error(DATA_OFF);
  }

  /**
   * The data being off: everything read from the dataset is deleted, once, and nothing is
   * returned from it. `again` deletes even if this instance already has, which is the case when
   * a read found the connection gone after results were cached through it.
   */
  async #off(again = false): Promise<DataState> {
    if (again || !this.#purged) {
      await this.#queue.run(async () => {
        const storage = this.ctx.storage;
        for (;;) {
          const keys = Array.from((await storage.list({ prefix: "r:", limit: MAX_STORAGE_KEYS })).keys());
          if (!keys.length) break;
          await storage.delete(keys);
        }
        await storage.delete("status");
      });
      this.#purged = true;
    }
    return { status: "off", mode: "off" };
  }

  /**
   * The dataset's status for this call, read again when the stored one is older than the
   * freshness setting, or when `fresh` asks for it.
   */
  async #dataState(meta: Meta, fresh = false): Promise<DataState> {
    const mode = this.#mode();
    if (mode === "off") return this.#off();
    const stored = await this.ctx.storage.get<StoredStatus>("status");
    if (mode === "snapshot") {
      if (!stored) return { status: "error", error: COPY_WITHOUT_DATA, mode };
      // A copy's presets count back from the day its data was read, which is the day its
      // results are from.
      return withMode(stored.status, mode, stored.readAt);
    }
    const now = Date.now();
    if (stored && !fresh && now - stored.readAt < meta.freshnessMinutes * 60_000) return withMode(stored.status, mode, now);
    const status = await this.#readStatus();
    // The library reports a connection that is gone as "off".
    if (status.status === "off") return this.#off(true);
    return withMode(status, mode, now);
  }

  #readStatus(): Promise<DataStatus> {
    if (this.#statusRead) return this.#statusRead;
    const reading = (async () => {
      const status = await readDataStatus(this.env.RETAIL_DATA);
      // A failed read is not kept: the next call tries again rather than waiting out the
      // freshness setting on an error.
      if (status.status === "ok" || status.status === "empty") {
        const record: StoredStatus = { status, readAt: Date.now() };
        await this.#queue.run(() => this.ctx.storage.put("status", record));
      }
      return status;
    })().finally(() => { this.#statusRead = null; });
    this.#statusRead = reading;
    return reading;
  }

  /** Runs one tile's query, joining a run of the same question that is already in flight. */
  #run(retail: RetailReader, run: TileRun, locations: { id: number; name: string }[]): Promise<QueryOutcome> {
    const question = canonical([run.tile.id, runInputs(run.tile), run.filters]);
    let running = this.#running.get(question);
    if (!running) {
      const started = Date.now();
      running = runSavedQuery(retail, run.tile.query, run.tile.visual, run.filters, { locations })
        .catch((error: unknown): QueryOutcome => {
          // The library turns a refused or failed query into an outcome itself and throws only
          // for a connection that is gone. Anything else it throws still belongs to this tile
          // alone.
          if (isConnectionGone(error)) throw error;
          return { error: plainError(error), ranAt: Date.now(), durationMs: Date.now() - started, period: { from: run.filters.from, to: run.filters.to } };
        })
        .finally(() => { this.#running.delete(question); });
      this.#running.set(question, running);
    }
    return running;
  }

  /**
   * Caches outcomes and returns the ones that are news for the default filters, by tile id. An
   * outcome is left out when its tile was removed or asks a different question by now, and when
   * a page that shared the same run has already stored it.
   */
  #store(items: (TileRun & { outcome: QueryOutcome })[]): Promise<Record<string, QueryOutcome>> {
    return this.#queue.run(async () => {
      const fresh: Record<string, QueryOutcome> = {};
      if (!items.length || this.#mode() !== "live") return fresh;
      const storage = this.ctx.storage;
      const ids = items.map((item) => item.tile.id);
      const tiles = await storage.get<Tile>(ids.map(tileKey));
      const stored = await storage.get<StoredResults>(ids.map(resultsKey));
      for (const item of items) {
        const id = item.tile.id;
        const current = tiles.get(tileKey(id));
        if (!current || runInputs(current) !== runInputs(item.tile)) continue;
        const entries = withOutcome(stored.get(resultsKey(id))?.entries ?? [], item.key, item.isDefault, item.outcome);
        if (!entries) continue;
        const next: StoredResults = { entries };
        await storage.put(resultsKey(id), next);
        stored.set(resultsKey(id), next);
        if (item.isDefault) fresh[id] = item.outcome;
      }
      return fresh;
    });
  }

  /** The stored outcomes of these tiles, by tile id. */
  async #cached(ids: string[]): Promise<Map<string, StoredResults>> {
    const cached = new Map<string, StoredResults>();
    if (!ids.length) return cached;
    const stored = await this.ctx.storage.get<StoredResults>(ids.map(resultsKey));
    for (const id of ids) {
      const results = stored.get(resultsKey(id));
      if (results) cached.set(id, results);
    }
    return cached;
  }

  // --- Structure -----------------------------------------------------------

  /** The structure as it stands once every mutation queued so far has landed. */
  #state(): Promise<State> {
    return this.#queue.run(() => this.#readState());
  }

  /** Reads the structure. Called inside the queue. */
  async #readState(): Promise<State> {
    const storage = this.ctx.storage;
    const meta = await storage.get<Meta>("meta");
    if (!meta) return this.#starterState();
    const tiles = new Map<string, Tile>();
    if (meta.tileOrder.length) {
      const stored = await storage.get<Tile>(meta.tileOrder.map(tileKey));
      for (const id of meta.tileOrder) {
        const tile = stored.get(tileKey(id));
        if (tile) tiles.set(id, tile);
      }
    }
    return { meta: { ...meta, tileOrder: meta.tileOrder.filter((id) => tiles.has(id)) }, tiles };
  }

  // The starter content, stored the first time the structure is read. A read-only copy writes
  // nothing, so one made before anything was stored keeps its starter content in memory.
  async #starterState(): Promise<State> {
    if (this.#unsaved) return this.#unsaved;
    const tiles = new Map<string, Tile>();
    for (const starter of starterTiles()) {
      const id = newId(tiles);
      tiles.set(id, { id, version: 1, ...starter });
    }
    const meta: Meta = {
      revision: 0,
      title: STARTER_TITLE,
      freshnessMinutes: STARTER_FRESHNESS_MINUTES,
      defaultFilters: starterFilters(),
      tileOrder: Array.from(tiles.keys()),
      lastModified: Date.now(),
    };
    const state: State = { meta, tiles };
    if (this.#mode() === "snapshot") {
      this.#unsaved = state;
      return state;
    }
    // Tiles first, then the meta that names them: a write cut short starts over.
    await this.ctx.storage.put(Object.fromEntries(Array.from(tiles.values(), (tile) => [tileKey(tile.id), tile])));
    await this.ctx.storage.put("meta", meta);
    return state;
  }

  /** One structure change: applied to a draft in the queue, stored, remembered for undo and broadcast. */
  #commit<T>(sender: unknown, change: (draft: State) => T): Promise<{ value: T; changed: Changed }> {
    return this.#queue.run(async () => {
      if (this.#mode() === "snapshot") throw new Error(READ_ONLY);
      const before = await this.#readState();
      const draft: State = { meta: structuredClone(before.meta), tiles: new Map(before.tiles) };
      const value = change(draft);
      const history = await this.#history();
      const changed = await this.#apply(before, draft, { past: [...history.past, snapshotOf(before)].slice(-MAX_UNDO), future: [] }, sender);
      return { value, changed };
    });
  }

  /** Undo and redo: the structure goes back to the last snapshot on one side of the history, and where it was goes on the other. */
  #travel(from: "past" | "future", to: "past" | "future", sender: unknown): Promise<Changed | null> {
    return this.#queue.run(async () => {
      if (this.#mode() === "snapshot") throw new Error(READ_ONLY);
      const history = await this.#history();
      const target = history[from].at(-1);
      if (!target) return null;
      const before = await this.#readState();
      const next: State = { meta: structuredClone(target.meta), tiles: new Map(target.tiles.map((tile) => [tile.id, tile])) };
      const moved: UndoHistory = { past: history.past, future: history.future };
      moved[from] = history[from].slice(0, -1);
      moved[to] = [...history[to], snapshotOf(before)].slice(-MAX_UNDO);
      return this.#apply(before, next, moved, sender);
    });
  }

  async #history(): Promise<UndoHistory> {
    return (await this.ctx.storage.get<UndoHistory>("undo")) ?? { past: [], future: [] };
  }

  /**
   * Stores `next` in place of `before` and tells every subscriber. Called inside the queue. A
   * tile that differs gets the next version; one that is gone, or whose question changed, loses
   * its cached results.
   */
  async #apply(before: State, next: State, history: UndoHistory, sender: unknown): Promise<Changed> {
    const storage = this.ctx.storage;
    const puts: Record<string, Tile> = {};
    const stale: string[] = [];
    for (const [id, tile] of next.tiles) {
      const old = before.tiles.get(id);
      if (old && canonical(contentOf(old)) === canonical(contentOf(tile))) {
        next.tiles.set(id, old);
        continue;
      }
      const stored: Tile = { ...tile, version: Math.max(old?.version ?? 0, tile.version) + 1 };
      next.tiles.set(id, stored);
      puts[tileKey(id)] = stored;
      if (old && runInputs(old) !== runInputs(stored)) stale.push(id);
    }
    const removed = Array.from(before.tiles.keys()).filter((id) => !next.tiles.has(id));
    const order = next.meta.tileOrder.filter((id) => next.tiles.has(id));
    const meta: Meta = {
      ...next.meta,
      tileOrder: [...order, ...Array.from(next.tiles.keys()).filter((id) => !order.includes(id))],
      revision: before.meta.revision + 1,
      lastModified: Date.now(),
    };

    if (Object.keys(puts).length) await storage.put(puts);
    await storage.put("meta", meta);
    if (removed.length) await storage.delete(removed.map(tileKey));
    if (removed.length || stale.length) await storage.delete([...removed, ...stale].map(resultsKey));
    // The outcomes cached for the old default filters stay, as outcomes for filters a viewer
    // might pick; they are no longer what the dashboard opens on.
    if (canonical(before.meta.defaultFilters) !== canonical(meta.defaultFilters)) await this.#unmarkDefaults(meta.tileOrder);
    const kept = fitHistory(history);
    await storage.put("undo", kept);

    const senderName = senderId(sender);
    const changed: Changed = {
      revision: meta.revision,
      meta,
      tiles: inOrder(meta, next.tiles),
      canUndo: kept.past.length > 0,
      canRedo: kept.future.length > 0,
      ...(senderName ? { senderId: senderName } : {}),
    };
    this.#subscribers.broadcast((subscriber) => subscriber.changed(changed));
    return changed;
  }

  async #unmarkDefaults(ids: string[]): Promise<void> {
    const storage = this.ctx.storage;
    for (const [id, results] of await this.#cached(ids)) {
      const first = results.entries[0];
      if (!first?.key.startsWith(DEFAULT_MARK)) continue;
      const key = first.key.slice(DEFAULT_MARK.length);
      const others = results.entries.slice(1).filter((entry) => entry.key !== key);
      const next: StoredResults = { entries: [{ key, outcome: first.outcome }, ...others].slice(0, MAX_OTHER_ENTRIES) };
      await storage.put(resultsKey(id), next);
    }
  }
}

// --- Results cache ----------------------------------------------------------

/** What makes two sets of resolved filters the same question to a query. */
function entryKey(filters: ResolvedFilters): string {
  return `${filters.from}..${filters.to}|${filters.locations.join(",")}`;
}

/** The default-filter outcome of each tile that has one. */
function defaultOutcomes(cached: Map<string, StoredResults>): Record<string, QueryOutcome> {
  const outcomes: Record<string, QueryOutcome> = {};
  for (const [id, results] of cached) {
    const first = results.entries[0];
    if (first?.key.startsWith(DEFAULT_MARK)) outcomes[id] = first.outcome;
  }
  return outcomes;
}

/**
 * A tile's entries with one more outcome: the default-filter outcome takes the first place, any
 * other goes right after it, and the oldest of the others beyond the cap is dropped. Null when
 * this very outcome is already there.
 */
function withOutcome(entries: StoredResults["entries"], key: string, isDefault: boolean, outcome: QueryOutcome): StoredResults["entries"] | null {
  const first = entries[0]?.key.startsWith(DEFAULT_MARK) ? entries[0] : null;
  const same = isDefault ? (first?.key === DEFAULT_MARK + key ? first : undefined) : entries.find((entry) => entry.key === key);
  if (same && same.outcome.ranAt === outcome.ranAt) return null;
  const others = entries.filter((entry) => entry !== first && entry.key !== key);
  if (isDefault) return [{ key: DEFAULT_MARK + key, outcome }, ...others.slice(0, MAX_OTHER_ENTRIES)];
  return [...(first ? [first] : []), { key, outcome }, ...others].slice(0, (first ? 1 : 0) + MAX_OTHER_ENTRIES);
}

/** The part of a tile that decides what its query returns: a change to any of it makes cached results wrong. */
function runInputs(tile: Tile): string {
  return canonical([tile.query ?? null, tile.uses, tile.visual.sort ?? null, tile.visual.limit ?? null]);
}

// --- Structure helpers -------------------------------------------------------

function hasQuery(tile: Tile): tile is Tile & { query: SavedQuery } {
  return tile.query !== undefined;
}

function inOrder(meta: Meta, tiles: Map<string, Tile>): Tile[] {
  return meta.tileOrder.flatMap((id) => {
    const tile = tiles.get(id);
    return tile ? [tile] : [];
  });
}

function snapshotOf(state: State): Snapshot {
  return { meta: state.meta, tiles: inOrder(state.meta, state.tiles) };
}

/** A tile without its version, for telling whether anything a person can see or change differs. */
function contentOf(tile: Tile): Omit<Tile, "version"> {
  const { version: _version, ...content } = tile;
  return content;
}

/** JSON with every object's keys in order, so two values that hold the same thing read the same. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** Settles the draft's layouts: the named tiles keep their place and whatever they cover moves down. */
function settle(draft: State, moved: string[]): void {
  const placed = Array.from(draft.tiles.values(), (tile) => ({ id: tile.id, layout: tile.layout }));
  for (const { id, layout } of settleLayout(placed, moved)) {
    const tile = draft.tiles.get(id);
    if (tile && canonical(tile.layout) !== canonical(layout)) draft.tiles.set(id, { ...tile, layout });
  }
}

/**
 * The history trimmed to what one stored value holds: the oldest undo steps go first, then the
 * furthest redo steps.
 */
function fitHistory(history: UndoHistory): UndoHistory {
  const past = [...history.past], future = [...history.future];
  const size = (snapshot: Snapshot) => JSON.stringify(snapshot).length;
  let total = [...past, ...future].reduce((sum, snapshot) => sum + size(snapshot), 0);
  while (total > MAX_UNDO_CHARS) {
    const dropped = past.length ? past.shift() : future.shift();
    if (!dropped) break;
    total -= size(dropped);
  }
  return { past, future };
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A tile id: 8 lowercase alphanumerics, not one already taken. */
function newId(taken: ReadonlyMap<string, unknown>): string {
  for (;;) {
    // 252 is the largest multiple of 36 a byte can hold, so every character is equally likely.
    const bytes = Array.from(crypto.getRandomValues(new Uint8Array(16))).filter((byte) => byte < 252).slice(0, 8);
    const id = bytes.map((byte) => ID_CHARS[byte % 36]).join("");
    if (id.length === 8 && !taken.has(id)) return id;
  }
}

function resolveFilters(filters: FilterValues, anchor: string): ResolvedFilters {
  const locations = Array.from(new Set(filters.locations)).sort((a, b) => a - b);
  return { ...resolveRange(filters.dateRange, anchor), locations };
}

/** The status with the access mode and, when the dataset has dates, the day presets count back from. */
function withMode(status: DataStatus, mode: DataMode, at: number): DataState {
  if (status.status !== "ok") return { ...status, mode };
  return { ...status, mode, anchor: anchorDate(isoDay(at), status.dateRange.to) };
}

/** Runs `work` over `items` with at most `limit` in flight, keeping their order. */
async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- Input checks ------------------------------------------------------------
// Arguments come from the page and from code the agent writes, so each is read as unknown.

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function textOf(value: unknown, max: number, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  const text = value.trim();
  if (!text || text.length > max) throw new Error(message);
  return text;
}

const TILE_ID = /^[a-z0-9]{8}$/;
function tileId(value: unknown): string {
  if (typeof value !== "string" || !TILE_ID.test(value)) throw new Error("A tile id is the 8-character id that getDashboard lists for the tile.");
  return value;
}

function noTile(id: string): Error {
  return new Error(`There is no tile with the id ${id}. Call getDashboard for the current tiles.`);
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new Error("ids is a list of tile ids.");
  return value as string[];
}

function senderId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined;
}

function layoutOf(value: unknown): Layout {
  const input = record(value, "A layout is { x, y, w, h } in grid units.");
  const { x, y, w, h } = input;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number" || ![x, y, w, h].every(Number.isFinite)) {
    throw new Error("A layout is { x, y, w, h }, each a number of grid units.");
  }
  return clampLayout({ x, y, w, h });
}

/** A tile's fields as given, or as they stand when updating and not given, checked together. */
interface TileFields {
  title: string;
  visual: VisualSpec;
  query?: SavedQuery;
  uses: FilterName[];
  layout?: Layout;
}

function tileFields(input: Record<string, unknown>, existing: Tile | null): TileFields {
  const tileTitleMessage = `A tile title must be 1 to ${MAX_TILE_TITLE} characters.`;
  const title = input.title === undefined && existing ? existing.title : textOf(input.title, MAX_TILE_TITLE, tileTitleMessage);
  const visual = input.visual === undefined && existing ? existing.visual : validateVisual(input.visual);
  let query: SavedQuery | undefined;
  if (visual.type === "text") {
    if (input.query !== undefined && input.query !== null) throw new Error("A text tile has no query. Leave the query out, or choose another visual type.");
  } else {
    query = input.query === undefined ? existing?.query : validateSavedQuery(input.query);
    if (!query) throw new Error(`A ${visual.type} tile needs a query.`);
  }
  const saved = query;
  const reacts = saved ? FILTER_NAMES.filter((name) => usesFilter(saved, name)) : [];
  let uses: FilterName[];
  if (input.uses !== undefined) {
    if (!Array.isArray(input.uses)) throw new Error('uses is a list of filter names: "dateRange", "locations".');
    const named: unknown[] = input.uses;
    for (const name of named) {
      if (name !== "dateRange" && name !== "locations") throw new Error('uses is a list of filter names: "dateRange", "locations".');
      if (!reacts.includes(name)) throw new Error(`This tile's query cannot react to the ${name} filter, so the tile cannot use it.`);
    }
    uses = FILTER_NAMES.filter((name) => named.includes(name));
  } else if (existing && input.query === undefined && input.visual === undefined) {
    uses = existing.uses;
  } else if (existing && input.query === undefined) {
    // The visual changed and the query did not: the tile keeps the filters it used, less any a
    // text tile no longer has a query for.
    uses = existing.uses.filter((name) => reacts.includes(name));
  } else {
    uses = reacts;
  }
  return { title, visual, ...(query ? { query } : {}), uses, ...(input.layout === undefined ? {} : { layout: layoutOf(input.layout) }) };
}

function buildTile(id: string, version: number, fields: TileFields, layout: Layout): Tile {
  return { id, version, title: fields.title, visual: fields.visual, ...(fields.query ? { query: fields.query } : {}), uses: fields.uses, layout };
}

// --- Export -----------------------------------------------------------------

/** An export format as the Workshop lists it. */
interface ExportFormat {
  id: string;
  label: string;
  mode: "server" | "browser";
  contentType: string;
  fileExtension: string;
}

/**
 * Releases an RPC result. Over Workers RPC a result holds its call open until it is disposed; a
 * direct call (the tests) returns a plain object with no disposer.
 */
function disposeResult(result: unknown): void {
  if (result && typeof result === "object") (result as Partial<Disposable>)[Symbol.dispose]?.();
}

export class ExportHandler extends WorkerEntrypoint {
  // PDF is the page itself in its print layout. CSV is written here, from the results the
  // dashboard has cached for its default filters: an export reads nothing from the dataset.
  async getExportFormats(): Promise<ExportFormat[]> {
    return [
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
      { id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv" },
    ];
  }

  async export(gadget: ExportGadgetStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "csv") throw new Error("Unsupported dashboard export format: " + id);
    const dashboard = await gadget.getDashboard();
    disposeResult(dashboard);
    const lines = csvLines(dashboard);
    const encoder = new TextEncoder();
    // One section per read, so a dashboard of large tables is never held as one string.
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = lines.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
    });
  }
}

// One section per tile with a query: a line with its title and period, a header line, then its
// rows as the tile shows them (money with its currency, dates written out). A blank line parts
// the sections. Text that a spreadsheet would read as a formula (a leading =, +, -, @, tab or
// CR) gets a leading ', so opening the file runs nothing; numbers such as -5 are left alone. The
// file starts with a byte order mark, which Excel needs to read UTF-8.
function* csvLines({ tiles, results }: DashboardContent): Generator<string> {
  yield "\ufeff";
  for (const tile of tiles) {
    if (!tile.query) continue;
    const outcome = results[tile.id];
    const lines = [csvLine([text(tile.title), text(outcome ? describeRange(outcome.period) : "")])];
    if (!outcome) {
      lines.push(csvLine([text("No result yet. Open the dashboard to run this tile.")]));
    } else if ("error" in outcome) {
      lines.push(csvLine([text(outcome.error)]));
    } else {
      const columns = outcome.columns;
      const shown = (row: Scalar[]) => csvLine(row.map((value, index) => {
        const display = formatValue(value, columns[index], row, columns);
        return typeof value === "string" ? text(display) : display;
      }));
      lines.push(csvLine(columns.map((column) => text(columnHeading(column)))));
      for (const row of outcome.rows) lines.push(shown(row));
      if (outcome.truncated) lines.push(csvLine([text(`Showing the first ${outcome.rows.length} rows`)]));
      if (outcome.previous) {
        lines.push(csvLine([text("Previous period"), text(describeRange(outcome.previous))]));
        for (const row of outcome.previous.rows) lines.push(shown(row));
      }
    }
    yield lines.join("") + "\r\n";
  }
}

/** Text as a CSV field may safely hold it: marked as text when a spreadsheet would run it. */
function text(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

function csvLine(fields: string[]): string {
  return fields.map((field) => (/[",\r\n]/.test(field) ? '"' + field.replace(/"/g, '""') + '"' : field)).join(",") + "\r\n";
}
