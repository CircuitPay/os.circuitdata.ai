// Cross-source matching (US6, T066): the same verified email in two sources and the same SKU in two
// sources are proposed pre-ticked; products sharing only a name are proposed but never linked
// without a person; confirming sets the canonical id (and merges repeat customers), undo clears it.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { RetailAppApi } from "../src/app-ui.js";
import { ERASE_CONFIRMATION } from "../src/app-api-types.js";
import type { RetailDataset } from "../src/dataset/dataset-do.js";
import { createSource, ingestRun, inspect, location, newDataset, order } from "./helpers.js";

class FakeAccess extends RpcTarget {
  constructor(private readonly canManage: boolean) {
    super();
  }

  async current(): Promise<{ canManage: boolean }> {
    return { canManage: this.canManage };
  }
}

function appApi(datasetId: string, canManage = true): RetailAppApi {
  return new RetailAppApi({
    dataset: env.RETAIL_DATASET.getByName(`test\0dataset\0${datasetId}`),
    datasetId,
    access: new RpcStub(new FakeAccess(canManage)) as never,
    memberId: "admin-1",
    connections: env.RETAIL_CONNECTION,
    sharingDomain: "test",
    providers: ["square", "stripe"],
    baseUrl: "https://workshop.example/gatekeeper/retail",
  });
}

const DAY = "2026-10-05";

/** Two sources: the same customer (by email) and the same product (by SKU), plus a name-only product. */
async function twoSources() {
  const { props, dataset } = newDataset();
  const square = await createSource(dataset, props.datasetId, "Square", "square");
  const csv = await createSource(dataset, props.datasetId, "Website CSV");
  await ingestRun(dataset, props.datasetId, square, {
    locations: [location()],
    customers: [{ sourceRecordId: "sq-c1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" }],
    products: [
      { sourceRecordId: "sq-p1", name: "Latte", sku: "LAT-12" },
      { sourceRecordId: "sq-p2", name: "Mocha" },
    ],
    orders: [order({ sourceRecordId: "sq-o1", customerRef: "sq-c1", totalAmount: 500 })],
  });
  await ingestRun(dataset, props.datasetId, csv, {
    locations: [location()],
    customers: [{ sourceRecordId: "web-c1", firstName: "A.", lastName: "Lovelace", email: " ADA@example.com " }],
    products: [
      { sourceRecordId: "web-p1", name: "Latte 12oz", sku: "lat-12" },
      { sourceRecordId: "web-p2", name: "mocha" },
    ],
    orders: [order({ sourceRecordId: "web-o1", customerRef: "web-c1", totalAmount: 700 })],
  });
  return { props, dataset, api: appApi(props.datasetId) };
}

async function repeatRate(dataset: DurableObjectStub<RetailDataset>, datasetId: string) {
  return (await dataset.metric(datasetId, "repeat_customer_rate", { from: DAY, to: DAY })).rows;
}

describe("matching", () => {
  it("proposes customers with the same email pre-ticked, and links them only when confirmed", async () => {
    const { props, dataset, api } = await twoSources();
    const proposals = await api.listMatchProposals({ kind: "customer" });
    expect(proposals).toEqual([expect.objectContaining({
      kind: "customer", basis: "email", status: "proposed", preselected: true,
      row: expect.objectContaining({ source: "Website CSV" }), canonical: expect.objectContaining({ source: "Square" }),
    })]);
    // Masked by default.
    expect(proposals[0]!.row.label).not.toContain("ada@example.com");
    expect(await inspect(dataset, "SELECT canonical_customer_id FROM store_customers WHERE canonical_customer_id IS NOT NULL")).toEqual([]);
    expect(await repeatRate(dataset, props.datasetId)).toEqual([[0]]);

    await api.confirmMatch(proposals[0]!.id);
    const [canonical] = await inspect<{ id: number }>(dataset, "SELECT id FROM store_customers WHERE source_record_id = 'sq-c1'");
    expect(await inspect(dataset, "SELECT canonical_customer_id FROM store_customers WHERE source_record_id = 'web-c1'"))
      .toEqual([{ canonical_customer_id: canonical!.id }]);
    // One person with two orders across the two sources.
    expect(await repeatRate(dataset, props.datasetId)).toEqual([[1]]);
    expect(await api.listMatchProposals({ kind: "customer" })).toEqual([
      expect.objectContaining({ id: proposals[0]!.id, status: "confirmed" }),
    ]);

    await api.undoMatch(proposals[0]!.id);
    expect(await inspect(dataset, "SELECT canonical_customer_id FROM store_customers WHERE source_record_id = 'web-c1'"))
      .toEqual([{ canonical_customer_id: null }]);
    expect(await repeatRate(dataset, props.datasetId)).toEqual([[0]]);
    // An undone pair is not proposed again.
    expect(await api.listMatchProposals({ kind: "customer" })).toEqual([]);
    expect(await inspect(dataset, "SELECT status, decided_by FROM match_links WHERE kind = 'customer'"))
      .toEqual([{ status: "undone", decided_by: "admin-1" }]);
  });

  it("proposes the same SKU pre-ticked and a name-only product unticked, and never links either by itself", async () => {
    const { dataset, api } = await twoSources();
    const proposals = await api.listMatchProposals({ kind: "product" });
    expect(proposals.map(({ basis, preselected, status }) => ({ basis, preselected, status }))).toEqual([
      { basis: "sku", preselected: true, status: "proposed" },
      { basis: "name", preselected: false, status: "proposed" },
    ]);
    expect(await inspect(dataset, "SELECT COUNT(*) AS n FROM store_products WHERE canonical_product_id IS NOT NULL"))
      .toEqual([{ n: 0 }]);

    const [sku, name] = proposals;
    await api.confirmMatch(sku!.id);
    await api.rejectMatch(name!.id);
    expect(await inspect(dataset, "SELECT source_record_id, canonical_product_id IS NOT NULL AS linked FROM store_products ORDER BY id"))
      .toEqual([
        { source_record_id: "sq-p1", linked: 0 }, { source_record_id: "sq-p2", linked: 0 },
        { source_record_id: "web-p1", linked: 1 }, { source_record_id: "web-p2", linked: 0 },
      ]);
    // A rejected proposal stays rejected; decided proposals cannot be decided again.
    expect((await api.listMatchProposals({ kind: "product" })).map(proposal => proposal.id)).toEqual([sku!.id]);
    await expect(api.confirmMatch(name!.id)).rejects.toThrow(/Only a proposed match/);
    await expect(api.undoMatch(name!.id)).rejects.toThrow(/Only a confirmed match/);
  });

  it("refuses members: matching, unmasking and erasing are for administrators", async () => {
    const { props } = await twoSources();
    const member = appApi(props.datasetId, false);
    await expect(member.listMatchProposals({ kind: "customer" })).rejects.toThrow(/Only organization administrators/);
    await expect(member.confirmMatch(1)).rejects.toThrow(/Only organization administrators/);
    await expect(member.rejectMatch(1)).rejects.toThrow(/Only organization administrators/);
    await expect(member.undoMatch(1)).rejects.toThrow(/Only organization administrators/);
    await expect(member.setPersonalDataUnmasked(true)).rejects.toThrow(/Only organization administrators/);
    await expect(member.eraseDataset({ confirm: ERASE_CONFIRMATION })).rejects.toThrow(/Only organization administrators/);
  });

  it("unmasks proposals when personal data is unmasked, and erases only with the typed confirmation", async () => {
    const { props, dataset, api } = await twoSources();
    await api.setPersonalDataUnmasked(true);
    expect((await api.getOverview()).settings.piiUnmasked).toBe(true);
    const [proposal] = await api.listMatchProposals({ kind: "customer" });
    expect(proposal!.canonical.label).toBe("Ada Lovelace <ada@example.com>");
    expect(await inspect(dataset, "SELECT pii_changed_by FROM settings")).toEqual([{ pii_changed_by: "admin-1" }]);

    await expect(api.eraseDataset({ confirm: "erase" })).rejects.toThrow(/Type "erase all retail data"/);
    await api.eraseDataset({ confirm: ERASE_CONFIRMATION });
    await runInDurableObject(dataset, instance => {
      expect(() => instance.overview(props.datasetId)).toThrow(/being erased/);
    });
    // The erase alarm is due at once; run it here unless the runtime already has.
    await runDurableObjectAlarm(dataset);
    await vi.waitFor(() => runInDurableObject(dataset, (_instance, state) => {
      expect(state.storage.kv.get("schemaVersion")).toBeUndefined();
    }));
    expect((await api.getOverview()).sources).toEqual([]);
  });
});
