import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("packaged node-pty runtime", () => {
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
