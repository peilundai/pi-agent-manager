import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { EnvironmentReference } from "../src/pi/config-references";
import type { ShellEnvironmentResult } from "../src/pi/shell-environment";
import { PiEnvironment, registerEnvironmentCommands } from "../src/view/pi-environment";
import { configuration, resetVscodeMock } from "./vscode-mock";
import type * as VscodeMock from "./vscode-mock";

const mock = vscode as unknown as typeof VscodeMock;

function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key)),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    keys: vi.fn(async () => [...store.keys()]),
    onDidChange: vi.fn(),
    map: store,
  };
}

function setup(
  options: {
    base?: NodeJS.ProcessEnv;
    shell?: ShellEnvironmentResult;
    references?: EnvironmentReference[];
    secrets?: Record<string, string>;
  } = {},
) {
  const secrets = fakeSecrets(options.secrets);
  const log = { info: vi.fn(), warn: vi.fn(), show: vi.fn() };
  const resolveShell = vi.fn(async () => options.shell ?? ({ status: "skipped", reason: "test" } as ShellEnvironmentResult));
  const findReferences = vi.fn(async () => options.references ?? []);
  const environment = new PiEnvironment({
    secrets: secrets as unknown as vscode.SecretStorage,
    log: log as unknown as vscode.LogOutputChannel,
    baseEnv: options.base ?? { PATH: "/usr/bin" },
    resolveShell,
    findReferences,
  });
  return { environment, secrets, log, resolveShell, findReferences };
}

const loaded = (env: Record<string, string>): ShellEnvironmentResult => ({ status: "loaded", shell: "/bin/zsh", env, durationMs: 12 });
const reference = (name: string): EnvironmentReference => ({ name, file: "/agent/models.json", field: `providers.gw.apiKey` });

beforeEach(() => resetVscodeMock());

describe("PiEnvironment", () => {
  it("merges VS Code, login-shell, setting and secret values in that order", async () => {
    configuration.set("environment", { GATEWAY_URL: "https://gw", BAD: 1, "not valid": "x" });
    const { environment, log, resolveShell } = setup({
      base: { PATH: "/usr/bin", HOME: "/u" },
      shell: loaded({ PATH: "/u/.nvm/bin", GATEWAY_KEY: "from-shell", EXA_API_KEY: "from-shell" }),
      secrets: { "piAgentManager.env.EXA_API_KEY": "from-secret", "other.key": "ignored" },
    });
    environment.preload();
    const resolved = await environment.resolveDetailed();
    expect(resolved.env).toEqual({
      PATH: "/usr/bin:/u/.nvm/bin",
      HOME: "/u",
      GATEWAY_KEY: "from-shell",
      EXA_API_KEY: "from-secret",
      GATEWAY_URL: "https://gw",
    });
    expect(["EXA_API_KEY", "GATEWAY_URL", "HOME", "GATEWAY_KEY", "NOPE"].map((name) => resolved.sourceOf(name))).toEqual([
      "secret",
      "setting",
      "VS Code",
      "login shell",
      "missing",
    ]);
    await environment.resolve();
    // The shell is asked once and cached until reload.
    expect(resolveShell).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Loaded 3 environment variables from /bin/zsh"));
    environment.reload();
    await environment.resolve();
    expect(resolveShell).toHaveBeenCalledTimes(2);
  });

  it("logs shell failures, never values, and can be turned off", async () => {
    const failing = setup({ shell: { status: "failed", shell: "/bin/zsh", error: "timed out.", durationMs: 10_000 } });
    expect((await failing.environment.resolve()).PATH).toBe("/usr/bin");
    expect(failing.log.warn).toHaveBeenCalledWith(expect.stringContaining("timed out."));

    configuration.set("loadShellEnvironment", false);
    const off = setup({ shell: loaded({ KEY: "x" }) });
    expect((await off.environment.resolve()).KEY).toBeUndefined();
    expect(off.resolveShell).not.toHaveBeenCalled();
  });

  it("stores, lists and deletes secrets under a private prefix", async () => {
    const { environment, secrets } = setup();
    await environment.setSecret("GATEWAY_KEY", "sk-1");
    await expect(environment.setSecret("bad name", "x")).rejects.toThrow("not a valid");
    expect(secrets.map.get("piAgentManager.env.GATEWAY_KEY")).toBe("sk-1");
    expect(await environment.secretNames()).toEqual(["GATEWAY_KEY"]);
    await environment.deleteSecret("GATEWAY_KEY");
    expect(await environment.secretNames()).toEqual([]);
  });

  it("warns once about missing variables and offers to set one", async () => {
    const { environment } = setup({ references: [reference("EXA_API_KEY"), reference("GATEWAY_KEY"), reference("SET_KEY")] });
    mock.window.showWarningMessage.mockResolvedValueOnce("Set Secret…");
    await environment.checkMissing("/work", { SET_KEY: "x" });
    expect(mock.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("uses EXA_API_KEY and GATEWAY_KEY, but they are not set"),
      "Set Secret…",
      "Show Details",
    );
    expect(mock.commands.executeCommand).toHaveBeenCalledWith("piAgentManager.setEnvironmentSecret", "EXA_API_KEY");

    await environment.checkMissing("/work", { SET_KEY: "x" });
    expect(mock.window.showWarningMessage).toHaveBeenCalledTimes(1);

    environment.reload();
    mock.window.showWarningMessage.mockResolvedValueOnce("Show Details");
    await environment.checkMissing(undefined, { EXA_API_KEY: "x", SET_KEY: "x" });
    expect(mock.window.showWarningMessage).toHaveBeenLastCalledWith(expect.stringContaining("uses GATEWAY_KEY, but it is not set"), "Set Secret…", "Show Details");
    expect(mock.commands.executeCommand).toHaveBeenLastCalledWith("piAgentManager.showEnvironmentDiagnostics");
  });

  it("reports where each referenced variable comes from without its value", async () => {
    const { environment, log } = setup({
      base: { HOME: "/u" },
      shell: loaded({ GATEWAY_KEY: "super-secret-value" }),
      references: [reference("GATEWAY_KEY"), reference("EXA_API_KEY")],
      secrets: { "piAgentManager.env.STORED": "x" },
    });
    await environment.showDiagnostics("/work");
    const lines = [...log.info.mock.calls, ...log.warn.mock.calls].map((call) => String(call[0]));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Login shell: /bin/zsh, 1 variables"),
        "Stored secrets: STORED",
        expect.stringMatching(/^GATEWAY_KEY: set \(login shell\), used by providers\.gw\.apiKey/),
        expect.stringMatching(/^EXA_API_KEY: MISSING/),
      ]),
    );
    expect(lines.join("\n")).not.toContain("super-secret-value");
    expect(log.show).toHaveBeenCalled();

    const empty = setup({ shell: { status: "failed", shell: "/bin/zsh", error: "boom", durationMs: 1 } });
    await empty.environment.showDiagnostics(undefined);
    expect(empty.log.warn).toHaveBeenCalledWith("Login shell: failed: boom");
    expect(empty.log.info).toHaveBeenCalledWith("Stored secrets: none");
    expect(empty.log.info).toHaveBeenCalledWith(expect.stringContaining("reference no environment variables"));

    const skipped = setup();
    await skipped.environment.showDiagnostics(undefined);
    expect(skipped.log.info).toHaveBeenCalledWith("Login shell: skipped: test");
  });
});

describe("environment commands", () => {
  function commands(options: Parameters<typeof setup>[0] = {}) {
    const context = setup(options);
    const restart = vi.fn(async () => undefined);
    registerEnvironmentCommands({ environment: context.environment, cwd: () => "/work", restart });
    const handlers = new Map(mock.commands.registerCommand.mock.calls.map((call) => [call[0] as string, call[1] as (...args: unknown[]) => Promise<void>]));
    return { ...context, restart, run: (name: string, ...args: unknown[]) => handlers.get(`piAgentManager.${name}`)!(...args) };
  }

  it("sets a preset secret with a masked prompt and restarts Pi", async () => {
    const { run, secrets, restart } = commands();
    mock.window.showInputBox.mockResolvedValueOnce("exa-123");
    await run("setEnvironmentSecret", "EXA_API_KEY");
    expect(mock.window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({ password: true, title: "Set EXA_API_KEY" }));
    expect(secrets.map.get("piAgentManager.env.EXA_API_KEY")).toBe("exa-123");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("offers missing variables first, then any name", async () => {
    const { run, secrets, restart } = commands({ references: [reference("GATEWAY_KEY")] });
    mock.window.showQuickPick.mockResolvedValueOnce("GATEWAY_KEY");
    mock.window.showInputBox.mockResolvedValueOnce("sk-1");
    await run("setEnvironmentSecret");
    expect(mock.window.showQuickPick).toHaveBeenCalledWith(["GATEWAY_KEY", "Another variable…"], expect.anything());
    expect(secrets.map.get("piAgentManager.env.GATEWAY_KEY")).toBe("sk-1");

    mock.window.showQuickPick.mockResolvedValueOnce("Another variable…");
    mock.window.showInputBox.mockResolvedValueOnce(" CUSTOM ").mockResolvedValueOnce("v");
    await run("setEnvironmentSecret");
    const validate = (mock.window.showInputBox.mock.calls[1]?.[0] as { validateInput(value: string): string | undefined }).validateInput;
    expect(validate("OK_NAME")).toBeUndefined();
    expect(validate("1bad")).toMatch(/letters/);
    expect(secrets.map.get("piAgentManager.env.CUSTOM")).toBe("v");
    expect(restart).toHaveBeenCalledTimes(2);

    // Cancelling at any step changes nothing.
    await run("setEnvironmentSecret");
    mock.window.showInputBox.mockResolvedValueOnce(undefined);
    await run("setEnvironmentSecret", "GATEWAY_KEY");
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("asks for a name directly when nothing is missing", async () => {
    const { run, restart } = commands();
    mock.window.showInputBox.mockResolvedValueOnce("");
    await run("setEnvironmentSecret");
    expect(mock.window.showQuickPick).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("removes a stored secret", async () => {
    const empty = commands();
    await empty.run("removeEnvironmentSecret");
    expect(mock.window.showInformationMessage).toHaveBeenCalledWith("No environment secrets are stored for Pi.");

    resetVscodeMock();
    const { run, secrets, restart } = commands({ secrets: { "piAgentManager.env.OLD": "x" } });
    await run("removeEnvironmentSecret");
    expect(restart).not.toHaveBeenCalled();
    mock.window.showQuickPick.mockResolvedValueOnce("OLD");
    await run("removeEnvironmentSecret");
    expect(secrets.map.has("piAgentManager.env.OLD")).toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("reloads the environment and shows diagnostics", async () => {
    const { run, restart, resolveShell, log, environment } = commands({ shell: loaded({}) });
    await environment.resolve();
    await run("reloadEnvironment");
    await environment.resolve();
    expect(resolveShell).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
    await run("showEnvironmentDiagnostics");
    expect(log.show).toHaveBeenCalled();
  });
});
