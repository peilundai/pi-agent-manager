import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";

if (process.platform === "darwin") {
  const helper = join(
    "node_modules",
    "node-pty",
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
  const file = await stat(helper);

  await chmod(helper, file.mode | 0o111);
  console.log(`Prepared executable node-pty helper: ${helper}`);
}
