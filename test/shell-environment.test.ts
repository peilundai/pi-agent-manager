import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  defaultShell,
  mergeEnvironment,
  parseShellEnvironment,
  quoteForShell,
  resolveShellEnvironment,
  shellArguments,
  type ProbeProcess,
  type ProbeSpawn,
} from "../src/pi/shell-environment";

class FakeChild extends EventEmitter implements ProbeProcess {
  readonly pid = undefined;
  readonly stdout = new EventEmitter();
  readonly kill = vi.fn(() => true);
}

/** A spawn stub whose child prints `output(marker)` and exits with `code`. */
function fakeSpawn(output: (marker: string) => string, options: { code?: number | null; hang?: boolean } = {}) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; stdio: readonly string[] }> = [];
  const children: FakeChild[] = [];
  const spawn: ProbeSpawn = (file, args, spawnOptions) => {
    calls.push({ file, args, env: spawnOptions.env, stdio: spawnOptions.stdio });
    const child = new FakeChild();
    children.push(child);
    if (!options.hang) {
      setTimeout(() => {
        const marker = spawnOptions.env.PI_AGENT_MANAGER_ENV_MARKER ?? "";
        child.stdout.emit("data", Buffer.from(output(marker)));
        child.emit("close", options.code ?? 0, null);
      }, 0);
    }
    return child;
  };
  return { spawn, calls, children };
}

describe("shell helpers", () => {
  it("quotes values for the shell, including single quotes", () => {
    expect(quoteForShell("/Applications/Visual Studio Code.app/x")).toBe("'/Applications/Visual Studio Code.app/x'");
    expect(quoteForShell("it's")).toBe(`'it'\\''s'`);
  });

  it("prefers $SHELL and falls back to a platform shell", () => {
    expect(defaultShell("darwin", { SHELL: " /opt/homebrew/bin/fish " })).toBe("/opt/homebrew/bin/fish");
    expect(defaultShell("linux", {})).toMatch(/\//);
  });

  it("starts an interactive login shell, with csh variants and unsupported shells handled", () => {
    expect(shellArguments("/bin/zsh", "cmd")).toEqual(["-i", "-l", "-c", "cmd"]);
    expect(shellArguments("/usr/local/bin/fish", "cmd")).toEqual(["-i", "-l", "-c", "cmd"]);
    expect(shellArguments("/bin/tcsh", "cmd")).toEqual(["-ic", "cmd"]);
    expect(shellArguments("/usr/local/bin/pwsh", "cmd")).toBeUndefined();
  });
});

describe("parseShellEnvironment", () => {
  const marker = "__M__";

  it("reads the JSON between markers and ignores rc-file noise around it", () => {
    const json = JSON.stringify({ GATEWAY_KEY: "sk-1", PATH: "/a:/b", SHLVL: "2", PWD: "/home", COUNT: 3, PI_AGENT_MANAGER_ENV_MARKER: marker });
    expect(parseShellEnvironment(`Welcome!\n${marker}${json}${marker}\nbye`, marker)).toEqual({ GATEWAY_KEY: "sk-1", PATH: "/a:/b" });
  });

  it("rejects missing markers, invalid JSON and non-objects", () => {
    expect(parseShellEnvironment("no markers", marker)).toBeUndefined();
    expect(parseShellEnvironment(`${marker}{}`, marker)).toBeUndefined();
    expect(parseShellEnvironment(`${marker}{oops${marker}`, marker)).toBeUndefined();
    expect(parseShellEnvironment(`${marker}[1]${marker}`, marker)).toBeUndefined();
  });
});

describe("resolveShellEnvironment", () => {
  it("runs the login shell with a Node probe and returns its environment", async () => {
    const { spawn, calls } = fakeSpawn((marker) => `motd\n${marker}${JSON.stringify({ EXA_API_KEY: "exa-1", ELECTRON_RUN_AS_NODE: "1" })}${marker}`);
    const result = await resolveShellEnvironment({ platform: "darwin", env: { SHELL: "/bin/zsh", HOME: "/u" }, execPath: "/Code Helper", spawn });
    expect(result).toMatchObject({ status: "loaded", shell: "/bin/zsh", env: { EXA_API_KEY: "exa-1" } });
    expect(calls[0]?.file).toBe("/bin/zsh");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
    expect(calls[0]?.args[3]).toMatch(/^'\/Code Helper' -e '/);
    expect(calls[0]?.env).toMatchObject({ HOME: "/u", ELECTRON_RUN_AS_NODE: "1", VSCODE_RESOLVING_ENVIRONMENT: "1" });
  });

  it("reports a shell that exits without printing its environment, without quoting its output", async () => {
    const { spawn, calls } = fakeSpawn(() => "+ export GATEWAY_KEY=sk-secret\n", { code: 1 });
    const result = await resolveShellEnvironment({ platform: "linux", env: { SHELL: "/bin/zsh" }, spawn });
    expect(result).toEqual({ status: "failed", shell: "/bin/zsh", error: "/bin/zsh exited with code 1 without printing its environment.", durationMs: expect.any(Number) });
    // stderr, where `set -x` traces exported values, is never read.
    expect(calls[0]?.stdio).toEqual(["ignore", "pipe", "ignore"]);
  });

  it("reports spawn failures", async () => {
    const throwing: ProbeSpawn = () => {
      throw new Error("ENOENT");
    };
    await expect(resolveShellEnvironment({ platform: "linux", env: { SHELL: "/nope" }, spawn: throwing })).resolves.toMatchObject({ status: "failed", error: "ENOENT" });

    const erroring: ProbeSpawn = () => {
      const child = new FakeChild();
      setTimeout(() => child.emit("error", new Error("spawn EACCES")), 0);
      return child;
    };
    await expect(resolveShellEnvironment({ platform: "linux", env: { SHELL: "/bin/sh" }, spawn: erroring })).resolves.toMatchObject({ status: "failed", error: "spawn EACCES" });
  });

  it("stops a shell that hangs", async () => {
    const { spawn, children } = fakeSpawn(() => "", { hang: true });
    const result = await resolveShellEnvironment({ platform: "linux", env: { SHELL: "/bin/bash" }, spawn, timeoutMs: 20 });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("did not finish") });
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("stops a shell that prints too much", async () => {
    const { spawn, children } = fakeSpawn(() => "x".repeat(9 * 1024 * 1024));
    const result = await resolveShellEnvironment({ platform: "linux", env: { SHELL: "/bin/bash" }, spawn });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("more than") });
    expect(children[0]?.kill).toHaveBeenCalled();
  });

  it("skips Windows, nested probes and unsupported shells", async () => {
    const { spawn, calls } = fakeSpawn(() => "");
    await expect(resolveShellEnvironment({ platform: "win32", spawn })).resolves.toMatchObject({ status: "skipped" });
    await expect(resolveShellEnvironment({ platform: "linux", env: { PI_AGENT_MANAGER_RESOLVING_ENVIRONMENT: "1" }, spawn })).resolves.toMatchObject({ status: "skipped" });
    await expect(resolveShellEnvironment({ platform: "linux", env: { SHELL: "/usr/bin/pwsh" }, spawn })).resolves.toMatchObject({ status: "skipped" });
    expect(calls).toHaveLength(0);
  });
});

describe("mergeEnvironment", () => {
  it("fills in missing variables and PATH entries without replacing VS Code's values", () => {
    const env = mergeEnvironment({
      base: { HOME: "/u", PATH: "/usr/bin:/bin", VIRTUAL_ENV: "/venv", EMPTY: "" },
      shell: { HOME: "/other", PATH: "/u/.nvm/bin:/usr/bin", GATEWAY_KEY: "sk-1", VIRTUAL_ENV: "/x", EMPTY: "filled" },
      delimiter: ":",
    });
    expect(env).toEqual({ HOME: "/u", PATH: "/usr/bin:/bin:/u/.nvm/bin", VIRTUAL_ENV: "/venv", EMPTY: "filled", GATEWAY_KEY: "sk-1" });
  });

  it("lets explicit overrides win", () => {
    expect(mergeEnvironment({ base: { KEY: "a" }, shell: { KEY: "b" }, overrides: { KEY: "c" } })).toEqual({ KEY: "c" });
    expect(mergeEnvironment({ base: {}, shell: { PATH: "/a" }, delimiter: ":" })).toEqual({ PATH: "/a" });
  });
});
