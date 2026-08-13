import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";

const nodePtyRoot = "node_modules/node-pty";

const excludedTopLevelDirectories = new Set([
  ".git",
  ".github",
  ".vscode",
  ".superpowers",
  "coverage",
  "docs",
  "resources",
  "scripts",
  "src",
  "test",
]);

const excludedTopLevelFiles = new Set([
  ".gitignore",
  "eslint.config.mjs",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
]);

export const ARTIFACT_NAME = "pi-agent-manager-0.1.0.vsix";

export const commonNodePtyRuntimeFiles = Object.freeze([
  `${nodePtyRoot}/package.json`,
  `${nodePtyRoot}/LICENSE`,
  `${nodePtyRoot}/lib/index.js`,
  `${nodePtyRoot}/lib/utils.js`,
  `${nodePtyRoot}/lib/eventEmitter2.js`,
  `${nodePtyRoot}/lib/terminal.js`,
  `${nodePtyRoot}/lib/unixTerminal.js`,
  `${nodePtyRoot}/lib/windowsTerminal.js`,
  `${nodePtyRoot}/lib/windowsPtyAgent.js`,
  `${nodePtyRoot}/lib/windowsConoutConnection.js`,
  `${nodePtyRoot}/lib/conpty_console_list_agent.js`,
  `${nodePtyRoot}/lib/shared/conout.js`,
  `${nodePtyRoot}/lib/worker/conoutSocketWorker.js`,
]);

function supportedArch(arch) {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new Error(`Unsupported extension host architecture: ${arch}`);
}

function darwinNativeFiles(arch) {
  const root = `${nodePtyRoot}/prebuilds/darwin-${arch}`;
  return [`${root}/pty.node`, `${root}/spawn-helper`];
}

function windowsNativeFiles(arch) {
  const root = `${nodePtyRoot}/prebuilds/win32-${arch}`;
  return [
    `${root}/conpty.node`,
    `${root}/conpty_console_list.node`,
    `${root}/pty.node`,
    `${root}/winpty-agent.exe`,
    `${root}/winpty.dll`,
    `${root}/conpty/OpenConsole.exe`,
    `${root}/conpty/conpty.dll`,
  ];
}

function linuxNativeFiles() {
  const root = `${nodePtyRoot}/build/Release`;
  return [`${root}/pty.node`];
}

export function derivePackageTarget(host) {
  const arch = supportedArch(host.arch);
  switch (host.platform) {
    case "darwin":
      return { platform: host.platform, arch, target: `darwin-${arch}`, nativeFiles: darwinNativeFiles(arch) };
    case "win32":
      return { platform: host.platform, arch, target: `win32-${arch}`, nativeFiles: windowsNativeFiles(arch) };
    case "linux":
      if (host.libc !== "glibc") {
        throw new Error("Alpine/musl packaging is not verified; build on a supported glibc Linux host.");
      }
      return { platform: host.platform, arch, target: `linux-${arch}`, nativeFiles: linuxNativeFiles() };
    default:
      throw new Error(`Unsupported extension host platform: ${host.platform}`);
  }
}

export function deriveCurrentPackageTarget(runtime = undefined) {
  const current = runtime ?? {
    platform: process.platform,
    arch: process.arch,
    report: process.report?.getReport(),
  };
  const libc =
    current.platform === "linux"
      ? current.report?.header?.glibcVersionRuntime
        ? "glibc"
        : "musl"
      : undefined;
  return derivePackageTarget({ platform: current.platform, arch: current.arch, libc });
}

export async function prepareNativeRuntime(target, root = process.cwd()) {
  for (const path of target.nativeFiles) {
    try {
      await stat(join(root, path));
    } catch {
      throw new Error(`Missing native runtime for ${target.target}: ${path}`);
    }
  }

  if (target.platform === "darwin") {
    const helper = target.nativeFiles.find((path) => path.endsWith("/spawn-helper"));
    if (!helper) throw new Error(`Missing native runtime helper for ${target.target}.`);
    const helperPath = join(root, helper);
    const file = await stat(helperPath);
    await chmod(helperPath, file.mode | 0o111);
  }
}

export function createTargetIgnore(baseIgnore, target) {
  const includes = [...commonNodePtyRuntimeFiles, ...target.nativeFiles]
    .map((path) => `!${path}`)
    .join("\n");
  return `${baseIgnore.trimEnd()}\n${includes}\n`;
}

export function packageArguments(target, ignoreFile) {
  return [
    "package",
    "--target",
    target.target,
    "--out",
    ARTIFACT_NAME,
    "--ignoreFile",
    ignoreFile,
  ];
}

export function validateArchiveInventory(inventory, target) {
  const files = new Set(inventory);
  const required = [...commonNodePtyRuntimeFiles, ...target.nativeFiles].map(
    (path) => `extension/${path}`,
  );
  for (const path of required) {
    if (!files.has(path)) throw new Error(`VSIX is missing required runtime file: ${path}`);
  }

  const allowedRuntime = new Set(required);
  const unexpected = inventory.find(
    (path) => path.startsWith(`extension/${nodePtyRoot}/`) && !allowedRuntime.has(path),
  );
  if (unexpected) {
    const native =
      unexpected.startsWith(`extension/${nodePtyRoot}/prebuilds/`) ||
      unexpected.startsWith(`extension/${nodePtyRoot}/build/`);
    throw new Error(
      native
        ? `VSIX contains foreign node-pty native file: ${unexpected}`
        : `VSIX contains unexpected node-pty runtime file: ${unexpected}`,
    );
  }

  const excludedDevelopmentFile = inventory.find((path) => {
    if (!path.startsWith("extension/")) return false;
    const relativePath = path.slice("extension/".length);
    const topLevelName = relativePath.split("/", 1)[0];
    return (
      excludedTopLevelDirectories.has(topLevelName) ||
      excludedTopLevelFiles.has(relativePath) ||
      (!relativePath.includes("/") && relativePath.endsWith(".vsix"))
    );
  });
  if (excludedDevelopmentFile) {
    throw new Error(`VSIX contains excluded development file: ${excludedDevelopmentFile}`);
  }
}

export function validateVsixManifest(manifest, target) {
  const withoutComments = manifest.replace(/<!--[\s\S]*?-->/g, "");
  const identity = withoutComments.match(/<Identity(?=\s|\/>)([^>]*)>/);
  if (!identity) throw new Error("VSIX manifest is missing an Identity element.");

  const attributes = new Map();
  const attributePattern = /([:\w.-]+)\s*=\s*(["'])(.*?)\2/g;
  for (const match of identity[1].matchAll(attributePattern)) {
    attributes.set(match[1], match[3]);
  }
  if (attributes.get("TargetPlatform") !== target.target) {
    throw new Error(`VSIX manifest Identity does not target ${target.target}.`);
  }
}
