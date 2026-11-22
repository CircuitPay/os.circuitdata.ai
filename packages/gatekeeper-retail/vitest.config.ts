import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/** Workerd options shared with the on-demand load test (`vitest.load.config.ts`). */
export const workerdTestOptions = {
  main: "./__tests__/worker.ts",
  miniflare: {
    compatibilityDate,
    compatibilityFlags,
    // Wrangler's default rule, which the pool does not apply: the SQL parser is a precompiled
    // WebAssembly module import (src/dataset/sql-parser.ts).
    modulesRules: [{ type: "CompiledWasm" as const, include: ["**/*.wasm"], fallthrough: true }],
    r2Buckets: ["RETAIL_RAW"],
    durableObjects: {
      RETAIL_DATASET: { className: "RetailDataset", useSQLite: true },
      // Declared so workerd treats the class as a SQLite Durable Object, as the deployed migration does.
      RETAIL_GATEKEEPER: { className: "RetailGatekeeper", useSQLite: true },
      // The gatekeeper reads `ctx.props`, which a `DurableObjectClass` carries only through
      // `ctx.facets`, so tests drive it from a host Durable Object as the overseer does.
      TEST_HOST: { className: "TestHost", useSQLite: true },
      RETAIL_CONNECTION: { className: "RetailConnection", useSQLite: true },
      RETAIL_WEBHOOK_ROUTE: { className: "RetailWebhookRoute", useSQLite: true },
    },
  },
};

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      ...workerdTestOptions,
      miniflare: {
        ...workerdTestOptions.miniflare,
        // Small enough that the tests' fact tables cross it.
        bindings: {
          RETAIL_SCAN_ROW_LIMIT: "50",
          // Connector tests mock every provider request; nothing reaches Square or Stripe.
          BASE_URL: "https://workshop.example/gatekeeper/retail",
          SQUARE_CLIENT_ID: "sq0idp-test-app",
          SQUARE_CLIENT_SECRET: "test-square-secret",
          SQUARE_WEBHOOK_SIGNATURE_KEY: "test-square-signature-key",
          STRIPE_CLIENT_ID: "ca_test",
          STRIPE_APP_SECRET: "sk_test_app",
          STRIPE_WEBHOOK_SECRET: "whsec_test",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    exclude: ["__tests__/vite-config.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
