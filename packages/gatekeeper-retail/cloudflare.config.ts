import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-retail",
  entrypoint: ".wrangler/validate/src/index.ts",
  // The dataset stores the account's persistent stubs; observability context needs AsyncLocalStorage.
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],

  env: {
    // Raw records (original CSV files, provider pages), keyed `ds/<datasetId>/...`, so any mapping
    // can be rebuilt without re-fetching. The binding name is the bucket's provisioning key in
    // releases and must stay unique across packages.
    RETAIL_RAW: bindings.r2({ name: "gadgets-retail-raw" }),
  },

  // Imports and rollup recomputes run inside alarms over large batches; the default 30 s is too
  // tight for a 4-8 MB CSV range plus its upserts.
  limits: { cpuMs: 300_000 },

  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

/**
 * DO classes are reached via ctx.exports; no durable_objects binding needed. Retail is unreleased,
 * so the connector objects join migration v1.
 */
export const migrations: DurableObjectMigration[] = [
  {
    tag: "v1",
    new_sqlite_classes: ["RetailDataset", "RetailGatekeeper", "RetailConnection", "RetailWebhookRoute"],
  },
];
