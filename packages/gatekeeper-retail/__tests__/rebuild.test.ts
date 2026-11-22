// Fix a mapping and re-run it (US5, T064): a template whose mapping put tips into discounts is
// corrected and re-applied; the rows change in place, the counts stay the same, rows the new
// version no longer produces are deleted, and the rebuild is offered until it has run.

import { describe, expect, it } from "vitest";
import type { MappingDocument } from "../src/app-api-types.js";
import { MEMBER, count, drain, importFiles, refusal } from "./import-helpers.js";
import { inspect, newDataset } from "./helpers.js";

const TEXT = [
  "Order ID,Date,Item,Qty,Price,Tip,Total",
  "R-1,2026-11-06 09:00:00,Latte,1,4.50,1.00,5.50",
  "R-2,2026-11-06 09:30:00,Mocha,1,5.00,0.50,5.50",
  "",
].join("\n");

/** The proposed mapping with the tip column mapped to the discount by mistake. */
function tipsAsDiscount(mapping: MappingDocument | null): MappingDocument {
  return {
    ...mapping!,
    targets: mapping!.targets.map(target => target.target === "orders.tip_amount"
      ? { ...target, target: "orders.discount_amount" } : target),
  };
}

async function wrongImport() {
  const { props, dataset } = newDataset();
  let proposed: MappingDocument | null = null;
  const { run } = await importFiles(dataset, props.datasetId, [{ name: "register.csv", text: TEXT }], {
    mapping: mapping => {
      proposed = mapping;
      return tipsAsDiscount(mapping);
    },
    saveAsTemplate: { name: "Register export" },
  });
  const template = (await dataset.listTemplates(props.datasetId)).find(entry => entry.name === "Register export")!;
  return { props, dataset, run, template, proposed: proposed! as MappingDocument };
}

describe("rebuild", () => {
  it("re-applies a corrected template: rows change, counts stay the same", async () => {
    const { props, dataset, run, template, proposed } = await wrongImport();
    expect(run.mappingVersion).toBe(`template:${template.id}:v1`);
    expect(await inspect(dataset, "SELECT source_record_id, discount_amount, tip_amount FROM store_orders ORDER BY id")).toEqual([
      { source_record_id: "R-1", discount_amount: 100, tip_amount: 0 },
      { source_record_id: "R-2", discount_amount: 50, tip_amount: 0 },
    ]);
    const ordersBefore = await count(dataset, "orders");
    const linesBefore = await count(dataset, "line_items");

    const { versionId } = await dataset.saveTemplateVersion(props.datasetId, template.id, proposed, MEMBER);
    const offered = (await dataset.listTemplates(props.datasetId)).find(entry => entry.id === template.id)!;
    expect(offered).toMatchObject({ currentVersionId: versionId, currentVersion: 2, rebuildOffered: true });

    const { runIds } = await dataset.reapplyTemplate(props.datasetId, template.id, undefined, MEMBER);
    expect(runIds).toHaveLength(1);
    await drain(dataset);
    const rebuild = await dataset.getRun(props.datasetId, runIds[0]!, MEMBER);
    expect(rebuild).toMatchObject({ kind: "rebuild", status: "succeeded", mappingVersion: `template:${template.id}:v2` });
    expect(rebuild.counts.orders).toMatchObject({ fetched: 2, updated: 2, written: 0 });

    expect(await inspect(dataset, "SELECT source_record_id, discount_amount, tip_amount, mapping_version FROM store_orders ORDER BY id")).toEqual([
      { source_record_id: "R-1", discount_amount: 0, tip_amount: 100, mapping_version: `template:${template.id}:v2` },
      { source_record_id: "R-2", discount_amount: 0, tip_amount: 50, mapping_version: `template:${template.id}:v2` },
    ]);
    expect(await count(dataset, "orders")).toBe(ordersBefore);
    expect(await count(dataset, "line_items")).toBe(linesBefore);
    const daily = await inspect<{ discount_amount: number; tip_amount: number }>(
      dataset, "SELECT discount_amount, tip_amount FROM store_daily_sales");
    expect(daily).toEqual([{ discount_amount: 0, tip_amount: 150 }]);
    expect((await dataset.listTemplates(props.datasetId)).find(entry => entry.id === template.id)?.rebuildOffered).toBe(false);

    // The import's rows now belong to the rebuild, so undoing the import is refused, naming it.
    expect(await refusal(dataset.undoImport(props.datasetId, run.id, MEMBER)))
      .toBe(`This import cannot be undone: later runs changed its rows: run ${rebuild.id} (rebuild).`);
  });

  it("deletes rows the corrected version no longer produces", async () => {
    const { props, dataset, template, proposed } = await wrongImport();
    expect(await count(dataset, "line_items")).toBe(2);
    const ordersOnly: MappingDocument = {
      ...proposed,
      targets: proposed.targets.filter(target => !target.target.startsWith("line_items.")),
    };
    await dataset.saveTemplateVersion(props.datasetId, template.id, ordersOnly, MEMBER);
    const { runIds } = await dataset.reapplyTemplate(props.datasetId, template.id, undefined, MEMBER);
    await drain(dataset);
    const rebuild = await dataset.getRun(props.datasetId, runIds[0]!, MEMBER);
    expect(rebuild.counts.line_items).toMatchObject({ deleted: 2 });
    expect(await count(dataset, "line_items")).toBe(0);
    expect(await count(dataset, "orders")).toBe(2);
    expect(await inspect(dataset, "SELECT gross_amount FROM store_orders ORDER BY id"))
      .toEqual([{ gross_amount: 0 }, { gross_amount: 0 }]);
  });

  it("refuses to save a version of a built-in template and validates saved mappings", async () => {
    const { props, dataset, template } = await wrongImport();
    const builtin = (await dataset.listTemplates(props.datasetId)).find(entry => entry.origin === "builtin")!;
    const detail = await dataset.getTemplate(props.datasetId, builtin.id);
    expect(await refusal(dataset.saveTemplateVersion(props.datasetId, builtin.id, detail.versions[0]!.mapping, MEMBER)))
      .toBe("Built-in templates are read-only; copy it to change it.");
    const { templateId } = await dataset.copyTemplate(props.datasetId, builtin.id, "My Toast", MEMBER);
    expect((await dataset.getTemplate(props.datasetId, templateId)).origin).toBe("user");
    expect(await refusal(dataset.saveTemplateVersion(props.datasetId, template.id, { version: 1 }, MEMBER)))
      .toMatch(/^settings: /);
    await dataset.deleteTemplate(props.datasetId, template.id);
    expect(await count(dataset, "orders")).toBe(2);
  });
});
