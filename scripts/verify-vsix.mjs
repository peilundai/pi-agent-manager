import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readZipArchive } from "./vsix-archive.mjs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const ARTIFACT_NAME = `${manifest.name}-${manifest.version}.vsix`;

const requiredExtensionFiles = [
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/webview.css",
  "extension/dist/codicon.ttf",
  "extension/media/pi.svg",
  "extension/media/icon.png",
  "extension/THIRD_PARTY_NOTICES.md",
  "extension/package.json",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/LICENSE.txt",
];

const forbiddenPrefixes = ["extension/src/", "extension/test/", "extension/node_modules/", "extension/scripts/"];

export function verifyRequiredFiles(inventory) {
  const files = new Set(inventory);
  for (const path of requiredExtensionFiles) {
    if (!files.has(path)) throw new Error(`VSIX is missing required extension file: ${path}`);
  }
  for (const path of inventory) {
    if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
      throw new Error(`VSIX unexpectedly contains a development file: ${path}`);
    }
    if (path.endsWith(".map")) throw new Error(`VSIX unexpectedly contains a source map: ${path}`);
  }
}

export function validateVsixManifest(xml) {
  const identity = xml.replace(/<!--[\s\S]*?-->/g, "").match(/<Identity(?=\s|\/>)([^>]*)>/);
  if (!identity) throw new Error("VSIX manifest is missing an Identity element.");
  if (/TargetPlatform\s*=/.test(identity[1])) {
    throw new Error("Pi Agent Manager must be packaged as a universal VSIX without a target platform.");
  }
}

export async function verifyVsix(artifact = ARTIFACT_NAME) {
  const entries = await readZipArchive(artifact);
  const inventory = [...entries.keys()];
  verifyRequiredFiles(inventory);
  const xml = entries.get("extension.vsixmanifest")?.data.toString("utf8");
  if (!xml) throw new Error("VSIX manifest is missing.");
  validateVsixManifest(xml);
  console.log(`Verified ${artifact}: ${inventory.length} files, universal package.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyVsix();
}
