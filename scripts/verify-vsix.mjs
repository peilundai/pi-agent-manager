import { stat, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_NAME,
  deriveCurrentPackageTarget,
  validateArchiveInventory,
  validateVsixManifest,
} from "./package-target.mjs";
import { extractZipArchive, readZipArchive } from "./vsix-archive.mjs";

const requiredExtensionFiles = [
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/webview.css",
  "extension/dist/index.html",
  "extension/dist/resources/pi-status.mjs",
  "extension/media/pi.svg",
  "extension/package.json",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/LICENSE.txt",
];

function verifyRequiredFiles(inventory) {
  const files = new Set(inventory);
  for (const path of requiredExtensionFiles) {
    if (!files.has(path)) throw new Error(`VSIX is missing required extension file: ${path}`);
  }
}

function runPtySmoke(extensionRoot) {
  const requireFromPackage = createRequire(join(extensionRoot, "package.json"));
  const pty = requireFromPackage("node-pty");
  const marker = "VERIFIED_VSIX_PTY";
  return new Promise((resolve, reject) => {
    const child = pty.spawn(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(marker)})`],
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: tmpdir(),
        env: process.env,
      },
    );
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Extracted VSIX PTY smoke timed out."));
    }, 10_000);
    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) reject(new Error(`Extracted VSIX PTY exited ${exitCode}.`));
      else if (!output.includes(marker)) {
        reject(new Error(`Unexpected extracted VSIX PTY output: ${JSON.stringify(output)}`));
      } else resolve();
    });
  });
}

export async function verifyVsix(
  target = deriveCurrentPackageTarget(),
  artifact = ARTIFACT_NAME,
) {
  const entries = await readZipArchive(artifact);
  const inventory = [...entries.keys()];
  verifyRequiredFiles(inventory);
  validateArchiveInventory(inventory, target);
  const manifest = entries.get("extension.vsixmanifest")?.data.toString("utf8");
  if (!manifest) throw new Error("VSIX manifest is missing.");
  validateVsixManifest(manifest, target);

  const extractionRoot = await mkdtemp(join(tmpdir(), "pi-agent-manager-vsix-"));
  try {
    await extractZipArchive(entries, extractionRoot);
    if (target.platform === "darwin") {
      const helper = target.nativeFiles.find((path) => path.endsWith("/spawn-helper"));
      if (!helper) throw new Error(`VSIX has no macOS helper for ${target.target}.`);
      const helperFile = await stat(join(extractionRoot, "extension", helper));
      if ((helperFile.mode & 0o111) === 0) {
        throw new Error("Extracted node-pty spawn-helper is not executable.");
      }
    }
    await runPtySmoke(join(extractionRoot, "extension"));
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }

  console.log(
    `Verified ${artifact} for ${target.target}: metadata, exact runtime inventory, and PTY smoke.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyVsix();
}
