// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateVsixManifest, verifyRequiredFiles } from "../scripts/verify-vsix.mjs";

const required = [
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/webview.css",
  "extension/dist/codicon.ttf",
  "extension/media/pi.svg",
  "extension/package.json",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/LICENSE.txt",
];

describe("VSIX verification", () => {
  it("requires runtime files and rejects development files", () => {
    expect(() => verifyRequiredFiles(required)).not.toThrow();
    expect(() => verifyRequiredFiles(required.slice(1))).toThrow(/missing required/);
    expect(() => verifyRequiredFiles([...required, "extension/src/extension.ts"])).toThrow(/development file/);
    expect(() => verifyRequiredFiles([...required, "extension/dist/webview.js.map"])).toThrow(/source map/);
  });

  it("requires a universal manifest", () => {
    expect(() => validateVsixManifest('<Identity Id="pi" Version="0.2.0" />')).not.toThrow();
    expect(() => validateVsixManifest('<Identity Id="pi" TargetPlatform="darwin-arm64" />')).toThrow(/universal/);
  });
});
