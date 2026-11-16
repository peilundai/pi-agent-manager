import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../src/extension";
import { configuration, resetVscodeMock } from "./vscode-mock";
import type * as VscodeMock from "./vscode-mock";

const mock = vscode as unknown as typeof VscodeMock;

const secrets = { keys: async () => [], get: async () => undefined, store: async () => undefined, delete: async () => undefined };

beforeEach(() => {
  resetVscodeMock();
  // Unit tests must not start the developer's real login shell.
  configuration.set("loadShellEnvironment", false);
});

describe("extension activation", () => {
  it("registers the chat view and commands", async () => {
    mock.workspace.workspaceFolders = [{ name: "w", index: 0, uri: mock.Uri.file("/w") }];
    const subscriptions: Array<{ dispose(): void }> = [];
    await activate({
      extensionUri: mock.Uri.file("/ext"),
      subscriptions,
      workspaceState: { get: () => undefined, update: async () => undefined },
      secrets,
    } as never);
    expect(mock.window.registerWebviewViewProvider).toHaveBeenCalledWith("piAgentManager.view", expect.anything(), {
      webviewOptions: { retainContextWhenHidden: true },
    });
    expect(mock.commands.registerCommand.mock.calls.map((call) => call[0])).toEqual([
      "piAgentManager.open",
      "piAgentManager.newAgent",
      "piAgentManager.newChat",
      "piAgentManager.history",
      "piAgentManager.sendSelection",
      "piAgentManager.focusInput",
      "piAgentManager.switchFolder",
      "piAgentManager.setEnvironmentSecret",
      "piAgentManager.removeEnvironmentSecret",
      "piAgentManager.reloadEnvironment",
      "piAgentManager.showEnvironmentDiagnostics",
    ]);
    expect(mock.window.registerWebviewPanelSerializer).toHaveBeenCalledWith("piAgentManager.agent", expect.anything());
    expect(subscriptions).toHaveLength(22);
    expect(mock.window.onDidChangeActiveTextEditor).toHaveBeenCalledOnce();
    expect(mock.window.onDidChangeTextEditorSelection).toHaveBeenCalledOnce();
    expect(mock.workspace.onDidChangeWorkspaceFolders).toHaveBeenCalledOnce();
    expect(mock.workspace.onDidChangeConfiguration).toHaveBeenCalledOnce();
    await expect(deactivate()).resolves.toBeUndefined();
  });

  it("matches the commands contributed in package.json", async () => {
    const manifest = (await import("../package.json")).default as {
      contributes: { commands: Array<{ command: string }>; views: Record<string, Array<{ id: string }>> };
    };
    await activate({ extensionUri: mock.Uri.file("/ext"), subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, secrets } as never);
    const registered = mock.commands.registerCommand.mock.calls.map((call) => call[0]).sort();
    expect(manifest.contributes.commands.map((command) => command.command).sort()).toEqual(registered);
    expect(manifest.contributes.views.piAgentManager?.[0]?.id).toBe("piAgentManager.view");
    await deactivate();
  });
});

const SECONDARY_CONTAINER = "workbench.view.extension.piAgentManager";
const SIDEBAR_CONTAINER = "workbench.view.extension.piAgentManagerSidebar";
const SECONDARY_FOCUS = "piAgentManager.view.focus";
const SIDEBAR_FOCUS = "piAgentManager.sidebarView.focus";
const FALLBACK_CONTEXT = "piAgentManager.useSidebarFallback";

function hostContext() {
  return {
    extensionUri: mock.Uri.file("/ext"),
    subscriptions: [] as Array<{ dispose(): void }>,
    workspaceState: { get: () => undefined, update: async () => undefined },
    secrets,
  };
}

async function runOpen(): Promise<void> {
  const open = mock.commands.registerCommand.mock.calls.find((call) => call[0] === "piAgentManager.open")?.[1] as
    | (() => Promise<void>)
    | undefined;
  if (!open) throw new Error("piAgentManager.open was not registered");
  await open();
}

function executed(): unknown[] {
  return mock.commands.executeCommand.mock.calls.map((call) => call[0]);
}

describe("chat placement", () => {
  // These cover the single-chat sidebar, which `defaultLocation: "sidebar"` keeps.
  beforeEach(() => configuration.set("defaultLocation", "sidebar"));

  it("uses the secondary view when its container command exists", async () => {
    mock.commands.getCommands.mockResolvedValue([SECONDARY_CONTAINER, SECONDARY_FOCUS, SIDEBAR_CONTAINER, SIDEBAR_FOCUS]);
    await activate(hostContext() as never);
    expect(mock.commands.getCommands).toHaveBeenCalledWith(true);
    expect(mock.commands.executeCommand).not.toHaveBeenCalledWith("setContext", FALLBACK_CONTEXT, true);
    const registered = mock.window.registerWebviewViewProvider.mock.calls;
    expect(registered.map((call) => call[0])).toEqual(["piAgentManager.view", "piAgentManager.sidebarView"]);
    expect(registered[0]?.[1]).toBe(registered[1]?.[1]);
    await runOpen();
    expect(mock.commands.executeCommand).toHaveBeenCalledWith(SECONDARY_FOCUS);
    expect(executed()).not.toContain(SIDEBAR_FOCUS);
    expect(executed()).not.toContain(SIDEBAR_CONTAINER);
    expect(executed()).not.toContain(SECONDARY_CONTAINER);
    await deactivate();
  });

  it("opens the activity bar view when the secondary container command is missing", async () => {
    mock.commands.getCommands.mockResolvedValue([SIDEBAR_CONTAINER, SIDEBAR_FOCUS]);
    await activate(hostContext() as never);
    expect(mock.commands.getCommands).toHaveBeenCalledWith(true);
    expect(mock.commands.executeCommand).toHaveBeenCalledWith("setContext", FALLBACK_CONTEXT, true);
    expect(executed()).not.toContain(SECONDARY_CONTAINER);
    await runOpen();
    expect(mock.commands.executeCommand).toHaveBeenCalledWith(SIDEBAR_FOCUS);
    expect(executed()).not.toContain(SECONDARY_CONTAINER);
    await deactivate();
  });

  it("does not run a reveal command that the host did not register", async () => {
    mock.commands.getCommands.mockResolvedValue([]);
    await activate(hostContext() as never);
    await runOpen();
    expect(executed().filter((command) => command !== "setContext")).toEqual([]);
    expect(mock.commands.executeCommand).toHaveBeenCalledWith("setContext", FALLBACK_CONTEXT, true);
    expect(executed()).not.toContain(SECONDARY_CONTAINER);
    await deactivate();
  });

  it("uses the container command when the view focus command is absent", async () => {
    mock.commands.getCommands.mockResolvedValue([SECONDARY_CONTAINER]);
    await activate(hostContext() as never);
    expect(mock.commands.executeCommand).not.toHaveBeenCalledWith("setContext", FALLBACK_CONTEXT, true);
    await runOpen();
    expect(mock.commands.executeCommand).toHaveBeenCalledWith(SECONDARY_CONTAINER);
    expect(executed()).not.toContain(SECONDARY_FOCUS);
    await deactivate();
  });
});

async function runCommand(id: string): Promise<void> {
  const handler = mock.commands.registerCommand.mock.calls.find((call) => call[0] === id)?.[1] as (() => Promise<unknown>) | undefined;
  if (!handler) throw new Error(`${id} was not registered`);
  await handler();
}

describe("terminal mode", () => {
  beforeEach(() => {
    mock.workspace.workspaceFolders = [{ name: "w", index: 0, uri: mock.Uri.file("/w") }];
    // Any executable absolute path resolves without searching the developer's PATH for pi.
    configuration.set("command", process.execPath);
    configuration.set("tabMode", "terminal");
  });

  it("opens New Pi Agent as a terminal in the editor area instead of a chat tab", async () => {
    await activate(hostContext() as never);
    await runCommand("piAgentManager.newAgent");
    expect(mock.window.createTerminal).toHaveBeenCalledOnce();
    expect(mock.window.createTerminal.mock.calls[0]?.[0]).toMatchObject({ cwd: "/w", isTransient: true });
    expect(mock.window.createWebviewPanel).not.toHaveBeenCalled();
    await deactivate();
  });

  it("keeps the chat UI in the side bar", async () => {
    configuration.set("defaultLocation", "sidebar");
    mock.commands.getCommands.mockResolvedValue([SECONDARY_CONTAINER, SECONDARY_FOCUS]);
    await activate(hostContext() as never);
    await runOpen();
    expect(mock.window.createTerminal).not.toHaveBeenCalled();
    expect(mock.commands.executeCommand).toHaveBeenCalledWith(SECONDARY_FOCUS);
    await deactivate();
  });
});

describe("view contributions", () => {
  it("keeps the secondary sidebar and gates the activity bar view on the fallback context", async () => {
    const manifest = (await import("../package.json")).default as {
      contributes: {
        viewsContainers: {
          secondarySidebar?: Array<{ id: string }>;
          activitybar?: Array<{ id: string }>;
        };
        views: Record<string, Array<{ id: string; type?: string; when?: string }>>;
      };
    };
    expect(manifest.contributes.viewsContainers.secondarySidebar?.map((container) => container.id)).toEqual(["piAgentManager"]);
    expect(manifest.contributes.viewsContainers.activitybar?.map((container) => container.id)).toEqual(["piAgentManagerSidebar"]);
    expect(manifest.contributes.views.piAgentManager?.[0]).toMatchObject({
      id: "piAgentManager.view",
      type: "webview",
      when: `!${FALLBACK_CONTEXT} && config.piAgentManager.defaultLocation == sidebar`,
    });
    expect(manifest.contributes.views.piAgentManagerSidebar?.[0]).toMatchObject({
      id: "piAgentManager.sidebarView",
      type: "webview",
      when: `${FALLBACK_CONTEXT} && config.piAgentManager.defaultLocation == sidebar`,
    });
  });

  it("defaults new agents to editor tabs and restores them after a reload", async () => {
    const manifest = (await import("../package.json")).default as {
      activationEvents: string[];
      contributes: {
        configuration: { properties: Record<string, { default?: unknown; enum?: unknown[] }> };
        menus: Record<string, Array<{ command: string; when?: string }>>;
      };
    };
    expect(manifest.contributes.configuration.properties["piAgentManager.defaultLocation"]).toMatchObject({
      default: "editor",
      enum: ["editor", "sidebar"],
    });
    expect(manifest.contributes.configuration.properties["piAgentManager.tabMode"]).toMatchObject({
      default: "chat",
      enum: ["chat", "terminal"],
    });
    expect(manifest.activationEvents).toContain("onWebviewPanel:piAgentManager.agent");
    expect(manifest.contributes.menus["editor/title"]).toEqual([
      expect.objectContaining({ command: "piAgentManager.newAgent", when: "config.piAgentManager.defaultLocation != sidebar" }),
      expect.objectContaining({ command: "piAgentManager.open", when: "config.piAgentManager.defaultLocation == sidebar" }),
    ]);
  });
});

function command(name: string): () => Promise<void> {
  const handler = mock.commands.registerCommand.mock.calls.find((call) => call[0] === name)?.[1] as (() => Promise<void>) | undefined;
  if (!handler) throw new Error(`${name} was not registered`);
  return handler;
}

function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

describe("editor-tab agents", () => {
  beforeEach(() => {
    mock.workspace.workspaceFolders = [{ name: "w", index: 0, uri: mock.Uri.file("/w") }];
    mock.commands.getCommands.mockResolvedValue([SECONDARY_CONTAINER, SECONDARY_FOCUS]);
  });

  it("opens each new agent in its own editor tab", async () => {
    const state = memento();
    await activate({ ...hostContext(), workspaceState: state } as never);
    await command("piAgentManager.newAgent")();
    await command("piAgentManager.newAgent")();
    expect(mock.window.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(mock.window.createWebviewPanel).toHaveBeenCalledWith("piAgentManager.agent", "Pi Agent", expect.anything(), {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [expect.objectContaining({ fsPath: "/ext/dist" })],
    });
    const [first, second] = mock.window.panels;
    expect(first?.webview.html).toContain("webview.js");
    expect(second?.webview.html).toContain("webview.js");
    const ids = state.values.get("piAgentManager.editorAgents") as string[];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // The sidebar is not used, so no view is revealed.
    expect(executed()).not.toContain(SECONDARY_FOCUS);
    await deactivate();
  });

  it("sends commands to the tab the user worked in last, opening one if none is open", async () => {
    await activate({ ...hostContext(), workspaceState: memento() } as never);
    await command("piAgentManager.focusInput")();
    expect(mock.window.panels).toHaveLength(1);
    await command("piAgentManager.newAgent")();
    const [first, second] = mock.window.panels;
    second!.setActive(false);
    first!.setActive(true);
    second!.reveal.mockClear();
    await command("piAgentManager.history")();
    expect(first!.reveal).toHaveBeenCalled();
    expect(second!.reveal).not.toHaveBeenCalled();
    expect(mock.window.panels).toHaveLength(2);
    await deactivate();
  });

  it("forgets an agent whose tab is closed, but keeps tabs that close with the window", async () => {
    const state = memento();
    await activate({ ...hostContext(), workspaceState: state } as never);
    await command("piAgentManager.newAgent")();
    await command("piAgentManager.newAgent")();
    const [first, second] = mock.window.panels;
    first!.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.values.get("piAgentManager.editorAgents")).toHaveLength(1);
    await deactivate();
    second!.dispose(); // the window reloads
    expect(state.values.get("piAgentManager.editorAgents")).toHaveLength(1);
  });

  it("restores a tab with the agent id its webview kept", async () => {
    const state = memento({ "piAgentManager.editorAgents": ["agent-1"] });
    await activate({ ...hostContext(), workspaceState: state } as never);
    const serializer = mock.window.registerWebviewPanelSerializer.mock.calls[0]?.[1] as {
      deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void>;
    };
    const panel = new mock.MockWebviewPanel("piAgentManager.agent", "Fix login");
    await serializer.deserializeWebviewPanel(panel, { agentId: "agent-1", draft: "hi" });
    expect(panel.webview.html).toContain('<meta name="pi-agent-id" content="agent-1" />');
    expect(panel.title).toBe("Pi Agent");
    // A second copy of an agent that is already on screen is closed.
    const duplicate = new mock.MockWebviewPanel("piAgentManager.agent", "Pi Agent");
    await serializer.deserializeWebviewPanel(duplicate, { agentId: "agent-1" });
    expect(duplicate.disposed).toBe(true);
    expect(state.values.get("piAgentManager.editorAgents")).toEqual(["agent-1"]);
    await deactivate();
  });

  it("forgets the agents when none of their tabs came back", async () => {
    const state = memento({
      "piAgentManager.editorAgents": ["agent-1"],
      "piAgentManager.relay.agent-1": { socketPath: "/tmp/x", token: "t", cwd: "/w" },
    });
    await activate({ ...hostContext(), workspaceState: state } as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.values.get("piAgentManager.editorAgents")).toEqual([]);
    expect(state.values.has("piAgentManager.relay.agent-1")).toBe(false);
    await deactivate();
  });
});
