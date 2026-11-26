// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — a grid of tiles, each drawn from a saved query against the
// organization's retail data, with shared filters that live in this page only.
//
// Sections:
//   1. Platform                  5. Tiles
//   2. Styles                    6. Running and filters
//   3. State                     7. Edit mode
//   4. Chrome                    8. Live updates and connect
// See README.md for the API the agent uses. The element builder comes from the `ui` library, the
// subscriber from `sync`, and everything that draws a result from `data`.
// ─────────────────────────────────────────────────────────────────────────────
import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import { createSubscriber } from "@gadgets/bundled-blueprints/libraries/sync/client";
import {
  type FilterName,
  type FilterValues,
  type QueryOutcome,
  type ResolvedFilters,
  type SavedQuery,
  type VisualType,
  DATA_STYLES,
  DATE_PRESETS,
  compatibleVisuals,
  describeRange,
  formatAge,
  formatDate,
  renderMarkdownLite,
  renderTable,
  renderVisual,
  validateFilters,
} from "@gadgets/bundled-blueprints/libraries/data/client";
import { GRID_COLUMNS, moveLayout, resizeLayout, settleLayout } from "./lib/layout.ts";
import type { Changed, DataState, GadgetStub, Layout, Meta, Opened, ResultsEvent, RunTilesArgs, SubscriberCallbacks, Tile } from "./lib/protocol.ts";

// The bindings the Workshop's iframe bootstrap defines before this module runs: the RPC stub to
// this gadget's Durable Object, and Cap'n Web's RpcTarget for the callbacks it is handed.
declare const gadget: GadgetStub;
declare const RpcTarget: { new (): object };
declare global {
  // Set by the export renderer before this module loads, to the browser-mode format being made.
  var gadgetExportFormatId: string | undefined;
}

/* ═══════════════════════════════ 1. Platform ═════════════════════════════ */

// An export draws the page once, from what the dashboard has cached, for paper: no controls, no
// subscription and no reads.
const isExport = typeof globalThis.gadgetExportFormatId === "string" && globalThis.gadgetExportFormatId !== "";
const clientId = Math.random().toString(36).slice(2);
if (isExport) document.documentElement.classList.add("document-export");

/** The grid's row height and gap in px. The stylesheet and the drag arithmetic share them. */
const ROW_HEIGHT = 84;
const GAP = 12;
const CUSTOM_RANGE = "custom";
const AGE_TICK_MS = 30_000;
const LOCATION_PAUSE_MS = 350;

const DATA_OFF = "Retail data is not turned on for this organization. An administrator can turn it on under Connectors → Data.";
const DATA_EMPTY = "No sales data yet. Import a CSV or connect a source in Data, then refresh.";

const VISUAL_LABELS: Record<VisualType, string> = {
  kpi: "Single value",
  line: "Line chart",
  area: "Area chart",
  bar: "Bar chart",
  stackedBar: "Stacked bar chart",
  table: "Table",
  text: "Text",
};

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

/* ════════════════════════════════ 2. Styles ══════════════════════════════ */

// What paper gets, written once and used twice: for an export (the class on the root) and for
// the browser's own print. Controls go, tiles flow in two columns in reading order, and the
// as-of line under the title says what the numbers are.
const paperRules = (root: string) => `
${root} body { background: #fff; }
${root} .dash { padding: 0; min-height: 0; background: #fff; }
${root} .dash-controls,
${root} .dash-status,
${root} .dash-banner button,
${root} .tile-foot,
${root} .tile-tools,
${root} .tile-resize,
${root} .tile-busy,
${root} .tile-handoff,
${root} .tile-fix { display: none !important; }
${root} .dash-asof { display: block; }
${root} .dash-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: auto; }
${root} .tile { grid-column: auto !important; grid-row: auto !important; break-inside: avoid; box-shadow: none; }
${root} .tile.tile-wide { grid-column: 1 / -1 !important; }
${root} .tile-body { overflow: visible; }
`;

const STYLES = `
:root {
  color-scheme: light;
  --bg: #f5f6f8;
  --panel: #ffffff;
  --text: #16181d;
  --muted: #5d6470;
  --line: #dde1e7;
  --accent: #1d4ed8;
  --accent-ink: #ffffff;
  --danger: #b42318;
  --danger-soft: #fdeceb;
}
@media screen and (prefers-color-scheme: dark) {
  :root:not(.document-export) {
    color-scheme: dark;
    --bg: #101216;
    --panel: #1a1d23;
    --text: #eef0f4;
    --muted: #a3aab6;
    --line: #2d323b;
    --accent: #8ab0ff;
    --accent-ink: #0b1020;
    --danger: #ff8f85;
    --danger-soft: #3a1c1a;
  }
}
[hidden] { display: none !important; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.dash { min-height: 100vh; padding: 16px 20px 32px; }
.dash-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; margin-bottom: 12px; }
.dash-titles { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
.dash-title { margin: 0; font-size: 22px; font-weight: 650; line-height: 1.2; overflow-wrap: anywhere; }
.dash-title-input { font: inherit; font-size: 20px; font-weight: 650; width: min(32ch, 80vw); }
.dash-badge { padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; color: var(--muted); background: var(--panel); }
.dash-asof { display: none; flex-basis: 100%; margin: 0; font-size: 12px; color: var(--muted); }
.dash-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.dash-filters, .dash-actions, .dash-custom { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.dash-controls label { font-size: 12px; color: var(--muted); }
.dash-updated { font-size: 12px; color: var(--muted); }
.dash-status { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
.dash-status:empty { display: none; }
.dash-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--danger); border-radius: 8px; background: var(--danger-soft); color: var(--text); }
.dash-banner p { margin: 0; }
.dash-message { max-width: 60ch; margin: 48px auto; padding: 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); font-size: 15px; text-align: center; }
button, select, input, textarea {
  font: inherit;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
}
button, select, input { min-height: 30px; padding: 3px 10px; }
button { cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button:disabled, select:disabled, input:disabled { opacity: 0.55; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.dash-locations { position: relative; }
.dash-locations summary { min-height: 30px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); cursor: pointer; }
.dash-locations fieldset {
  position: absolute; z-index: 5; top: calc(100% + 4px); right: 0;
  display: flex; flex-direction: column; gap: 4px;
  min-width: 220px; max-height: 320px; overflow: auto;
  margin: 0; padding: 10px 12px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.dash-locations fieldset label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); }
.dash-locations fieldset input { min-height: 0; padding: 0; }
.dash-grid {
  display: grid;
  grid-template-columns: repeat(${GRID_COLUMNS}, minmax(0, 1fr));
  grid-auto-rows: ${ROW_HEIGHT}px;
  gap: ${GAP}px;
}
.tile {
  position: relative;
  display: flex; flex-direction: column; gap: 6px;
  min-width: 0; min-height: 0;
  padding: 12px 14px 10px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.tile[aria-busy="true"] .tile-body { opacity: 0.6; }
.tile-dragging { z-index: 4; border-color: var(--accent); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22); }
.tile-head { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.dash-editing .tile-head { cursor: grab; touch-action: none; }
.tile-title { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 600; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile-title-input { flex: 1; min-width: 0; min-height: 26px; font-size: 13px; }
.tile-busy { font-size: 12px; color: var(--muted); white-space: nowrap; }
.tile-tools { display: flex; align-items: center; gap: 6px; }
.tile-tools select, .tile-tools button { min-height: 26px; padding: 1px 6px; font-size: 12px; }
.tile-body { flex: 1; min-height: 0; overflow: auto; }
.tile-body > :first-child { margin-top: 0; }
.tile-error { margin: 0 0 8px; color: var(--danger); overflow-wrap: anywhere; }
.tile-handoff { display: flex; flex-direction: column; gap: 4px; }
.tile-handoff p { margin: 0; font-size: 12px; color: var(--muted); }
.tile-request { width: 100%; padding: 6px 8px; font-size: 12px; resize: vertical; }
.tile-notes:empty { display: none; }
.tile-foot { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); }
.tile-details { min-width: 0; }
.tile-details summary { cursor: pointer; }
.tile-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; margin: 6px 0 0; }
.tile-facts dt { font-weight: 600; }
.tile-facts dd { margin: 0; overflow-wrap: anywhere; }
.tile-sql { margin: 0; max-height: 160px; overflow: auto; white-space: pre-wrap; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tile-ask { margin: 6px 0 0; }
.tile-as-table { min-height: 24px; padding: 0 8px; font-size: 12px; white-space: nowrap; }
.tile-resize {
  position: absolute; right: 2px; bottom: 2px;
  width: 18px; height: 18px; min-height: 0; padding: 0;
  border: 0; border-right: 3px solid var(--muted); border-bottom: 3px solid var(--muted); border-radius: 0 0 6px 0;
  background: transparent; cursor: nwse-resize; touch-action: none;
}
@media screen and (max-width: 720px) {
  .dash-grid { grid-template-columns: minmax(0, 1fr); grid-auto-rows: auto; }
  .tile { grid-column: auto !important; grid-row: auto !important; min-height: ${ROW_HEIGHT * 2}px; }
}
@page { margin: 0.5in; }
${paperRules(":root.document-export")}
@media print {
${paperRules(":root")}
}
`;

document.head.appendChild(el("style", { text: DATA_STYLES + STYLES }));

/* ════════════════════════════════ 3. State ═══════════════════════════════ */

// The structure and the data status are the server's, replaced whole by each open and each
// `changed` event. The filters are this page's alone: they reach the server only as the
// `filters` argument of runTiles and are never stored there.
let meta: Meta = {
  revision: -1,
  title: "",
  freshnessMinutes: 15,
  defaultFilters: { dateRange: { preset: "last30" }, locations: [] },
  tileOrder: [],
  lastModified: 0,
};
let tiles: Tile[] = [];
let data: DataState = { status: "off", mode: "off" };
let filters: FilterValues = meta.defaultFilters;
/** The viewer's filters as the server last bound them, for the period shown on paper. */
let resolved: ResolvedFilters | undefined;
let canUndo = false, canRedo = false;
let editing = false;
/** Whether the custom range inputs are showing before a custom range has been entered. */
let customOpen = false;
/** Locations ticked a moment ago that have not been run yet (see the picker's pause). */
let tickedLocations: number[] | null = null;
/** Each tile's outcome for this page's filters. */
const outcomes = new Map<string, QueryOutcome>();
/** How many runs each tile is waiting on. */
const busy = new Map<string, number>();
/** Tiles whose result is shown as a table instead of its picture. */
const asTable = new Set<string>();

const tileById = (id: string) => tiles.find((tile) => tile.id === id);

function sameFilters(a: FilterValues, b: FilterValues): boolean {
  const key = (value: FilterValues) => JSON.stringify([value.dateRange, [...value.locations].sort((x, y) => x - y)]);
  return key(a) === key(b);
}

/** The part of a tile that decides what its query returns. */
function runInputs(tile: Tile): string {
  return JSON.stringify([tile.query ?? null, tile.uses, tile.visual.sort ?? null, tile.visual.limit ?? null]);
}

/**
 * What a tile is asked under `values`: its query and the filter values it uses. A filter the
 * tile does not use is left out, so two sets of filters that differ only there are the same
 * question to it.
 */
function question(tile: Tile, values: FilterValues): string {
  return JSON.stringify([
    runInputs(tile),
    tile.uses.includes("dateRange") ? values.dateRange : null,
    tile.uses.includes("locations") ? [...values.locations].sort((x, y) => x - y) : null,
  ]);
}

/** Which of three pages to show: the grid, or one of the two messages that replace it. */
function pageState(): "ready" | "off" | "empty" {
  if (data.status === "off") return "off";
  return data.status === "empty" ? "empty" : "ready";
}

/* ════════════════════════════════ 4. Chrome ══════════════════════════════ */

const titleHeading = el("h1", { class: "dash-title" });
const titleInput = el("input", { class: "dash-title-input", type: "text", maxlength: "200", "aria-label": "Dashboard title", hidden: true });
const badge = el("span", { class: "dash-badge", hidden: true }, "Read-only copy");
const asOfLine = el("p", { class: "dash-asof" });

const rangeSelect = el("select", { id: "dash-range" });
for (const preset of DATE_PRESETS) rangeSelect.appendChild(el("option", { value: preset.id }, preset.label));
rangeSelect.appendChild(el("option", { value: CUSTOM_RANGE }, "Custom range"));
const fromInput = el("input", { type: "date", id: "dash-from" });
const toInput = el("input", { type: "date", id: "dash-to" });
const customBox = el("span", { class: "dash-custom", hidden: true }, [
  el("label", { for: "dash-from" }, "From"),
  fromInput,
  el("label", { for: "dash-to" }, "To"),
  toInput,
]);
const locationSummary = el("summary", {}, "All locations");
const locationList = el("fieldset", {}, el("legend", { class: "sr-only" }, "Locations"));
const locationBox = el("details", { class: "dash-locations", hidden: true }, [locationSummary, locationList]);
const filterBar = el("div", { class: "dash-filters", role: "group", "aria-label": "Filters" }, [
  el("label", { for: "dash-range" }, "Date range"),
  rangeSelect,
  customBox,
  locationBox,
]);

const refreshButton = el("button", { type: "button" }, "Refresh");
const updatedText = el("span", { class: "dash-updated" });
const editButton = el("button", { type: "button", "aria-pressed": "false" }, "Edit");
const undoButton = el("button", { type: "button", hidden: true }, "Undo");
const redoButton = el("button", { type: "button", hidden: true }, "Redo");
const actionBar = el("div", { class: "dash-actions" }, [refreshButton, updatedText, editButton, undoButton, redoButton]);
const controls = el("div", { class: "dash-controls" }, [filterBar, actionBar]);

const statusLine = el("p", { class: "dash-status", role: "status", "aria-live": "polite" });
const bannerText = el("p");
const retryButton = el("button", { type: "button" }, "Try again");
const banner = el("div", { class: "dash-banner", hidden: true }, [bannerText, retryButton]);
const message = el("p", { class: "dash-message", hidden: true });
const grid = el("div", { class: "dash-grid" });
const page = el("div", { class: "dash" }, [
  el("header", { class: "dash-head" }, [el("div", { class: "dash-titles" }, [titleHeading, titleInput, badge, asOfLine]), controls]),
  statusLine,
  banner,
  el("main", {}, [message, grid]),
]);
document.body.appendChild(page);

/** Says what just happened, to everyone: the line is visible and is read out politely. */
function announce(text: string): void {
  statusLine.textContent = text;
}

function locationLabel(): string {
  if (!filters.locations.length) return "All locations";
  if (filters.locations.length > 1) return `${filters.locations.length} locations`;
  const only = data.status === "ok" ? data.locations.find((location) => location.id === filters.locations[0]) : undefined;
  return only ? only.name : "1 location";
}

/** The oldest run among the results on screen: the dashboard is as fresh as its stalest tile. */
function oldestRun(): number | null {
  let oldest: number | null = null;
  for (const tile of tiles) {
    const outcome = outcomes.get(tile.id);
    if (outcome && (oldest === null || outcome.ranAt < oldest)) oldest = outcome.ranAt;
  }
  return oldest;
}

function drawAge(): void {
  const oldest = oldestRun();
  const running = busy.size > 0;
  updatedText.textContent = running ? "Updating…" : oldest === null ? "" : `Updated ${formatAge(oldest, Date.now())}`;
  const parts: string[] = [];
  if (oldest !== null) parts.push(`As of ${new Date(oldest).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`);
  if (resolved) parts.push(describeRange(resolved));
  parts.push(locationLabel());
  asOfLine.textContent = parts.join(" · ");
}

function drawLocations(): void {
  const locations = data.status === "ok" ? data.locations : [];
  // The picker is for choosing between locations: with one, or none, there is nothing to choose.
  locationBox.hidden = locations.length < 2;
  const listed = JSON.stringify(locations);
  if (locationList.dataset.listed !== listed) {
    locationList.dataset.listed = listed;
    locationList.replaceChildren(
      el("legend", { class: "sr-only" }, "Locations"),
      ...locations.map((location) => el("label", {}, [el("input", { type: "checkbox", value: String(location.id) }), location.name])),
    );
  }
  for (const box of locationList.querySelectorAll("input")) {
    box.checked = (tickedLocations ?? filters.locations).includes(Number(box.value));
    box.disabled = data.mode !== "live";
  }
  locationSummary.textContent = locationLabel();
}

function drawChrome(): void {
  const state = pageState();
  const live = data.mode === "live";
  document.title = meta.title;
  titleHeading.textContent = meta.title;
  if (document.activeElement !== titleInput) titleInput.value = meta.title;
  titleHeading.classList.toggle("sr-only", editing);
  // An export is the page on paper: the attribute hides the controls even where the print
  // stylesheet is not applied.
  controls.hidden = isExport;
  statusLine.hidden = isExport;
  titleInput.hidden = !editing;
  badge.hidden = data.mode !== "snapshot";

  message.hidden = state === "ready";
  message.textContent = state === "off" ? DATA_OFF : state === "empty" ? DATA_EMPTY : "";
  grid.hidden = state !== "ready";
  banner.hidden = data.status !== "error";
  bannerText.textContent = data.status === "error" ? data.error : "";
  retryButton.hidden = !live;

  // Filters choose among results, so they go when there are none to choose among; a read-only
  // copy shows them, disabled, because they say what its results were filtered to.
  filterBar.hidden = state !== "ready";
  const custom = customOpen || !("preset" in filters.dateRange);
  rangeSelect.value = "preset" in filters.dateRange && !customOpen ? filters.dateRange.preset : CUSTOM_RANGE;
  rangeSelect.disabled = !live;
  customBox.hidden = !custom;
  const range = "preset" in filters.dateRange ? resolved : filters.dateRange;
  if (document.activeElement !== fromInput) fromInput.value = range?.from ?? "";
  if (document.activeElement !== toInput) toInput.value = range?.to ?? "";
  fromInput.disabled = toInput.disabled = !live;
  drawLocations();

  refreshButton.hidden = state === "off";
  refreshButton.disabled = !live;
  const canEdit = live && state === "ready";
  editButton.hidden = !canEdit;
  editButton.setAttribute("aria-pressed", String(editing));
  editButton.textContent = editing ? "Done" : "Edit";
  undoButton.hidden = redoButton.hidden = !(canEdit && editing);
  undoButton.disabled = !canUndo;
  redoButton.disabled = !canRedo;
  page.classList.toggle("dash-editing", editing);
  drawAge();
}

/* ════════════════════════════════ 5. Tiles ═══════════════════════════════ */

/** A tile's elements. They live as long as the tile does, so focus survives every redraw. */
interface TileView {
  section: HTMLElement;
  head: HTMLElement;
  heading: HTMLHeadingElement;
  titleInput: HTMLInputElement;
  busyMark: HTMLSpanElement;
  tools: HTMLDivElement;
  typeSelect: HTMLSelectElement;
  deleteButton: HTMLButtonElement;
  body: HTMLDivElement;
  handoff: HTMLDivElement;
  notes: HTMLDivElement;
  foot: HTMLElement;
  facts: HTMLDListElement;
  ask: HTMLParagraphElement;
  tableButton: HTMLButtonElement;
  resizeHandle: HTMLButtonElement;
}
const views = new Map<string, TileView>();

function createView(id: string): TileView {
  const heading = el("h2", { class: "tile-title", id: `tile-title-${id}` });
  const tileTitleInput = el("input", { class: "tile-title-input", type: "text", maxlength: "120", "aria-label": "Tile title", hidden: true });
  const busyMark = el("span", { class: "tile-busy", hidden: true }, "Updating…");
  const typeSelect = el("select", { class: "tile-type" });
  const deleteButton = el("button", { type: "button", class: "tile-delete" }, "Delete");
  const tools = el("div", { class: "tile-tools", hidden: true }, [typeSelect, deleteButton]);
  const head = el("header", { class: "tile-head" }, [heading, tileTitleInput, busyMark, tools]);
  const body = el("div", { class: "tile-body" });
  const handoff = el("div", { class: "tile-handoff", hidden: true });
  const notes = el("div", { class: "tile-notes" });
  const facts = el("dl", { class: "tile-facts" });
  const ask = el("p", { class: "tile-ask", hidden: true }, "Ask the agent to change this query.");
  const tableButton = el("button", { type: "button", class: "tile-as-table", "aria-pressed": "false" }, "Show as table");
  const foot = el("footer", { class: "tile-foot" }, [el("details", { class: "tile-details" }, [el("summary", {}, "Details"), facts, ask]), tableButton]);
  const resizeHandle = el("button", { type: "button", class: "tile-resize", hidden: true });
  const section = el("section", { class: "tile", "aria-labelledby": heading.id, "aria-busy": "false", "data-tile": id }, [head, body, handoff, notes, foot, resizeHandle]);

  tableButton.addEventListener("click", () => {
    if (!asTable.delete(id)) asTable.add(id);
    const tile = tileById(id);
    if (tile) drawTile(tile);
  });
  tileTitleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") tileTitleInput.blur();
  });
  tileTitleInput.addEventListener("change", () => renameTile(id, tileTitleInput.value));
  typeSelect.addEventListener("change", () => retypeTile(id, typeSelect.value));
  deleteButton.addEventListener("click", () => deleteTile(id));
  section.addEventListener("keydown", (event) => {
    if (event.target === section) nudgeTile(id, event);
  });
  const handles: [HTMLElement, Drag["kind"]][] = [[head, "move"], [resizeHandle, "resize"]];
  for (const [handle, kind] of handles) {
    handle.addEventListener("pointerdown", (event) => startDrag(event, handle, id, kind));
    handle.addEventListener("pointermove", moveDrag);
    handle.addEventListener("pointerup", (event) => endDrag(event, true));
    handle.addEventListener("pointercancel", (event) => endDrag(event, false));
  }
  return { section, head, heading, titleInput: tileTitleInput, busyMark, tools, typeSelect, deleteButton, body, handoff, notes, foot, facts, ask, tableButton, resizeHandle };
}

function querySummary(query: SavedQuery): Node {
  if (query.kind === "metric") {
    const by = query.groupBy?.length ? `, by ${query.groupBy.join(" and ")}` : "";
    return document.createTextNode(`Standard metric ${query.metric}${by}${query.compare ? ", compared with the previous period" : ""}`);
  }
  const params = Object.entries(query.params ?? {}).map(([name, value]) => `:${name} = ${JSON.stringify(value)}`);
  return el("div", {}, [el("pre", { class: "tile-sql" }, el("code", {}, query.sql)), params.length ? `Parameters: ${params.join(", ")}` : null]);
}

function usesSummary(uses: FilterName[]): string {
  const names = [uses.includes("dateRange") ? "date range" : null, uses.includes("locations") ? "locations" : null].filter((name) => name !== null);
  return names.length ? names.join(" and ") : "none (always the dashboard's default period and locations)";
}

function drawFacts(view: TileView, tile: Tile, outcome: QueryOutcome | undefined): void {
  const facts: [string, Node | string][] = [];
  if (tile.query) {
    facts.push(["Query", querySummary(tile.query)]);
    facts.push(["Filters used", usesSummary(tile.uses)]);
  }
  if (outcome) {
    const ran = new Date(outcome.ranAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    facts.push(["Period", describeRange(outcome.period)]);
    facts.push(["Last ran", `${formatAge(outcome.ranAt, Date.now())} (${ran})`]);
    if (!("error" in outcome)) facts.push(["Rows", `${outcome.rowCount}${outcome.truncated ? " (cut at the row limit)" : ""}`]);
    facts.push(["Duration", outcome.durationMs < 1000 ? `${Math.round(outcome.durationMs)} ms` : `${(outcome.durationMs / 1000).toFixed(1)} s`]);
  } else if (tile.query) {
    facts.push(["Last ran", "Not yet"]);
  }
  view.facts.replaceChildren(...facts.flatMap(([term, value]) => [el("dt", {}, term), el("dd", {}, value)]));
}

// "Fix with agent" cannot open the chat from inside the gadget's frame, so it hands the member
// the request to paste there. The frame has an opaque origin, where the async clipboard API is
// refused: the text is put in a focused, selected field and copied with the click's own
// permission, and when even that is refused the selection is ready for the member's own copy.
function revealHandoff(view: TileView, tile: Tile, error: string): void {
  const request = el("textarea", { class: "tile-request", readonly: true, rows: "4", "aria-label": "Request for the agent" });
  request.value = `In the dashboard "${meta.title}", the tile "${tile.title}" (id ${tile.id}) fails with this error: ${error}\nPlease fix the tile's query.`;
  const hint = el("p");
  view.handoff.replaceChildren(el("p", {}, "Paste this into the chat with the agent:"), request, hint);
  view.handoff.hidden = false;
  request.focus();
  request.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  const said = copied ? "Copied. Paste it into the chat." : "Copy the selected text, then paste it into the chat.";
  hint.textContent = said;
  announce(said);
}

/** The picture's size in px: the tile's real width once it is laid out, its grid size before. */
function visualSize(view: TileView, layout: Layout): { width: number; height: number } {
  const width = view.body.clientWidth > 0 ? view.body.clientWidth : layout.w * 96;
  return { width, height: Math.max(96, layout.h * (ROW_HEIGHT + GAP) - 110) };
}

function drawTypeSelect(view: TileView, tile: Tile, outcome: QueryOutcome | undefined): void {
  // The types offered are the ones the tile's last result can be drawn as. The tile's own type
  // is listed even when the result no longer fits it, so the select says what the tile is.
  const fitting: VisualType[] = outcome && !("error" in outcome) ? compatibleVisuals(outcome.columns, outcome.rows.length).filter((type) => type !== "text") : [];
  const types = fitting.includes(tile.visual.type) ? fitting : [tile.visual.type, ...fitting];
  const listed = types.join(",");
  if (view.typeSelect.dataset.listed !== listed) {
    view.typeSelect.dataset.listed = listed;
    view.typeSelect.replaceChildren(...types.map((type) => el("option", { value: type }, VISUAL_LABELS[type])));
  }
  view.typeSelect.value = tile.visual.type;
  view.typeSelect.hidden = !tile.query;
  view.typeSelect.setAttribute("aria-label", `Visual type for ${tile.title}`);
}

function drawTile(tile: Tile): void {
  const view = views.get(tile.id);
  if (!view) return;
  const { section, body } = view;
  section.style.gridColumn = `${tile.layout.x + 1} / span ${tile.layout.w}`;
  section.style.gridRow = `${tile.layout.y + 1} / span ${tile.layout.h}`;
  section.classList.toggle("tile-wide", tile.layout.w > GRID_COLUMNS / 2);
  if (editing) section.setAttribute("tabindex", "0");
  else section.removeAttribute("tabindex");

  view.heading.textContent = tile.title;
  view.heading.classList.toggle("sr-only", editing);
  if (document.activeElement !== view.titleInput) view.titleInput.value = tile.title;
  view.titleInput.hidden = !editing;
  view.tools.hidden = !editing;
  view.deleteButton.setAttribute("aria-label", `Delete ${tile.title}`);
  view.resizeHandle.hidden = !editing;
  view.resizeHandle.setAttribute("aria-label", `Resize ${tile.title}. With the tile focused, Shift and the arrow keys resize it.`);
  view.ask.hidden = !(editing && tile.query);

  const running = busy.has(tile.id);
  section.setAttribute("aria-busy", String(running));
  view.busyMark.hidden = !running;

  const outcome = outcomes.get(tile.id);
  const notes: string[] = [];
  let failure: string | null = null;
  let hasResult = false;
  if (!tile.query) {
    body.innerHTML = renderMarkdownLite(tile.visual.text ?? "");
  } else if (!outcome) {
    // While a first run is in flight the busy mark says so; otherwise the tile says why it is blank.
    const waiting = data.mode === "snapshot" ? "No result was stored for this tile." : running ? "" : "No result yet.";
    body.replaceChildren(el("p", { class: "data-empty" }, waiting));
  } else if ("error" in outcome) {
    failure = outcome.error;
    const error = outcome.error;
    const fix = el("button", { type: "button", class: "tile-fix" }, "Fix with agent");
    fix.addEventListener("click", () => revealHandoff(view, tile, error));
    body.replaceChildren(el("p", { class: "tile-error" }, error), fix);
  } else {
    hasResult = true;
    const rendered = renderVisual(outcome, tile.visual, visualSize(view, tile.layout));
    body.innerHTML = asTable.has(tile.id) && tile.visual.type !== "table" ? renderTable(outcome) : rendered.html;
    notes.push(...rendered.notes);
    const completeThrough = data.status === "ok" ? data.completeThrough : null;
    if (completeThrough && tile.uses.includes("dateRange") && outcome.period.to > completeThrough) {
      notes.push(`Data is complete through ${formatDate(completeThrough)}`);
    }
  }
  if (failure === null) {
    view.handoff.hidden = true;
    view.handoff.replaceChildren();
  }
  view.notes.replaceChildren(...notes.map((note) => el("p", { class: "data-note" }, note)));

  view.foot.hidden = !tile.query;
  drawFacts(view, tile, outcome);
  const tabular = hasResult && tile.visual.type !== "table";
  view.tableButton.hidden = !tabular;
  view.tableButton.setAttribute("aria-pressed", String(asTable.has(tile.id)));
  view.tableButton.textContent = asTable.has(tile.id) ? "Show as chart" : "Show as table";
  drawTypeSelect(view, tile, outcome);
}

/** Puts each tile's section where its layout says, without touching what is inside. */
function placeTiles(): void {
  for (const tile of tiles) {
    const view = views.get(tile.id);
    if (!view) continue;
    view.section.style.gridColumn = `${tile.layout.x + 1} / span ${tile.layout.w}`;
    view.section.style.gridRow = `${tile.layout.y + 1} / span ${tile.layout.h}`;
  }
}

function drawTiles(): void {
  const shown = pageState() === "ready" ? tiles : [];
  for (const [id, view] of views) {
    if (shown.some((tile) => tile.id === id)) continue;
    view.section.remove();
    views.delete(id);
    asTable.delete(id);
  }
  // Sections follow reading order (top to bottom, left to right), which is the order the Tab key
  // and paper take them in. Moving a section drops its focus and its pointer capture, so the
  // order is left alone during a drag and focus is handed back afterwards.
  const focused = document.activeElement;
  const ordered = [...shown].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  ordered.forEach((tile, index) => {
    let view = views.get(tile.id);
    if (!view) {
      view = createView(tile.id);
      views.set(tile.id, view);
      grid.appendChild(view.section);
    }
    if (!drag && grid.children[index] !== view.section) grid.insertBefore(view.section, grid.children[index] ?? null);
    drawTile(tile);
  });
  if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
}

function draw(): void {
  drawChrome();
  drawTiles();
}

/* ══════════════════════════ 6. Running and filters ═══════════════════════ */

/**
 * Asks the server for these tiles' outcomes under this page's filters (every tile with a query
 * when `ids` is null). The server reads only what its cache cannot answer, unless `force`. While
 * a tile waits it keeps its picture and is marked busy.
 */
async function runTiles(ids: string[] | null, force: boolean): Promise<void> {
  const targets = (ids ?? tiles.map((tile) => tile.id)).filter((id) => tileById(id)?.query);
  if (!targets.length && !force) return;
  const asked = new Map(targets.map((id) => {
    const tile = tileById(id);
    return [id, tile ? question(tile, filters) : ""];
  }));
  const askedFilters = filters;
  for (const id of targets) busy.set(id, (busy.get(id) ?? 0) + 1);
  draw();
  try {
    const args: RunTilesArgs = {
      ...(ids ? { ids: targets } : {}),
      ...(sameFilters(filters, meta.defaultFilters) ? {} : { filters }),
      ...(force ? { force: true } : {}),
    };
    const result = await gadget.runTiles(args);
    data = result.data;
    if (data.status === "off") {
      outcomes.clear();
    } else {
      if (sameFilters(askedFilters, filters)) resolved = result.resolved;
      let failed = 0;
      for (const [id, outcome] of Object.entries(result.results)) {
        const tile = tileById(id);
        // An answer to a question this page has since stopped asking (the filters or the tile's
        // query moved on) is dropped.
        if (!tile || asked.get(id) !== question(tile, filters)) continue;
        outcomes.set(id, outcome);
        if ("error" in outcome) failed++;
      }
      announce(failed ? `${failed} ${failed === 1 ? "tile" : "tiles"} could not be updated.` : "The dashboard is up to date.");
    }
  } catch (error) {
    announce(messageOf(error));
  } finally {
    for (const id of targets) {
      const waiting = (busy.get(id) ?? 1) - 1;
      if (waiting > 0) busy.set(id, waiting);
      else busy.delete(id);
    }
    draw();
  }
}

/** Runs the tiles that have nothing to show under this page's filters. */
function runMissing(): void {
  if (isExport || data.mode !== "live" || pageState() !== "ready") return;
  const ids = tiles.filter((tile) => tile.query && !outcomes.has(tile.id) && !busy.has(tile.id)).map((tile) => tile.id);
  if (ids.length) void runTiles(ids, false);
}

/** Changes one filter in this page and re-runs exactly the tiles that use it. */
function applyFilter(next: FilterValues, name: FilterName): void {
  filters = next;
  drawChrome();
  const ids = tiles.filter((tile) => tile.query && tile.uses.includes(name)).map((tile) => tile.id);
  if (ids.length) void runTiles(ids, false);
}

rangeSelect.addEventListener("change", () => {
  const preset = DATE_PRESETS.find((each) => each.id === rangeSelect.value);
  if (!preset) {
    // The inputs open on the range now showing; nothing is asked until one of them changes.
    customOpen = true;
    drawChrome();
    fromInput.focus();
    return;
  }
  customOpen = false;
  applyFilter({ ...filters, dateRange: { preset: preset.id } }, "dateRange");
});

function applyCustomRange(): void {
  if (!fromInput.value || !toInput.value) return;
  let next: FilterValues;
  try {
    next = validateFilters({ dateRange: { from: fromInput.value, to: toInput.value }, locations: filters.locations });
  } catch (error) {
    announce(messageOf(error));
    return;
  }
  customOpen = false;
  applyFilter(next, "dateRange");
}
fromInput.addEventListener("change", applyCustomRange);
toInput.addEventListener("change", applyCustomRange);

// Several locations are usually ticked in a row; the tiles run once the ticking pauses. Until
// then the ticks are kept here, so a redraw in the meantime (a run finishing) leaves them be.
let locationTimer: ReturnType<typeof setTimeout> | undefined;
locationList.addEventListener("change", () => {
  tickedLocations = Array.from(locationList.querySelectorAll("input"))
    .filter((box) => box.checked)
    .map((box) => Number(box.value));
  clearTimeout(locationTimer);
  locationTimer = setTimeout(() => {
    const chosen = tickedLocations ?? filters.locations;
    tickedLocations = null;
    let next: FilterValues;
    try {
      next = validateFilters({ dateRange: filters.dateRange, locations: chosen });
    } catch (error) {
      announce(messageOf(error));
      drawChrome();
      return;
    }
    applyFilter(next, "locations");
  }, LOCATION_PAUSE_MS);
});

refreshButton.addEventListener("click", () => void runTiles(null, true));
retryButton.addEventListener("click", () => void runTiles(null, true));

/* ═══════════════════════════════ 7. Edit mode ════════════════════════════ */

/** Sends one structure change. A refusal is said aloud and the page goes back to what the server holds. */
async function change(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    announce(messageOf(error));
    try {
      applyOpened(await gadget.open());
    } catch {
      // The connection is gone; the subscriber's dispose hook reconnects and redraws.
    }
  }
}

editButton.addEventListener("click", () => {
  editing = !editing;
  draw();
  announce(editing
    ? "Editing. Drag a tile by its title to move it and by its corner to resize it, or focus a tile and use the arrow keys to move it and Shift with the arrow keys to resize it."
    : "Done editing.");
});

async function travel(step: "undo" | "redo"): Promise<void> {
  await change(async () => {
    const changed = await gadget[step]({ clientId });
    if (changed) applyChanged(changed);
    else announce(step === "undo" ? "Nothing to undo." : "Nothing to redo.");
  });
}
undoButton.addEventListener("click", () => void travel("undo"));
redoButton.addEventListener("click", () => void travel("redo"));

titleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") titleInput.blur();
});
titleInput.addEventListener("change", () => {
  const title = titleInput.value.trim();
  if (!title || title === meta.title) {
    titleInput.value = meta.title;
    return;
  }
  meta = { ...meta, title };
  drawChrome();
  void change(() => gadget.setTitle({ title, clientId }));
});

function renameTile(id: string, value: string): void {
  const tile = tileById(id);
  const title = value.trim();
  if (!tile || !title || title === tile.title) {
    if (tile) drawTile(tile);
    return;
  }
  tiles = tiles.map((each) => (each.id === id ? { ...each, title } : each));
  drawTiles();
  void change(() => gadget.updateTile({ id, title, clientId }));
}

// The result stays as it is: the same rows are drawn another way, with no run.
function retypeTile(id: string, value: string): void {
  const tile = tileById(id);
  const type = (Object.keys(VISUAL_LABELS) as VisualType[]).find((each) => each === value);
  if (!tile || !type || type === tile.visual.type) return;
  const visual = { ...tile.visual, type };
  tiles = tiles.map((each) => (each.id === id ? { ...each, visual } : each));
  asTable.delete(id);
  drawTiles();
  announce(`${tile.title} is now shown as: ${VISUAL_LABELS[type]}.`);
  void change(() => gadget.updateTile({ id, visual, clientId }));
}

function deleteTile(id: string): void {
  const tile = tileById(id);
  if (!tile) return;
  tiles = tiles.filter((each) => each.id !== id);
  outcomes.delete(id);
  draw();
  editButton.focus();
  announce(`${tile.title} was deleted. Undo brings it back.`);
  void change(() => gadget.removeTile({ id, clientId }));
}

/** The tiles with one of them put at `layout` and whatever it now covers moved down, as the server will settle them. */
function withLayout(base: Tile[], id: string, layout: Layout): Tile[] {
  const settled = settleLayout(base.map((tile) => ({ id: tile.id, layout: tile.id === id ? layout : tile.layout })), [id]);
  return base.map((tile, index) => ({ ...tile, layout: settled[index].layout }));
}

const sameLayout = (a: Layout, b: Layout) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function saveLayout(id: string, layout: Layout, resized: boolean): void {
  announce(resized
    ? `Resized to ${layout.w} columns by ${layout.h} rows.`
    : `Moved to column ${layout.x + 1}, row ${layout.y + 1}.`);
  void change(() => gadget.setLayout({ tiles: [{ id, ...layout }], clientId }));
}

// Arrow keys move the focused tile one grid unit; with Shift they resize it by one. The tile's
// section is never rebuilt, so focus stays on it and the next key press carries on.
function nudgeTile(id: string, event: KeyboardEvent): void {
  if (!editing || event.altKey || event.ctrlKey || event.metaKey) return;
  const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const step = steps[event.key];
  const tile = tileById(id);
  if (!step || !tile) return;
  event.preventDefault();
  const [dx, dy] = step;
  const { x, y, w, h } = tile.layout;
  const next = event.shiftKey ? resizeLayout(tile.layout, w + dx, h + dy) : moveLayout(tile.layout, x + dx, y + dy);
  if (sameLayout(next, tile.layout)) {
    announce(event.shiftKey ? "The tile cannot be resized further that way." : "The tile is at the edge of the grid.");
    return;
  }
  tiles = withLayout(tiles, id, next);
  drawTiles();
  views.get(id)?.section.focus({ preventScroll: true });
  saveLayout(id, next, event.shiftKey);
}

/** A tile being moved or resized with the pointer. Nothing is saved until the pointer is let go. */
interface Drag {
  id: string;
  kind: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  origin: Layout;
  /** The tiles as they were when the drag began: each step is settled from these, so a tile pushed aside comes back when the dragged one moves on. */
  base: Tile[];
  latest: Layout;
}
let drag: Drag | null = null;

function startDrag(event: PointerEvent, handle: HTMLElement, id: string, kind: Drag["kind"]): void {
  const tile = tileById(id);
  if (!editing || drag || event.button !== 0 || !tile) return;
  // The title field, the type select and the delete button sit in the header and keep their own clicks.
  if (kind === "move" && event.target instanceof Element && event.target.closest("input, select, button")) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  drag = { id, kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: tile.layout, base: tiles, latest: tile.layout };
  views.get(id)?.section.classList.add("tile-dragging");
}

function moveDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const column = (grid.getBoundingClientRect().width + GAP) / GRID_COLUMNS;
  const dx = Math.round((event.clientX - drag.startX) / column);
  const dy = Math.round((event.clientY - drag.startY) / (ROW_HEIGHT + GAP));
  const { x, y, w, h } = drag.origin;
  const next = drag.kind === "move" ? moveLayout(drag.origin, x + dx, y + dy) : resizeLayout(drag.origin, w + dx, h + dy);
  if (sameLayout(next, drag.latest)) return;
  drag.latest = next;
  tiles = withLayout(drag.base, drag.id, next);
  placeTiles();
}

function endDrag(event: PointerEvent, keep: boolean): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const done = drag;
  drag = null;
  const section = views.get(done.id)?.section;
  section?.classList.remove("tile-dragging");
  if (!keep || sameLayout(done.latest, done.origin)) {
    tiles = done.base;
    drawTiles();
    return;
  }
  drawTiles();
  section?.focus({ preventScroll: true });
  saveLayout(done.id, done.latest, done.kind === "resize");
}

/* ═══════════════════════ 8. Live updates and connect ═════════════════════ */

function applyOpened(opened: Opened): void {
  // A page still on the default filters follows them; one the viewer has filtered keeps its own.
  const following = meta.revision < 0 || sameFilters(filters, meta.defaultFilters);
  meta = opened.meta;
  tiles = opened.tiles;
  data = opened.data;
  canUndo = opened.canUndo;
  canRedo = opened.canRedo;
  if (following) {
    filters = meta.defaultFilters;
    resolved = opened.resolved;
    outcomes.clear();
  }
  if (data.status === "off") outcomes.clear();
  for (const [id, outcome] of Object.entries(opened.results)) {
    const tile = tileById(id);
    if (tile && question(tile, filters) === question(tile, meta.defaultFilters)) outcomes.set(id, outcome);
  }
  for (const id of Array.from(outcomes.keys())) if (!tileById(id)) outcomes.delete(id);
  if (data.mode !== "live" || pageState() !== "ready") editing = false;
  draw();
}

function applyChanged(event: Changed): void {
  if (event.revision <= meta.revision) return;
  // The structure a drag started from is gone; the drag ends where the new structure stands.
  if (drag) {
    views.get(drag.id)?.section.classList.remove("tile-dragging");
    drag = null;
  }
  const before = new Map(tiles.map((tile) => [tile.id, tile]));
  const defaultsMoved = !sameFilters(event.meta.defaultFilters, meta.defaultFilters);
  const following = sameFilters(filters, meta.defaultFilters);
  meta = event.meta;
  tiles = event.tiles;
  canUndo = event.canUndo;
  canRedo = event.canRedo;
  if (defaultsMoved) {
    // Every tile leans on the defaults for the filters it does not use, so every answer is in doubt.
    if (following) {
      filters = meta.defaultFilters;
      resolved = undefined;
    }
    outcomes.clear();
  }
  for (const id of Array.from(outcomes.keys())) {
    const tile = tileById(id), old = before.get(id);
    if (!tile || (old && runInputs(old) !== runInputs(tile))) outcomes.delete(id);
  }
  draw();
  if (event.senderId !== clientId) announce("The dashboard was changed.");
  runMissing();
}

// The server broadcasts outcomes for the default filters only. A tile takes one when the
// default filters are what this page is asking that tile; a tile the viewer has filtered keeps
// the viewer's answer.
function applyResults(event: ResultsEvent): void {
  if (data.status === "off") return;
  for (const [id, outcome] of Object.entries(event.results)) {
    const tile = tileById(id);
    if (!tile || question(tile, filters) !== question(tile, meta.defaultFilters)) continue;
    const shown = outcomes.get(id);
    if (shown && shown.ranAt >= outcome.ranAt) continue;
    outcomes.set(id, outcome);
    drawTile(tile);
  }
  if (sameFilters(filters, meta.defaultFilters)) resolved = event.resolved;
  drawAge();
}

// Events that arrive before the opening snapshot is applied are held back and replayed after
// it, so a snapshot read a moment earlier cannot hide a newer change.
let ready = false;
let held: (() => void)[] = [];

type DashboardSubscriber = SubscriberCallbacks & Disposable;
function newSubscriber(): DashboardSubscriber {
  return createSubscriber<DashboardSubscriber>(RpcTarget, {
    changed(event: Changed) {
      if (ready) applyChanged(event);
      else held.push(() => applyChanged(event));
    },
    results(event: ResultsEvent) {
      if (ready) applyResults(event);
      else held.push(() => applyResults(event));
    },
    // The server's handle on this subscriber is dropped when the connection breaks; subscribe
    // again so live updates keep flowing.
    [Symbol.dispose](this: DashboardSubscriber) {
      if (subscription === this) subscription = null;
      ready = false;
      announce("Reconnecting…");
      void ensureConnected();
    },
  });
}
// The subscriber the server holds, until it drops it. A connect attempt that fails after
// subscribing retries without subscribing a second one.
let subscription: DashboardSubscriber | null = null;

let connectedOnce = false, connecting: Promise<void> | null = null;

function tickAge(): void {
  drawAge();
  setTimeout(tickAge, AGE_TICK_MS);
}

async function connect(): Promise<void> {
  ready = false;
  for (let attempt = 0; ; attempt++) {
    try {
      let opened: Opened;
      if (isExport || subscription) {
        opened = await gadget.open();
      } else {
        // Held before the call returns, so a drop during it is seen.
        const sub = subscription = newSubscriber();
        try {
          opened = await gadget.subscribe(sub, { clientId });
        } catch (error) {
          if (subscription === sub) subscription = null;
          throw error;
        }
      }
      // The subscriber was dropped meanwhile: subscribe again and re-read.
      if (!isExport && !subscription) continue;
      // What the dashboard has cached is on screen before anything is asked of the dataset.
      applyOpened(opened);
      ready = true;
      const replay = held;
      held = [];
      for (const event of replay) event();
      if (connectedOnce) announce("");
      if (isExport) return;
      if (!connectedOnce) {
        connectedOnce = true;
        setTimeout(tickAge, AGE_TICK_MS);
        // Charts are drawn to the width their tile has, so a resized window redraws them.
        let resizeTimer: ReturnType<typeof setTimeout> | undefined;
        window.addEventListener("resize", () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(drawTiles, 150);
        });
      }
      // Now the stale tiles: the server re-runs only what is older than the freshness setting.
      if (data.mode === "live" && pageState() === "ready") void runTiles(null, false);
      return;
    } catch (error) {
      console.error(error);
      held = [];
      if (isExport) {
        announce(messageOf(error));
        return;
      }
      announce("The dashboard could not be reached. Trying again…");
      await new Promise((resolve) => setTimeout(resolve, Math.min(1e4, 500 * 2 ** attempt)));
    }
  }
}

function ensureConnected(): Promise<void> {
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  return connecting;
}

// The export page waits on this module: it resolves once the cached results are drawn.
await ensureConnected();
