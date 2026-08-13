import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createTargetIgnore,
  deriveCurrentPackageTarget,
  packageArguments,
  prepareNativeRuntime,
} from "./package-target.mjs";
import { verifyVsix } from "./verify-vsix.mjs";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const vsce = require.resolve("@vscode/vsce/vsce");
const target = deriveCurrentPackageTarget();

await prepareNativeRuntime(target);
const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-manager-package-"));
try {
  const ignoreFile = join(tempRoot, `.vscodeignore-${target.target}`);
  const baseIgnore = await readFile(".vscodeignore", "utf8");
  await writeFile(ignoreFile, createTargetIgnore(baseIgnore, target), "utf8");
  const { stdout, stderr } = await execFile(
    process.execPath,
    [vsce, ...packageArguments(target, ignoreFile)],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  await verifyVsix(target);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
