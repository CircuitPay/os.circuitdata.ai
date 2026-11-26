// The Report's page in a jsdom document, against a scripted `gadget` stub: which text and which
// numbers it shows for the latest and for an earlier edition, its states, and what an export
// prints. The module runs on import (it builds its page and connects), so each test imports a
// fresh copy.
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryFailure, QueryResult } from "@gadgets/bundled-blueprints/libraries/data/client";
import {
  type Changed,
  type DataSection,
  type DataState,
  type Edition,
  type EditionBlock,
  type EditionSummary,
  type GadgetStub,
  type HeadingSection,
  LIMITS,
  type Meta,
  type Opened,
  type Section,
  type SubscriberCallbacks,
  type TextSection,
} from "../files/lib/protocol.ts";

const OCTOBER = { from: "2025-10-01", to: "2025-10-31" };
const SEPTEMBER = { from: "2025-09-01", to: "2025-09-30" };

const OFF_TEXT = "Retail data is not turned on for this organization. An administrator can turn it on from Data in the navigation.";
const EMPTY_TEXT = "No sales data yet. Import a CSV or connect a source in Data, then generate this report.";
const NOT_GENERATED_TEXT = "This report has not been generated yet.";
const STALE_TEXT = "Not in the latest edition yet. Regenerate to include it.";
const REVIEW_TEXT = "The numbers changed since this was written. Review the text.";

const LOGO = "data:image/png;base64," + btoa("\x89PNG\r\n\x1a\n");

/** A single amount in US dollars, as a KPI's query returns it. */
function amount(cents: number, period = OCTOBER): QueryResult {
  return {
    columns: [{ name: "currency", type: "text" }, { name: "value", type: "money", currencyColumn: "currency" }],
    rows: [["USD", cents]],
    truncated: false,
    period,
    ranAt: Date.UTC(2025, 10, 3, 9, 12),
    durationMs: 18,
    rowCount: 1,
  };
}

function byDay(period = OCTOBER): QueryResult {
  return {
    columns: [{ name: "day", type: "date" }, { name: "currency", type: "text" }, { name: "value", type: "money", currencyColumn: "currency" }],
    rows: [[period.from, "USD", 40_000], [period.to, "USD", 83_456]],
    truncated: false,
    period,
    ranAt: Date.UTC(2025, 10, 3, 9, 12),
    durationMs: 25,
    rowCount: 2,
  };
}

const heading: HeadingSection = { id: "head0001", version: 1, kind: "heading", level: 1, text: "Monthly sales report" };
const subheading: HeadingSection = { id: "head0002", version: 1, kind: "heading", level: 2, text: "Summary" };
const summary: TextSection = { id: "text0001", version: 3, kind: "text", text: "Net sales were **$1,234.56** this month.", reviewedEdition: "ed000002" };
const netSales: DataSection = { id: "data0001", version: 1, kind: "data", title: "Net sales", visual: { type: "kpi" }, query: { kind: "metric", metric: "net_sales", compare: true }, width: "third" };
const salesByDay: DataSection = { id: "data0002", version: 1, kind: "data", title: "Sales by day", visual: { type: "line" }, query: { kind: "metric", metric: "net_sales", groupBy: ["day"] }, width: "full" };
const SECTIONS: Section[] = [heading, subheading, summary, netSales, salesByDay];

function edition(id: string, asOf: number, blocks: EditionBlock[], extra: Partial<Edition> = {}): Edition {
  return { id, asOf, period: OCTOBER, pinned: false, createdBy: "member", title: "Monthly sales report", letterhead: {}, completeThrough: "2025-10-31", blocks, fingerprints: {}, ...extra };
}

/** October's edition: the one the latest view draws its numbers from. */
const october = edition("ed000002", Date.UTC(2025, 10, 3, 9, 12), [
  heading,
  subheading,
  { ...summary, text: "Write a short summary of the month here." },
  { ...netSales, outcome: amount(123_456) },
  { ...salesByDay, outcome: byDay() },
]);

/** September's edition, with the text and the numbers it was stored with. */
const september = edition("ed000001", Date.UTC(2025, 9, 2, 8, 30), [
  heading,
  subheading,
  { ...summary, text: "Net sales were $999.00 in September." },
  { ...netSales, outcome: amount(99_900, SEPTEMBER) },
  { ...salesByDay, outcome: byDay(SEPTEMBER) },
], { period: SEPTEMBER, completeThrough: "2025-09-30" });

function summaryOf(of: Edition): EditionSummary {
  return { id: of.id, asOf: of.asOf, period: of.period, pinned: of.pinned, createdBy: of.createdBy };
}

const LIVE: DataState = {
  status: "ok",
  mode: "live",
  anchor: "2025-10-31",
  dateRange: { from: "2025-01-01", to: "2025-10-31" },
  completeThrough: "2025-10-31",
  personalDataMasked: true,
  locations: [{ id: 1, name: "Downtown" }, { id: 2, name: "Airport" }],
};

function meta(editions: Edition[], extra: Partial<Meta> = {}): Meta {
  return {
    revision: 7,
    title: "Monthly sales report",
    period: { preset: "lastMonth" },
    locations: [],
    letterhead: {},
    sectionOrder: SECTIONS.map((section) => section.id),
    editions: editions.map(summaryOf),
    lastModified: 0,
    ...extra,
  };
}

/** What the server opens with: October as the latest edition and September before it. */
function opened(extra: Partial<Opened> = {}): Opened {
  return { meta: meta([october, september]), sections: SECTIONS, data: LIVE, edition: october, review: [], stale: [], canUndo: false, canRedo: false, ...extra };
}

/** A report that has never been generated. */
function fresh(data: DataState = LIVE): Opened {
  return opened({ meta: meta([]), edition: null, data });
}

interface Harness {
  gadget: { [K in keyof GadgetStub]: Mock };
  /** The page's subscriber, as the server would call it. */
  callbacks: SubscriberCallbacks;
}

async function loadClient(first: Opened, options: { editions?: Edition[]; exportFormat?: string } = {}): Promise<Harness> {
  let callbacks: SubscriberCallbacks | null = null;
  const editions = new Map((options.editions ?? [october, september]).map((known) => [known.id, known]));
  const revised = async () => ({ revision: first.meta.revision });
  const gadget: Harness["gadget"] = {
    subscribe: vi.fn(async (callback: SubscriberCallbacks) => {
      callbacks = callback;
      return first;
    }),
    open: vi.fn(async () => first),
    getEdition: vi.fn(async ({ id }: { id: string }) => {
      const found = editions.get(id);
      if (!found) throw new Error("That edition no longer exists.");
      return found;
    }),
    undo: vi.fn(async () => null),
    redo: vi.fn(async () => null),
    addSection: vi.fn(async () => ({ sectionId: "added001", revision: first.meta.revision })),
    updateSection: vi.fn(async () => ({ revision: first.meta.revision, before: summary, after: summary })),
    removeSection: vi.fn(revised),
    moveSection: vi.fn(revised),
    setTitle: vi.fn(revised),
    setPeriod: vi.fn(revised),
    setLetterhead: vi.fn(revised),
    markReviewed: vi.fn(revised),
    generate: vi.fn(async () => ({ edition: summaryOf(october), review: [], failed: [] })),
    pinEdition: vi.fn(revised),
    deleteEdition: vi.fn(revised),
  };
  Object.assign(globalThis, { gadget, RpcTarget: class {}, gadgetExportFormatId: options.exportFormat, gadgetRenderMode: undefined });
  // The page builds itself and connects as its module is evaluated, so a fresh copy is loaded
  // here, after the globals it reads are in place; a static import would run once, before them.
  vi.resetModules();
  await import("../files/client.ts");
  if (options.exportFormat) return { gadget, callbacks: { changed: () => {}, generated: () => {} } };
  if (!callbacks) throw new Error("The page did not subscribe");
  return { gadget, callbacks };
}

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.className = "";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const page = () => document.querySelector<HTMLElement>("main.page")!;
const sectionNode = (id: string) => document.querySelector<HTMLElement>(`[data-section="${id}"]`);
const notices = () => document.querySelector<HTMLElement>(".notices")?.textContent ?? "";
const isShown = (node: Element) => node.closest("[hidden]") === null;

/** The visible button with this text. */
function buttonNamed(label: string, within: ParentNode = document): HTMLButtonElement {
  const found = Array.from(within.querySelectorAll("button")).find((candidate) => candidate.textContent === label && isShown(candidate));
  if (!found) throw new Error(`No visible button reads "${label}"`);
  return found;
}

function hasButton(label: string): boolean {
  return Array.from(document.querySelectorAll("button")).some((candidate) => candidate.textContent === label && isShown(candidate));
}

function changedEvent(base: Opened, extra: Partial<Changed>): Changed {
  return { revision: base.meta.revision + 1, meta: { ...base.meta, revision: base.meta.revision + 1 }, sections: base.sections, review: base.review, stale: base.stale, canUndo: true, canRedo: false, ...extra };
}

describe("the latest view", () => {
  it("shows the report's current text with the latest edition's results", async () => {
    await loadClient(opened());

    // The text is what the section says now, not what the edition stored.
    expect(sectionNode("text0001")?.textContent).toBe("Net sales were $1,234.56 this month.");
    expect(sectionNode("text0001")?.querySelector("strong")?.textContent).toBe("$1,234.56");
    expect(page().textContent).not.toContain("Write a short summary of the month here.");

    const kpi = sectionNode("data0001")!;
    expect(kpi.querySelector(".data-kpi-value")?.textContent).toBe("$1,234.56");
    expect(kpi.getAttribute("aria-labelledby")).toBe(kpi.querySelector(".block-title")?.id);
    expect(kpi.querySelector(".block-title")?.textContent).toBe("Net sales");
    expect(kpi.querySelector(".block-meta")?.textContent).toMatch(/^As of .+ · 1–31 Oct 2025$/);

    const chart = sectionNode("data0002")!.querySelector("svg[role='img']");
    expect(chart?.getAttribute("aria-label")).toBeTruthy();
    expect(page().querySelector(".asof")?.textContent).toMatch(/^As of .+ · 1–31 Oct 2025$/);
    expect(notices()).toBe("");
  });

  it("draws headings as real headings in order, and the title once", async () => {
    await loadClient(opened());
    const headings = Array.from(page().querySelectorAll("h1, h2, h3")).map((node) => [node.tagName, node.textContent]);
    expect(headings).toEqual([["H1", "Monthly sales report"], ["H2", "Summary"]]);

    document.body.replaceChildren();
    await loadClient(opened({ meta: meta([october, september], { title: "October for the board" }) }));
    expect(Array.from(page().querySelectorAll("h1")).map((node) => node.textContent)).toEqual(["October for the board", "Monthly sales report"]);
  });

  it("lists the editions newest first in a labelled picker, with pinned ones marked", async () => {
    await loadClient(opened({ meta: meta([october, { ...september, pinned: true }]) }));
    const picker = document.querySelector<HTMLSelectElement>("select#edition-picker")!;
    expect(document.querySelector("label[for='edition-picker']")?.textContent).toBe("Edition");
    expect(picker.value).toBe("ed000002");
    const labels = Array.from(picker.options).map((option) => option.textContent ?? "");
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/^As of .+ — 1–31 Oct 2025$/);
    expect(labels[1]).toMatch(/^As of .+ — 1–30 Sep 2025 \(pinned\)$/);
  });

  it("says a data section added or changed since the edition is not in it yet, instead of old numbers", async () => {
    await loadClient(opened({ stale: ["data0001"] }));
    const block = sectionNode("data0001")!;
    expect(block.textContent).toContain(STALE_TEXT);
    expect(block.textContent).not.toContain("$1,234.56");
    expect(sectionNode("data0002")!.querySelector("svg[role='img']")).not.toBeNull();
  });

  it("says when a block's period runs past what every source has reported", async () => {
    const partial = { ...october, completeThrough: "2025-10-20" };
    await loadClient(opened({ edition: partial }), { editions: [partial, september] });
    expect(sectionNode("data0001")!.textContent).toContain("Data is complete through 20 Oct 2025; later days may be missing.");

    document.body.replaceChildren();
    await loadClient(opened());
    expect(page().textContent).not.toContain("Data is complete through");
  });

  it("shows a block's table in place of its chart, and its details, on request", async () => {
    await loadClient(opened());
    const block = () => sectionNode("data0002")!;
    expect(block().querySelector("table")).toBeNull();

    buttonNamed("Show as table", block()).click();
    expect(block().querySelector("svg")).toBeNull();
    expect(Array.from(block().querySelectorAll("tbody tr")).map((row) => row.textContent)).toEqual(["1 Oct 2025USD$400.00", "31 Oct 2025USD$834.56"]);
    expect(buttonNamed("Show as chart", block()).getAttribute("aria-pressed")).toBe("true");

    const details = block().querySelector("details")!;
    expect(details.querySelector("summary")?.textContent).toBe("Details");
    const facts = Object.fromEntries(Array.from(details.querySelectorAll("dt")).map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent]));
    expect(facts).toMatchObject({ Metric: "net_sales", "Grouped by": "day", Period: "1–31 Oct 2025", Rows: "2", Duration: "25 ms" });
    expect(facts["Last ran"]).toBeTruthy();
  });
});

describe("an earlier edition", () => {
  async function chooseSeptember(): Promise<Harness> {
    const harness = await loadClient(opened());
    const picker = document.querySelector<HTMLSelectElement>("select#edition-picker")!;
    picker.value = "ed000001";
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(notices()).toContain("You are reading an earlier edition."));
    return harness;
  }

  it("shows its own stored text and numbers, under a banner saying so", async () => {
    const { gadget } = await chooseSeptember();
    expect(gadget.getEdition).toHaveBeenCalledWith({ id: "ed000001" });

    expect(notices()).toMatch(/You are reading an earlier edition\. Its numbers are as of .+\./);
    expect(document.querySelector(".notices")?.getAttribute("aria-live")).toBe("polite");
    expect(sectionNode("text0001")?.textContent).toBe("Net sales were $999.00 in September.");
    expect(sectionNode("data0001")!.querySelector(".data-kpi-value")?.textContent).toBe("$999.00");
    expect(page().textContent).not.toContain("$1,234.56");
    expect(page().querySelector(".asof")?.textContent).toMatch(/· 1–30 Sep 2025$/);
  });

  it("goes back to the latest on request", async () => {
    await chooseSeptember();
    buttonNamed("Back to latest").click();
    await vi.waitFor(() => expect(notices()).toBe(""));
    expect(sectionNode("data0001")!.querySelector(".data-kpi-value")?.textContent).toBe("$1,234.56");
    expect(sectionNode("text0001")?.textContent).toBe("Net sales were $1,234.56 this month.");
    expect(document.querySelector<HTMLSelectElement>("select#edition-picker")!.value).toBe("ed000002");
  });

  it("offers a newly generated edition instead of replacing what is being read", async () => {
    const { callbacks } = await chooseSeptember();
    const november = edition("ed000003", Date.UTC(2025, 11, 1, 8, 0), october.blocks);
    callbacks.generated({ edition: summaryOf(november), review: [] });

    expect(notices()).toContain("A new edition is available.");
    expect(sectionNode("data0001")!.querySelector(".data-kpi-value")?.textContent).toBe("$999.00");
  });
});

describe("live updates", () => {
  it("shows a newly generated edition when the latest is being read", async () => {
    const november = edition("ed000003", Date.UTC(2025, 11, 1, 8, 0), [heading, subheading, summary, { ...netSales, outcome: amount(200_000) }, { ...salesByDay, outcome: byDay() }]);
    const base = opened();
    const { gadget, callbacks } = await loadClient(base, { editions: [november, october, september] });

    callbacks.changed(changedEvent(base, { meta: { ...meta([november, october, september]), revision: 8 } }));
    callbacks.generated({ edition: summaryOf(november), review: [] });

    await vi.waitFor(() => expect(sectionNode("data0001")!.querySelector(".data-kpi-value")?.textContent).toBe("$2,000.00"));
    expect(gadget.getEdition).toHaveBeenCalledWith({ id: "ed000003" });
    expect(document.querySelector<HTMLSelectElement>("select#edition-picker")!.options).toHaveLength(3);
  });

  it("replaces structure and text, and ignores an event older than what it shows", async () => {
    const base = opened();
    const { callbacks } = await loadClient(base);
    const renamed: Section[] = [{ ...heading, text: "October in review" }, summary, netSales];

    callbacks.changed(changedEvent(base, { sections: renamed }));
    expect(Array.from(page().querySelectorAll("[data-section]")).map((node) => (node as HTMLElement).dataset.section)).toEqual(["head0001", "text0001", "data0001"]);
    expect(sectionNode("head0001")?.textContent).toBe("October in review");

    callbacks.changed({ ...changedEvent(base, { sections: SECTIONS }), revision: base.meta.revision });
    expect(sectionNode("head0001")?.textContent).toBe("October in review");
  });
});

describe("review flags", () => {
  it("flags text whose numbers changed and clears the flag when it is marked as reviewed", async () => {
    const base = opened({ review: ["text0001"] });
    const { gadget, callbacks } = await loadClient(base);
    const flagged = sectionNode("text0001")!;
    expect(flagged.querySelector(".flag")?.textContent).toContain(REVIEW_TEXT);
    expect(flagged.querySelector("[aria-live='polite']")?.contains(flagged.querySelector(".flag"))).toBe(true);

    buttonNamed("Mark as reviewed", flagged).click();
    await vi.waitFor(() => expect(gadget.markReviewed).toHaveBeenCalledWith({ ids: ["text0001"], clientId: expect.any(String) }));

    callbacks.changed(changedEvent(base, { review: [] }));
    expect(page().textContent).not.toContain(REVIEW_TEXT);
    expect(sectionNode("text0001")?.textContent).toBe("Net sales were $1,234.56 this month.");
  });
});

describe("states", () => {
  it("says a report was never generated and offers to generate it", async () => {
    const { gadget } = await loadClient(fresh());
    expect(page().querySelector(".state")?.textContent).toContain(NOT_GENERATED_TEXT);
    expect(page().querySelector(".asof")).toBeNull();
    expect(sectionNode("data0001")?.textContent).toContain("Generate the report to fill this in.");
    expect(document.querySelector<HTMLElement>("#edition-picker")!.closest("[hidden]")).not.toBeNull();

    gadget.open.mockResolvedValue(opened());
    buttonNamed("Generate").click();
    await vi.waitFor(() => expect(sectionNode("data0001")!.querySelector(".data-kpi-value")?.textContent).toBe("$1,234.56"));
    expect(gadget.generate).toHaveBeenCalledTimes(1);
    expect(gadget.generate).toHaveBeenCalledWith({ createdBy: "member" });
    expect(page().querySelector(".state")?.closest("[hidden]")).not.toBeNull();
    expect(notices()).toContain("A new edition was generated.");
    expect(hasButton("Regenerate")).toBe(true);
  });

  it("says who can turn the data on when it is off, and shows no data blocks", async () => {
    const { gadget } = await loadClient(fresh({ status: "off", mode: "off" }));
    expect(page().querySelector(".state")?.textContent).toBe(OFF_TEXT);
    expect(page().querySelectorAll(".sec-data")).toHaveLength(0);
    // The report's own words are still there to read and edit.
    expect(sectionNode("text0001")?.textContent).toBe("Net sales were $1,234.56 this month.");
    expect(hasButton("Generate")).toBe(false);
    expect(hasButton("Regenerate")).toBe(false);
    expect(hasButton("Edit")).toBe(true);
    expect(gadget.generate).not.toHaveBeenCalled();
  });

  it("says there is no sales data yet when the dataset is empty, and shows no data blocks", async () => {
    await loadClient(fresh({ status: "empty", mode: "live" }));
    expect(page().querySelector(".state")?.textContent).toBe(EMPTY_TEXT);
    expect(page().querySelectorAll(".sec-data")).toHaveLength(0);
    expect(hasButton("Generate")).toBe(false);
  });

  it("marks a view-only copy and offers neither regenerating nor editing", async () => {
    await loadClient(opened({ data: { ...LIVE, mode: "snapshot" } }));
    expect(isShown(document.querySelector(".badge")!)).toBe(true);
    expect(document.querySelector(".badge")?.textContent).toBe("Read-only copy");
    expect(hasButton("Regenerate")).toBe(false);
    expect(hasButton("Edit")).toBe(false);
    expect(hasButton("Pin")).toBe(false);
    expect(sectionNode("data0001")!.querySelector(".data-kpi-value")?.textContent).toBe("$1,234.56");
  });

  it("tells a person which edition goes before generating past the limit", async () => {
    const many = Array.from({ length: LIMITS.editions }, (_, index) => edition("many" + String(index).padStart(4, "0"), Date.UTC(2025, 10, 30 - index, 9, 0), october.blocks));
    const { gadget } = await loadClient(opened({ meta: meta(many), edition: many[0] }), { editions: many });

    buttonNamed("Regenerate").click();
    expect(notices()).toContain("This report keeps 24 editions. Generating a new one removes the oldest that is not pinned, as of");
    expect(gadget.generate).not.toHaveBeenCalled();

    buttonNamed("Generate", document.querySelector(".notices")!).click();
    await vi.waitFor(() => expect(gadget.generate).toHaveBeenCalledWith({ createdBy: "member" }));
  });
});

describe("a failed block", () => {
  const failure: QueryFailure = { error: "no such column: totl_amount", ranAt: Date.UTC(2025, 10, 3, 9, 12), durationMs: 4, period: OCTOBER };
  const failed = { ...october, blocks: [heading, subheading, summary, { ...netSales, outcome: failure }, { ...salesByDay, outcome: byDay() }] };

  it("shows the error and the request to hand to the agent, without stopping the other blocks", async () => {
    await loadClient(opened({ edition: failed }), { editions: [failed, september] });
    const block = sectionNode("data0001")!;
    expect(block.querySelector(".block-error")?.textContent).toBe("no such column: totl_amount");
    expect(sectionNode("data0002")!.querySelector("svg[role='img']")).not.toBeNull();

    const request = block.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(isShown(request)).toBe(false);
    buttonNamed("Fix with agent", block).click();

    expect(isShown(request)).toBe(true);
    expect(request.readOnly).toBe(true);
    expect(request.value).toBe('In the report "Monthly sales report", the block "Net sales" could not be computed: no such column: totl_amount. Please fix its query.');
    expect(document.activeElement).toBe(request);
    expect(request.selectionStart).toBe(0);
    expect(request.selectionEnd).toBe(request.value.length);
    // This browser cannot copy for the person, so they are told to.
    expect(block.querySelector(".handoff p")?.textContent).toBe("Copy this text and paste it into the chat with the agent.");
  });

  it("copies the request inside the click when the browser allows it", async () => {
    const copy = vi.fn(() => true);
    Object.assign(document, { execCommand: copy });
    try {
      await loadClient(opened({ edition: failed }), { editions: [failed, september] });
      const block = sectionNode("data0001")!;
      buttonNamed("Fix with agent", block).click();
      expect(copy).toHaveBeenCalledWith("copy");
      expect(block.querySelector(".handoff p")?.textContent).toBe("Copied. Paste it into the chat with the agent.");
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });
});

describe("editing", () => {
  async function editText(base: Opened): Promise<Harness & { editor: HTMLTextAreaElement }> {
    const harness = await loadClient(base);
    buttonNamed("Edit").click();
    await vi.waitFor(() => expect(hasButton("Done")).toBe(true));
    buttonNamed("Edit", sectionNode("text0001")!).click();
    const editor = sectionNode("text0001")!.querySelector("textarea")!;
    return { ...harness, editor };
  }

  it("edits text in place as its Markdown source and saves it when focus leaves", async () => {
    const { gadget, editor } = await editText(opened());
    expect(editor.value).toBe("Net sales were **$1,234.56** this month.");
    expect(document.activeElement).toBe(editor);

    editor.value = "Net sales were **$1,300.00** this month.";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    await vi.waitFor(() => expect(gadget.updateSection).toHaveBeenCalledWith({ id: "text0001", text: "Net sales were **$1,300.00** this month.", clientId: expect.any(String) }));
    await vi.waitFor(() => expect(sectionNode("text0001")!.querySelector("textarea")).toBeNull());
  });

  it("keeps a draft when someone else's change arrives, and saves the draft next", async () => {
    const base = opened();
    const { gadget, callbacks, editor } = await editText(base);
    editor.value = "My draft, half written";
    editor.dispatchEvent(new Event("input", { bubbles: true }));

    callbacks.changed(changedEvent(base, {
      sections: [{ ...heading, text: "Renamed by someone else" }, subheading, { ...summary, text: "Their text.", version: 4 }, netSales, salesByDay],
    }));

    // The rest of the page follows the change; the section being edited keeps its editor.
    expect(sectionNode("head0001")!.querySelector("h1")?.textContent).toBe("Renamed by someone else");
    expect(sectionNode("text0001")!.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("My draft, half written");
    expect(gadget.updateSection).not.toHaveBeenCalled();

    editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await vi.waitFor(() => expect(gadget.updateSection).toHaveBeenCalledWith({ id: "text0001", text: "My draft, half written", clientId: expect.any(String) }));
  });

  it("does not send text that was not changed", async () => {
    const { gadget, editor } = await editText(opened());
    editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await vi.waitFor(() => expect(sectionNode("text0001")!.querySelector("textarea")).toBeNull());
    expect(gadget.updateSection).not.toHaveBeenCalled();
  });

  it("moves, removes and adds sections through the server", async () => {
    const { gadget } = await editText(opened());
    const first = sectionNode("head0001")!;
    expect(buttonNamed("Move up", first).disabled).toBe(true);
    buttonNamed("Move down", first).click();
    await vi.waitFor(() => expect(gadget.moveSection).toHaveBeenCalledWith({ id: "head0001", after: "head0002", clientId: expect.any(String) }));

    buttonNamed("Move up", sectionNode("data0001")!).click();
    await vi.waitFor(() => expect(gadget.moveSection).toHaveBeenCalledWith({ id: "data0001", after: "head0002", clientId: expect.any(String) }));

    buttonNamed("Delete", sectionNode("data0002")!).click();
    await vi.waitFor(() => expect(gadget.removeSection).toHaveBeenCalledWith({ id: "data0002", clientId: expect.any(String) }));

    buttonNamed("Add heading").click();
    await vi.waitFor(() => expect(gadget.addSection).toHaveBeenCalledTimes(1));
    expect(gadget.addSection.mock.calls[0][0]).toMatchObject({ section: { kind: "heading", level: 2, text: "New heading" } });
  });

  it("lets a data block be renamed and redrawn as another type its result fits, and nothing else", async () => {
    const { gadget } = await editText(opened());
    const block = sectionNode("data0002")!;
    const visual = block.querySelector<HTMLSelectElement>("select[aria-label='Show as']")!;
    expect(Array.from(visual.options).map((option) => option.value)).toEqual(["line", "area", "bar", "table"]);
    visual.value = "bar";
    visual.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(gadget.updateSection).toHaveBeenCalledWith({ id: "data0002", visual: { type: "bar" }, clientId: expect.any(String) }));

    const title = block.querySelector<HTMLInputElement>("input[aria-label='Block title']")!;
    title.value = "Daily sales";
    title.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(gadget.updateSection).toHaveBeenCalledWith({ id: "data0002", title: "Daily sales", clientId: expect.any(String) }));
    // A data block's query is the agent's to change: the page offers no editor for it.
    expect(Array.from(block.querySelectorAll(".sec-tools button")).map((control) => control.textContent)).toEqual(["Move up", "Move down", "Delete"]);
    expect(block.querySelector("textarea")).toBeNull();
  });
});

describe("export", () => {
  it("prints the latest edition with its letterhead and as-of line, and no controls", async () => {
    const letterhead = { name: "Acme Retail", logo: LOGO, accent: "#aa3300" };
    const { gadget } = await loadClient(
      opened({ meta: meta([october, september], { letterhead }), review: ["text0001"], stale: ["data0002"] }),
      { exportFormat: "pdf" },
    );

    expect(document.documentElement.classList.contains("document-export")).toBe(true);
    expect(page().querySelector(".lh-name")?.textContent).toBe("Acme Retail");
    const logo = page().querySelector<HTMLImageElement>("img.lh-logo")!;
    expect(logo.getAttribute("src")).toBe(LOGO);
    expect(logo.alt).toBe("Acme Retail logo");
    expect(page().style.getPropertyValue("--accent")).toBe("#aa3300");
    expect(page().querySelector(".asof")?.textContent).toMatch(/^As of .+ · 1–31 Oct 2025$/);

    // The current text with the edition's stored numbers.
    expect(sectionNode("text0001")?.textContent).toBe("Net sales were $1,234.56 this month.");
    expect(sectionNode("data0001")!.querySelector(".data-kpi-value")?.textContent).toBe("$1,234.56");

    // Nothing to press, no review flag, and no block the edition does not hold.
    expect(document.body.querySelectorAll("button, select, input, textarea, details, header")).toHaveLength(0);
    expect(document.body.textContent).not.toContain(REVIEW_TEXT);
    expect(document.body.textContent).not.toContain(STALE_TEXT);
    expect(sectionNode("data0002")).toBeNull();

    // Drawn from what one open() returned: nothing is subscribed to, generated or read.
    expect(gadget.open).toHaveBeenCalledTimes(1);
    for (const method of ["subscribe", "generate", "getEdition", "updateSection", "markReviewed"] as const) expect(gadget[method]).not.toHaveBeenCalled();
  });

  it("prints why there is nothing to print before the first edition", async () => {
    await loadClient(fresh(), { exportFormat: "pdf" });
    expect(page().querySelector(".state")?.textContent).toBe(NOT_GENERATED_TEXT);
    expect(document.body.querySelectorAll("button")).toHaveLength(0);
    expect(page().querySelectorAll(".sec-data")).toHaveLength(0);
  });

  it("never draws a logo that is not an image data URL", async () => {
    const letterhead = { name: "Acme Retail", logo: "javascript:alert(1)" };
    await loadClient(opened({ meta: meta([october, september], { letterhead }) }), { exportFormat: "pdf" });
    expect(page().querySelector("img")).toBeNull();
    expect(page().querySelector(".lh-name")?.textContent).toBe("Acme Retail");
  });
});
