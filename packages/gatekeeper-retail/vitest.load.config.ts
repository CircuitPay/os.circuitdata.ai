import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import { workerdTestOptions } from "./vitest.config.ts";

/**
 * The SC-006a load test (`pnpm --filter @gadgets/gatekeeper-retail test:load`), run on demand only.
 * `RETAIL_LOAD_SCALE` scales the synthetic dataset; 1 is the full 10 locations x 3 years.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      ...workerdTestOptions,
      miniflare: {
        ...workerdTestOptions.miniflare,
        bindings: { RETAIL_LOAD_SCALE: process.env.RETAIL_LOAD_SCALE ?? "0.01" },
      },
    }),
  ],
  test: {
    include: ["__tests__/load/*.test.ts"],
    testTimeout: 0,
    hookTimeout: 0,
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
