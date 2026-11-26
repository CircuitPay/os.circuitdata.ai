// ─────────────────────────────────────────────────────────────────────────────
// Report: a written document whose numbers are frozen as of the day it was generated.
//
// Sections:
//   1. Platform                 5. The page (letterhead, sections, data blocks)
//   2. Styles                   6. Editing in place
//   3. State                    7. Actions
//   4. Chrome (header, panel)   8. Live updates and connecting
//
// The latest view shows the report's current text with the latest edition's results; an earlier
// edition shows its own stored blocks. Nothing here reads the dataset: every number on the page
// comes from an edition the server stored. See README.md for the server's API.
// ─────────────────────────────────────────────────────────────────────────────
import {
  DATA_STYLES,
  DATE_PRESETS,
  type DateRangeFilter,
  type QueryOutcome,
  type QueryResult,
  type VisualType,
  compatibleVisuals,
  describeRange,
  formatDate,
  renderMarkdownLite,
  renderTable,
  renderVisual,
} from "@gadgets/bundled-blueprints/libraries/data/client";
import { createSubscriber } from "@gadgets/bundled-blueprints/libraries/sync/client";
import { type ElChild, el, readFileAsDataURL } from "@gadgets/bundled-blueprints/libraries/ui/client";
import { currentBlocks, isFailure } from "./lib/editions.ts";
import {
  type Changed,
  type DataSection,
  type DataState,
  type Edition,
  type EditionBlock,
  type EditionSummary,
  type GadgetStub,
  type Generated,
  LIMITS,
  type Letterhead,
  type Meta,
  type Opened,
  type Section,
  type SectionInput,
  type SubscriberCallbacks,
} from "./lib/protocol.ts";

// The bindings the Workshop's iframe bootstrap defines before this module runs: the RPC stub to
// this gadget's Durable Object, and Cap'n Web's RpcTarget for the callbacks it is handed.
declare const gadget: GadgetStub;
declare const RpcTarget: { new (): object };
declare global {
  // Set by the export renderer before this module loads, to the browser-mode format being made.
  var gadgetExportFormatId: string | undefined;
  // "snapshot" when the frame shows a view-only copy; unset otherwise.
  var gadgetRenderMode: string | undefined;
}

/* ═══════════════════════════════ 1. Platform ═══════════════════════════════ */

const isExport = typeof globalThis.gadgetExportFormatId === "string" && globalThis.gadgetExportFormatId !== "";
const clientId = Math.random().toString(36).slice(2);

const OFF_TEXT = "Retail data is not turned on for this organization. An administrator can turn it on under Connectors → Data.";
const EMPTY_TEXT = "No sales data yet. Import a CSV or connect a source in Data, then generate this report.";
const NOT_GENERATED_TEXT = "This report has not been generated yet.";
const STALE_TEXT = "Not in the latest edition yet. Regenerate to include it.";
const REVIEW_TEXT = "The numbers changed since this was written. Review the text.";
const ALL_PINNED_TEXT = `All ${LIMITS.editions} editions are pinned. Unpin one to generate a new edition.`;

/** How long after the last keystroke a draft is saved. */
const SAVE_PAUSE_MS = 900;

const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml"];
const LOGO_URL = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
const ACCENT = /^#[0-9a-fA-F]{6}$/;

const HEADING_TAGS = { 1: "h1", 2: "h2", 3: "h3" } as const;
/** The box a chart is drawn for, by the width of its block; the picture scales with its container. */
const VISUAL_SIZES = { full: { width: 880, height: 320 }, half: { width: 430, height: 260 }, third: { width: 280, height: 200 } } as const;
const VISUAL_LABELS: Record<VisualType, string> = {
  kpi: "Single value",
  line: "Line chart",
  area: "Area chart",
  bar: "Bar chart",
  stackedBar: "Stacked bar chart",
  table: "Table",
  text: "Text",
};

// A PDF is made by a browser somewhere else, so its times say which zone they are in.
const timeFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  ...(isExport ? { timeZoneName: "short" } : {}),
});

function formatTime(time: number): string {
  return timeFormat.format(new Date(time));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ═══════════════════════════════ 2. Styles ═════════════════════════════════ */

const STYLES = `
:root {
  color-scheme: light;
  --bg: #f4f4f5;
  --paper: #ffffff;
  --text: #18181b;
  --muted: #6b7280;
  --line: #e4e4e7;
  --line-strong: #c9c9cf;
  --hover: rgba(24, 24, 32, 0.06);
  --accent: #2563eb;
  --focus: #2563eb;
  --note-bg: #eff6ff;
  --note-text: #1e3a8a;
  --warn-bg: #fef3c7;
  --warn-text: #78350f;
  --bad-bg: #fee2e2;
  --bad-text: #991b1b;
}
@media screen and (prefers-color-scheme: dark) {
  :root:not(.document-export) {
    color-scheme: dark;
    --bg: #111113;
    --paper: #1b1b1f;
    --text: #f4f4f5;
    --muted: #a1a1aa;
    --line: #2e2e33;
    --line-strong: #45454d;
    --hover: rgba(255, 255, 255, 0.08);
    --focus: #93c5fd;
    --note-bg: #172554;
    --note-text: #dbeafe;
    --warn-bg: #422006;
    --warn-text: #fde68a;
    --bad-bg: #450a0a;
    --bad-text: #fecaca;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 16px;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}
.bar-title { font-weight: 600; flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-title-input { flex: 1 1 200px; min-width: 0; }
.bar-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.bar-label, .field > label, .field > span { font-size: 12px; color: var(--muted); }
.badge { font-size: 12px; padding: 2px 8px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--muted); }
.btn {
  padding: 5px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper);
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: var(--hover); }
.btn:disabled { opacity: 0.55; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
.btn.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(0.92); }
.btn.small { padding: 2px 8px; font-size: 12px; }
.btn[aria-pressed="true"] { background: var(--hover); }
input[type="text"], input[type="date"], select, textarea {
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--paper);
  max-width: 100%;
}

.edit-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  align-items: flex-end;
  padding: 12px 16px;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}
.field { display: flex; flex-direction: column; gap: 3px; }
.field-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.locations { border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px 6px; margin: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.locations legend { font-size: 12px; color: var(--muted); padding: 0 4px; }
.locations label { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; }

.notices { max-width: 960px; margin: 0 auto; padding: 0 16px; }
.notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--note-bg);
  color: var(--note-text);
}
.notice.warn { background: var(--warn-bg); color: var(--warn-text); }
.notice.bad { background: var(--bad-bg); color: var(--bad-text); }
.notice p { margin: 0; flex: 1 1 240px; }

.page {
  max-width: 960px;
  margin: 16px auto 48px;
  padding: 40px 48px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 4px;
}
.letterhead { display: flex; align-items: center; gap: 12px; }
.lh-logo { max-height: 48px; max-width: 200px; }
.lh-name { font-weight: 600; letter-spacing: 0.01em; }
.lh-rule { height: 3px; margin: 10px 0 24px; border: 0; background: var(--accent); }
.doc-title { font-size: 28px; line-height: 1.2; margin: 0 0 4px; }
.asof { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
.state { margin: 0 0 20px; padding: 16px; border: 1px dashed var(--line-strong); border-radius: 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.state p { margin: 0; flex: 1 1 260px; }

.sections { display: flex; flex-wrap: wrap; gap: 16px 20px; align-items: flex-start; }
.sec { flex: 0 0 100%; min-width: 0; }
.sec-data { border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; }
.sec-data.w-half { flex: 1 1 calc(50% - 10px); max-width: calc(50% - 10px); }
.sec-data.w-third { flex: 1 1 calc(33.333% - 14px); max-width: calc(33.333% - 14px); }
@media screen and (max-width: 640px) {
  .page { padding: 20px 16px; }
  .sec-data.w-half, .sec-data.w-third { flex-basis: 100%; max-width: 100%; }
}
.sec h1, .sec h2, .sec h3 { margin: 0; line-height: 1.25; }
.sec h1 { font-size: 28px; }
.sec h2 { font-size: 21px; margin-top: 8px; }
.sec h3 { font-size: 17px; margin-top: 4px; }
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }
.prose h3, .prose h4, .prose h5 { margin: 12px 0 4px; font-size: 15px; }
.prose p, .prose ul { margin: 0 0 10px; }
.placeholder { color: var(--muted); font-style: italic; }
.sec.editable .heading, .sec.editable .prose { cursor: text; border-radius: 4px; }
.sec.editable .heading:hover, .sec.editable .prose:hover { background: var(--hover); }
.sec-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px; }
.editor { display: flex; flex-direction: column; gap: 6px; }
.editor textarea { width: 100%; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.editor input[type="text"] { width: 100%; font-weight: 600; }
.flag {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 13px;
}
.flag span { flex: 1 1 200px; }

.block-title { margin: 0 0 8px; font-weight: 600; font-size: 14px; }
.block-visual { min-width: 0; overflow-x: auto; }
.block-meta { margin: 8px 0 0; font-size: 12px; color: var(--muted); }
.block-error { margin: 0 0 8px; color: var(--bad-text); background: var(--bad-bg); padding: 6px 10px; border-radius: 6px; font-size: 13px; }
.block-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.block-details { margin-top: 8px; font-size: 12px; color: var(--muted); }
.block-details summary { cursor: pointer; }
.block-details dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 6px 0 0; }
.block-details dt { font-weight: 600; }
.block-details dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.block-details pre { margin: 0; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.handoff { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.handoff textarea { width: 100%; font-size: 13px; }
.handoff p { margin: 0; color: var(--muted); }

.document-export body { background: #ffffff; }
.document-export .page { max-width: none; margin: 0; padding: 0; border: 0; }

@page { margin: 0.7in; }
@media print {
  :root {
    color-scheme: light;
    --bg: #ffffff;
    --paper: #ffffff;
    --text: #000000;
    --muted: #4b5563;
    --line: #d1d5db;
    --line-strong: #9ca3af;
  }
  body { background: #ffffff; }
  .bar, .edit-panel, .notices, .sec-tools, .flag, .stale-note, .block-actions, .block-details, .handoff, .state .btn { display: none !important; }
  .page { max-width: none; margin: 0; padding: 0; border: 0; }
  .sec h1, .sec h2, .sec h3, .block-title { break-after: avoid; }
  .sec-data, .prose p, .prose li { break-inside: avoid; }
  .lh-rule, .sec-data { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

document.head.appendChild(el("style", { text: DATA_STYLES + STYLES }));
// The dark palettes skip this class, so a PDF made on a dark machine is still a light page.
if (isExport) document.documentElement.classList.add("document-export");

/* ═══════════════════════════════ 3. State ══════════════════════════════════ */

let meta: Meta = { revision: -1, title: "", period: { preset: "lastMonth" }, locations: [], letterhead: {}, sectionOrder: [], editions: [], lastModified: 0 };
let sections: Section[] = [];
let data: DataState = { status: "off", mode: "off" };
let review = new Set<string>();
let stale = new Set<string>();
let canUndo = false;
let canRedo = false;
/** The latest edition, with its blocks. */
let latest: Edition | null = null;
/** The earlier edition being read; null while the latest is shown. */
let earlier: Edition | null = null;
/** A newer edition that arrived while an earlier one was being read. */
let offered: EditionSummary | null = null;
let editMode = false;
let generating = false;
/** The section whose controls or editor last had focus: where "Add" inserts after. */
let selectedId: string | null = null;
let notice: { text: string; tone: "info" | "bad" } | null = null;
/** A question that needs a yes before something is removed; the sandbox has no confirm(). */
let question: { text: string; yes: string; run: () => Promise<void> } | null = null;
/** Data blocks the viewer switched to their table. */
const asTable = new Set<string>();
/** Failed blocks whose request for the agent is shown. */
const handoffs = new Set<string>();

/** A heading or text section being edited in place. Its draft is the input's value. */
interface Editing {
  id: string;
  kind: "heading" | "text";
  input: HTMLInputElement | HTMLTextAreaElement;
  /** The text the server last took from this editor. */
  saved: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves run one after another. */
  chain: Promise<void>;
  failed: boolean;
}
let editing: Editing | null = null;

function isReadOnly(): boolean {
  return isExport || data.mode === "snapshot" || globalThis.gadgetRenderMode === "snapshot";
}

function isEditable(): boolean {
  return editMode && !earlier && !isReadOnly();
}

function canGenerate(): boolean {
  return !isReadOnly() && data.mode === "live" && data.status !== "off" && data.status !== "empty";
}

/* ═══════════════════════════════ 4. Chrome ═════════════════════════════════ */

function button(label: string, key: string, onclick: () => void, extra = ""): HTMLButtonElement {
  return el("button", { type: "button", class: "btn" + (extra ? " " + extra : ""), "data-key": key, onclick }, label);
}

/** Runs a person's action and says so in plain words when the server refuses it. */
async function act(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    say(messageOf(error), "bad");
  }
}

function say(text: string, tone: "info" | "bad" = "info"): void {
  notice = { text, tone };
  render();
}

const titleText = el("div", { class: "bar-title" });
const titleInput: HTMLInputElement = el("input", {
  class: "bar-title-input",
  type: "text",
  "aria-label": "Report title",
  maxlength: LIMITS.title,
  "data-key": "title",
  onchange: () => {
    const title = titleInput.value.trim();
    if (!title || title === meta.title) {
      titleInput.value = meta.title;
      return;
    }
    void act(async () => settle((await gadget.setTitle({ title, clientId })).revision));
  },
});
const picker: HTMLSelectElement = el("select", { id: "edition-picker", "data-key": "picker", onchange: () => void act(() => showEdition(picker.value)) });
const pickerGroup = el("div", { class: "bar-group" }, [el("label", { class: "bar-label", for: "edition-picker" }, "Edition"), picker]);
const pinButton = button("Pin", "pin", () => void act(togglePin));
const deleteEditionButton = button("Delete edition", "delete-edition", askDeleteEdition);
const generateButton = button("Regenerate", "generate", () => void regenerate(false), "primary");
const editButton = button("Edit", "edit-mode", () => void toggleEdit());
const undoButton = button("Undo", "undo", () => void act(async () => applyStep(await gadget.undo({ clientId }))));
const redoButton = button("Redo", "redo", () => void act(async () => applyStep(await gadget.redo({ clientId }))));
const badge = el("span", { class: "badge" }, "Read-only copy");
const header = el("header", { class: "bar" }, [
  titleText,
  titleInput,
  pickerGroup,
  el("div", { class: "bar-group" }, [pinButton, deleteEditionButton, generateButton, editButton, undoButton, redoButton, badge]),
]);

function editionLabel(edition: EditionSummary): string {
  return `As of ${formatTime(edition.asOf)} — ${describeRange(edition.period)}${edition.pinned ? " (pinned)" : ""}`;
}

let pickerShown = "";
function renderHeader(): void {
  const readOnly = isReadOnly();
  const viewed = earlier ?? latest;
  titleText.textContent = meta.title;
  titleText.hidden = editMode;
  titleInput.hidden = !editMode;
  if (document.activeElement !== titleInput) titleInput.value = meta.title;
  if (meta.title) document.title = meta.title;

  // Newest first. The options are rebuilt only when the list changed, so an open picker stays put.
  const listed = JSON.stringify(meta.editions);
  if (listed !== pickerShown) {
    pickerShown = listed;
    picker.replaceChildren(...meta.editions.map((edition) => el("option", { value: edition.id }, editionLabel(edition))));
  }
  if (viewed) picker.value = viewed.id;
  pickerGroup.hidden = meta.editions.length === 0;

  pinButton.hidden = !viewed || readOnly;
  pinButton.textContent = viewed?.pinned ? "Unpin" : "Pin";
  pinButton.setAttribute("aria-pressed", String(viewed?.pinned === true));
  pinButton.setAttribute("aria-label", viewed?.pinned ? "Unpin this edition" : "Pin this edition so it is always kept");
  deleteEditionButton.hidden = !viewed || readOnly;

  // Before the first edition the page itself offers Generate, beside the reason nothing is shown.
  generateButton.hidden = !canGenerate() || meta.editions.length === 0;
  generateButton.textContent = generating ? "Generating…" : "Regenerate";
  generateButton.disabled = generating;
  generateButton.setAttribute("aria-busy", String(generating));

  editButton.hidden = readOnly;
  editButton.textContent = editMode ? "Done" : "Edit";
  editButton.setAttribute("aria-pressed", String(editMode));
  undoButton.hidden = redoButton.hidden = !editMode || readOnly;
  undoButton.disabled = !canUndo;
  redoButton.disabled = !canRedo;
  badge.hidden = !(data.mode === "snapshot" || globalThis.gadgetRenderMode === "snapshot");
}

// ---- The edit panel: add sections, the period, the locations and the letterhead.

function field(label: string, control: HTMLElement): HTMLElement {
  return el("div", { class: "field" }, [el("label", { for: control.id }, label), control]);
}

const periodSelect = el("select", { id: "period-select", "data-key": "period", onchange: onPeriodChange }, [
  ...DATE_PRESETS.map((preset) => el("option", { value: preset.id }, preset.label)),
  el("option", { value: "custom" }, "Custom range"),
]);
const fromInput = el("input", { type: "date", id: "period-from", "data-key": "from", onchange: onRangeChange });
const toInput = el("input", { type: "date", id: "period-to", "data-key": "to", onchange: onRangeChange });
const fromField = field("From", fromInput);
const toField = field("To", toInput);
const locationsBox = el("fieldset", { class: "locations" });
const nameInput: HTMLInputElement = el("input", {
  type: "text",
  id: "letterhead-name",
  "data-key": "letterhead-name",
  maxlength: LIMITS.letterheadName,
  onchange: () => saveLetterhead({ ...meta.letterhead, name: nameInput.value.trim() || undefined }),
});
const accentInput: HTMLInputElement = el("input", {
  type: "color",
  id: "letterhead-accent",
  "data-key": "letterhead-accent",
  onchange: () => saveLetterhead({ ...meta.letterhead, accent: accentInput.value }),
});
const clearAccentButton = button("Use the default colour", "clear-accent", () => saveLetterhead({ ...meta.letterhead, accent: undefined }), "small");
const logoInput = el("input", { type: "file", id: "letterhead-logo", "data-key": "letterhead-logo", accept: LOGO_TYPES.join(","), onchange: () => void act(uploadLogo) });
const removeLogoButton = button("Remove logo", "remove-logo", () => saveLetterhead({ ...meta.letterhead, logo: undefined }), "small");
const editPanel = el("div", { class: "edit-panel", role: "group", "aria-label": "Report settings" }, [
  el("div", { class: "field-row" }, [
    button("Add heading", "add-heading", () => addSection({ kind: "heading", level: 2, text: "New heading" })),
    button("Add text", "add-text", () => addSection({ kind: "text", text: "" })),
  ]),
  field("Period", periodSelect),
  fromField,
  toField,
  locationsBox,
  field("Letterhead name", nameInput),
  el("div", { class: "field" }, [el("label", { for: "letterhead-accent" }, "Accent colour"), el("div", { class: "field-row" }, [accentInput, clearAccentButton])]),
  el("div", { class: "field" }, [el("label", { for: "letterhead-logo" }, "Logo (PNG, JPEG or SVG, up to 200 KB)"), el("div", { class: "field-row" }, [logoInput, removeLogoButton])]),
]);

function onPeriodChange(): void {
  const custom = periodSelect.value === "custom";
  fromField.hidden = toField.hidden = !custom;
  // A custom range is sent once both of its dates are chosen.
  if (custom) return;
  const preset = DATE_PRESETS.find((known) => known.id === periodSelect.value);
  if (preset) savePeriod({ preset: preset.id }, meta.locations);
}

function onRangeChange(): void {
  const from = fromInput.value, to = toInput.value;
  if (!from || !to) return;
  if (from > to) {
    say("The start date must not be after the end date.", "bad");
    return;
  }
  savePeriod({ from, to }, meta.locations);
}

function savePeriod(period: DateRangeFilter, locations: number[]): void {
  void act(async () => settle((await gadget.setPeriod({ period, locations, clientId })).revision));
}

function saveLetterhead(letterhead: Letterhead): void {
  void act(async () => settle((await gadget.setLetterhead({ letterhead, clientId })).revision));
}

async function uploadLogo(): Promise<void> {
  const file = logoInput.files?.[0];
  logoInput.value = "";
  if (!file) return;
  if (!LOGO_TYPES.includes(file.type)) throw new Error("The logo must be a PNG, JPEG or SVG image.");
  const logo = await readFileAsDataURL(file);
  if (logo.length > LIMITS.logo) throw new Error("The logo is too large. Use an image of at most 200 KB.");
  await settle((await gadget.setLetterhead({ letterhead: { ...meta.letterhead, logo }, clientId })).revision);
}

let locationsShown = "";
function renderEditPanel(): void {
  editPanel.hidden = !isEditable();
  if (editPanel.hidden) return;
  const active = document.activeElement;
  if (active !== periodSelect && active !== fromInput && active !== toInput) {
    const custom = !("preset" in meta.period);
    periodSelect.value = "preset" in meta.period ? meta.period.preset : "custom";
    fromField.hidden = toField.hidden = !custom;
    if ("from" in meta.period) {
      fromInput.value = meta.period.from;
      toInput.value = meta.period.to;
    }
  }
  // With one location, or none known, there is nothing to choose between.
  const locations = data.status === "ok" ? data.locations : [];
  locationsBox.hidden = locations.length < 2;
  const listed = JSON.stringify([locations, meta.locations]);
  if (listed !== locationsShown && !locationsBox.contains(active)) {
    locationsShown = listed;
    locationsBox.replaceChildren(
      el("legend", {}, "Locations (none ticked means all)"),
      ...locations.map((location) => {
        const box = el("input", { type: "checkbox", value: location.id, "data-key": "location-" + location.id, onchange: onLocationsChange });
        box.checked = meta.locations.includes(location.id);
        return el("label", {}, [box, location.name]);
      }),
    );
  }
  if (active !== nameInput) nameInput.value = meta.letterhead.name ?? "";
  if (active !== accentInput) accentInput.value = meta.letterhead.accent ?? "#2563eb";
  clearAccentButton.hidden = !meta.letterhead.accent;
  removeLogoButton.hidden = !meta.letterhead.logo;
}

function onLocationsChange(): void {
  const chosen: number[] = [];
  for (const box of Array.from(locationsBox.querySelectorAll("input"))) if (box.checked) chosen.push(Number(box.value));
  savePeriod(meta.period, chosen);
}

// ---- Notices: banners and messages, read out politely as they change.

const notices = el("div", { class: "notices", "aria-live": "polite" });
let noticesShown = "";

function noticeBar(tone: string, text: string, actions: HTMLElement[]): HTMLElement {
  return el("div", { class: "notice" + (tone ? " " + tone : "") }, [el("p", {}, text), ...actions]);
}

function renderNotices(): void {
  const signature = JSON.stringify([earlier?.id, earlier?.asOf, offered, notice, question?.text, data.status === "error" ? data.error : "", meta.editions.length > 0]);
  if (signature === noticesShown) return;
  noticesShown = signature;
  const bars: HTMLElement[] = [];
  if (earlier) {
    bars.push(noticeBar("warn", `You are reading an earlier edition. Its numbers are as of ${formatTime(earlier.asOf)}.`, [
      button("Back to latest", "back-to-latest", () => void act(() => showEdition(null)), "small"),
    ]));
  }
  if (offered) {
    bars.push(noticeBar("", "A new edition is available.", [button("Show it", "show-new", () => void act(() => showEdition(null)), "small")]));
  }
  // With an edition on the page a failed status read is a notice; with none it is the page's state.
  if (data.status === "error" && meta.editions.length > 0) bars.push(noticeBar("bad", "The data could not be read: " + data.error, []));
  if (question) {
    const asked = question;
    bars.push(noticeBar("warn", asked.text, [
      button(asked.yes, "question-yes", () => {
        question = null;
        void act(asked.run);
        render();
      }, "small"),
      button("Cancel", "question-no", () => {
        question = null;
        render();
      }, "small"),
    ]));
  }
  if (notice) {
    bars.push(noticeBar(notice.tone === "bad" ? "bad" : "", notice.text, [
      button("Dismiss", "dismiss", () => {
        notice = null;
        render();
      }, "small"),
    ]));
  }
  notices.replaceChildren(...bars);
}

/* ═══════════════════════════════ 5. The page ═══════════════════════════════ */

const pageHead = el("div", { class: "page-head" });
const stateBox = el("div", { class: "state", hidden: true });
const list = el("div", { class: "sections" });
const page = el("main", { class: "page" }, [pageHead, stateBox, list]);
const root = el("div", { class: "report" }, isExport ? [page] : [header, editPanel, notices, page]);
document.body.appendChild(root);

/** What the page draws for one section. */
interface Shown {
  block: EditionBlock;
  flagged: boolean;
  stale: boolean;
}

// The latest view is the report's current text with the latest edition's results; an earlier
// edition is its own blocks exactly as stored.
function shownBlocks(): Shown[] {
  if (earlier) return earlier.blocks.map((block) => ({ block, flagged: false, stale: false }));
  const blocks = currentBlocks(sections, Array.from(stale), latest);
  const editable = isEditable();
  return blocks
    .filter((block) => {
      if (block.kind !== "data" || editable) return true;
      // A printed report leaves out what its edition does not hold, and a report that cannot be
      // generated shows no frame of empty blocks.
      if (isExport) return block.outcome !== undefined;
      return meta.editions.length > 0 || (data.status === "ok" && data.mode !== "off");
    })
    .map((block) => ({ block, flagged: !isExport && review.has(block.id), stale: latest !== null && stale.has(block.id) }));
}

let headShown = "";
function renderHead(): void {
  const viewed = earlier ?? latest;
  const title = earlier ? earlier.title : meta.title;
  const letterhead = earlier ? earlier.letterhead : meta.letterhead;
  const first = (earlier ? earlier.blocks : sections)[0];
  // A report that opens with its own title as a level-1 heading is not given the title twice.
  const titled = first !== undefined && first.kind === "heading" && first.level === 1 && first.text.trim().toLowerCase() === title.trim().toLowerCase();
  const signature = JSON.stringify([title, letterhead, titled, viewed?.asOf, viewed?.period]);
  if (signature === headShown) return;
  headShown = signature;

  const accent = letterhead.accent && ACCENT.test(letterhead.accent) ? letterhead.accent : null;
  if (accent) page.style.setProperty("--accent", accent);
  else page.style.removeProperty("--accent");
  const children: HTMLElement[] = [];
  const logo = letterhead.logo && LOGO_URL.test(letterhead.logo) ? letterhead.logo : null;
  if (logo || letterhead.name || accent) {
    children.push(
      el("div", { class: "letterhead" }, [
        // Only ever an image: an SVG logo is never put into the page as markup.
        logo && el("img", { class: "lh-logo", src: logo, alt: letterhead.name ? letterhead.name + " logo" : "Logo" }),
        letterhead.name && el("span", { class: "lh-name" }, letterhead.name),
      ]),
      el("hr", { class: "lh-rule" }),
    );
  }
  if (!titled) children.push(el("h1", { class: "doc-title" }, title));
  if (viewed) children.push(el("p", { class: "asof" }, `As of ${formatTime(viewed.asOf)} · ${describeRange(viewed.period)}`));
  pageHead.replaceChildren(...children);
}

let stateShown = "";
function renderState(): void {
  let text = "";
  let offerGenerate = false;
  if (data.mode === "off" || data.status === "off") {
    // A view-only copy made before any status was stored says nothing about the organization's data.
    if (data.mode !== "snapshot") text = OFF_TEXT;
    else if (meta.editions.length === 0) text = NOT_GENERATED_TEXT;
  } else if (meta.editions.length === 0) {
    if (data.status === "empty") text = EMPTY_TEXT;
    else if (data.status === "error") text = "The data could not be read: " + data.error;
    else {
      text = NOT_GENERATED_TEXT;
      offerGenerate = canGenerate();
    }
  }
  const signature = JSON.stringify([text, offerGenerate, generating]);
  if (signature === stateShown) return;
  stateShown = signature;
  stateBox.hidden = text === "";
  const children: HTMLElement[] = [el("p", {}, text)];
  if (offerGenerate) {
    const generate = button(generating ? "Generating…" : "Generate", "state-generate", () => void regenerate(false), "primary");
    generate.disabled = generating;
    children.push(generate);
  }
  stateBox.replaceChildren(...children);
}

/** The section nodes on the page, by section id, each with what it was drawn from. */
const nodes = new Map<string, { signature: string; node: HTMLElement }>();

function renderSections(): void {
  const editable = isEditable();
  const shown = shownBlocks();
  const viewed = earlier ?? latest;
  const view = JSON.stringify([earlier ? "earlier" : "latest", viewed?.id, viewed?.asOf, viewed?.completeThrough, editable, earlier ? earlier.title : meta.title]);
  const order = sections.map((section) => section.id);
  const wanted = new Set<string>();
  shown.forEach((item, position) => {
    const { outcome, ...section } = item.block;
    const id = section.id;
    wanted.add(id);
    const index = order.indexOf(id);
    // An edition's outcome for a section never changes, so its presence stands for its content.
    const signature = JSON.stringify([view, section, outcome !== undefined, item.flagged, item.stale, index === 0, index === order.length - 1, asTable.has(id)]);
    let entry = nodes.get(id);
    // The section being edited keeps its editor whatever arrives: the local draft wins.
    if (!entry || (entry.signature !== signature && editing?.id !== id)) {
      const node = buildSection(item, editable, index === 0, index === order.length - 1);
      if (entry) entry.node.replaceWith(node);
      entry = { signature, node };
      nodes.set(id, entry);
    }
    const at = list.children[position];
    if (at !== entry.node) list.insertBefore(entry.node, at ?? null);
  });
  for (const [id, entry] of nodes) {
    if (wanted.has(id)) continue;
    entry.node.remove();
    nodes.delete(id);
  }
}

function buildSection(item: Shown, editable: boolean, first: boolean, last: boolean): HTMLElement {
  const { block } = item;
  const tools = editable ? sectionTools(block, first, last) : null;
  let node: HTMLElement;
  if (block.kind === "heading") {
    const heading = el(HEADING_TAGS[block.level], { class: "heading" }, block.text);
    if (editable) heading.addEventListener("click", () => startEditing(block.id));
    node = el("div", { class: "sec sec-heading" + (editable ? " editable" : "") }, [tools, heading]);
  } else if (block.kind === "text") {
    const body = block.text.trim() === "" && editable
      ? el("div", { class: "prose placeholder" }, "No text yet. Select Edit to write here.")
      : el("div", { class: "prose", html: renderMarkdownLite(block.text) });
    if (editable) body.addEventListener("click", () => startEditing(block.id));
    const flag = el("div", { class: "flag-slot", "aria-live": "polite" }, item.flagged ? reviewFlag(block.id) : null);
    node = el("div", { class: "sec sec-text" + (editable ? " editable" : "") }, [tools, flag, body]);
  } else {
    node = buildBlock(block, item.stale, tools);
  }
  node.dataset.section = block.id;
  node.addEventListener("focusin", () => { selectedId = block.id; });
  return node;
}

function reviewFlag(id: string): HTMLElement {
  const children: ElChild[] = [el("span", {}, REVIEW_TEXT)];
  if (!isReadOnly()) {
    children.push(button("Mark as reviewed", "mark-reviewed", () => void act(async () => settle((await gadget.markReviewed({ ids: [id], clientId })).revision)), "small"));
  }
  return el("div", { class: "flag" }, children);
}

function labelOf(section: Section): string {
  if (section.kind === "data") return section.title;
  const text = section.text.replace(/\s+/g, " ").trim();
  if (!text) return section.kind === "heading" ? "heading" : "empty text";
  return text.length > 40 ? text.slice(0, 39) + "…" : text;
}

function sectionTools(block: EditionBlock, first: boolean, last: boolean): HTMLElement {
  const name = labelOf(block);
  const tool = (label: string, key: string, onclick: () => void, disabled = false): HTMLButtonElement => {
    const control = button(label, key, onclick, "small");
    control.setAttribute("aria-label", `${label}: ${name}`);
    control.disabled = disabled;
    return control;
  };
  const children: HTMLElement[] = [];
  if (block.kind === "data") {
    const title = el("input", { type: "text", "aria-label": "Block title", "data-key": "block-title", maxlength: LIMITS.blockTitle });
    title.value = block.title;
    title.addEventListener("change", () => {
      const next = title.value.trim();
      if (!next || next === block.title) {
        title.value = block.title;
        return;
      }
      void act(async () => settle((await gadget.updateSection({ id: block.id, title: next, clientId })).revision));
    });
    // Only the types the block's last result can be drawn as, and always the one it has.
    const result = block.outcome && !isFailure(block.outcome) ? block.outcome : null;
    const types: VisualType[] = (result ? compatibleVisuals(result.columns, result.rows.length) : []).filter((type) => type !== "text");
    if (!types.includes(block.visual.type)) types.unshift(block.visual.type);
    const visual = el("select", { "aria-label": "Show as", "data-key": "visual" }, types.map((type) => el("option", { value: type }, VISUAL_LABELS[type])));
    visual.value = block.visual.type;
    visual.addEventListener("change", () => {
      const type = types.find((known) => known === visual.value);
      if (!type || type === block.visual.type) return;
      void act(async () => settle((await gadget.updateSection({ id: block.id, visual: { ...block.visual, type }, clientId })).revision));
    });
    children.push(title, visual);
  } else {
    children.push(tool("Edit", "edit", () => startEditing(block.id)));
  }
  children.push(
    tool("Move up", "up", () => moveSection(block.id, -1), first),
    tool("Move down", "down", () => moveSection(block.id, 1), last),
    tool("Delete", "delete", () => void act(async () => settle((await gadget.removeSection({ id: block.id, clientId })).revision))),
  );
  return el("div", { class: "sec-tools", role: "group", "aria-label": `Section: ${name}` }, children);
}

// ---- Data blocks

function buildBlock(block: DataSection & { outcome?: QueryOutcome }, isStale: boolean, tools: HTMLElement | null): HTMLElement {
  const titleId = "block-title-" + block.id;
  const children: ElChild[] = [tools, el("p", { class: "block-title", id: titleId }, block.title)];
  const outcome = block.outcome;
  if (!outcome) {
    const text = isStale ? STALE_TEXT
      : latest || earlier ? "This edition does not hold this block."
      : meta.editions.length > 0 ? "Loading the latest edition…"
      : data.status === "ok" && data.mode !== "off" ? "Generate the report to fill this in."
      : "There is no data to show here.";
    children.push(el("p", { class: "block-meta" + (isStale ? " stale-note" : "") }, text));
  } else if (isFailure(outcome)) {
    children.push(el("p", { class: "block-error" }, outcome.error));
    if (!isExport) children.push(...handoff(block, outcome.error));
  } else {
    children.push(...resultParts(block, outcome));
  }
  return el("section", { class: "sec sec-data w-" + block.width, "aria-labelledby": titleId }, children);
}

function resultParts(block: DataSection, result: QueryResult): ElChild[] {
  const viewed = earlier ?? latest;
  const tabular = asTable.has(block.id) && block.visual.type !== "table";
  const rendered = renderVisual(result, block.visual, VISUAL_SIZES[block.width]);
  const parts: ElChild[] = [el("div", { class: "block-visual", html: tabular ? renderTable(result) : rendered.html })];
  for (const note of rendered.notes) parts.push(el("p", { class: "data-note" }, note));
  if (viewed && viewed.completeThrough !== null && result.period.to > viewed.completeThrough) {
    parts.push(el("p", { class: "data-note" }, `Data is complete through ${formatDate(viewed.completeThrough)}; later days may be missing.`));
  }
  parts.push(el("p", { class: "block-meta" }, `As of ${formatTime(viewed ? viewed.asOf : result.ranAt)} · ${describeRange(result.period)}`));
  if (isExport) return parts;

  if (block.visual.type !== "table") {
    const toggle = button(tabular ? "Show as chart" : "Show as table", "as-table", () => {
      if (!asTable.delete(block.id)) asTable.add(block.id);
      render();
    }, "small");
    toggle.setAttribute("aria-pressed", String(tabular));
    parts.push(el("div", { class: "block-actions" }, toggle));
  }
  const source = block.query.kind === "metric"
    ? [
      ["Metric", block.query.metric],
      ["Grouped by", block.query.groupBy?.length ? block.query.groupBy.join(", ") : "nothing"],
      ["Compared with", block.query.compare ? "the previous period of the same length" : "nothing"],
    ]
    : [["Parameters", Object.entries(block.query.params ?? {}).map(([name, value]) => `:${name} = ${String(value)}`).join(", ") || "none of its own"]];
  const rows: [string, ElChild][] = [
    ...(block.query.kind === "sql" ? [["Query", el("pre", {}, block.query.sql)] as [string, ElChild]] : []),
    ...source.map(([term, value]): [string, ElChild] => [term, value]),
    ["Period", describeRange(result.period)],
    ["Last ran", formatTime(result.ranAt)],
    ["Rows", String(result.rowCount)],
    ["Duration", `${result.durationMs} ms`],
  ];
  parts.push(el("details", { class: "block-details" }, [
    el("summary", {}, "Details"),
    el("dl", {}, rows.flatMap(([term, value]) => [el("dt", {}, term), el("dd", {}, value)])),
  ]));
  return parts;
}

// The page cannot open the chat or write into it, so a failed block offers the request to paste
// there: shown in a read-only box, selected, and copied when the browser allows it.
function handoff(block: DataSection, error: string): HTMLElement[] {
  const open = handoffs.has(block.id);
  const request = `In the report "${earlier ? earlier.title : meta.title}", the block "${block.title}" could not be computed: ${error.replace(/[.\s]+$/, "")}. Please fix its query.`;
  const box = el("textarea", { readonly: true, rows: 3, "aria-label": "Request for the agent", "data-key": "handoff-text" });
  box.value = request;
  const note = el("p", { "aria-live": "polite" });
  const panel = el("div", { class: "handoff" }, [box, note]);
  panel.hidden = !open;
  const fix = button("Fix with agent", "fix", () => {
    handoffs.add(block.id);
    panel.hidden = false;
    box.focus();
    box.select();
    let copied = false;
    try {
      // Inside the click, where the sandbox allows it; navigator.clipboard is not available here.
      copied = typeof document.execCommand === "function" && document.execCommand("copy");
    } catch {
      copied = false;
    }
    note.textContent = copied
      ? "Copied. Paste it into the chat with the agent."
      : "Copy this text and paste it into the chat with the agent.";
  }, "small");
  fix.setAttribute("aria-expanded", String(open));
  fix.addEventListener("click", () => fix.setAttribute("aria-expanded", "true"));
  return [el("div", { class: "block-actions" }, fix), panel];
}

/* ═══════════════════════════ 6. Editing in place ═══════════════════════════ */

function startEditing(id: string): void {
  if (editing?.id === id) {
    editing.input.focus();
    return;
  }
  const section = sections.find((known) => known.id === id);
  const entry = nodes.get(id);
  if (!section || section.kind === "data" || !entry || !isEditable()) return;
  if (editing) void finishEditing(editing);

  const input = section.kind === "text"
    ? el("textarea", { "aria-label": "Text, in Markdown", "data-key": "editor", rows: Math.min(30, Math.max(4, section.text.split("\n").length + 1)), maxlength: LIMITS.text })
    : el("input", { type: "text", "aria-label": "Heading text", "data-key": "editor", maxlength: LIMITS.heading });
  input.value = section.text;
  const target: Editing = { id, kind: section.kind, input, saved: section.text, timer: undefined, chain: Promise.resolve(), failed: false };
  const fields: HTMLElement[] = [input];
  if (section.kind === "heading") {
    const level = el("select", { "aria-label": "Heading level", "data-key": "level" }, [1, 2, 3].map((n) => el("option", { value: n }, "Heading " + n)));
    level.value = String(section.level);
    level.addEventListener("change", () => {
      const chosen = level.value === "1" ? 1 : level.value === "3" ? 3 : 2;
      void act(async () => settle((await gadget.updateSection({ id, level: chosen, clientId })).revision));
    });
    fields.push(level);
  }
  const box = el("div", { class: "editor" }, fields);
  // Listeners go on through the element type the two kinds of input share.
  const control: HTMLElement = input;
  control.addEventListener("input", () => {
    clearTimeout(target.timer);
    target.timer = setTimeout(() => void saveDraft(target), SAVE_PAUSE_MS);
  });
  control.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // Saves, closes, and leaves focus on the section's Edit button.
    void finishEditing(target).then(() => nodes.get(id)?.node.querySelector<HTMLElement>('[data-key="edit"]')?.focus());
  });
  // Leaving the editor saves and closes it; moving between its own fields does not.
  box.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && box.contains(next)) return;
    void finishEditing(target);
  });
  entry.node.replaceChildren(box);
  editing = target;
  input.focus();
}

/** Sends the draft when it differs from what the server last took. */
function saveDraft(target: Editing): Promise<void> {
  clearTimeout(target.timer);
  target.chain = target.chain.then(async () => {
    const value = target.input.value;
    // A heading cannot be empty: an emptied one keeps its last text.
    if (value === target.saved || (target.kind === "heading" && !value.trim())) return;
    try {
      const result = await gadget.updateSection({ id: target.id, text: value, clientId });
      target.saved = value;
      target.failed = false;
      await settle(result.revision);
    } catch (error) {
      target.failed = true;
      say("Your text was not saved: " + messageOf(error), "bad");
    }
  });
  return target.chain;
}

async function finishEditing(target: Editing): Promise<void> {
  await saveDraft(target);
  // A draft the server refused stays on screen, so nothing typed is lost.
  if (target.failed && target.input.value !== target.saved) return;
  if (editing === target) editing = null;
  const entry = nodes.get(target.id);
  if (entry && entry.node.contains(target.input)) entry.signature = "";
  render();
}

/* ═══════════════════════════════ 7. Actions ════════════════════════════════ */

/** Catches up when a change this page made has not arrived as an event. */
async function settle(revision: number): Promise<void> {
  if (revision > meta.revision) applyOpened(await gadget.open());
}

function applyStep(changed: Changed | null): void {
  if (changed) applyChanged(changed);
}

function addSection(section: SectionInput): void {
  const after = selectedId !== null && sections.some((known) => known.id === selectedId) ? selectedId : undefined;
  void act(async () => {
    const added = await gadget.addSection({ section, after, clientId });
    await settle(added.revision);
    startEditing(added.sectionId);
  });
}

function moveSection(id: string, direction: -1 | 1): void {
  const index = sections.findIndex((section) => section.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sections.length) return;
  // Moving up lands after the section two places before; moving down, after the next one.
  const after = direction === 1 ? sections[target].id : target === 0 ? null : sections[target - 1].id;
  void act(async () => settle((await gadget.moveSection({ id, after, clientId })).revision));
}

async function toggleEdit(): Promise<void> {
  if (editMode && editing) await finishEditing(editing);
  editMode = !editMode;
  // Editing changes the report as it stands now, which is what the latest view shows.
  if (editMode) earlier = null;
  render();
}

/** Shows an edition: an earlier one by id, or the latest (null, or the latest's own id). */
async function showEdition(id: string | null): Promise<void> {
  if (id === null || id === meta.editions[0]?.id) {
    earlier = null;
    offered = null;
    render();
    return;
  }
  const edition = await gadget.getEdition({ id });
  if (editing) await finishEditing(editing);
  earlier = edition;
  editMode = false;
  render();
}

async function togglePin(): Promise<void> {
  const viewed = earlier ?? latest;
  if (viewed) await settle((await gadget.pinEdition({ id: viewed.id, pinned: !viewed.pinned, clientId })).revision);
}

function askDeleteEdition(): void {
  const viewed = earlier ?? latest;
  if (!viewed) return;
  question = {
    text: `Delete the edition as of ${formatTime(viewed.asOf)}? Its numbers cannot be brought back.`,
    yes: "Delete edition",
    run: async () => settle((await gadget.deleteEdition({ id: viewed.id, clientId })).revision),
  };
  render();
}

async function regenerate(confirmed: boolean): Promise<void> {
  if (generating || !canGenerate()) return;
  // A report keeps a fixed number of editions, so a person is told what goes before it goes.
  if (!confirmed && meta.editions.length >= LIMITS.editions) {
    const unpinned = meta.editions.filter((edition) => !edition.pinned);
    if (!unpinned.length) {
      say(ALL_PINNED_TEXT, "bad");
      return;
    }
    const oldest = unpinned.reduce((a, b) => (b.asOf < a.asOf ? b : a));
    question = {
      text: `This report keeps ${LIMITS.editions} editions. Generating a new one removes the oldest that is not pinned, as of ${formatTime(oldest.asOf)}.`,
      yes: "Generate",
      run: () => regenerate(true),
    };
    render();
    return;
  }
  generating = true;
  notice = null;
  render();
  try {
    const result = await gadget.generate({ createdBy: "member" });
    earlier = null;
    offered = null;
    applyOpened(await gadget.open());
    const failed = result.failed.length;
    notice = { text: failed ? `A new edition was generated. ${failed} ${failed === 1 ? "block" : "blocks"} could not be computed.` : "A new edition was generated.", tone: failed ? "bad" : "info" };
  } catch (error) {
    notice = { text: messageOf(error), tone: "bad" };
  } finally {
    generating = false;
    render();
  }
}

/* ═════════════════════ 8. Live updates and connecting ══════════════════════ */

/** Where focus is, as something that can be found again after the page is redrawn. */
function focusToken(): { section: string | null; key: string } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.dataset.key) return null;
  return { section: active.closest<HTMLElement>("[data-section]")?.dataset.section ?? null, key: active.dataset.key };
}

function render(): void {
  const focus = focusToken();
  if (!isExport) {
    renderHeader();
    renderEditPanel();
    renderNotices();
  }
  renderHead();
  renderState();
  renderSections();
  // A control that was redrawn or moved lost focus to the body: give it back to the same control.
  const active = document.activeElement;
  if (focus && !(active instanceof HTMLElement && active !== document.body && active.isConnected)) {
    const scope = focus.section === null ? root : nodes.get(focus.section)?.node;
    scope?.querySelector<HTMLElement>(`[data-key="${focus.key}"]`)?.focus();
  }
}

/** Keeps the editions on the page in step with the report's list of them. */
function followEditions(): void {
  const summaries = new Map(meta.editions.map((edition) => [edition.id, edition]));
  if (earlier) {
    const summary = summaries.get(earlier.id);
    if (summary) earlier = { ...earlier, pinned: summary.pinned };
    else {
      earlier = null;
      notice = { text: "The edition you were reading is no longer available.", tone: "info" };
    }
  }
  if (offered && offered.id !== meta.editions[0]?.id) offered = null;
  const newest = meta.editions[0];
  if (!newest) latest = null;
  else if (latest?.id === newest.id) latest = { ...latest, pinned: newest.pinned };
  else void loadLatest(newest.id);
}

const loading = new Set<string>();
async function loadLatest(id: string): Promise<void> {
  if (loading.has(id)) return;
  loading.add(id);
  try {
    const edition = await gadget.getEdition({ id });
    if (meta.editions[0]?.id === id) {
      latest = edition;
      render();
    }
  } catch (error) {
    say(messageOf(error), "bad");
  } finally {
    loading.delete(id);
  }
}

function applyReport(next: { meta: Meta; sections: Section[]; review: string[]; stale: string[]; canUndo: boolean; canRedo: boolean }): void {
  meta = next.meta;
  sections = next.sections;
  review = new Set(next.review);
  stale = new Set(next.stale);
  canUndo = next.canUndo;
  canRedo = next.canRedo;
  if (editing && !sections.some((section) => section.id === editing?.id)) {
    clearTimeout(editing.timer);
    editing = null;
    notice = { text: "The section you were editing was removed.", tone: "info" };
  }
}

function applyOpened(opened: Opened): void {
  applyReport(opened);
  data = opened.data;
  // `open()` is asked for no edition in particular, so the one it brings is the latest.
  latest = opened.edition;
  followEditions();
  render();
}

function applyChanged(event: Changed): void {
  if (event.revision <= meta.revision) return;
  applyReport(event);
  followEditions();
  render();
}

function applyGenerated(event: Generated): void {
  // While an earlier edition is being read the new one is offered, not put in its place.
  if (earlier) {
    offered = event.edition;
    render();
  } else if (latest?.id !== event.edition.id) void loadLatest(event.edition.id);
}

type ReportSubscriber = SubscriberCallbacks & Disposable;
let ready = false;
/** Events that arrive before the first (or a reconnect's) state is applied, replayed after it. */
let buffered: (() => void)[] = [];
// The subscriber the server holds, until it drops it. A connect attempt that fails after
// subscribing retries without subscribing a second one.
let subscription: ReportSubscriber | null = null;

function newSubscriber(): ReportSubscriber {
  return createSubscriber<ReportSubscriber>(RpcTarget, {
    changed(event: Changed) {
      if (ready) applyChanged(event);
      else buffered.push(() => applyChanged(event));
    },
    generated(event: Generated) {
      if (ready) applyGenerated(event);
      else buffered.push(() => applyGenerated(event));
    },
    // The server's handle on this subscriber is dropped when the connection breaks; subscribe
    // again so live updates keep flowing.
    [Symbol.dispose](this: ReportSubscriber) {
      if (subscription === this) subscription = null;
      ready = false;
      void ensureConnected();
    },
  });
}

async function connect(): Promise<void> {
  ready = false;
  for (let attempt = 0; ; attempt++) {
    try {
      let opened: Opened;
      // An export draws once from what is stored: it subscribes to nothing, generates nothing and
      // asks for no data.
      if (isExport || subscription) opened = await gadget.open();
      else {
        // Held before the call returns, so a drop during it is seen.
        const subscriber = subscription = newSubscriber();
        try {
          opened = await gadget.subscribe(subscriber, { clientId });
        } catch (error) {
          if (subscription === subscriber) subscription = null;
          throw error;
        }
      }
      // The subscriber was dropped meanwhile: subscribe again and re-read.
      if (!isExport && !subscription) continue;
      applyOpened(opened);
      ready = true;
      const events = buffered;
      buffered = [];
      for (const replay of events) replay();
      return;
    } catch (error) {
      console.error(error);
      buffered = [];
      if (isExport) {
        stateBox.hidden = false;
        stateBox.replaceChildren(el("p", {}, "This report could not be opened: " + messageOf(error)));
        return;
      }
      notice = { text: "The report could not be reached. Trying again…", tone: "bad" };
      renderNotices();
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)));
      if (notice?.text.startsWith("The report could not be reached")) notice = null;
    }
  }
}

let connecting: Promise<void> | null = null;
function ensureConnected(): Promise<void> {
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  return connecting;
}

// Resolves once the viewed edition is drawn, which is what an export waits for.
await ensureConnected();
