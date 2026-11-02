import { defineConfig, devices } from "@playwright/test";

// Drives the built webview (dist/) in Chromium against a real ChatSession + Pi CLI + mock LLM.
// Locally, PW_CHROMIUM_PATH can point at a preinstalled browser; CI runs `playwright install`.
export default defineConfig({
  testDir: "test/ui",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "test-results/playwright",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 440, height: 860 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
});
