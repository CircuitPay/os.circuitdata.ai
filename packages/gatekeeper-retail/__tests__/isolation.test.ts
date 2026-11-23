// Isolation and observers (T036, SC-007): across three datasets no query or raw object reaches
// another dataset, erasure removes only its own dataset, and a collaborator whose tenant holds a
// different dataset is refused by addObserver.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { datasetPrefix } from "../src/dataset/raw-store.js";
import { createSource, ingestRun, line, location, newDataset, order } from "./helpers.js";

async function seededDataset(orderNumber: string) {
  const { props, dataset } = newDataset();
  const sourceId = await createSource(dataset, props.datasetId);
  const { runId } = await ingestRun(dataset, props.datasetId, sourceId, {
    locations: [location()],
    orders: [order({ sourceRecordId: "o-1", orderNumber, totalAmount: 500 })],
    lineItems: [line({ sourceRecordId: "l-1", orderRef: "o-1" })],
  });
  return { props, dataset, sourceId, runId };
}

function bytes(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

async function keysUnder(prefix: string): Promise<string[]> {
  return (await env.RETAIL_RAW.list({ prefix })).objects.map(object => object.key);
}

describe("dataset isolation", () => {
  it("serves each binding only its own dataset's rows", async () => {
    const datasets = await Promise.all(["A-100", "B-200", "C-300"].map(seededDataset));
    const host = env.TEST_HOST.getByName("isolation-queries");
    for (const [index, { props }] of datasets.entries()) {
      const result = await host.run(props, "SELECT order_number FROM orders WHERE business_date >= ?", ["2000-01-01"]);
      expect(result.rows).toEqual([[["A-100", "B-200", "C-300"][index]]]);
      const description = await host.describeData(props);
      expect(description.tables.find(table => table.name === "orders")?.rows).toBe(1);
    }
  });

  it("keeps raw objects under the dataset's own prefix and erases only that prefix", async () => {
    const a = await seededDataset("A");
    const b = await seededDataset("B");
    const rawA = await a.dataset.putRawObject(a.props.datasetId, { sourceId: a.sourceId, runId: a.runId, kind: "csv_file" },
      bytes("order,total\n1,5.00\n"), 19);
    await b.dataset.putRawObject(b.props.datasetId, { sourceId: b.sourceId, runId: b.runId, kind: "csv_file" },
      bytes("other tenant"), 12);

    expect(await keysUnder(datasetPrefix(a.props.datasetId)))
      .toEqual([`ds/${a.props.datasetId}/src/${a.sourceId}/run/${a.runId}/1`]);
    expect(await keysUnder(datasetPrefix(b.props.datasetId))).toHaveLength(1);
    expect(rawA).toBe(1);
    expect((await a.dataset.storageStatus(a.props.datasetId)).rawUsedBytes).toBe(19);

    await a.dataset.erase(a.props.datasetId);
    await runInDurableObject(a.dataset, instance => {
      expect(() => instance.describe(a.props.datasetId)).toThrow(/being erased/);
    });
    // The erase alarm is due at once; run it here unless the runtime already has.
    await runDurableObjectAlarm(a.dataset);
    // Erasure ends with deleteAll, which also drops the schema version.
    await vi.waitFor(() => runInDurableObject(a.dataset, (_instance, state) => {
      expect(state.storage.kv.get("schemaVersion")).toBeUndefined();
    }));

    expect(await keysUnder(datasetPrefix(a.props.datasetId))).toEqual([]);
    expect(await keysUnder(datasetPrefix(b.props.datasetId))).toHaveLength(1);
    expect((await b.dataset.describe(b.props.datasetId)).dateRange).not.toBeNull();
    // The erased object holds nothing; a later use starts empty.
    expect((await a.dataset.describe(a.props.datasetId)).dateRange).toBeNull();
  });

  it("refuses raw objects past the quota before writing any byte", async () => {
    const { props, dataset, sourceId, runId } = await seededDataset("Q");
    await runInDurableObject(dataset, async instance => {
      await expect(instance.putRawObject(props.datasetId, { sourceId, runId, kind: "csv_file" },
        bytes("x"), 21 * 1024 ** 3)).rejects.toThrow(/quota is full/);
    });
    expect(await keysUnder(datasetPrefix(props.datasetId))).toEqual([]);
  });
});

describe("observers", () => {
  it("admits a collaborator whose tenant holds the same dataset and refuses any other", async () => {
    const a = newDataset();
    const b = newDataset();
    const host = env.TEST_HOST.getByName("isolation-observers");

    expect(await host.addObserver(a.props, a.props)).toBeNull();
    expect(await host.addObserver(a.props, b.props))
      .toBe("This workspace reads an organization's retail data that you do not have access to.");
    // Same dataset id from another deployment's sharing domain is still that dataset only.
    expect(await host.addObserver(b.props, { ...a.props, sharingDomain: "elsewhere" }))
      .toMatch(/do not have access/);
  });

  it("lists tables and metrics in the agent catalog without observing anything", async () => {
    const { props } = await seededDataset("cat");
    const host = env.TEST_HOST.getByName("isolation-catalog");
    const catalog = await host.catalog(props);
    expect(catalog.entries.map(entry => entry.id)).toContain("table:daily_sales");
    expect(catalog.entries.map(entry => entry.id)).toContain("metric:net_sales");
    expect(catalog.entries.some(entry => entry.id === "pending-imports")).toBe(false);
    expect(await host.observations()).toEqual([]);
  });
});
