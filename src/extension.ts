import * as vscode from "vscode";
import { resolveWorkspaceFolder } from "./editor/editor-context";
import { PiSessionRepository, type ArchiveStore } from "./pi/session-repository";
import { ChatViewProvider, FALLBACK_CONTEXT, SIDEBAR_VIEW_ID, VIEW_ID, chatSurface } from "./view/chat-view-provider";
import { AGENT_PANEL_TYPE, defaultLocation, EditorAgents } from "./view/editor-agents";
import { PiEnvironment, registerEnvironmentCommands } from "./view/pi-environment";

const ARCHIVED_SESSIONS_KEY = "piAgentManager.archivedSessions";

let activeHost: { shutdown(): Promise<void> } | undefined;
class MementoArchiveStore implements ArchiveStore {
  constructor(private readonly memento: vscode.Memento) {}

  read(): readonly string[] {
    const value = this.memento.get<unknown>(ARCHIVED_SESSIONS_KEY);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  async write(ids: readonly string[]): Promise<void> {
    await this.memento.update(ARCHIVED_SESSIONS_KEY, [...ids]);
  }
}

const webviewViewOptions = { webviewOptions: { retainContextWhenHidden: true } };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = resolveWorkspaceFolder(vscode.workspace, vscode.window.activeTextEditor);
  const log = vscode.window.createOutputChannel("Pi Agent for VS Code", { log: true });
  const environment = new PiEnvironment({ secrets: context.secrets, log });
  const knownCommands = await vscode.commands.getCommands(true);
  const surface = chatSurface(knownCommands);
  if (surface === "activitybar") {
    await vscode.commands.executeCommand("setContext", FALLBACK_CONTEXT, true);
  }
  const repository = new PiSessionRepository({ archiveStore: new MementoArchiveStore(context.workspaceState) });
  const chatOptions = {
    extensionUri: context.extensionUri,
    workspaceFolder,
    environment,
    repository,
    memento: context.workspaceState,
    relay: { script: vscode.Uri.joinPath(context.extensionUri, "dist", "relay.js").fsPath, nodePath: process.execPath },
  };
  const sidebar = new ChatViewProvider({ ...chatOptions, surface });
  const agents = new EditorAgents({
    extensionUri: context.extensionUri,
    memento: context.workspaceState,
    createChat: (agentId) => new ChatViewProvider({ ...chatOptions, agentId }),
  });
  const inSidebar = () => defaultLocation() === "sidebar";
  /** The chat a command acts on: the sidebar's, or the editor-tab agent the user worked in last. */
  const target = (): ChatViewProvider => (inSidebar() ? sidebar : agents.current());
  const everyChat = (): ChatViewProvider[] => [sidebar, ...agents.chats];
  activeHost = {
    shutdown: async () => {
      await Promise.all([sidebar.shutdown(), agents.shutdown()]);
    },
  };
  context.subscriptions.push(
    sidebar,
    agents,
    vscode.window.registerWebviewViewProvider(VIEW_ID, sidebar, webviewViewOptions),
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar, webviewViewOptions),
    vscode.window.registerWebviewPanelSerializer(AGENT_PANEL_TYPE, agents),
    vscode.commands.registerCommand("piAgentManager.open", () => target().focusInput()),
    vscode.commands.registerCommand("piAgentManager.newAgent", () => (inSidebar() ? sidebar.newChat() : agents.open().focusInput())),
    vscode.commands.registerCommand("piAgentManager.newChat", () => target().newChat()),
    vscode.commands.registerCommand("piAgentManager.history", () => target().toggleHistory()),
    vscode.commands.registerCommand("piAgentManager.sendSelection", () => target().sendSelection()),
    vscode.commands.registerCommand("piAgentManager.focusInput", () => target().focusInput()),
    vscode.commands.registerCommand("piAgentManager.switchFolder", () => target().pickFolder()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      for (const chat of everyChat()) {
        chat.followEditor(editor);
        chat.editorSelectionChanged(editor);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      for (const chat of everyChat()) chat.editorSelectionChanged(event.textEditor);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const chat of everyChat()) chat.workspaceFoldersChanged();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      for (const chat of everyChat()) chat.configurationChanged(event);
    }),
    ...registerEnvironmentCommands({
      environment,
      // The folder can change in multi-root windows, so ask the chat each time.
      cwd: () => (inSidebar() ? sidebar : (agents.activeChat ?? sidebar)).workspaceFolder?.uri.fsPath,
      restart: async () => {
        await Promise.all([...(inSidebar() ? [sidebar] : []), ...agents.chats].map((chat) => chat.restartPi()));
      },
    }),
    log,
  );
  // A reload left Pi running behind its relay: pick it back up straight away.
  if (inSidebar()) sidebar.resumeRunningPi();
  agents.resumeRunning();
}

export async function deactivate(): Promise<void> {
  const host = activeHost;
  activeHost = undefined;
  await host?.shutdown();
}
