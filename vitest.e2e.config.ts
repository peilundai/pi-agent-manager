import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Real Pi CLI end-to-end tests: node environment, generous timeouts, run serially.
export default defineConfig({
  resolve: {
    // Extension-level tests drive activate() through the same stand-in as the unit tests.
    alias: {
      vscode: fileURLToPath(new URL("./test/vscode-mock.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
