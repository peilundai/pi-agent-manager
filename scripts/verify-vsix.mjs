import { execFile as execFileCallback } from "node:child_process";
import { stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const target = "darwin-arm64";
const artifact = `pi-agent-manager-${target}-0.1.0.vsix`;

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(`The ${target} package must be built and verified on Darwin ARM64.`);
}

const { stdout: inventoryOutput } = await execFile("unzip", ["-Z1", artifact]);
const inventory = inventoryOutput.trim().split("\n");
const required = [
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/webview.css",
  "extension/dist/index.html",
  "extension/dist/resources/pi-status.mjs",
  "extension/media/pi.svg",
  "extension/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
  "extension/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
];

for (const path of required) {
  if (!inventory.includes(path)) throw new Error(`Missing required VSIX runtime file: ${path}`);
}

const unexpectedNative = inventory.filter(
  (path) => path.includes("node-pty/prebuilds/") && !path.includes("prebuilds/darwin-arm64/"),
);
if (unexpectedNative.length) {
  throw new Error(`Unexpected non-target native files: ${unexpectedNative.join(", ")}`);
}

const { stdout: manifest } = await execFile("unzip", [
  "-p",
  artifact,
  "extension.vsixmanifest",
]);
if (!manifest.includes('TargetPlatform="darwin-arm64"')) {
  throw new Error("VSIX manifest is missing Darwin ARM64 target metadata.");
}

const extractionRoot = await mkdtemp(join(tmpdir(), "pi-agent-manager-vsix-"));
try {
  await execFile("unzip", ["-q", artifact, "-d", extractionRoot]);
  const extensionRoot = join(extractionRoot, "extension");
  const helper = join(
    extensionRoot,
    "node_modules",
    "node-pty",
    "prebuilds",
    target,
    "spawn-helper",
  );
  const helperFile = await stat(helper);
  if ((helperFile.mode & 0o111) === 0) {
    throw new Error("Extracted node-pty spawn-helper is not executable.");
  }

  const requireFromPackage = createRequire(join(extensionRoot, "package.json"));
  const pty = requireFromPackage("node-pty");
  const processResult = await new Promise((resolve, reject) => {
    const child = pty.spawn("/bin/sh", ["-c", "printf VERIFIED_VSIX_PTY"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: process.env,
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Extracted VSIX PTY smoke timed out."));
    }, 5_000);
    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) reject(new Error(`Extracted VSIX PTY exited ${exitCode}.`));
      else resolve(output);
    });
  });
  if (processResult !== "VERIFIED_VSIX_PTY") {
    throw new Error(`Unexpected extracted VSIX PTY output: ${JSON.stringify(processResult)}`);
  }
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
}

console.log(`Verified ${artifact}: target metadata, runtime inventory, executable helper, and PTY smoke.`);
