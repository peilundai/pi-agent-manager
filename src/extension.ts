import * as vscode from "vscode";
import { resolveWorkspaceFolder } from "./editor/editor-context";
import { PiSessionRepository, type ArchiveStore } from "./pi/session-repository";
import { ChatViewProvider, VIEW_ID } from "./view/chat-view-provider";

const ARCHIVED_SESSIONS_KEY = "piChat.archivedSessions";

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
  const provider = new ChatViewProvider({
    extensionUri: context.extensionUri,
    workspaceFolder,
    repository: new PiSessionRepository({ archiveStore: new MementoArchiveStore(context.workspaceState) }),
  });
  activeProvider = provider;
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("piChat.open", () => provider.focusInput()),
    vscode.commands.registerCommand("piChat.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("piChat.history", () => provider.toggleHistory()),
    vscode.commands.registerCommand("piChat.sendSelection", () => provider.sendSelection()),
    vscode.commands.registerCommand("piChat.focusInput", () => provider.focusInput()),
  );
}

export async function deactivate(): Promise<void> {
  const provider = activeProvider;
  activeProvider = undefined;
  await provider?.shutdown();
}
