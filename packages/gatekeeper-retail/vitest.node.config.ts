import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** The node project: the app's Vite config and the Data app (component tests opt into jsdom). */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["__tests__/vite-config.test.ts", "app/**/*.test.{ts,tsx}"],
  },
});
