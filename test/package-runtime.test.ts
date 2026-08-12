import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("packaged node-pty runtime", () => {
  it("targets and verifies the Darwin ARM64 package explicitly", async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");

    expect(packageJson.scripts?.package).toContain("vsce package --target darwin-arm64");
    expect(packageJson.scripts?.package).toContain("npm run verify:package");
    expect(packageJson.scripts?.["verify:package"]).toBe(
      "node scripts/verify-vsix.mjs",
    );
    expect(readme).toContain("pi-agent-manager-darwin-arm64-0.1.0.vsix");
    expect(readme).toContain("Other platforms require separately built native VSIX packages");
  });

  it.runIf(process.platform === "darwin")("keeps the current-platform spawn helper executable", async () => {
    const helper = join(
      process.cwd(),
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper",
    );
    const file = await stat(helper);

    expect(file.mode & 0o111).not.toBe(0);
  });
});
