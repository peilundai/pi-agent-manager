import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_NAME,
  commonNodePtyRuntimeFiles,
  createTargetIgnore,
  deriveCurrentPackageTarget,
  derivePackageTarget,
  packageArguments,
  prepareNativeRuntime,
  validateArchiveInventory,
  validateVsixManifest,
} from "../scripts/package-target.mjs";
import { verifyVsix } from "../scripts/verify-vsix.mjs";
import { extractZipArchive, readZipArchive } from "../scripts/vsix-archive.mjs";

const require = createRequire(import.meta.url);
const { ZipFile } = require("yazl") as {
  ZipFile: new () => {
    addBuffer(buffer: Buffer, path: string, options?: { mode?: number }): void;
    end(): void;
    outputStream: NodeJS.ReadableStream;
  };
};

describe("host-targeted packaging", () => {
  it.each([
    [{ platform: "darwin", arch: "x64" }, "darwin-x64", "prebuilds/darwin-x64"],
    [{ platform: "darwin", arch: "arm64" }, "darwin-arm64", "prebuilds/darwin-arm64"],
    [{ platform: "win32", arch: "x64" }, "win32-x64", "prebuilds/win32-x64"],
    [{ platform: "win32", arch: "arm64" }, "win32-arm64", "prebuilds/win32-arm64"],
    [{ platform: "linux", arch: "x64", libc: "glibc" }, "linux-x64", "build/Release"],
    [{ platform: "linux", arch: "arm64", libc: "glibc" }, "linux-arm64", "build/Release"],
  ] as const)("maps %j to %s with matching native files", (host, target, nativeRoot) => {
    const result = derivePackageTarget(host);

    expect(result.target).toBe(target);
    expect(result.nativeFiles).not.toHaveLength(0);
    expect(result.nativeFiles.every((path) => path.includes(`/node-pty/${nativeRoot}/`))).toBe(true);
  });

  it("rejects Alpine and unsupported desktop architectures without claiming a package", () => {
    expect(() => derivePackageTarget({ platform: "linux", arch: "x64", libc: "musl" })).toThrow(
      "Alpine/musl packaging is not verified",
    );
    expect(() => derivePackageTarget({ platform: "darwin", arch: "ia32" })).toThrow(
      "Unsupported extension host",
    );
  });

  it("derives glibc Linux from the current host report boundary", () => {
    expect(
      deriveCurrentPackageTarget({
        platform: "linux",
        arch: "arm64",
        report: { header: { glibcVersionRuntime: "2.39" } },
      }).target,
    ).toBe("linux-arm64");
    expect(() =>
      deriveCurrentPackageTarget({
        platform: "linux",
        arch: "x64",
        report: { header: {} },
      }),
    ).toThrow("Alpine/musl packaging is not verified");
  });

  it.each(["x64", "arm64"] as const)(
    "uses only the node-pty binary built on glibc Linux %s",
    (arch) => {
      expect(derivePackageTarget({ platform: "linux", arch, libc: "glibc" }).nativeFiles).toEqual([
        "node_modules/node-pty/build/Release/pty.node",
      ]);
    },
  );

  it("prepares a glibc Linux runtime without requiring or chmodding a Darwin helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-package-linux-target-"));
    try {
      const target = derivePackageTarget({ platform: "linux", arch: "x64", libc: "glibc" });
      const native = join(root, "node_modules/node-pty/build/Release/pty.node");
      await mkdir(dirname(native), { recursive: true });
      await writeFile(native, "native");
      await chmod(native, 0o644);

      await prepareNativeRuntime(target, root);

      expect((await stat(native)).mode & 0o111).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates the target native files and makes a Darwin helper executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-package-target-"));
    try {
      const target = derivePackageTarget({ platform: "darwin", arch: "arm64" });
      for (const path of target.nativeFiles) {
        const fullPath = join(root, path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, path.endsWith(".node") ? "native" : "helper");
      }
      const helper = join(root, target.nativeFiles[1] ?? "missing");
      await chmod(helper, 0o644);

      await prepareNativeRuntime(target, root);

      expect((await stat(helper)).mode & 0o111).not.toBe(0);
      await rm(join(root, target.nativeFiles[0] ?? "missing"));
      await expect(prepareNativeRuntime(target, root)).rejects.toThrow(
        "Missing native runtime for darwin-arm64",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains both Unix and Windows JavaScript branches plus only the target native runtime", () => {
    expect(commonNodePtyRuntimeFiles).toEqual([
      "node_modules/node-pty/package.json",
      "node_modules/node-pty/LICENSE",
      "node_modules/node-pty/lib/index.js",
      "node_modules/node-pty/lib/utils.js",
      "node_modules/node-pty/lib/eventEmitter2.js",
      "node_modules/node-pty/lib/terminal.js",
      "node_modules/node-pty/lib/unixTerminal.js",
      "node_modules/node-pty/lib/windowsTerminal.js",
      "node_modules/node-pty/lib/windowsPtyAgent.js",
      "node_modules/node-pty/lib/windowsConoutConnection.js",
      "node_modules/node-pty/lib/conpty_console_list_agent.js",
      "node_modules/node-pty/lib/shared/conout.js",
      "node_modules/node-pty/lib/worker/conoutSocketWorker.js",
    ]);

    const windows = derivePackageTarget({ platform: "win32", arch: "x64" });
    expect(windows.nativeFiles).toEqual([
      "node_modules/node-pty/prebuilds/win32-x64/conpty.node",
      "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node",
      "node_modules/node-pty/prebuilds/win32-x64/pty.node",
      "node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe",
      "node_modules/node-pty/prebuilds/win32-x64/winpty.dll",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll",
    ]);

    const ignore = createTargetIgnore("node_modules/**\n", windows);
    for (const path of [...commonNodePtyRuntimeFiles, ...windows.nativeFiles]) {
      expect(ignore).toContain(`!${path}`);
    }
    expect(ignore).not.toContain("!node_modules/node-pty/prebuilds/darwin-arm64/pty.node");
  });

  it("builds VSCE arguments with target metadata, dynamic inventory, and the stable artifact name", () => {
    const target = derivePackageTarget({ platform: "linux", arch: "arm64", libc: "glibc" });

    expect(ARTIFACT_NAME).toBe("pi-agent-manager-0.1.0.vsix");
    expect(packageArguments(target, "/tmp/pi-agent-manager-linux-arm64.ignore")).toEqual([
      "package",
      "--target",
      "linux-arm64",
      "--out",
      "pi-agent-manager-0.1.0.vsix",
      "--ignoreFile",
      "/tmp/pi-agent-manager-linux-arm64.ignore",
    ]);
  });

  it("rejects a VSIX with a foreign native binary or a missing target file", () => {
    const target = derivePackageTarget({ platform: "darwin", arch: "arm64" });
    const valid = [
      "extension/package.json",
      "extension.vsixmanifest",
      ...commonNodePtyRuntimeFiles.map((path) => `extension/${path}`),
      ...target.nativeFiles.map((path) => `extension/${path}`),
    ];

    expect(() => validateArchiveInventory(valid, target)).not.toThrow();
    expect(() =>
      validateArchiveInventory(
        [...valid, "extension/node_modules/node-pty/prebuilds/win32-x64/pty.node"],
        target,
      ),
    ).toThrow("foreign node-pty native file");
    expect(() => validateArchiveInventory(valid.slice(0, -1), target)).toThrow(
      "missing required runtime file",
    );
    expect(() =>
      validateArchiveInventory(
        [...valid, "extension/node_modules/node-pty/lib/terminal.test.js"],
        target,
      ),
    ).toThrow("unexpected node-pty runtime file");
  });

  it.each([
    "extension/src/extension.ts",
    "extension/test/package-runtime.test.ts",
    "extension/scripts/package-target.mjs",
    "extension/coverage/index.html",
    "extension/.git/config",
    "extension/.gitignore",
    "extension/.github/workflows/ci.yml",
    "extension/.vscode/launch.json",
    "extension/.superpowers/sdd/task.md",
    "extension/docs/architecture.md",
    "extension/resources/pi-status.ts",
    "extension/eslint.config.mjs",
    "extension/tsconfig.json",
    "extension/vitest.config.ts",
    "extension/package-lock.json",
    "extension/nested.vsix",
  ])("rejects the excluded top-level development file %s", (excludedPath) => {
    const target = derivePackageTarget({ platform: "darwin", arch: "arm64" });
    const runtimeAndUserFiles = [
      "extension/dist/extension.js",
      "extension/media/pi.svg",
      "extension/package.json",
      "extension/readme.md",
      "extension/changelog.md",
      "extension/LICENSE.txt",
      ...commonNodePtyRuntimeFiles.map((path) => `extension/${path}`),
      ...target.nativeFiles.map((path) => `extension/${path}`),
    ];

    expect(() => validateArchiveInventory(runtimeAndUserFiles, target)).not.toThrow();
    expect(() =>
      validateArchiveInventory([...runtimeAndUserFiles, excludedPath], target),
    ).toThrow("excluded development file");
  });

  it("requires VSIX target metadata to match the derived extension host", () => {
    const target = derivePackageTarget({ platform: "win32", arch: "arm64" });
    const matching = '<Identity Id="pi-agent-manager" TargetPlatform="win32-arm64"/>';

    expect(() => validateVsixManifest(matching, target)).not.toThrow();
    expect(() =>
      validateVsixManifest(
        '<Identity Id="pi-agent-manager" TargetPlatform="darwin-arm64"/>',
        target,
      ),
    ).toThrow("does not target win32-arm64");
  });

  it("rejects matching target text outside the Identity TargetPlatform attribute", () => {
    const target = derivePackageTarget({ platform: "win32", arch: "arm64" });
    const decoy = `<?xml version="1.0"?>
      <PackageManifest>
        <Identity Id="pi-agent-manager" TargetPlatform="darwin-arm64"/>
        <Metadata Note='TargetPlatform="win32-arm64"'/>
      </PackageManifest>`;

    expect(() => validateVsixManifest(decoy, target)).toThrow("does not target win32-arm64");
    expect(() =>
      validateVsixManifest(
        '<PackageManifest><Metadata TargetPlatform="win32-arm64"/></PackageManifest>',
        target,
      ),
    ).toThrow("Identity element");
  });

  it("verifies a glibc Linux package without a macOS spawn-helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-linux-vsix-"));
    const archive = join(root, "linux.vsix");
    try {
      const target = derivePackageTarget({ platform: "linux", arch: "x64", libc: "glibc" });
      const zip = new ZipFile();
      const packageJson = JSON.stringify({ name: "node-pty", main: "lib/index.js" });
      const fakePty = `exports.spawn = function () {
        let onData;
        return {
          onData(callback) { onData = callback; },
          onExit(callback) {
            setImmediate(function () {
              onData("VERIFIED_VSIX_PTY");
              callback({ exitCode: 0 });
            });
          },
          kill() {}
        };
      };`;
      const requiredFiles = [
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
      zip.addBuffer(
        Buffer.from(
          '<PackageManifest><Identity Id="pi-agent-manager" TargetPlatform="linux-x64"/></PackageManifest>',
        ),
        "extension.vsixmanifest",
      );
      for (const path of requiredFiles) {
        const content = path === "extension/package.json" ? JSON.stringify({ name: "fixture" }) : "fixture";
        zip.addBuffer(Buffer.from(content), path);
      }
      for (const path of commonNodePtyRuntimeFiles) {
        const content = path.endsWith("/package.json")
          ? packageJson
          : path.endsWith("/lib/index.js")
            ? fakePty
            : "fixture";
        zip.addBuffer(Buffer.from(content), `extension/${path}`);
      }
      for (const path of target.nativeFiles) {
        zip.addBuffer(Buffer.from("native"), `extension/${path}`);
      }
      const output = createWriteStream(archive);
      zip.outputStream.pipe(output);
      zip.end();
      await finished(output);

      await expect(verifyVsix(target, archive)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Node VSIX archive handling", () => {
  it("reads and extracts ZIP entries while preserving executable mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-vsix-archive-"));
    const archive = join(root, "fixture.vsix");
    const extraction = join(root, "extracted");
    try {
      const zip = new ZipFile();
      zip.addBuffer(Buffer.from("manifest"), "extension.vsixmanifest", { mode: 0o100644 });
      zip.addBuffer(Buffer.from("helper"), "extension/native/spawn-helper", { mode: 0o100755 });
      const output = createWriteStream(archive);
      zip.outputStream.pipe(output);
      zip.end();
      await finished(output);

      const entries = await readZipArchive(archive);
      expect([...entries.keys()]).toEqual([
        "extension.vsixmanifest",
        "extension/native/spawn-helper",
      ]);
      expect(entries.get("extension.vsixmanifest")?.data.toString("utf8")).toBe("manifest");

      await extractZipArchive(entries, extraction);

      const helper = join(extraction, "extension", "native", "spawn-helper");
      expect(await readFile(helper, "utf8")).toBe("helper");
      if (process.platform !== "win32") expect((await stat(helper)).mode & 0o111).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
