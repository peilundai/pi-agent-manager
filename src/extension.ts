import * as vscode from "vscode";
import { buildPiArgs, buildPiInvocation, resolvePiCommand } from "./pi/command-resolver";
import { NodePtyAdapter } from "./pi/pty-adapter";
import { SessionController, type SessionControllerEvent } from "./pi/session-controller";
import { PiSessionRepository, type ArchiveStore } from "./pi/session-repository";
import { PiStatusBridge } from "./pi/status-bridge";
import type { StatusReport } from "./pi/status-report";
import { PiViewProvider, type PiViewHost } from "./view/pi-view-provider";
import type { PersistedViewState } from "./view/view-state";

const VIEW_STATE_KEY = "piAgent.viewState";
const ARCHIVED_SESSIONS_KEY = "piAgent.archivedSessions";

interface ExtensionProvider {
  start(): Promise<void>;
  open(): Promise<void>;
  newSession(): Promise<unknown>;
  sendSelection(): Promise<void>;
  shutdown(): Promise<void>;
}

interface ExtensionApi {
  window: Pick<typeof vscode.window, "registerWebviewViewProvider">;
  commands: Pick<typeof vscode.commands, "registerCommand">;
}

export interface ActivationOverrides {
  api?: ExtensionApi;
  provider?: ExtensionProvider;
  workspace?: Pick<typeof vscode.workspace, "workspaceFolders" | "getWorkspaceFolder">;
  activeEditor?: Pick<vscode.TextEditor, "document"> | null;
  providerFactory?(workspaceFolder: vscode.WorkspaceFolder): ExtensionProvider;
}

let activeProvider: ExtensionProvider | undefined;

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

interface EditorSelectionSource<TUri extends { scheme: string } = { scheme: string }> {
  document: {
    uri: TUri;
    fileName: string;
    languageId: string;
    lineAt(line: number): { text: string };
    getText(selection: unknown): string;
  };
  selection: {
    isEmpty: boolean;
    active: { line: number };
    start: { line: number };
    end: { line: number; character: number };
  };
}

export function selectionFromEditor(
  editor: EditorSelectionSource,
  relativePath: string,
): ReturnType<PiViewHost["captureEditorSelection"]> {
  const { document, selection } = editor;
  if (selection.isEmpty) {
    const line = selection.active.line;
    return {
      scheme: document.uri.scheme,
      relativePath,
      languageId: document.languageId,
      startLine: line,
      endLine: line,
      text: document.lineAt(line).text,
    };
  }
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
    ? selection.end.line - 1
    : selection.end.line;
  return {
    scheme: document.uri.scheme,
    relativePath,
    languageId: document.languageId,
    startLine: selection.start.line,
    endLine,
    text: document.getText(selection),
  };
}

interface WorkspaceBoundary<TFolder, TUri> {
  workspaceFolders: readonly TFolder[] | undefined;
  getWorkspaceFolder(uri: TUri): TFolder | undefined;
}

export function resolveWorkspaceFolder<TFolder, TUri>(
  workspace: WorkspaceBoundary<TFolder, TUri>,
  activeEditor?: { document: { uri: TUri } },
): TFolder | undefined {
  const activeFolder = activeEditor ? workspace.getWorkspaceFolder(activeEditor.document.uri) : undefined;
  if (activeFolder) return activeFolder;
  return workspace.workspaceFolders?.length === 1 ? workspace.workspaceFolders[0] : undefined;
}

export function selectionFromWorkspaceEditor<
  TUri extends { scheme: string },
  TFolder extends { name: string },
>(
  editor: EditorSelectionSource<TUri>,
  workspaceFolder: TFolder,
  workspace: WorkspaceBoundary<TFolder, TUri> & {
    asRelativePath(uri: TUri, includeWorkspaceFolder?: boolean): string;
  },
): ReturnType<PiViewHost["captureEditorSelection"]> {
  const documentFolder = editor.document.uri.scheme === "untitled"
    ? workspaceFolder
    : workspace.getWorkspaceFolder(editor.document.uri);
  if (documentFolder !== workspaceFolder) {
    throw new Error(`The active editor is in a different workspace. Pi Agent Manager is scoped to “${workspaceFolder.name}”.`);
  }
  const relativePath = editor.document.uri.scheme === "untitled"
    ? editor.document.fileName
    : workspace.asRelativePath(editor.document.uri, false);
  return selectionFromEditor(editor, relativePath);
}

function captureSelection(
  workspaceFolder: vscode.WorkspaceFolder,
): ReturnType<PiViewHost["captureEditorSelection"]> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  return selectionFromWorkspaceEditor<vscode.Uri, vscode.WorkspaceFolder>(
    editor,
    workspaceFolder,
    vscode.workspace,
  );
}

export function boundFilePosition(
  target: { path?: string; line?: number; column?: number },
  document: { lineCount: number; lineAt(line: number): { text: string } },
): { line: number; column: number } {
  const line = Math.min(Math.max(target.line ?? 0, 0), Math.max(document.lineCount - 1, 0));
  const column = Math.min(Math.max(target.column ?? 0, 0), document.lineAt(line).text.length);
  return { line, column };
}

function createHost(workspaceFolder: vscode.WorkspaceFolder): PiViewHost {
  return {
    captureEditorSelection: () => captureSelection(workspaceFolder),
    async revealManager() {
      await vscode.commands.executeCommand("workbench.view.extension.piAgent");
    },
    async confirmDelete(session) {
      const answer = await vscode.window.showWarningMessage(
        `Delete “${session.title}”?`,
        { modal: true, detail: "This permanently deletes the Pi transcript and its sidecar data." },
        "Delete",
      );
      return answer === "Delete";
    },
    async requestName(session) {
      return vscode.window.showInputBox({
        title: "Rename Pi Agent",
        prompt: "Enter a new session name",
        value: session.title,
        validateInput(value) {
          const length = value.replace(/\s+/g, " ").trim().length;
          return length >= 1 && length <= 80 ? undefined : "Session names must contain 1 to 80 characters.";
        },
      });
    },
    async openUrl(target) {
      await vscode.env.openExternal(vscode.Uri.parse(target, true));
    },
    async openFile(target) {
      const uri = vscode.Uri.file(target.path);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        return false;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const { line, column } = boundFilePosition(target, document);
      const position = new vscode.Position(line, column);
      await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(position, position),
      });
      return true;
    },
    closeBehavior() {
      return vscode.workspace.getConfiguration("piAgent").get<"detach" | "stop">("closeBehavior", "detach");
    },
  };
}

function createProvider(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
): PiViewProvider {
  const cwd = workspaceFolder.uri.fsPath;
  const distUri = vscode.Uri.joinPath(context.extensionUri, "dist");
  const statusExtensionPath = vscode.Uri.joinPath(distUri, "resources", "pi-status.mjs").fsPath;
  const repository = new PiSessionRepository({ archiveStore: new MementoArchiveStore(context.workspaceState) });
  let provider: PiViewProvider | undefined;
  const bridge = new PiStatusBridge((report: StatusReport) => provider?.handleStatusReport(report));
  const controller = new SessionController({
    pty: new NodePtyAdapter(),
    invocationFor: async (sessionPath) => {
      const configured = vscode.workspace.getConfiguration("piAgent").get<string>("command", "pi");
      const command = await resolvePiCommand({ configured });
      return buildPiInvocation(command.path, buildPiArgs(statusExtensionPath, sessionPath));
    },
    environmentFor: (tabId) => bridge.environmentFor(tabId),
    onEvent: (event: SessionControllerEvent) => provider?.handleControllerEvent(event),
  });
  provider = new PiViewProvider({
    cwd,
    distUri,
    resourceUri: (path) => vscode.Uri.joinPath(distUri, path),
    state: {
      get: () => context.workspaceState.get<unknown>(VIEW_STATE_KEY),
      update: (value: PersistedViewState) => context.workspaceState.update(VIEW_STATE_KEY, value),
    },
    repository,
    controller,
    bridge,
    host: createHost(workspaceFolder),
  });
  return provider;
}

export async function activate(
  context: vscode.ExtensionContext,
  overrides: ActivationOverrides = {},
): Promise<void> {
  const api = overrides.api ?? vscode;
  const provider = overrides.provider ?? (() => {
    const workspace = overrides.workspace ?? vscode.workspace;
    const activeEditor = overrides.activeEditor === undefined
      ? vscode.window.activeTextEditor
      : overrides.activeEditor ?? undefined;
    const workspaceFolder = resolveWorkspaceFolder(workspace, activeEditor);
    if (!workspaceFolder) {
      throw new Error("Open a workspace folder for Pi Agent Manager. In a multi-root workspace, focus a file in the folder to manage and try again.");
    }
    return overrides.providerFactory?.(workspaceFolder) ?? createProvider(context, workspaceFolder);
  })();
  activeProvider = provider;
  await provider.start();

  context.subscriptions.push(
    api.window.registerWebviewViewProvider(
      "piAgent.view",
      provider as unknown as vscode.WebviewViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    api.commands.registerCommand("piAgent.open", () => provider.open()),
    api.commands.registerCommand("piAgent.newSession", () => provider.newSession()),
    api.commands.registerCommand("piAgent.sendSelection", () => provider.sendSelection()),
  );
}

export async function deactivate(): Promise<void> {
  const provider = activeProvider;
  activeProvider = undefined;
  await provider?.shutdown();
}
