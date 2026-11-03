import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../src/extension";
import { resetVscodeMock } from "./vscode-mock";
import type * as VscodeMock from "./vscode-mock";

const mock = vscode as unknown as typeof VscodeMock;

beforeEach(() => resetVscodeMock());

describe("extension activation", () => {
  it("registers the chat view and commands", async () => {
    mock.workspace.workspaceFolders = [{ name: "w", index: 0, uri: mock.Uri.file("/w") }];
    const subscriptions: Array<{ dispose(): void }> = [];
    activate({
      extensionUri: mock.Uri.file("/ext"),
      subscriptions,
      workspaceState: { get: () => undefined, update: async () => undefined },
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
    ]);
    expect(subscriptions).toHaveLength(10);
    expect(mock.window.onDidChangeActiveTextEditor).toHaveBeenCalledOnce();
    expect(mock.workspace.onDidChangeWorkspaceFolders).toHaveBeenCalledOnce();
    await expect(deactivate()).resolves.toBeUndefined();
  });

  it("matches the commands contributed in package.json", async () => {
    const manifest = (await import("../package.json")).default as {
      contributes: { commands: Array<{ command: string }>; views: Record<string, Array<{ id: string }>> };
    };
    activate({ extensionUri: mock.Uri.file("/ext"), subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined } } as never);
    const registered = mock.commands.registerCommand.mock.calls.map((call) => call[0]).sort();
    expect(manifest.contributes.commands.map((command) => command.command).sort()).toEqual(registered);
    expect(manifest.contributes.views.piAgentManager?.[0]?.id).toBe("piAgentManager.view");
    await deactivate();
  });
});
