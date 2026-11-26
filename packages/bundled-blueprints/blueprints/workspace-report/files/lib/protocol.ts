// What the Report's client and server share: the stored report, its editions, and the RPC surface
// between the page and the Durable Object. The saved-query, visual and result types are the `data`
// library's; they are imported type-only, so nothing of the library's server side reaches the page.
import type {
  DataStatus,
  DateRangeFilter,
  QueryOutcome,
  RetailDatasetDescription,
  SavedQuery,
  VisualSpec,
} from "@gadgets/bundled-blueprints/libraries/data/server";

/** The limits the server enforces and the page explains. */
export const LIMITS = {
  sections: 60,
  editions: 24,
  title: 200,
  heading: 200,
  text: 20_000,
  blockTitle: 120,
  letterheadName: 120,
  /** The longest logo data URL, in characters (200 KB). */
  logo: 200 * 1024,
  undo: 50,
  runs: 50,
} as const;

export type HeadingLevel = 1 | 2 | 3;

/** How wide a data block draws: beside neighbouring data blocks of width "third" or "half". */
export type SectionWidth = "full" | "half" | "third";

export type HeadingSection = { id: string; version: number; kind: "heading"; level: HeadingLevel; text: string };

export type TextSection = {
  id: string;
  version: number;
  kind: "text";
  /** Markdown-lite, at most 20,000 characters. */
  text: string;
  /** The edition this text was last written or confirmed against. */
  reviewedEdition: string | null;
};

export type DataSection = {
  id: string;
  version: number;
  kind: "data";
  title: string;
  visual: VisualSpec;
  query: SavedQuery;
  width: SectionWidth;
};

export type Section = HeadingSection | TextSection | DataSection;

/** A section as `addSection` takes it: no id or version, and whatever is left out takes its default. */
export type SectionInput =
  | { kind: "heading"; level?: HeadingLevel; text: string }
  | { kind: "text"; text: string }
  | { kind: "data"; title: string; visual: VisualSpec; query: SavedQuery; width?: SectionWidth };

/** What `updateSection` takes: the section's id and the fields to change (those of its kind). */
export type SectionPatch = {
  id: string;
  kind?: Section["kind"];
  level?: HeadingLevel;
  text?: string;
  title?: string;
  visual?: VisualSpec;
  query?: SavedQuery;
  width?: SectionWidth;
  clientId?: string;
};

/** The report's own branding, printed at the top of every edition. */
export type Letterhead = {
  name?: string;
  /** A `data:image/png`, `data:image/jpeg` or `data:image/svg+xml` URL in base64, at most 200 KB. */
  logo?: string;
  /** `#rrggbb`. */
  accent?: string;
};

export type EditionAuthor = "member" | "agent" | "schedule";

export type EditionSummary = {
  id: string;
  /** When the edition was generated, epoch milliseconds. */
  asOf: number;
  period: { from: string; to: string };
  pinned: boolean;
  createdBy: EditionAuthor;
};

/** A section as an edition keeps it; a data section carries what its query returned. */
export type EditionBlock = Section & { outcome?: QueryOutcome };

export type Edition = EditionSummary & {
  title: string;
  letterhead: Letterhead;
  completeThrough: string | null;
  /** Every section as it was, in order; data sections carry their outcome. */
  blocks: EditionBlock[];
  /** Fingerprint of each data block's rows, by section id, for comparing editions. */
  fingerprints: Record<string, string>;
};

export type Meta = {
  revision: number;
  title: string;
  period: DateRangeFilter;
  /** Location ids; empty means every location. */
  locations: number[];
  letterhead: Letterhead;
  sectionOrder: string[];
  /** Newest first. */
  editions: EditionSummary[];
  lastModified: number;
};

export type DataMode = "live" | "off" | "snapshot";

/** The dataset's state as the page shows it, with how this copy of the report reaches it. */
export type DataState = DataStatus & {
  mode: DataMode;
  /** The date a preset period counts back from; present when the dataset has orders. */
  anchor?: string;
};

export type Opened = {
  meta: Meta;
  sections: Section[];
  data: DataState;
  /** The latest edition, or the one asked for; null when none exists or data is off. */
  edition: Edition | null;
  /** Section ids whose text should be reviewed against the latest edition. */
  review: string[];
  /** Data section ids added or changed since the latest edition. */
  stale: string[];
  canUndo: boolean;
  canRedo: boolean;
};

export type Changed = {
  revision: number;
  meta: Meta;
  sections: Section[];
  review: string[];
  stale: string[];
  canUndo: boolean;
  canRedo: boolean;
  /** The `clientId` the change was made with, when its caller gave one. */
  senderId?: string;
};

export type Generated = { edition: EditionSummary; review: string[] };

/** The callbacks a subscribing page exposes on its `RpcTarget`, as the server calls them. */
export interface SubscriberCallbacks {
  changed(event: Changed): unknown;
  generated(event: Generated): unknown;
}

export type ReportView = {
  meta: Meta;
  sections: Section[];
  latestEdition: EditionSummary | null;
  review: string[];
  stale: string[];
};

export type DataDescription = {
  data: DataStatus;
  tables: RetailDatasetDescription["tables"];
  metrics: RetailDatasetDescription["metrics"];
  limits: RetailDatasetDescription["limits"];
};

export type GenerateResult = {
  edition: EditionSummary;
  review: string[];
  /** Ids of the data sections whose query failed; each is stored with its failure. */
  failed: string[];
};

export type Revised = { revision: number };

/** What a mutation may say about its caller, so the caller's own page can tell its echo apart. */
export type Sender = { clientId?: string };

/**
 * The page's view of the Durable Object's RPC surface: every method it calls on the `gadget` stub
 * (over RPC every call resolves to a promise).
 */
export interface GadgetStub {
  subscribe(callback: SubscriberCallbacks, client?: Sender): Promise<Opened>;
  open(args?: { editionId?: string }): Promise<Opened>;
  getEdition(args: { id: string }): Promise<Edition>;
  undo(args?: Sender): Promise<Changed | null>;
  redo(args?: Sender): Promise<Changed | null>;
  addSection(args: { section: SectionInput; after?: string | null } & Sender): Promise<{ sectionId: string; revision: number }>;
  updateSection(args: SectionPatch): Promise<{ revision: number; before: Section; after: Section }>;
  removeSection(args: { id: string } & Sender): Promise<Revised>;
  moveSection(args: { id: string; after: string | null } & Sender): Promise<Revised>;
  setTitle(args: { title: string } & Sender): Promise<Revised>;
  setPeriod(args: { period: DateRangeFilter; locations?: number[] } & Sender): Promise<Revised>;
  setLetterhead(args: { letterhead: Letterhead } & Sender): Promise<Revised>;
  markReviewed(args: { ids: string[] } & Sender): Promise<Revised>;
  generate(args?: { createdBy?: EditionAuthor }): Promise<GenerateResult>;
  pinEdition(args: { id: string; pinned: boolean } & Sender): Promise<Revised>;
  deleteEdition(args: { id: string } & Sender): Promise<Revised>;
}

/** What the export handler calls on the gadget's Durable Object. */
export interface ExportGadgetStub {
  getReport(): Promise<ReportView>;
  readEdition(args?: { id?: string }): Promise<Edition>;
}

/** What `[restore]()` accepts: a scheduled regeneration, optionally only in the month's first week. */
export type RestoreParams = { type: "regenerate"; monthly?: "first" };

/**
 * A scheduled occurrence as the Scheduled Tasks binding delivers it (copied from
 * `packages/gatekeeper-scheduler/src/types.d.ts`, which a blueprint cannot import).
 */
export interface ScheduledFiring {
  /** Stable registration ID. */
  scheduleId: string;
  /** Stable ID reused by retries of this logical occurrence. */
  runId: string;
  /** Planned occurrence time as Unix epoch milliseconds. */
  scheduledTime: number;
  /** Delivery-attempt time as Unix epoch milliseconds; may be later than `scheduledTime`. */
  actualTime: number;
  /** Schedule timezone, or `UTC` for elapsed intervals and numeric one-shots. */
  timeZone: string;
}

/** The hook a schedule calls (the same source as {@link ScheduledFiring}). */
export interface ScheduledTaskHook {
  onSchedule(firing: ScheduledFiring): Promise<void>;
}

/** A schedule run already handled, and the edition it produced. */
export type HandledRun = { runId: string; editionId: string };
