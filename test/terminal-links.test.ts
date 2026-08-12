import { describe, expect, it } from "vitest";
import {
  httpUrl,
  parseTerminalTarget,
  resolveFileTarget,
} from "../src/terminal/links";

describe("resolveFileTarget", () => {
  it("resolves a workspace-relative source location", () => {
    expect(resolveFileTarget("src/auth.ts:12:4", "/repo", "linux")).toEqual({
      path: "/repo/src/auth.ts",
      line: 11,
      column: 3,
    });
  });

  it("supports line fragments and quoted paths with spaces", () => {
    expect(resolveFileTarget("`src/my file.ts#L9`", "/repo", "linux")).toEqual({
      path: "/repo/src/my file.ts",
      line: 8,
    });
  });

  it("preserves simulated Windows absolute paths", () => {
    expect(resolveFileTarget("C:\\repo\\src\\auth.ts:3:2", "C:\\repo", "win32")).toEqual({
      path: "C:\\repo\\src\\auth.ts",
      line: 2,
      column: 1,
    });
  });

  it("rejects invalid coordinates and control characters", () => {
    expect(() => resolveFileTarget("src/auth.ts:0", "/repo", "linux")).toThrow(/line/i);
    expect(() => resolveFileTarget("src/\u0000auth.ts:2", "/repo", "linux")).toThrow(/control/i);
  });
});

describe("terminal target parsing", () => {
  it("accepts HTTP(S) URLs and file targets only", () => {
    expect(httpUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(httpUrl("ftp://example.com/file")).toBeUndefined();
    expect(parseTerminalTarget("https://example.com", "/repo", "linux")).toEqual({
      kind: "url",
      target: "https://example.com/",
    });
    expect(parseTerminalTarget("src/a.ts:2", "/repo", "linux")).toEqual({
      kind: "file",
      target: { path: "/repo/src/a.ts", line: 1 },
    });
  });
});
