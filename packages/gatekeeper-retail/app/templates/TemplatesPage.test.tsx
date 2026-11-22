// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MappingDocument, RunSummary, TemplateDetail, TemplateSummary } from "../../src/app-api-types";
import { button, cleanup, click, field, render, type } from "../testDom";
import TemplatesPage, { type TemplatesApi } from "./TemplatesPage";

const mapping: MappingDocument = {
  version: 1,
  settings: { timezone: "America/New_York", currency: "USD", dateFormat: "MM/dd/yyyy", decimalMark: "." },
  orderKey: "Order",
  targets: [{ target: "orders.discount_amount", from: "Tips", transform: "money" }],
};

const toast: TemplateSummary = {
  id: 1,
  name: "Toast export",
  origin: "builtin",
  builtinKey: "toast",
  currentVersionId: 10,
  currentVersion: 1,
  runs: 4,
  rebuildOffered: false,
};

const october: TemplateSummary = {
  id: 5,
  name: "Front counter",
  origin: "user",
  builtinKey: null,
  currentVersionId: 52,
  currentVersion: 2,
  runs: 3,
  rebuildOffered: true,
};

const octoberDetail: TemplateDetail = {
  ...october,
  versions: [
    { id: 51, version: 1, createdBy: "member-1", createdAt: "2026-10-01T10:00:00Z", mapping, runs: 3 },
    { id: 52, version: 2, createdBy: "member-1", createdAt: "2026-11-01T10:00:00Z", mapping, runs: 0 },
  ],
};

const rebuild: RunSummary = {
  id: 90,
  sourceId: 3,
  sourceLabel: "Front counter exports",
  kind: "rebuild",
  status: "running",
  templateVersionId: 52,
  mappingVersion: "template-5-v2",
  startedBy: "member-1",
  startedAt: "2026-11-17T10:00:00Z",
  finishedAt: null,
  counts: {},
  progress: { phase: "Rebuilding orders", done: 10, total: 40, etaSeconds: null },
  warnings: { fingerprintRows: 0, totalMismatch: 0, quantityRounded: 0 },
  error: null,
  undoOf: null,
  undoneBy: null,
  undo: { possible: false, reason: null },
  files: [],
};

function fakeApi(overrides: Partial<TemplatesApi> = {}) {
  return {
    listTemplates: vi.fn<TemplatesApi["listTemplates"]>(async () => [toast, october]),
    getTemplate: vi.fn<TemplatesApi["getTemplate"]>(async (id) =>
      id === 5 ? octoberDetail : { ...toast, versions: [{ ...octoberDetail.versions[0], id: 10 }] },
    ),
    saveTemplateVersion: vi.fn<TemplatesApi["saveTemplateVersion"]>(async () => ({ versionId: 53 })),
    copyTemplate: vi.fn<TemplatesApi["copyTemplate"]>(async () => ({ templateId: 5 })),
    deleteTemplate: vi.fn<TemplatesApi["deleteTemplate"]>(async () => {}),
    reapplyTemplate: vi.fn<TemplatesApi["reapplyTemplate"]>(async () => ({ runIds: [90] })),
    getRun: vi.fn<TemplatesApi["getRun"]>(async () => rebuild),
    ...overrides,
  };
}

afterEach(cleanup);

describe("TemplatesPage", () => {
  it("highlights a template whose imports used an older version and re-applies it with progress", async () => {
    const api = fakeApi();
    await render(<TemplatesPage api={api} />);
    expect(document.body.textContent).toContain("Rebuild offered");
    await click(button("Open Front counter"));
    expect(api.getTemplate).toHaveBeenCalledWith(5);
    expect(document.body.textContent).toContain("Imports used an older version");

    await click(button("Re-apply"));
    expect(api.reapplyTemplate).toHaveBeenCalledWith(5, undefined);
    const progress = document.querySelector('[role="progressbar"]')!;
    expect(progress.getAttribute("aria-label")).toBe("Progress of rebuild 90");
    expect(progress.getAttribute("aria-valuetext")).toBe("Rebuilding orders: 10 of 40");
  });

  it("shows the gatekeeper's validation message when a new version is refused", async () => {
    const api = fakeApi({
      saveTemplateVersion: vi.fn<TemplatesApi["saveTemplateVersion"]>(async () => {
        throw new Error('targets.0.target: "orders.tip" is not a known target');
      }),
    });
    await render(<TemplatesPage api={api} />);
    await click(button("Open Front counter"));

    const editor = field("Mapping (JSON)");
    expect(JSON.parse(editor.value)).toEqual(mapping);

    await type(editor, "{ not json");
    await click(button("Save as a new version"));
    expect(document.body.textContent).toContain("This is not valid JSON");
    expect(api.saveTemplateVersion).not.toHaveBeenCalled();

    const corrected = { ...mapping, targets: [{ target: "orders.tip", from: "Tips" }] };
    await type(editor, JSON.stringify(corrected));
    await click(button("Save as a new version"));
    expect(api.saveTemplateVersion).toHaveBeenCalledWith(5, corrected);
    expect(document.body.textContent).toContain('targets.0.target: "orders.tip" is not a known target');
  });

  it("copies a read-only built-in template and opens the copy", async () => {
    const api = fakeApi();
    await render(<TemplatesPage api={api} />);
    await click(button("Open Toast export"));
    expect(document.body.textContent).toContain("Built-in, read-only");
    expect(() => field("Mapping (JSON)")).toThrow('No field labelled "Mapping (JSON)"');
    expect(() => button("Delete")).toThrow('No button "Delete"');

    await click(button("Copy"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(field("Name of the copy").value).toBe("Toast export (copy)");
    await type(field("Name of the copy"), "Our Toast");
    await click(button("Copy", dialog));

    expect(api.copyTemplate).toHaveBeenCalledWith(1, "Our Toast");
    expect(api.getTemplate).toHaveBeenLastCalledWith(5);
    expect(document.querySelector("h2")!.textContent).toBe("Front counter");
  });

  it("deletes a user template after confirmation and returns to the list", async () => {
    const api = fakeApi();
    await render(<TemplatesPage api={api} />);
    await click(button("Open Front counter"));

    await click(button("Delete"));
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("The data it imported stays.");
    await click(button("Delete template", dialog));

    expect(api.deleteTemplate).toHaveBeenCalledWith(5);
    expect(api.listTemplates).toHaveBeenCalledTimes(2);
    expect(document.activeElement?.textContent).toBe("Templates");
  });
});
