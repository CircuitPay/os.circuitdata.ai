// Types shared by the Data area capability (`RetailAppApi`) and the app in `app/`. Plain data only,
// so the browser build can import them.

/** A source's kind (contracts/retail-binding.md `RetailCoverage`). */
export type SourceKind = "square" | "stripe" | "toast" | "csv";

/** A source's status (data-model §7). */
export type SourceStatus =
  | "connecting" | "backfilling" | "active" | "syncing" | "retrying" | "needs_reconnect"
  | "disconnected" | "imported";

/** A source of data as the Data area lists it. */
export type SourceSummary = {
  id: number;
  kind: SourceKind;
  label: string;
  status: SourceStatus;
  /** ISO 8601 UTC, or null before the first successful run. */
  lastSuccessAt: string | null;
  /** First and last business dates with orders from this source. */
  coverageFrom: string | null;
  coverageTo: string | null;
};

/** Storage use against the platform cap and the raw quota (FR-020). */
export type StorageStatus = {
  usedBytes: number;
  capBytes: number;
  rawUsedBytes: number;
  rawQuotaBytes: number;
  /** True at or above 70% of the cap. */
  warn: boolean;
};

/** The dataset's state for the Data area overview. */
export type DatasetOverview = {
  sources: SourceSummary[];
  storage: StorageStatus;
  settings: { piiUnmasked: boolean; backfillYears: number };
  /** Sources whose failure an administrator must act on (reconnect). */
  failuresNeedingAdmin: { sourceId: number; label: string; code: string; message: string | null }[];
};

/** The overview plus the signed-in member's current rights. */
export type RetailOverview = DatasetOverview & {
  /** Whether the member may perform administrator actions right now. */
  canManage: boolean;
  /** Providers this deployment can connect (their app credentials are configured). */
  connectableProviders: ProviderKind[];
};

// --- Runs, imports, templates, coverage and lineage (US2, US4, US5) ---

/** Run kinds (data-model §4). */
export type RunKind = "backfill" | "sync" | "import" | "rebuild" | "undo";

/**
 * A run's state. An import run is `staged` while its files wait for a mapping, `expired` when it
 * was abandoned, and `undone` once an undo restored its pre-images.
 */
export type RunStatus =
  | "staged" | "running" | "succeeded" | "failed" | "cancelled" | "undone" | "expired";

/** Per-table outcome counts. */
export type RunTableCounts = {
  fetched: number;
  written: number;
  updated: number;
  skipped: number;
  rejected: number;
  /** Rebuild runs: rows an earlier version produced that the rebuild no longer does, deleted. */
  deleted?: number;
};

/** Where a running run is. */
export type RunProgress = {
  phase: string;
  done: number;
  total: number;
  etaSeconds: number | null;
};

/** One run as the Data area lists it, with its report and undo eligibility. */
export type RunSummary = {
  id: number;
  sourceId: number;
  sourceLabel: string;
  kind: RunKind;
  status: RunStatus;
  templateVersionId: number | null;
  mappingVersion: string;
  /** Member id of whoever started it; null for scheduled runs. */
  startedBy: string | null;
  /** ISO 8601 UTC. */
  startedAt: string;
  finishedAt: string | null;
  counts: Partial<Record<string, RunTableCounts>>;
  progress: RunProgress | null;
  warnings: {
    /** Rows without an id that were keyed by a fingerprint of their fields (US2.5). */
    fingerprintRows: number;
    /** Orders whose total disagrees with their parts. */
    totalMismatch: number;
    /** Quantities rounded to 4 decimals. */
    quantityRounded: number;
  };
  /** Why the run failed, when it did. Never row values. */
  error: string | null;
  /** The run this one undid (undo runs), or the undo run that undid this one. */
  undoOf: number | null;
  undoneBy: number | null;
  /** Import runs: whether this member may undo it now, and why not otherwise. */
  undo: { possible: boolean; reason: string | null };
  /** Import runs: the files read. */
  files: { name: string; role: string | null; bytes: number }[];
};

/** A rejected row (FR-011). `detail` never holds a value from a personal column. */
export type RunRejection = {
  id: number;
  table: string;
  file: string | null;
  /** 1-based row in the file. */
  row: number | null;
  reason: string;
  column: string | null;
  detail: string | null;
};

/** A page of results; pass `nextAfter` as `after` for the next page. */
export type Page<T> = { items: T[]; nextAfter: number | null };

/** A column reference: a header of the single file, or `{ file: role, column }` in a file set. */
export type ColumnRef = string | { file: string; column: string };

/** How a cell becomes a value (contracts/mapping-document.md). */
export type MappingTransform =
  | "date" | "datetime" | "time" | "money" | "negate_money" | "quantity" | "percent"
  | "lowercase" | "uppercase" | "trim" | "boolean" | "split_name_first" | "split_name_last";

/** One mapped target field. */
export type MappingTarget = {
  /** `<table>.<column>`, e.g. "orders.total_amount"; see `TargetInfo`. */
  target: string;
  from: ColumnRef | null;
  constant?: string | number | boolean;
  transform?: MappingTransform;
  /** Enum targets only: source value → canonical value. */
  valueMap?: Record<string, string>;
};

/** The mapping document (contracts/mapping-document.md): data, never code. */
export type MappingDocument = {
  version: 1;
  /** Each field overrides the sniffed value. */
  parsing?: {
    encoding?: string;
    delimiter?: "," | ";" | "\t" | "|";
    /** 1-based. */
    headerRow?: number;
    footerRows?: number;
  };
  settings: {
    /** IANA zone of the location when the file has no location column. */
    timezone: string;
    /** ISO 4217, used when no currency column is mapped. */
    currency: string;
    /** e.g. "MM/dd/yyyy HH:mm:ss", "yyyy-MM-dd". */
    dateFormat: string;
    decimalMark: "." | ",";
    negativeStyle?: "minus" | "parentheses";
    businessDate?: "from_column" | "from_timestamp" | "from_file_date";
    /** The export set's business date for `from_file_date` (Toast), "YYYY-MM-DD". */
    fileDate?: string;
  };
  /** Multi-file sets (Toast). Absent for a single file. Files are read in this order. */
  files?: {
    role: string;
    required: boolean;
    /** Recognised by these headers (all must be present). */
    headerSignature: string[];
    /** Overrides `settings.dateFormat` for this file. */
    dateFormat?: string;
  }[];
  /** Rows sharing this key form one order. Null: each row is one order, keyed by `fingerprint`. */
  orderKey: ColumnRef | null;
  /** Target paths whose values identify a row that has no id (US2.5). */
  fingerprint?: string[];
  /** Continuation rows (Shopify): blank order fields are filled from the order's first row. */
  fillOrderFieldsDown?: boolean;
  /** Rows whose `column` holds one of `values` are returns of the order's items, not sales. */
  refundWhen?: { column: ColumnRef; values: string[] };
  targets: MappingTarget[];
  /** Joins between files of a set, e.g. items."Order Id" = orders."Order Id". */
  joins?: { from: ColumnRef; to: ColumnRef }[];
};

/** A target field a mapping may name. */
export type TargetInfo = {
  path: string;
  label: string;
  kind: "text" | "money" | "datetime" | "date" | "time" | "quantity" | "boolean" | "integer" | "enum";
  /** Canonical values of enum targets. */
  values?: string[];
  /** Personal data: masked in samples shown to the agent. */
  personal?: boolean;
  description: string;
};

/** Sniffed parsing settings of one staged file; each can be overridden in the mapping. */
export type SniffResult = {
  encoding: string;
  delimiter: "," | ";" | "\t" | "|";
  /** 1-based. */
  headerRow: number;
  footerRows: number;
};

/** One staged file. */
export type StagedImportFile = {
  rawObjectId: number;
  name: string;
  bytes: number;
  /** The role in a file set (Toast), when a template recognised it. */
  role: string | null;
  sniff: SniffResult;
  headers: string[];
  /** Up to 20 rows after the header, unmasked (members may see their own file). */
  sampleRows: (string | null)[][];
};

/** A saved or built-in template whose header signature the staged files match. */
export type TemplateMatch = {
  templateId: number;
  versionId: number;
  name: string;
  origin: "builtin" | "user";
  lastUsedAt: string | null;
};

/** Staged import status. */
export type StagedImportStatus = "staged" | "importing" | "imported" | "cancelled" | "failed" | "undone" | "expired";

/** A staged CSV import (contracts/data-area-api.md `getImport`). */
export type StagedImport = {
  id: number;
  sourceId: number;
  sourceLabel: string;
  status: StagedImportStatus;
  createdBy: string | null;
  expiresAt: string;
  runId: number;
  files: StagedImportFile[];
  templateMatches: TemplateMatch[];
  /** The template or header-alias mapping, if any. */
  deterministicMapping: MappingDocument | null;
  /** The agent's applied suggestion, if any. */
  agentMapping: MappingDocument | null;
  /** Required files of the matched set that were not uploaded (US2.8). */
  missingRequiredFiles: string[];
  /** Every target a mapping may name. */
  targets: TargetInfo[];
};

/** A staged import in a list. */
export type ImportListEntry = {
  id: number;
  sourceId: number;
  sourceLabel: string;
  status: StagedImportStatus;
  fileNames: string[];
  runId: number;
  createdBy: string | null;
  expiresAt: string;
  hasAgentMapping: boolean;
};

/** Where uploaded files go: an existing CSV source, or a new one. */
export type ImportTarget = number | { newSourceLabel: string };

/** A preview of a mapping over the staged files. Nothing is written. */
export type ImportPreview = {
  /** Data rows read. */
  rowsRead: number;
  /** True when only the first `ImportPreview` row limit was read. */
  truncated: boolean;
  rowLimit: number;
  /** Canonical rows per table. */
  counts: Partial<Record<string, RunTableCounts>>;
  /** The first 50 rows per table, as the public views show them. */
  samples: { table: string; columns: string[]; rows: (string | number | null)[][] }[];
  /** Row problems by reason, with examples. */
  problems: {
    reason: string;
    count: number;
    examples: { table: string; file: string | null; row: number | null; column: string | null; detail: string | null }[];
  }[];
  warnings: { fingerprintRows: number; totalMismatch: number; quantityRounded: number };
  /** Totals per business date and currency, to compare with the POS report (US2.3). */
  dailyTotals: {
    businessDate: string;
    currency: string;
    orders: number;
    gross: number;
    discounts: number;
    refunds: number;
    net: number;
    tax: number;
    tips: number;
  }[];
};

/** A template in a list. */
export type TemplateSummary = {
  id: number;
  name: string;
  origin: "builtin" | "user";
  builtinKey: string | null;
  currentVersionId: number | null;
  currentVersion: number | null;
  /** Succeeded imports and rebuilds that used any version. */
  runs: number;
  /** True when imports used an older version than the current one: a rebuild is offered (US5.2). */
  rebuildOffered: boolean;
};

/** A template with every version. */
export type TemplateDetail = TemplateSummary & {
  versions: {
    id: number;
    version: number;
    createdBy: string | null;
    createdAt: string;
    mapping: MappingDocument;
    runs: number;
  }[];
};

/** Same shape as the binding's `RetailCoverage`. */
export type CoverageReport = {
  sources: { id: number; kind: SourceKind; label: string; status: SourceStatus; lastSuccessAt: string | null }[];
  ranges: { locationId: number; sourceId: number; from: string; to: string }[];
  possibleGaps: { locationId: number; businessDate: string }[];
};

/** Tables lineage can trace. */
export type LineageTable =
  | "locations" | "customers" | "products" | "orders" | "line_items" | "transactions"
  | "refund_items" | "inventory" | "inventory_movements" | "sources"
  | "daily_sales" | "daily_product_sales" | "customer_summary" | "daily_source_coverage";

/** Same shape as the binding's `RetailRowLineage`. */
export type RowLineage = {
  table: LineageTable;
  id: number;
  source: { id: number; kind: SourceKind; label: string };
  sourceRecordId: string;
  run: { id: number; kind: RunKind; finishedAt: string | null };
  mappingVersion: string;
  file?: { name: string; row: number };
};

// --- Browsing (spec 008, contracts/data-app-api.md) ---

/** Tables the Data area browses. */
export type BrowseTable =
  | "orders" | "line_items" | "transactions" | "products" | "customers" | "locations" | "inventory";

/** A column as the browser shows it (same types as the binding's RetailColumn). */
export type BrowseColumn = {
  name: string;
  type: "integer" | "real" | "text" | "boolean" | "json" | "timestamp" | "date" | "money";
  /** For money: the column in the same row holding the ISO 4217 code. */
  currencyColumn?: string;
  personal?: boolean;
  description?: string;
};

/** One browsable table. */
export type BrowseTableInfo = {
  name: BrowseTable;
  /** "Orders", "Line items", "Payments", ... */
  label: string;
  description: string;
  /** Exact row count, deleted rows excluded. */
  rows: number;
  /** The column date ranges filter on, or null (products, customers, locations, inventory). */
  dateColumn: "business_date" | null;
  /** Whether `search` applies, and what it searches, for the placeholder text. */
  search: { columns: string[]; label: string } | null;
  /** Columns the grid shows, in order. */
  gridColumns: BrowseColumn[];
};

export type BrowseCatalog = {
  tables: BrowseTableInfo[];
  /** Earliest and latest business date with orders, or null when there are none. */
  dateRange: { from: string; to: string } | null;
  completeThrough: string | null;
  personalDataMasked: boolean;
  /** Sources rows can be narrowed to. */
  sources: { id: number; kind: SourceKind; label: string }[];
};

export type BrowseQuery = {
  /** 0-based row offset; a multiple of 100. Default 0. */
  offset?: number;
  /** Inclusive business dates "YYYY-MM-DD"; only for tables with a dateColumn. */
  from?: string;
  to?: string;
  /** Rows last written by this run (an import's run id). */
  runId?: number;
  sourceId?: number;
  /** Substring to find in the table's search columns; 1-100 characters. */
  search?: string;
};

/** One row of a grid: its id, then the grid columns' values in order. */
export type BrowseRow = { id: number; values: (string | number | boolean | null)[] };

export type BrowsePage = {
  table: BrowseTable;
  /** The table's gridColumns. */
  columns: BrowseColumn[];
  /** Each row: `id` first, then the grid columns' values in order. */
  rows: BrowseRow[];
  offset: number;
  /** Rows matching the query (all pages). */
  total: number;
  pageSize: 100;
  /** Set when the server narrowed an unfiltered query on a large table (FR-024). */
  narrowedTo: { from: string; to: string } | null;
};

export type RowDetail = {
  table: BrowseTable;
  id: number;
  /** Every column of the public view, with its value. */
  fields: { column: BrowseColumn; value: string | number | boolean | null }[];
  related: {
    table: BrowseTable;
    /** "Line items", "Payments", "Order", "Product", ... */
    label: string;
    /** The related table's gridColumns. */
    columns: BrowseColumn[];
    rows: BrowseRow[];
    /** True when more than 50 matched. */
    truncated: boolean;
  }[];
  /** Where the row came from; null when lineage cannot be read. */
  origin: RowLineage | null;
};

/** The Data area capability, as the app sees it. */
export interface RetailAppClient extends RetailConnectionsClient {
  /** Sources, storage, settings and failures, with the member's live rights. */
  getOverview(): Promise<RetailOverview>;

  /** Runs, newest first. */
  listRuns(options?: { sourceId?: number; after?: number; limit?: number }): Promise<Page<RunSummary>>;
  getRun(id: number): Promise<RunSummary>;
  /** Rejected rows of a run, in row order. */
  listRejections(runId: number, options?: { after?: number; limit?: number }): Promise<Page<RunRejection>>;
  /** Which sources cover which dates and locations, and which days look like missing data. */
  getCoverage(options?: { from?: string; to?: string; locationIds?: number[] }): Promise<CoverageReport>;
  /** Where one row came from. */
  getLineage(table: LineageTable, id: number): Promise<RowLineage>;

  /** The browsable tables with exact row counts, the date range, and the sources to filter by. */
  getBrowseCatalog(): Promise<BrowseCatalog>;
  /** One page of a table's rows, newest first. Refuses an unknown table or an invalid query. */
  browseRows(table: BrowseTable, query?: BrowseQuery): Promise<BrowsePage>;
  /** One row with every field, its related rows and its origin. Throws "This row no longer exists." */
  getRowDetail(table: BrowseTable, id: number): Promise<RowDetail>;

  /** Staged imports that are not finished, newest first. */
  listImports(): Promise<ImportListEntry[]>;
  getImport(id: number): Promise<StagedImport>;
  /** Drops a staged import and its files. */
  discardImport(id: number): Promise<void>;
  /** The prompt the app passes to the host's `openPrompt()`. */
  askAgentPrompt(id: number): Promise<string>;
  /** Validates the mapping and previews it over the staged files; nothing is written. */
  preview(id: number, mapping: MappingDocument): Promise<ImportPreview>;
  /** Starts the background import; optionally saves the mapping as a template version. */
  startImport(
    id: number,
    mapping: MappingDocument,
    options?: { saveAsTemplate?: { name: string } | { templateId: number } },
  ): Promise<{ runId: number }>;
  /** Takes effect between batches. Members may cancel their own imports; administrators any. */
  cancelRun(runId: number): Promise<void>;
  /** Restores the import's pre-images. Members may undo their own imports; administrators any. */
  undoImport(runId: number): Promise<{ undoRunId: number }>;

  listTemplates(): Promise<TemplateSummary[]>;
  getTemplate(id: number): Promise<TemplateDetail>;
  /** Saves a new version of a user template. Built-in templates are read-only; copy them. */
  saveTemplateVersion(id: number, mapping: MappingDocument): Promise<{ versionId: number }>;
  copyTemplate(id: number, name: string): Promise<{ templateId: number }>;
  /** Deletes a user template; the data it imported stays. */
  deleteTemplate(id: number): Promise<void>;
  /** Rebuilds every source's imports of the template with one version (default: current) (US5). */
  reapplyTemplate(templateId: number, options?: { versionId?: number }): Promise<{ runIds: number[] }>;

  /** Shows `customers` unmasked to the agent and consumers, or masks it again. Administrators only. */
  setPersonalDataUnmasked(on: boolean): Promise<void>;
  /**
   * Erases every row, raw object and connection; the account stays enabled and empty.
   * Administrators only; `confirm` must be {@link ERASE_CONFIRMATION}.
   */
  eraseDataset(options: { confirm: string }): Promise<void>;

  /** Open proposals and confirmed links (US6). Administrators only. */
  listMatchProposals(options: { kind: MatchKind }): Promise<MatchProposal[]>;
  confirmMatch(id: number): Promise<void>;
  rejectMatch(id: number): Promise<void>;
  undoMatch(id: number): Promise<void>;
}

/** What an administrator types to erase the dataset. */
export const ERASE_CONFIRMATION = "erase all retail data";

// --- Matching (US6, data-model `match_links`) ---

export type MatchKind = "customer" | "product";
export type MatchBasis = "email" | "sku" | "name";

/** One proposed or confirmed cross-source link: `row` is (or would be) linked to `canonical`. */
export type MatchProposal = {
  id: number;
  kind: MatchKind;
  basis: MatchBasis;
  status: "proposed" | "confirmed";
  /** Email and SKU proposals are pre-ticked; name-only proposals never are. */
  preselected: boolean;
  decidedAt: string | null;
  /** `label` is masked unless personal data is unmasked. `source` is the source's label. */
  row: { id: number; source: string; label: string };
  canonical: { id: number; source: string; label: string };
};

// --- Connections (contracts/data-area-api.md "Connections") ---

/** A provider the Data area connects. */
export type ProviderKind = "square" | "stripe";

/** A provider location the administrator may include in a source. */
export type ProviderLocationInfo = {
  id: string;
  name: string;
  timezone: string | null;
  currency: string | null;
  /** Inactive locations may still have history worth reading. */
  active: boolean;
};

/** What the host's `openConnectPopup` takes: the provider's consent URL and the popup's nonce. */
export type ConnectFlow = { url: string; nonce: string };

/** Connection management; every method is for organization administrators only. */
export interface RetailConnectionsClient {
  /** Starts a provider connection; pass the result to the host's `openConnectPopup`. */
  beginConnect(provider: ProviderKind): Promise<ConnectFlow>;
  /**
   * Called by the Workshop's `/connect/handoff` page: commits the staged grant when the ticket and
   * nonce belong to a flow of this dataset. Returns the source.
   */
  redeemConnectHandoff(ticket: string, nonce: string): Promise<{ sourceId: number }>;
  listProviderLocations(sourceId: number): Promise<ProviderLocationInfo[]>;
  /** Sets the locations to read and starts the backfill. */
  chooseLocations(sourceId: number, locationIds: string[]): Promise<void>;
  /** How many years a backfill reads, 1–3. */
  setBackfillYears(years: number): Promise<void>;
  syncNow(sourceId: number): Promise<void>;
  /** Re-authorizes the same provider account; same flow as `beginConnect`. */
  reconnect(sourceId: number): Promise<ConnectFlow>;
  /** Stops sync and revokes the grant; with `deleteData`, deletes the source's data. */
  disconnect(sourceId: number, options: { deleteData: boolean }): Promise<void>;
}
