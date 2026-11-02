import { defineConfig } from "vitest/config";

// Real Pi CLI end-to-end tests: node environment, generous timeouts, run serially.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
