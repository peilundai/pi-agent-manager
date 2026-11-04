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
    expect(subscriptions).toHaveLength(17);
    expect(mock.window.onDidChangeActiveTextEditor).toHaveBeenCalledOnce();
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
      when: `!${FALLBACK_CONTEXT}`,
    });
    expect(manifest.contributes.views.piAgentManagerSidebar?.[0]).toMatchObject({
      id: "piAgentManager.sidebarView",
      type: "webview",
      when: FALLBACK_CONTEXT,
    });
  });
});
