// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ERASE_CONFIRMATION, type MatchKind, type MatchProposal, type RetailAppClient, type RetailOverview,
} from "../../src/app-api-types";
import { button, byRole, cleanup, click, field, render, settle, type } from "../testDom";
import SettingsPage from "./SettingsPage";

function overview(canManage: boolean): RetailOverview {
  return {
    canManage,
    connectableProviders: ["square", "stripe"],
    sources: [],
    storage: { usedBytes: 1, capBytes: 10, rawUsedBytes: 0, rawQuotaBytes: 1, warn: false },
    settings: { piiUnmasked: false, backfillYears: 3 },
    failuresNeedingAdmin: [],
  };
}

function proposal(id: number, kind: MatchKind, basis: MatchProposal["basis"]): MatchProposal {
  return {
    id, kind, basis, status: "proposed", preselected: basis !== "name", decidedAt: null,
    row: { id: id * 10, source: "Website CSV", label: `Row ${id}` },
    canonical: { id: id * 10 + 1, source: "Square", label: `Canonical ${id}` },
  };
}

function fakeApi(canManage = true) {
  return {
    getOverview: vi.fn<RetailAppClient["getOverview"]>(async () => overview(canManage)),
    setPersonalDataUnmasked: vi.fn<RetailAppClient["setPersonalDataUnmasked"]>(async () => {}),
    eraseDataset: vi.fn<RetailAppClient["eraseDataset"]>(async () => {}),
    listMatchProposals: vi.fn<RetailAppClient["listMatchProposals"]>(async ({ kind }) =>
      kind === "product" ? [proposal(1, "product", "sku"), proposal(2, "product", "name")] : []),
    confirmMatch: vi.fn<RetailAppClient["confirmMatch"]>(async () => {}),
    rejectMatch: vi.fn<RetailAppClient["rejectMatch"]>(async () => {}),
    undoMatch: vi.fn<RetailAppClient["undoMatch"]>(async () => {}),
  };
}

afterEach(cleanup);

describe("SettingsPage", () => {
  it("links only the pre-ticked SKU match; the name-only match stays unticked", async () => {
    const api = fakeApi();
    await render(<SettingsPage api={api} />);
    await settle();

    await click(button("Link 1 selected"));
    expect(api.confirmMatch).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("rejects a proposal that is not the same record", async () => {
    const api = fakeApi();
    await render(<SettingsPage api={api} />);
    await settle();

    await click(button("Not the same: Row 2 (Website CSV) and Canonical 2 (Square)"));
    expect(api.rejectMatch).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("unmasks personal data", async () => {
    const api = fakeApi();
    await render(<SettingsPage api={api} />);
    await settle();

    await click(byRole("switch", "Show personal data unmasked"));
    expect(api.setPersonalDataUnmasked).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("erases only after the phrase is typed", async () => {
    const api = fakeApi();
    await render(<SettingsPage api={api} />);
    await settle();

    await click(button("Erase dataset…"));
    const erase = button("Erase dataset");
    expect(erase.disabled).toBe(true);
    await type(field("Confirmation"), ERASE_CONFIRMATION);
    await click(button("Erase dataset"));
    expect(api.eraseDataset).toHaveBeenCalledExactlyOnceWith({ confirm: ERASE_CONFIRMATION });
  });

  it("shows members no settings", async () => {
    const api = fakeApi(false);
    const page = await render(<SettingsPage api={api} />);
    await settle();

    expect(page.textContent).toContain("Only organization administrators can change these settings.");
    expect(api.listMatchProposals).not.toHaveBeenCalled();
  });
});
