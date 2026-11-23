/// <reference types="@cloudflare/vitest-plugin/types" />

// Test-only bindings, declared in vitest.config.ts rather than wrangler.jsonc.

import type { RetailConnection } from "../src/connectors/connection-do.js";
import type { RetailWebhookRoute } from "../src/connectors/webhook-route-do.js";
import type { RetailDataset } from "../src/dataset/dataset-do.js";
import type { TestHost } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      RETAIL_DATASET: DurableObjectNamespace<RetailDataset>;
      TEST_HOST: DurableObjectNamespace<TestHost>;
      RETAIL_CONNECTION: DurableObjectNamespace<RetailConnection>;
      RETAIL_WEBHOOK_ROUTE: DurableObjectNamespace<RetailWebhookRoute>;
      RETAIL_LOAD_SCALE?: string;
    }
  }
}
