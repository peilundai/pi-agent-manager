import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { buildTerminalArgs } from "../src/pi/command-resolver";
import {
  buildTerminalLaunch,
  TERMINAL_AGENTS_KEY,
  TerminalAgents,
  tabMode,
  terminalMention,
  terminalPath,
  terminalTitle,
} from "../src/view/terminal-agents";
import { configuration, type MockTerminal, resetVscodeMock, TabInputTerminal, TerminalExitReason } from "./vscode-mock";
import type * as VscodeMock from "./vscode-mock";

const mock = vscode as unknown as typeof VscodeMock;

const resolveCommand = vi.fn(async () => ({ path: "/usr/local/bin/pi", source: "path" as const, attempts: ["/usr/local/bin/pi"] }));
const environment = {
  resolve: async () => ({ PATH: "/usr/bin:/bin" }) as NodeJS.ProcessEnv,
  checkMissing: vi.fn(async () => undefined),
};

function memoryMemento(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
}

let sessionIds = 0;

function agents(memento?: ReturnType<typeof memoryMemento>): TerminalAgents {
  // Pin the platform so the login-shell launch is tested the same way on every CI runner.
  return new TerminalAgents({
    extensionUri: mock.Uri.file("/ext"),
    environment,
    resolveCommand: resolveCommand as never,
    platform: "linux",
    createSessionId: () => `session-${++sessionIds}`,
    ...(memento ? { memento } : {}),
  });
}

function shellArgs(index: number): string {
  return (mock.window.createTerminal.mock.calls[index]?.[0] as { shellArgs: string[] }).shellArgs.join(" ");
}

function names(): string[] {
  return mock.window.createTerminal.mock.calls.map((call) => (call[0] as { name: string }).name);
}

function closeTerminal(terminal: unknown, reason: number): void {
  const mockTerminal = terminal as MockTerminal;
  mockTerminal.exitStatus = { code: 0, reason };
  mockTerminal.dispose();
  for (const call of mock.window.onDidCloseTerminal.mock.calls) (call[0] as (value: unknown) => void)(terminal);
}

function activeEditor(uri = "/w/src/app.ts", selection = { startLine: 7, endLine: 11 }): void {
  mock.workspace.workspaceFolders = [{ name: "w", index: 0, uri: mock.Uri.file("/w") }];
  mock.workspace.getWorkspaceFolder.mockReturnValue(mock.workspace.workspaceFolders[0]);
  mock.workspace.asRelativePath.mockImplementation((value: unknown) => String((value as { fsPath: string }).fsPath).replace(/^\/w\//, ""));
  mock.window.activeTextEditor = {
    document: {
      uri: mock.Uri.file(uri),
      fileName: uri,
      languageId: "typescript",
      lineAt: () => ({ text: "const x = 1;" }),
      getText: () => "const x = 1;\nconst y = 2;",
    },
    selection: {
      isEmpty: false,
      active: { line: selection.endLine },
      start: { line: selection.startLine },
      end: { line: selection.endLine, character: 1 },
    },
  };
}

beforeEach(() => {
  resetVscodeMock();
  sessionIds = 0;
  resolveCommand.mockClear();
  environment.checkMissing.mockClear();
  mock.workspace.workspaceFolders = [{ name: "w", index: 0, uri: mock.Uri.file("/w") }];
  mock.workspace.getWorkspaceFolder.mockImplementation(() => mock.workspace.workspaceFolders?.[0]);
});

describe("tabMode", () => {
  it("defaults to chat", () => {
    expect(tabMode()).toBe("chat");
  });

  it("reads terminal and falls back to chat for unknown values", () => {
    configuration.set("tabMode", "terminal");
    expect(tabMode()).toBe("terminal");
    configuration.set("tabMode", "sidecar");
    expect(tabMode()).toBe("chat");
  });
});

describe("buildTerminalArgs", () => {
  it("passes extra arguments through to plain pi", () => {
    expect(buildTerminalArgs(["--offline", "--provider", "anthropic"])).toEqual(["--offline", "--provider", "anthropic"]);
  });

  it("adds the terminal's own Pi session after the extra arguments", () => {
    expect(buildTerminalArgs(["--offline"], "abc")).toEqual(["--offline", "--session-id", "abc"]);
  });

  it("rejects the flags the extension manages", () => {
    expect(() => buildTerminalArgs(["--mode", "rpc"])).toThrow(/managed by the extension/);
    expect(() => buildTerminalArgs(["--session", "/tmp/x"])).toThrow(/managed by the extension/);
    expect(() => buildTerminalArgs(["--continue"])).toThrow(/managed by the extension/);
  });
});

describe("buildTerminalLaunch", () => {
  it("runs pi through the login shell on macOS/Linux", () => {
    const launch = buildTerminalLaunch("/usr/local/bin/pi", ["--offline"], "darwin", { SHELL: "/bin/zsh", PATH: "/usr/bin" });
    expect(launch.shellPath).toBe("/bin/zsh");
    expect(launch.shellArgs).toEqual(["-i", "-l", "-c", "exec '/usr/local/bin/pi' '--offline'"]);
  });

  it("quotes paths with spaces instead of splitting them", () => {
    const launch = buildTerminalLaunch("/opt/my pi/pi", [], "linux", { SHELL: "/bin/bash", PATH: "/usr/bin" });
    expect(launch.shellArgs[3]).toBe("exec '/opt/my pi/pi'");
  });

  it("runs the Windows shim through cmd.exe", () => {
    const launch = buildTerminalLaunch("C:\\npm\\pi.cmd", ["--offline"], "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(launch.shellPath).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.shellArgs).toContain("/c");
  });
});

describe("terminalMention", () => {
  it("uses the compact @path#lines token", () => {
    expect(terminalMention({ relativePath: "src/app.ts", startLine: 7, endLine: 11 })).toBe("@src/app.ts#8-12");
  });

  it("quotes paths with spaces", () => {
    expect(terminalMention({ relativePath: "docs/design notes.md", startLine: 0, endLine: 0 })).toBe('@"docs/design notes.md"#1');
  });

  it("refuses paths with control characters, which would act as keystrokes", () => {
    expect(() => terminalMention({ relativePath: "evil\n!rm -rf ~", startLine: 0, endLine: 0 })).toThrow(/cannot be typed/);
    expect(() => terminalMention({ relativePath: "a\u001b[2Jb", startLine: 0, endLine: 0 })).toThrow(/cannot be typed/);
  });
});

describe("terminalPath", () => {
  it("is relative to the terminal's folder", () => {
    expect(terminalPath({ uri: mock.Uri.file("/w/src/app.ts") } as never, "/w")).toBe("src/app.ts");
  });

  it("is absolute for files outside the terminal's folder", () => {
    expect(terminalPath({ uri: mock.Uri.file("/other/lib.ts") } as never, "/w")).toBe("/other/lib.ts");
  });

  it("stays relative for in-folder names that start with two dots", () => {
    expect(terminalPath({ uri: mock.Uri.file("/w/..env") } as never, "/w")).toBe("..env");
  });

  it("has no path for unsaved documents", () => {
    expect(terminalPath({ uri: new mock.Uri("untitled", "Untitled-1") } as never, "/w")).toBeUndefined();
  });
});

describe("terminalTitle", () => {
  it("numbers every terminal after the first", () => {
    expect(terminalTitle(undefined, 1)).toBe("Pi Agent");
    expect(terminalTitle(undefined, 2)).toBe("Pi Agent 2");
    expect(terminalTitle("api", 3)).toBe("Pi Agent 3: api");
  });

  it("is Pi Agent, with the folder name in multi-root windows, capped at 24 characters", () => {
    expect(terminalTitle()).toBe("Pi Agent");
    expect(terminalTitle("api")).toBe("Pi Agent: api");
    const long = terminalTitle("a-very-long-folder-name");
    expect(long).toHaveLength(24);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("TerminalAgents", () => {
  it("opens a terminal in the editor area running pi in the workspace folder", async () => {
    const manager = agents();
    const terminal = await manager.newAgent();
    expect(terminal).toBeDefined();
    expect(mock.window.createTerminal).toHaveBeenCalledTimes(1);
    const options = mock.window.createTerminal.mock.calls[0]?.[0] as {
      name: string;
      cwd: string;
      env: Record<string, string>;
      location: { viewColumn: number; preserveFocus: boolean };
      shellPath: string;
      shellArgs: string[];
    };
    expect(options.name).toBe("Pi Agent");
    expect(options.cwd).toBe("/w");
    expect(options.location).toEqual({ viewColumn: -2, preserveFocus: false });
    expect(options.env.COLORTERM).toBe("truecolor");
    expect(options.env.PATH).toContain("/usr/local/bin");
    // Login shell (platform pinned to linux; `$SHELL` is unset in tests, so /bin/sh).
    expect(options.shellArgs).toContain("exec '/usr/local/bin/pi' '--session-id' 'session-1'");
    expect(terminal?.show).toHaveBeenCalledWith(false);
    expect(resolveCommand).toHaveBeenCalledWith({ configured: "pi", env: expect.anything() });
    expect(manager.count).toBe(1);
    manager.dispose();
  });

  it("passes extraArgs to plain pi, not to --mode rpc", async () => {
    configuration.set("extraArgs", ["--offline"]);
    const manager = agents();
    await manager.newAgent();
    const options = mock.window.createTerminal.mock.calls[0]?.[0] as { shellArgs: string[] };
    expect(options.shellArgs.join(" ")).toContain("exec '/usr/local/bin/pi' '--offline'");
    expect(options.shellArgs.join(" ")).not.toContain("--mode rpc");
    manager.dispose();
  });

  it("shows an error and opens nothing when pi cannot be found", async () => {
    resolveCommand.mockRejectedValueOnce(new Error("Pi executable was not found. Checked 3 locations."));
    const manager = agents();
    await expect(manager.newAgent()).resolves.toBeUndefined();
    expect(mock.window.createTerminal).not.toHaveBeenCalled();
    expect(mock.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Pi executable was not found"));
    manager.dispose();
  });

  it("reveals the most recently used terminal instead of opening another", async () => {
    const manager = agents();
    const first = await manager.newAgent();
    const second = await manager.newAgent();
    await manager.open();
    expect(mock.window.createTerminal).toHaveBeenCalledTimes(2);
    expect(second?.show).toHaveBeenCalledTimes(2);
    expect(first?.show).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("forgets a terminal once it is closed", async () => {
    const manager = agents();
    const terminal = await manager.newAgent();
    expect(manager.count).toBe(1);
    const onClose = mock.window.onDidCloseTerminal.mock.calls[0]?.[0] as (terminal: unknown) => void;
    terminal?.dispose();
    onClose(terminal);
    expect(manager.count).toBe(0);
    manager.dispose();
  });

  it("reuses one editor group for the next chat", async () => {
    const manager = agents();
    await manager.newAgent();
    mock.window.tabGroups.activeTabGroup = { viewColumn: 2, activeTab: { input: new TabInputTerminal() } };
    // The next terminal is placed beside the first, then rebound to its group.
    const onActive = mock.window.onDidChangeActiveTerminal.mock.calls[0]?.[0] as (terminal: unknown) => void;
    onActive(mock.window.terminals[0]);
    await manager.newAgent();
    const options = mock.window.createTerminal.mock.calls[1]?.[0] as { location: { viewColumn: number } };
    expect(options.location.viewColumn).toBe(2);
    manager.dispose();
  });

  it("inserts the selection as an @mention without submitting it", async () => {
    activeEditor();
    const manager = agents();
    await manager.newAgent();
    await manager.sendSelection();
    expect(mock.window.createTerminal).toHaveBeenCalledTimes(1);
    const terminal = mock.window.terminals[0]!;
    expect(terminal.sendText).toHaveBeenCalledWith("@src/app.ts#8-12 ", false);
    manager.dispose();
  });

  it("opens Pi without typing into it while it starts, and asks to send again", async () => {
    activeEditor();
    const manager = agents();
    await manager.sendSelection();
    expect(mock.window.createTerminal).toHaveBeenCalledTimes(1);
    expect(mock.window.terminals[0]!.sendText).not.toHaveBeenCalled();
    expect(mock.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("Run Add Selection to Chat again"));
    manager.dispose();
  });

  it("mentions files from another root by absolute path", async () => {
    activeEditor("/other/lib.ts");
    mock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    const manager = agents();
    await manager.newAgent();
    await manager.sendSelection();
    expect(mock.window.terminals[0]!.sendText).toHaveBeenCalledWith("@/other/lib.ts#8-12 ", false);
    manager.dispose();
  });

  it("asks to save an untitled document instead of mentioning it", async () => {
    activeEditor();
    (mock.window.activeTextEditor as { document: { uri: unknown } }).document.uri = new mock.Uri("untitled", "Untitled-1");
    const manager = agents();
    await manager.sendSelection();
    expect(mock.window.createTerminal).not.toHaveBeenCalled();
    expect(mock.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("Save the file first"));
    manager.dispose();
  });

  it("does not open a terminal for Add Selection without an editor", async () => {
    const manager = agents();
    await manager.sendSelection();
    expect(mock.window.createTerminal).not.toHaveBeenCalled();
    expect(mock.window.showInformationMessage).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("restartAll stops the old terminals and opens a fresh one in each folder", async () => {
    mock.workspace.workspaceFolders = [
      { name: "w", index: 0, uri: mock.Uri.file("/w") },
      { name: "api", index: 1, uri: mock.Uri.file("/api") },
    ];
    const manager = agents();
    const first = await manager.newAgent();
    mock.window.showQuickPick.mockImplementationOnce(async (items: unknown) => (items as unknown[])[1]);
    await manager.pickFolder();
    await manager.restartAll();
    expect((first as unknown as MockTerminal | undefined)?.disposed).toBe(true);
    expect(mock.window.createTerminal).toHaveBeenCalledTimes(4);
    const cwds = mock.window.createTerminal.mock.calls.slice(2).map((call) => (call[0] as { cwd: string }).cwd);
    expect(cwds).toEqual(["/w", "/api"]);
    expect(manager.count).toBe(2);
    manager.dispose();
  });

  it("restartAll does nothing when no Pi terminal is open", async () => {
    const manager = agents();
    await manager.restartAll();
    expect(mock.window.createTerminal).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("opens a terminal in the picked folder of a multi-root window, titled with its name", async () => {
    mock.workspace.workspaceFolders = [
      { name: "w", index: 0, uri: mock.Uri.file("/w") },
      { name: "api", index: 1, uri: mock.Uri.file("/api") },
    ];
    mock.window.showQuickPick.mockImplementationOnce(async (items: unknown) => (items as unknown[])[1]);
    const manager = agents();
    await manager.pickFolder();
    expect(mock.window.createTerminal.mock.calls[0]?.[0]).toMatchObject({ cwd: "/api", name: "Pi Agent: api" });
    manager.dispose();
  });

  it("opens nothing when the folder pick is cancelled", async () => {
    mock.workspace.workspaceFolders = [
      { name: "w", index: 0, uri: mock.Uri.file("/w") },
      { name: "api", index: 1, uri: mock.Uri.file("/api") },
    ];
    const manager = agents();
    await manager.pickFolder();
    expect(mock.window.createTerminal).not.toHaveBeenCalled();
    manager.dispose();
  });
});

describe("TerminalAgents titles", () => {
  it("gives every open terminal a distinct title and reuses the number of a closed one", async () => {
    const manager = agents();
    const first = await manager.newAgent();
    await manager.newAgent();
    await manager.newAgent();
    closeTerminal(first, TerminalExitReason.User);
    await manager.newAgent();
    expect(names()).toEqual(["Pi Agent", "Pi Agent 2", "Pi Agent 3", "Pi Agent"]);
    manager.dispose();
  });
});

describe("TerminalAgents restore after a reload", () => {
  it("saves each open terminal with its session, folder, editor group and title number", async () => {
    const memento = memoryMemento();
    const manager = agents(memento);
    mock.window.tabGroups.activeTabGroup = { viewColumn: 1, activeTab: { input: new TabInputTerminal() } };
    await manager.newAgent();
    mock.window.tabGroups.activeTabGroup = { viewColumn: 2, activeTab: { input: new TabInputTerminal() } };
    await manager.newAgent();
    expect(memento.values.get(TERMINAL_AGENTS_KEY)).toEqual([
      { sessionId: "session-1", folder: "/w", viewColumn: 1, number: 1 },
      { sessionId: "session-2", folder: "/w", viewColumn: 2, number: 2 },
    ]);
    manager.dispose();
  });

  it("keeps the saved order in step with the terminal used last", async () => {
    const memento = memoryMemento();
    const manager = agents(memento);
    const first = await manager.newAgent();
    await manager.newAgent();
    const onActive = mock.window.onDidChangeActiveTerminal.mock.calls[0]?.[0] as (terminal: unknown) => void;
    onActive(first);
    const saved = memento.values.get(TERMINAL_AGENTS_KEY) as Array<{ sessionId: string }>;
    expect(saved.map((entry) => entry.sessionId)).toEqual(["session-2", "session-1"]);
    manager.dispose();
  });

  it("reopens every saved terminal with its session, folder, group and title, last-used last", async () => {
    mock.workspace.workspaceFolders = [
      { name: "w", index: 0, uri: mock.Uri.file("/w") },
      { name: "api", index: 1, uri: mock.Uri.file("/api") },
    ];
    const memento = memoryMemento({
      [TERMINAL_AGENTS_KEY]: [
        { sessionId: "aaa", folder: "/api", name: "api", viewColumn: 2, number: 2 },
        { sessionId: "bbb", folder: "/w", name: "w", viewColumn: 1, number: 1 },
      ],
    });
    const manager = agents(memento);
    await manager.restore();
    expect(mock.window.createTerminal).toHaveBeenCalledTimes(2);
    expect(mock.window.createTerminal.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ cwd: "/api", name: "Pi Agent 2: api", isTransient: true, location: { viewColumn: 2, preserveFocus: false } }),
      expect.objectContaining({ cwd: "/w", name: "Pi Agent: w", isTransient: true, location: { viewColumn: 1, preserveFocus: false } }),
    ]);
    expect(shellArgs(0)).toContain("'--session-id' 'aaa'");
    expect(shellArgs(1)).toContain("'--session-id' 'bbb'");
    expect(manager.count).toBe(2);
    // A new terminal after the restore takes the next free number.
    await manager.newAgent();
    expect(names()[2]).toBe("Pi Agent 3: w");
    manager.dispose();
  });

  it("drops saved terminals whose folder left the workspace, and ignores malformed entries", async () => {
    const memento = memoryMemento({
      [TERMINAL_AGENTS_KEY]: [{ sessionId: "gone", folder: "/elsewhere", viewColumn: 1 }, { folder: "/w" }, "junk", { sessionId: "kept", folder: "/w", viewColumn: 1 }],
    });
    const manager = agents(memento);
    await manager.restore();
    expect(mock.window.createTerminal).toHaveBeenCalledOnce();
    expect(shellArgs(0)).toContain("'--session-id' 'kept'");
    expect(memento.values.get(TERMINAL_AGENTS_KEY)).toEqual([{ sessionId: "kept", folder: "/w", viewColumn: 1, number: 1 }]);
    manager.dispose();
  });

  it("opens nothing when no terminal was saved", async () => {
    const manager = agents(memoryMemento());
    await manager.restore();
    expect(mock.window.createTerminal).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("forgets a terminal the user closes, or whose Pi exits", async () => {
    const memento = memoryMemento();
    const manager = agents(memento);
    const first = await manager.newAgent();
    const second = await manager.newAgent();
    closeTerminal(first, TerminalExitReason.User);
    expect((memento.values.get(TERMINAL_AGENTS_KEY) as unknown[]).length).toBe(1);
    closeTerminal(second, TerminalExitReason.Process);
    expect(memento.values.get(TERMINAL_AGENTS_KEY)).toEqual([]);
    manager.dispose();
  });

  it("keeps terminals saved when the window reloads or shuts down", async () => {
    const memento = memoryMemento();
    const manager = agents(memento);
    mock.window.tabGroups.activeTabGroup = { viewColumn: 1, activeTab: { input: new TabInputTerminal() } };
    const terminal = await manager.newAgent();
    closeTerminal(terminal, TerminalExitReason.Shutdown);
    manager.dispose();
    expect(memento.values.get(TERMINAL_AGENTS_KEY)).toEqual([{ sessionId: "session-1", folder: "/w", viewColumn: 1, number: 1 }]);
  });

  it("restartAll reopens each terminal with the same session and title", async () => {
    const memento = memoryMemento();
    const manager = agents(memento);
    await manager.newAgent();
    await manager.newAgent();
    await manager.restartAll();
    expect(shellArgs(2)).toContain("'--session-id' 'session-1'");
    expect(shellArgs(3)).toContain("'--session-id' 'session-2'");
    expect(names().slice(2)).toEqual(["Pi Agent", "Pi Agent 2"]);
    expect((memento.values.get(TERMINAL_AGENTS_KEY) as Array<{ sessionId: string }>).map((entry) => entry.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
    manager.dispose();
  });
});
