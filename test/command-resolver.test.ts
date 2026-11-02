import { describe, expect, it } from "vitest";
import {
  augmentPath,
  buildRpcArgs,
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

  it("wraps a Windows npm cmd shim through quoted environment indirection", () => {
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
        "/v:off",
        "/c",
        "\"\"%PI_AGENT_MANAGER_SHIM_COMMAND%\" \"%PI_AGENT_MANAGER_SHIM_ARG_0%\" \"%PI_AGENT_MANAGER_SHIM_ARG_1%\"\"",
      ],
      env: {
        PI_AGENT_MANAGER_SHIM_COMMAND: "C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd",
        PI_AGENT_MANAGER_SHIM_ARG_0: "--session",
        PI_AGENT_MANAGER_SHIM_ARG_1: "C:\\work\\a b.jsonl",
      },
    });
  });

  it.each([
    ["ampersand", "C:\\Pi & tools\\pi.cmd", "C:\\work\\agent & notes.jsonl"],
    ["caret", "C:\\Pi^tools\\pi.cmd", "C:\\work\\agent^notes.jsonl"],
    ["percent", "C:\\Pi%tools%\\pi.cmd", "C:\\work\\agent%PATH%.jsonl"],
    ["spaces", "C:\\Program Files\\Pi\\pi.cmd", "C:\\work files\\agent notes.jsonl"],
    ["Unicode", "C:\\工具\\π\\pi.cmd", "C:\\工作\\代理.jsonl"],
  ])("preserves %s in legal Windows paths without embedding values in cmd source", (_label, command, sessionPath) => {
    const invocation = buildPiInvocation(command, ["--session", sessionPath], "win32");

    expect(invocation.env).toEqual({
      PI_AGENT_MANAGER_SHIM_COMMAND: command,
      PI_AGENT_MANAGER_SHIM_ARG_0: "--session",
      PI_AGENT_MANAGER_SHIM_ARG_1: sessionPath,
    });
    const commandSource = invocation.args.at(-1) ?? "";
    expect(commandSource).not.toContain(command);
    expect(commandSource).not.toContain(sessionPath);
    expect(commandSource).toContain("%PI_AGENT_MANAGER_SHIM_COMMAND%");
  });
});

describe("buildRpcArgs", () => {
  it("starts RPC mode with an optional transcript", () => {
    expect(buildRpcArgs({ sessionPath: "/sessions/one.jsonl" })).toEqual([
      "--mode",
      "rpc",
      "--session",
      "/sessions/one.jsonl",
    ]);
    expect(buildRpcArgs()).toEqual(["--mode", "rpc"]);
  });

  it("passes extra arguments but rejects reserved flags", () => {
    expect(buildRpcArgs({ extraArgs: [" --offline ", ""] })).toEqual(["--mode", "rpc", "--offline"]);
    expect(() => buildRpcArgs({ extraArgs: ["--mode=json"] })).toThrow(/managed by the extension/);
    expect(() => buildRpcArgs({ extraArgs: ["--session"] })).toThrow(/managed by the extension/);
  });
});

describe("augmentPath", () => {
  it("prepends the executable directory once", () => {
    expect(augmentPath("/home/u/.nvm/bin/pi", { PATH: "/usr/bin" }, "linux")).toBe(
      "/home/u/.nvm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin",
    );
    expect(augmentPath("/usr/bin/pi", { PATH: "/usr/bin:/usr/local/bin" }, "linux")).toBe(
      "/opt/homebrew/bin:/usr/bin:/usr/local/bin",
    );
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
