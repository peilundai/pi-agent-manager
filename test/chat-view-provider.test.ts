import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Uri, WebviewView, WorkspaceFolder } from "vscode";
import { PiCommandNotFoundError } from "../src/pi/command-resolver";
import type { SessionSummary } from "../src/shared/model";
import type { HostToWebviewMessage } from "../src/shared/protocol";
import { ChatViewProvider, webviewHtml } from "../src/view/chat-view-provider";
import { resetVscodeMock } from "./vscode-mock";
import type * as VscodeMock from "./vscode-mock";
import { FakeClient } from "./support/fake-client";

const mock = vscode as unknown as typeof VscodeMock;

const session: SessionSummary = {
  id: "one",
  path: "/s/two.jsonl",
  cwd: "/work",
  title: "Fix login",
  createdAt: 1,
  updatedAt: 2,
  archived: false,
  status: "stopped",
};

function folder(path = "/work", name = "work", index = 0) {
  return { name, index, uri: mock.Uri.file(path) } as unknown as WorkspaceFolder;
}

function setup(
  options: {
    workspace?: boolean;
    createClient?: (listener: ConstructorParameters<typeof FakeClient>[0]) => Promise<FakeClient>;
  } = {},
) {
  const posted: HostToWebviewMessage[] = [];
  let receive: (message: unknown) => void = () => undefined;
  const repository = {
    list: vi.fn(async () => [session]),
    watch: vi.fn(() => ({ dispose: vi.fn() })),
    delete: vi.fn(async () => undefined),
  };
  let client: FakeClient | undefined;
  const clients: FakeClient[] = [];
  const provider = new ChatViewProvider({
    extensionUri: mock.Uri.file("/ext") as unknown as Uri,
    workspaceFolder: options.workspace === false ? undefined : folder(),
    repository,
    createClient: async (listener) => {
      client = options.createClient ? await options.createClient(listener) : new FakeClient(listener);
      clients.push(client);
      return client;
    },
  });
  const webview = {
    cspSource: "vscode-resource:",
    options: undefined as unknown,
    html: "",
    asWebviewUri: (uri: unknown) => uri,
    postMessage: vi.fn(async (message: HostToWebviewMessage) => {
      posted.push(message);
      return true;
    }),
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      receive = listener;
      return { dispose: vi.fn() };
    },
  };
  const view = { viewType: "piAgentManager.view", webview, show: vi.fn(), onDidDispose: () => ({ dispose: vi.fn() }) };
  provider.resolveWebviewView(view as unknown as WebviewView);
  const send = async (message: unknown) => {
    receive(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const ready = () => send({ version: 1, type: "ready" });
  return { provider, posted, send, ready, repository, webview, client: () => client!, clients };
}

beforeEach(() => resetVscodeMock());

describe("webviewHtml", () => {
  it("locks the page down with a nonce CSP", () => {
    const html = webviewHtml({ cspSource: "vscode-resource:", asWebviewUri: (uri: unknown) => uri } as never, mock.Uri.file("/ext/dist") as never);
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'nonce-([\w-]+)'/);
    const nonce = /nonce-([\w-]+)/.exec(html)?.[1];
    expect(html).toContain(`<script nonce="${nonce}"`);
    expect(html).toContain("/ext/dist/webview.js");
  });
});

describe("ChatViewProvider", () => {
  it("initializes the webview, lists sessions and starts Pi on ready", async () => {
    const { posted, ready, webview } = setup();
    expect(webview.options).toMatchObject({ enableScripts: true });
    await ready();
    const types = posted.map((message) => message.type);
    expect(types[0]).toBe("init");
    expect(types).toEqual(expect.arrayContaining(["sessions", "snapshot", "process"]));
    expect(posted[0]).toMatchObject({ workspaceName: "work", platform: process.platform });
  });

  it("drops invalid webview messages", async () => {
    const { posted, send } = setup();
    await send({ version: 1, type: "prompt", text: "", images: [], mode: "send" });
    await send({ type: "ready" });
    expect(posted).toEqual([]);
  });

  it("asks for a folder when none is open", async () => {
    const { posted, ready } = setup({ workspace: false });
    await ready();
    expect(posted).toEqual([{ version: 1, type: "init", workspaceName: "", platform: process.platform, maxContentWidth: 800, setupError: { kind: "workspace" }, toolExpansion: "edits" }]);
  });

  it("sends the tool card expansion setting and resends it when it changes", async () => {
    mock.configuration.set("expandToolCards", "all");
    const { provider, posted, ready } = setup();
    await ready();
    expect(posted[0]).toMatchObject({ type: "init", toolExpansion: "all" });
    mock.configuration.set("expandToolCards", "bogus");
    provider.configurationChanged({ affectsConfiguration: (key) => key === "piAgentManager.expandToolCards" });
    expect(posted.at(-1)).toMatchObject({ type: "init", toolExpansion: "edits" });
    const count = posted.length;
    provider.configurationChanged({ affectsConfiguration: () => false });
    expect(posted).toHaveLength(count);
  });

  it("reports a missing Pi executable as a setup error", async () => {
    const { posted, ready } = setup({
      createClient: () => Promise.reject(new PiCommandNotFoundError(["/usr/bin/pi"])),
    });
    await ready();
    expect(posted.at(-1)).toMatchObject({ type: "init", setupError: { kind: "executable" } });
  });

  it("restarts Pi so a changed environment takes effect", async () => {
    let starts = 0;
    let failFirst = true;
    const { provider, posted, ready } = setup({
      createClient: async () => {
        starts += 1;
        if (failFirst) {
          failFirst = false;
          throw new PiCommandNotFoundError(["/usr/bin/pi"]);
        }
        return new FakeClient({ onEvent: () => undefined, onExit: () => undefined });
      },
    });
    await ready();
    expect(posted.at(-1)).toMatchObject({ setupError: { kind: "executable" } });
    // A setup error is retried, for example after the login-shell PATH was loaded.
    await provider.restartPi();
    expect(starts).toBe(2);
    expect(posted.some((message) => message.type === "snapshot")).toBe(true);
    await provider.restartPi();
    expect(starts).toBe(3);

    const noFolder = setup({ workspace: false });
    await noFolder.provider.restartPi();
    expect(noFolder.posted).toEqual([]);
  });

  it("re-watches sessions when Pi's environment moves the session directory", async () => {
    const repository = {
      list: vi.fn(async () => [session]),
      watch: vi.fn(() => ({ dispose: vi.fn() })),
      delete: vi.fn(async () => undefined),
      useEnvironment: vi.fn(() => true),
    };
    const environment = { resolve: vi.fn(async () => ({ PATH: "/usr/bin", PI_CODING_AGENT_SESSION_DIR: "/elsewhere" })), checkMissing: vi.fn(async () => undefined) };
    // Any existing absolute executable stands in for pi; the client is created but not started.
    mock.workspace.getConfiguration.mockReturnValue({ get: () => process.execPath, update: vi.fn() });
    const provider = new ChatViewProvider({ extensionUri: mock.Uri.file("/ext") as unknown as Uri, workspaceFolder: folder(), repository, environment });
    const create = (provider as unknown as { createClient(listener: unknown): Promise<unknown> }).createClient.bind(provider);
    await create({ onEvent: () => undefined, onExit: () => undefined });
    expect(environment.checkMissing).toHaveBeenCalledWith("/work", expect.objectContaining({ PI_CODING_AGENT_SESSION_DIR: "/elsewhere" }));
    expect(repository.useEnvironment).toHaveBeenCalledWith(expect.objectContaining({ PI_CODING_AGENT_SESSION_DIR: "/elsewhere" }));
    expect(repository.watch).toHaveBeenCalledTimes(2);
    provider.dispose();
  });

  it("forwards prompts and dialog answers to Pi", async () => {
    const { send, ready, client } = setup();
    await ready();
    await send({ version: 1, type: "prompt", text: "hello", images: [], mode: "send" });
    expect(client().requests.at(-1)).toEqual({ type: "prompt", message: "hello" });
    await send({ version: 1, type: "dialog.respond", response: { id: "d1", value: "Allow" } });
    expect(client().sent).toEqual([{ type: "extension_ui_response", id: "d1", value: "Allow" }]);
    await send({ version: 1, type: "thinking.set", level: "high" });
    expect(client().requests.some((request) => request.type === "set_thinking_level" && request.level === "high")).toBe(true);
  });

  it("searches workspace files for @ mentions", async () => {
    mock.workspace.findFiles.mockResolvedValue([mock.Uri.file("/work/src/app.ts"), mock.Uri.file("/work/README.md")]);
    const { posted, send } = setup();
    await send({ version: 1, type: "ready" });
    await send({ version: 1, type: "files.search", requestId: 7, query: "app" });
    expect(posted.at(-1)).toEqual({ version: 1, type: "files.result", requestId: 7, files: ["src/app.ts"] });
  });

  it("opens workspace files at a clamped line and URLs externally", async () => {
    mock.workspace.openTextDocument.mockResolvedValue({ lineCount: 3, lineAt: () => ({ text: "abc" }) });
    const { send } = setup();
    await send({ version: 1, type: "file.open", path: "src/app.ts", line: 99 });
    expect(mock.workspace.fs.stat).toHaveBeenCalledWith(expect.objectContaining({ fsPath: join("/work", "src/app.ts") }));
    const options = mock.window.showTextDocument.mock.calls[0]?.[1] as { selection: { start: { line: number } } };
    expect(options.selection.start.line).toBe(2);
    await send({ version: 1, type: "url.open", url: "https://pi.dev" });
    expect(mock.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "https://pi.dev" }));
  });

  it("warns instead of opening a missing file", async () => {
    mock.workspace.fs.stat.mockRejectedValue(new Error("ENOENT"));
    const { posted, send } = setup();
    await send({ version: 1, type: "ready" });
    await send({ version: 1, type: "file.open", path: "missing.ts" });
    expect(posted.at(-1)).toEqual({ version: 1, type: "notice", level: "warning", message: "File not found: missing.ts" });
    expect(mock.window.showTextDocument).not.toHaveBeenCalled();
  });

  it("deletes a chat only after confirmation", async () => {
    const { send, ready, repository } = setup();
    await ready();
    await send({ version: 1, type: "chat.delete", path: session.path });
    expect(repository.delete).not.toHaveBeenCalled();
    mock.window.showWarningMessage.mockResolvedValue("Delete");
    await send({ version: 1, type: "chat.delete", path: session.path });
    expect(repository.delete).toHaveBeenCalledWith(session);
  });

  it("keeps the active chat when an extension vetoes new_session", async () => {
    mock.window.showWarningMessage.mockResolvedValue("Delete");
    const { posted, send, ready, repository, client } = setup();
    await ready();
    const fake = client();
    const request = fake.request.bind(fake);
    fake.request = async <T,>(command: Record<string, unknown> & { type: string }) =>
      command.type === "new_session" ? ({ cancelled: true } as T) : request<T>(command);
    repository.list.mockResolvedValue([{ ...session, path: "/s/one.jsonl" }]);
    await send({ version: 1, type: "sessions.refresh" });
    await send({ version: 1, type: "chat.delete", path: "/s/one.jsonl" });
    expect(repository.delete).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ version: 1, type: "notice", level: "warning", message: "This chat is still active, so it was not deleted." });
  });

  it("renames the current chat through an input box", async () => {
    mock.window.showInputBox.mockResolvedValue("  New   name ");
    const { send, ready, client } = setup();
    await ready();
    await send({ version: 1, type: "chat.rename" });
    expect(client().requests).toContainEqual({ type: "set_session_name", name: "New name" });
  });

  it("refuses to open a transcript outside the workspace history", async () => {
    const { posted, send, ready, client } = setup();
    await ready();
    await send({ version: 1, type: "chat.open", path: "/elsewhere/x.jsonl" });
    expect(client().requests.some((request) => request.type === "switch_session")).toBe(false);
    expect(posted.at(-1)).toEqual({ version: 1, type: "notice", level: "error", message: "That chat is no longer available." });
    await send({ version: 1, type: "chat.open", path: session.path });
    expect(client().requests).toContainEqual({ type: "switch_session", sessionPath: session.path });
  });

  it("inserts the editor selection into the composer", async () => {
    mock.window.activeTextEditor = {
      document: {
        uri: mock.Uri.file("/work/src/app.ts"),
        fileName: "/work/src/app.ts",
        languageId: "typescript",
        lineAt: () => ({ text: "const a = 1;" }),
        getText: () => "",
      },
      selection: { isEmpty: true, active: { line: 4 }, start: { line: 4 }, end: { line: 4, character: 0 } },
    };
    mock.workspace.asRelativePath.mockReturnValue("src/app.ts");
    const { provider, posted, ready } = setup();
    await ready();
    await provider.sendSelection();
    expect(posted.slice(-2)).toEqual([
      {
        version: 1,
        type: "composer.insert",
        text: "@src/app.ts#5 ",
        references: [{ label: "@src/app.ts#5", text: "From `src/app.ts` line 5:\n\n```typescript\nconst a = 1;\n```\n\n" }],
      },
      { version: 1, type: "composer.focus" },
    ]);
  });

  it("tracks the live editor selection for the composer", async () => {
    const editor = (start: number, end: number, scheme = "file") => ({
      document: {
        uri: { ...mock.Uri.file("/work/src/app.ts"), scheme },
        fileName: "/work/src/app.ts",
        languageId: "typescript",
        lineAt: () => ({ text: "" }),
        getText: () => "a\nb",
      },
      selection: { isEmpty: start === end, active: { line: end }, start: { line: start }, end: { line: end, character: 3 } },
    });
    mock.workspace.asRelativePath.mockReturnValue("src/app.ts");
    mock.window.activeTextEditor = editor(1, 2);
    const { provider, posted, ready } = setup();
    await ready();
    const selections = () => posted.filter((message) => message.type === "editor.selection");
    expect(selections()).toEqual([
      {
        version: 1,
        type: "editor.selection",
        selection: { label: "@src/app.ts#2-3", text: "From `src/app.ts` lines 2-3:\n\n```typescript\na\nb\n```\n\n", lineCount: 2 },
      },
    ]);
    vi.useFakeTimers();
    try {
      provider.editorSelectionChanged(editor(1, 2) as never);
      vi.advanceTimersByTime(200);
      expect(selections()).toHaveLength(1);
      provider.editorSelectionChanged(editor(4, 4) as never);
      vi.advanceTimersByTime(200);
      expect(selections().at(-1)).toEqual({ version: 1, type: "editor.selection" });
      provider.editorSelectionChanged(editor(0, 1, "output") as never);
      provider.editorSelectionChanged(undefined);
      vi.advanceTimersByTime(200);
      expect(selections()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays composer insertions queued before the webview was ready", async () => {
    mock.window.activeTextEditor = {
      document: { uri: mock.Uri.file("/work/a.py"), fileName: "/work/a.py", languageId: "python", lineAt: () => ({ text: "x = 1" }), getText: () => "" },
      selection: { isEmpty: true, active: { line: 0 }, start: { line: 0 }, end: { line: 0, character: 0 } },
    };
    mock.workspace.asRelativePath.mockReturnValue("a.py");
    const { provider, posted, ready } = setup();
    await provider.sendSelection();
    expect(posted).toEqual([]);
    await ready();
    expect(posted.map((message) => message.type)).toContain("composer.insert");
  });

  it("stores a chosen executable and retries setup", async () => {
    mock.window.showOpenDialog.mockResolvedValue([mock.Uri.file("/opt/pi/bin/pi")]);
    const { send } = setup();
    await send({ version: 1, type: "setup.action", action: "chooseExecutable" });
    expect(mock.configuration.get("command")).toBe("/opt/pi/bin/pi");
    await send({ version: 1, type: "setup.action", action: "openSettings" });
    expect(mock.commands.executeCommand).toHaveBeenCalledWith("workbench.action.openSettings", "piAgentManager");
  });

  it("tracks webview focus in a context key", async () => {
    const { send } = setup();
    await send({ version: 1, type: "focus.changed", focused: true });
    expect(mock.commands.executeCommand).toHaveBeenCalledWith("setContext", "piAgentManager.focused", true);
  });

  it("keeps the open chat when the other contributed view resolves", async () => {
    const { provider, posted, ready, clients } = setup();
    await ready();
    const diverted: HostToWebviewMessage[] = [];
    provider.resolveWebviewView({
      viewType: "piAgentManager.sidebarView",
      show: vi.fn(),
      onDidDispose: () => ({ dispose: vi.fn() }),
      webview: {
        cspSource: "vscode-resource:",
        options: {},
        html: "",
        asWebviewUri: (uri: unknown) => uri,
        postMessage: async (message: HostToWebviewMessage) => {
          diverted.push(message);
          return true;
        },
        onDidReceiveMessage: () => ({ dispose: vi.fn() }),
      },
    } as unknown as WebviewView);
    const before = posted.length;
    await provider.focusInput();
    expect(clients).toHaveLength(1);
    expect(diverted).toEqual([]);
    expect(posted.slice(before)).toContainEqual({ version: 1, type: "composer.focus" });
  });
});

describe("ChatViewProvider multi-root folders", () => {
  const work = folder("/work", "work", 0);
  const other = folder("/other", "other", 1);
  const editorIn = (target: WorkspaceFolder) => ({ document: { uri: mock.Uri.file(`${target.uri.fsPath}/a.ts`) } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const inits = (posted: HostToWebviewMessage[]) => posted.filter((message) => message.type === "init");

  beforeEach(() => {
    mock.workspace.workspaceFolders = [work, other];
    mock.workspace.getWorkspaceFolder.mockImplementation((uri: { fsPath: string }) =>
      [work, other].find((candidate) => uri.fsPath.startsWith(`${candidate.uri.fsPath}/`)),
    );
  });

  it("marks the init message as multi-root", async () => {
    const { posted, ready } = setup();
    await ready();
    expect(posted[0]).toMatchObject({ type: "init", workspaceName: "work", multiRoot: true });
  });

  it("follows the active editor to another folder while the chat is empty", async () => {
    const { provider, posted, ready, repository, clients } = setup();
    await ready();
    provider.followEditor(editorIn(other) as never);
    await settle();
    expect(inits(posted).at(-1)).toMatchObject({ workspaceName: "other", multiRoot: true });
    expect(provider.workspaceFolder).toBe(other);
    expect(repository.watch).toHaveBeenLastCalledWith("/other", expect.any(Function));
    expect(repository.list).toHaveBeenLastCalledWith("/other");
    expect(clients).toHaveLength(2);
    expect(clients[0]?.running).toBe(false);
    expect(clients[1]?.running).toBe(true);
  });

  it("keeps a chat with messages in its folder when the editor moves", async () => {
    const { provider, posted, ready, clients } = setup({
      createClient: async (listener) => new FakeClient(listener, { get_state: { sessionFile: "/s/one.jsonl", messageCount: 3 } }),
    });
    await ready();
    provider.followEditor(editorIn(other) as never);
    await settle();
    expect(inits(posted).map((message) => message.workspaceName)).toEqual(["work"]);
    expect(clients).toHaveLength(1);
  });

  it("keeps a running chat in its folder when the editor moves", async () => {
    const { provider, ready, client, clients } = setup();
    await ready();
    client().listener.onEvent({ type: "agent_start" });
    provider.followEditor(editorIn(other) as never);
    await settle();
    expect(clients).toHaveLength(1);
  });

  it("only changes scope, without starting Pi, before the view is ready", async () => {
    const { provider, ready, repository, clients, posted } = setup();
    provider.followEditor(editorIn(other) as never);
    await settle();
    expect(clients).toHaveLength(0);
    await ready();
    expect(posted[0]).toMatchObject({ type: "init", workspaceName: "other" });
    expect(repository.list).toHaveBeenLastCalledWith("/other");
    expect(clients).toHaveLength(1);
  });

  it("starts a new chat in the active editor's folder", async () => {
    const { posted, ready, send, clients } = setup({
      createClient: async (listener) => new FakeClient(listener, { get_state: { sessionFile: "/s/one.jsonl", messageCount: 3 } }),
    });
    await ready();
    mock.window.activeTextEditor = editorIn(other);
    await send({ version: 1, type: "chat.new" });
    await settle();
    expect(inits(posted).at(-1)).toMatchObject({ workspaceName: "other" });
    expect(clients).toHaveLength(2);
    expect(clients[0]?.requests.some((request) => request.type === "new_session")).toBe(false);
  });

  it("starts a new chat in place when the editor is in the same folder", async () => {
    const { ready, send, clients } = setup();
    await ready();
    mock.window.activeTextEditor = editorIn(work);
    await send({ version: 1, type: "chat.new" });
    expect(clients).toHaveLength(1);
    expect(clients[0]?.requests.some((request) => request.type === "new_session")).toBe(true);
  });

  it("switches folders from the picker", async () => {
    const { posted, ready, send, clients } = setup();
    await ready();
    mock.window.showQuickPick.mockImplementation(async (items: Array<{ folder: WorkspaceFolder; description: string }>) => {
      expect(items.map((item) => item.description)).toEqual(["current", ""]);
      return items[1];
    });
    await send({ version: 1, type: "folder.pick" });
    await settle();
    expect(inits(posted).at(-1)).toMatchObject({ workspaceName: "other" });
    expect(clients).toHaveLength(2);
  });

  it("asks before stopping a running chat to switch folders", async () => {
    const { provider, ready, client, clients } = setup();
    await ready();
    client().listener.onEvent({ type: "agent_start" });
    mock.window.showQuickPick.mockImplementation(async (items: unknown[]) => items[1]);
    await provider.pickFolder();
    expect(mock.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("still working"),
      expect.objectContaining({ modal: true }),
      "Stop and Switch",
    );
    expect(clients).toHaveLength(1);
    mock.window.showWarningMessage.mockResolvedValue("Stop and Switch");
    await provider.pickFolder();
    expect(clients).toHaveLength(2);
  });

  it("moves to a remaining folder when the current one is removed", async () => {
    const { provider, posted, ready, clients } = setup();
    await ready();
    mock.workspace.workspaceFolders = [other];
    provider.workspaceFoldersChanged();
    await settle();
    expect(inits(posted).at(-1)).toEqual({ version: 1, type: "init", workspaceName: "other", platform: process.platform, maxContentWidth: 800, toolExpansion: "edits" });
    expect(clients).toHaveLength(2);
  });

  it("re-sends the content width when the setting changes", async () => {
    const { provider, posted, ready, clients } = setup();
    provider.configurationChanged({ affectsConfiguration: () => true });
    expect(inits(posted)).toHaveLength(0);
    await ready();
    const before = inits(posted).length;
    mock.configuration.set("maxContentWidth", 960);
    provider.configurationChanged({ affectsConfiguration: (section) => section === "piAgentManager.command" });
    expect(inits(posted)).toHaveLength(before);
    provider.configurationChanged({ affectsConfiguration: (section) => section === "piAgentManager.maxContentWidth" });
    expect(inits(posted).at(-1)).toMatchObject({ maxContentWidth: 960 });
    mock.configuration.set("maxContentWidth", -5);
    provider.configurationChanged({ affectsConfiguration: () => true });
    expect(inits(posted).at(-1)).toMatchObject({ maxContentWidth: 800 });
    mock.configuration.set("maxContentWidth", 0);
    provider.configurationChanged({ affectsConfiguration: () => true });
    expect(inits(posted).at(-1)).toMatchObject({ maxContentWidth: 0 });
    expect(clients).toHaveLength(1);
  });

  it("asks for a folder when the last one is removed", async () => {
    const { provider, posted, ready, clients } = setup();
    await ready();
    mock.workspace.workspaceFolders = [];
    provider.workspaceFoldersChanged();
    await settle();
    expect(inits(posted).at(-1)).toMatchObject({ workspaceName: "", setupError: { kind: "workspace" } });
    expect(clients[0]?.running).toBe(false);
  });

  it("does not cache a file search that finishes after the folder changed", async () => {
    const { provider, posted, ready, send } = setup();
    await ready();
    let finish: (uris: unknown[]) => void = () => undefined;
    mock.workspace.findFiles.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await send({ version: 1, type: "files.search", requestId: 1, query: "" });
    provider.followEditor(editorIn(other) as never);
    await settle();
    finish([mock.Uri.file("/work/old.ts")]);
    await settle();
    mock.workspace.findFiles.mockResolvedValueOnce([mock.Uri.file("/other/new.ts")]);
    await send({ version: 1, type: "files.search", requestId: 2, query: "" });
    expect(mock.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(posted.filter((message) => message.type === "files.result").at(-1)).toMatchObject({ requestId: 2, files: ["new.ts"] });
  });

  it("ignores a session list that finishes after the folder changed", async () => {
    const { provider, posted, ready, repository } = setup();
    const stale = { ...session, id: "stale", path: "/s/stale.jsonl" };
    let release: () => void = () => undefined;
    repository.list.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([stale]))));
    await ready();
    provider.followEditor(editorIn(other) as never);
    await settle();
    release();
    await settle();
    const lists = posted.flatMap((message) => (message.type === "sessions" ? [message.sessions.map((item) => item.id)] : []));
    expect(lists).not.toContainEqual(["stale"]);
    expect(lists.at(-1)).toEqual(["one"]);
  });
});
