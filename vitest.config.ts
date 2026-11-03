import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/vscode-mock.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["test/e2e/**", "test/ui/**", "node_modules/**"],
    setupFiles: ["test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/webview/main.tsx", "src/**/*.d.ts", "src/pi/rpc-types.ts", "src/shared/model.ts"],
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // Keep just under current coverage; raise as tests are added. Re-baselined for vitest 5, whose
      // AST-aware V8 remapping counts statements separately from lines (same tests, stricter metric).
      thresholds: { lines: 84, statements: 80, functions: 78, branches: 69 },
    },
  },
});
