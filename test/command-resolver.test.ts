import { describe, expect, it } from "vitest";
import {
  buildPiArgs,
  buildPiInvocation,
  PiCommandNotFoundError,
  resolvePiCommand,
} from "../src/pi/command-resolver";

describe("buildPiInvocation", () => {
  it("passes POSIX executables and arguments directly", () => {
    expect(buildPiInvocation("/opt/homebrew/bin/pi", ["--session", "/work/a b.jsonl"], "darwin")).toEqual({
      file: "/opt/homebrew/bin/pi",
      args: ["--session", "/work/a b.jsonl"],
    });
  });

  it("wraps a Windows npm cmd shim without shell interpolation", () => {
    expect(
      buildPiInvocation(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd",
        ["--session", "C:\\work\\a b.jsonl"],
        "win32",
      ),
    ).toEqual({
      file: process.env.ComSpec ?? "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "\"\"C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd\" --session \"C:\\work\\a b.jsonl\"\"",
      ],
    });
  });

  it("rejects cmd metacharacters before constructing a shim command", () => {
    expect(() => buildPiInvocation("C:\\npm\\pi.cmd", ["--session", "C:\\work\\x&whoami.jsonl"], "win32"))
      .toThrow(/unsafe/i);
  });
});

describe("buildPiArgs", () => {
  it("loads the manager extension before an optional transcript", () => {
    expect(buildPiArgs("/extension/pi-status.mjs", "/sessions/one.jsonl")).toEqual([
      "--extension",
      "/extension/pi-status.mjs",
      "--session",
      "/sessions/one.jsonl",
    ]);
    expect(buildPiArgs("/extension/pi-status.mjs")).toEqual(["--extension", "/extension/pi-status.mjs"]);
  });
});

describe("resolvePiCommand", () => {
  it("prefers a validated explicit executable", async () => {
    const resolved = await resolvePiCommand({
      configured: "/custom/pi",
      env: { PATH: "/bin" },
      platform: "darwin",
      access: async (path) => path === "/custom/pi",
      npmRoot: async () => undefined,
    });
    expect(resolved.path).toBe("/custom/pi");
    expect(resolved.source).toBe("configured");
  });

  it("finds an executable name on PATH", async () => {
    const resolved = await resolvePiCommand({
      configured: "pi",
      env: { PATH: "/first:/second" },
      platform: "linux",
      access: async (path) => path === "/second/pi",
      npmRoot: async () => undefined,
      commonPaths: [],
    });
    expect(resolved).toMatchObject({ path: "/second/pi", source: "path" });
    expect(resolved.attempts).toEqual(["/first/pi", "/second/pi"]);
  });

  it("reports every attempted location when Pi is missing", async () => {
    const promise = resolvePiCommand({
      configured: "pi",
      env: { PATH: "/bin" },
      platform: "linux",
      access: async () => false,
      npmRoot: async () => "/usr/local/lib/node_modules",
      commonPaths: ["/custom/bin/pi"],
    });
    await expect(promise).rejects.toBeInstanceOf(PiCommandNotFoundError);
    await expect(promise).rejects.toMatchObject({
      attempts: ["/bin/pi", "/usr/local/bin/pi", "/custom/bin/pi"],
    });
  });
});
