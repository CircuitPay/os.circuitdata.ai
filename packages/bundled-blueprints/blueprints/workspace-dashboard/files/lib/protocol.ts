// What the Dashboard's server and its page share: the stored shapes, the RPC surface and the
// events a subscriber hears. Type-only, so nothing of this file ships; both sides import it with
// `import type`. The data shapes (queries, visuals, filters, outcomes) are the `data` library's.
import type {
  DataStatus,
  FilterName,
  FilterValues,
  QueryOutcome,
  ResolvedFilters,
  RetailDatasetDescription,
  SavedQuery,
  VisualSpec,
} from "@gadgets/bundled-blueprints/libraries/data/server";

/** Where a tile sits on the 12-column grid, in grid units. */
export type Layout = { x: number; y: number; w: number; h: number };

/** One tile: a visual drawn from a saved query, or a block of text. Stored at `t:<id>`. */
export type Tile = {
  /** 8 lowercase alphanumerics. */
  id: string;
  /** Goes up by one each time the tile is changed. */
  version: number;
  /** 1 to 120 characters. */
  title: string;
  visual: VisualSpec;
  /** Absent for a text tile. */
  query?: SavedQuery;
  /** Which shared filters reach the query. A filter left out takes the dashboard's default value. */
  uses: FilterName[];
  layout: Layout;
};

/** The dashboard itself. Stored at `meta`. */
export type Meta = {
  /** Goes up by one with every structure change. */
  revision: number;
  title: string;
  /** How old a cached result may be before it is run again, 1 to 1440. */
  freshnessMinutes: number;
  /** The filters a viewer starts on, and the ones results are cached and broadcast for. */
  defaultFilters: FilterValues;
  tileOrder: string[];
  lastModified: number;
};

/** The structure at one moment, as undo keeps it. Results are never part of it. */
export type Snapshot = { meta: Meta; tiles: Tile[] };

/** Stored at `undo`. */
export type UndoHistory = { past: Snapshot[]; future: Snapshot[] };

/**
 * A tile's cached outcomes. Stored at `r:<tileId>`. The outcome for the default filters comes
 * first, its key marked as such, followed by the most recent outcomes for other filter values.
 */
export type StoredResults = { entries: { key: string; outcome: QueryOutcome }[] };

/** The last data status read and when. Stored at `status`. */
export type StoredStatus = { status: DataStatus; readAt: number };

/**
 * How this gadget reaches the dataset right now: `live` reads it, `off` has no connection to it,
 * and `snapshot` is a read-only copy that serves what was stored and reads nothing.
 */
export type DataMode = "live" | "off" | "snapshot";

/** The dataset's status with the access mode and, when known, the date presets count back from. */
export type DataState = DataStatus & { mode: DataMode; anchor?: string };

/** What opening the dashboard returns. */
export type Opened = {
  meta: Meta;
  tiles: Tile[];
  data: DataState;
  /** Cached outcomes for the default filters, by tile id. */
  results: Record<string, QueryOutcome>;
  /** The default filters resolved against today's anchor. Absent while the dataset has no dates. */
  resolved?: ResolvedFilters;
  canUndo: boolean;
  canRedo: boolean;
};

/** What `runTiles` returns: the filters as they were bound, and each named tile's outcome. */
export type RunResult = { resolved: ResolvedFilters; results: Record<string, QueryOutcome>; data: DataState };

/** A structure change, as every subscriber hears it. */
export type Changed = {
  revision: number;
  meta: Meta;
  tiles: Tile[];
  canUndo: boolean;
  canRedo: boolean;
  /** The page that made the change, when it said who it was. */
  senderId?: string;
};

/** Fresh outcomes for the default filters. Outcomes for a viewer's own filters are never broadcast. */
export type ResultsEvent = { results: Record<string, QueryOutcome>; resolved: ResolvedFilters };

/** The callbacks the page hands to `subscribe`. */
export interface SubscriberCallbacks {
  changed(event: Changed): unknown;
  results(event: ResultsEvent): unknown;
}

/** A page naming itself, so its own changes come back marked as its own. */
export type Sender = { clientId?: string };

export type AddTileArgs = Sender & { title: string; visual: VisualSpec; query?: SavedQuery; uses?: FilterName[]; layout?: Layout };
export type UpdateTileArgs = Sender & { id: string; title?: string; visual?: VisualSpec; query?: SavedQuery; uses?: FilterName[]; layout?: Layout };
export type RunTilesArgs = { ids?: string[]; filters?: FilterValues; force?: boolean };
export type PreviewQueryArgs = { query: SavedQuery; visual?: VisualSpec; filters?: FilterValues };

/** What `describeData` returns: the dataset as a query writer needs it. */
export type DataDescription = {
  data: DataState;
  tables: RetailDatasetDescription["tables"];
  metrics: RetailDatasetDescription["metrics"];
  limits: RetailDatasetDescription["limits"];
};

/** What `getDashboard` returns. */
export type DashboardContent = { meta: Meta; tiles: Tile[]; results: Record<string, QueryOutcome> };

/** The gadget's RPC surface as the page and the agent call it. */
export interface GadgetStub {
  subscribe(callback: SubscriberCallbacks, client?: Sender): Promise<Opened>;
  open(): Promise<Opened>;
  runTiles(args?: RunTilesArgs): Promise<RunResult>;
  undo(sender?: Sender): Promise<Changed | null>;
  redo(sender?: Sender): Promise<Changed | null>;
  describeData(): Promise<DataDescription>;
  getDashboard(): Promise<DashboardContent>;
  addTile(args: AddTileArgs): Promise<{ tileId: string; revision: number }>;
  updateTile(args: UpdateTileArgs): Promise<{ revision: number; before: Tile; after: Tile }>;
  removeTile(args: Sender & { id: string }): Promise<{ revision: number }>;
  setLayout(args: Sender & { tiles: ({ id: string } & Layout)[] }): Promise<{ revision: number }>;
  setTitle(args: Sender & { title: string }): Promise<{ revision: number }>;
  setDefaultFilters(args: Sender & { filters: FilterValues }): Promise<{ revision: number }>;
  setFreshness(args: Sender & { minutes: number }): Promise<{ revision: number }>;
  previewQuery(args: PreviewQueryArgs): Promise<QueryOutcome>;
}

/** The part of the gadget a server-mode export reads. */
export type ExportGadgetStub = Pick<GadgetStub, "getDashboard">;
