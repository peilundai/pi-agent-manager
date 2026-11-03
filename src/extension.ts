import * as vscode from "vscode";
import { resolveWorkspaceFolder } from "./editor/editor-context";
import { PiSessionRepository, type ArchiveStore } from "./pi/session-repository";
import { ChatViewProvider, VIEW_ID } from "./view/chat-view-provider";
import { PiEnvironment, registerEnvironmentCommands } from "./view/pi-environment";

const ARCHIVED_SESSIONS_KEY = "piAgentManager.archivedSessions";

let activeProvider: ChatViewProvider | undefined;

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

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = resolveWorkspaceFolder(vscode.workspace, vscode.window.activeTextEditor);
  const log = vscode.window.createOutputChannel("Pi Agent Manager", { log: true });
  const environment = new PiEnvironment({ secrets: context.secrets, log });
  environment.preload();
  const provider = new ChatViewProvider({
    extensionUri: context.extensionUri,
    workspaceFolder,
    environment,
    repository: new PiSessionRepository({ archiveStore: new MementoArchiveStore(context.workspaceState) }),
  });
  activeProvider = provider;
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("piAgentManager.open", () => provider.focusInput()),
    vscode.commands.registerCommand("piAgentManager.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("piAgentManager.history", () => provider.toggleHistory()),
    vscode.commands.registerCommand("piAgentManager.sendSelection", () => provider.sendSelection()),
    vscode.commands.registerCommand("piAgentManager.focusInput", () => provider.focusInput()),
    ...registerEnvironmentCommands({
      environment,
      cwd: () => workspaceFolder?.uri.fsPath,
      restart: () => provider.restartPi(),
    }),
    log,
  );
}

export async function deactivate(): Promise<void> {
  const provider = activeProvider;
  activeProvider = undefined;
  await provider?.shutdown();
}
