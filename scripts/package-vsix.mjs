import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { ARTIFACT_NAME, verifyVsix } from "./verify-vsix.mjs";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const vsce = require.resolve("@vscode/vsce/vsce");

// Pi Agent Manager has no native dependencies, so one universal package serves every platform.
const { stdout, stderr } = await execFile(
  process.execPath,
  [vsce, "package", "--no-dependencies", "--out", ARTIFACT_NAME],
  { maxBuffer: 16 * 1024 * 1024 },
);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
await verifyVsix();
