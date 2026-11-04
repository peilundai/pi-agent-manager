import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import * as vscode from "vscode";
import { boundFilePosition, imageMimeType, searchFiles, selectionFromEditor } from "../editor/editor-context";
import { formatEditorSelection, selectionLabel } from "../editor/selection";
import { ChatSession, type ChatSessionOptions } from "../pi/chat-session";
import { augmentPath, buildPiInvocation, buildRpcArgs, resolvePiCommand } from "../pi/command-resolver";
import { PiRpcClient } from "../pi/rpc-client";
import type { PiSessionRepository } from "../pi/session-repository";
import type { PiEnvironment } from "./pi-environment";
import type { SessionSummary, SetupErrorState } from "../shared/model";
import {
  isWebviewMessage,
  TOOL_EXPANSIONS,
  type HostToWebviewMessage,
  type ImageAttachment,
  type ToolExpansion,
  type WebviewToHostMessage,
} from "../shared/protocol";

const SESSIONS_DEBOUNCE_MS = 200;
const FILE_CACHE_MS = 30_000;
const MAX_INDEXED_FILES = 20_000;
const MAX_ATTACH_IMAGE_BYTES = 10 * 1024 * 1024;
const FILE_EXCLUDES = "**/{node_modules,.git,dist,out,build,.next,coverage,.venv,__pycache__}/**";

export const VIEW_ID = "piAgentManager.view";
export const CONTAINER_COMMAND = "workbench.view.extension.piAgentManager";

export interface ChatViewProviderOptions {
  extensionUri: vscode.Uri;
  workspaceFolder: vscode.WorkspaceFolder | undefined;
  repository: Pick<PiSessionRepository, "list" | "watch" | "delete"> & Partial<Pick<PiSessionRepository, "useEnvironment">>;
  /** Builds Pi's environment (login shell, settings, secrets); defaults to VS Code's own. */
  environment?: Pick<PiEnvironment, "resolve" | "checkMissing">;
  /** Test seam: replaces spawning the real `pi --mode rpc` process. */
  createClient?: ChatSessionOptions["createClient"];
}

function sameFolder(left: vscode.WorkspaceFolder | undefined, right: vscode.WorkspaceFolder | undefined): boolean {
  return left?.uri.toString() === right?.uri.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const DEFAULT_MAX_CONTENT_WIDTH = 800;

/** The configured content width in pixels, or 0 for no limit. Invalid values fall back to the default. */
export function maxContentWidth(): number {
  const value = vscode.workspace.getConfiguration("piAgentManager").get<unknown>("maxContentWidth", DEFAULT_MAX_CONTENT_WIDTH);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_MAX_CONTENT_WIDTH;
}

export function webviewHtml(webview: Pick<vscode.Webview, "cspSource" | "asWebviewUri">, distUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString("base64url");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.js")).toString();
  const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.css")).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data: blob:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp};" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style}" />
    <title>Pi</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}

function toolExpansionSetting(): ToolExpansion {
  const value = vscode.workspace.getConfiguration("piAgentManager").get<unknown>("expandToolCards", "edits");
  return TOOL_EXPANSIONS.includes(value as ToolExpansion) ? (value as ToolExpansion) : "edits";
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private outbox: HostToWebviewMessage[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined;
  private sessions: SessionSummary[] = [];
  private watcher: { dispose(): void } | undefined;
  private fileCache: { at: number; cwd: string; files: string[] } | undefined;
  private setupError: SetupErrorState | undefined;
  private readonly session: ChatSession;
  /** The folder Pi runs in. In multi-root windows it can change; see followEditor(). */
  private folder: vscode.WorkspaceFolder | undefined;
  /** Serializes folder switches so rapid editor changes cannot interleave Pi restarts. */
  private switching: Promise<void> = Promise.resolve();

  constructor(private readonly options: ChatViewProviderOptions) {
    this.folder = options.workspaceFolder;
    this.setupError = options.workspaceFolder ? undefined : { kind: "workspace" };
    this.session = new ChatSession({
      createClient: options.createClient ?? ((listener) => this.createClient(listener)),
      post: (message) => this.post(message),
      onSessionsChanged: () => this.scheduleSessions(),
    });
    this.watchSessions();
  }

  /** The workspace folder Pi currently runs in, if any. */
  get workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return this.folder;
  }

  /** Watches the current folder's transcripts, wherever Pi's environment puts them. */
  private watchSessions(): void {
    this.watcher?.dispose();
    const folder = this.folder;
    this.watcher = folder ? this.options.repository.watch(folder.uri.fsPath, () => this.scheduleSessions()) : undefined;
  }

  private get cwd(): string | undefined {
    return this.folder?.uri.fsPath;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const distUri = vscode.Uri.joinPath(this.options.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.html = webviewHtml(view.webview, distUri);
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isWebviewMessage(message)) return;
        void this.receive(message).catch((error) => this.notice("error", errorMessage(error)));
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
          this.ready = false;
        }
      }),
    );
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(CONTAINER_COMMAND);
    this.view?.show?.(true);
  }

  async newChat(): Promise<void> {
    await this.reveal();
    if (this.setupError) return;
    await this.startNewChat().catch((error) => this.notice("error", errorMessage(error)));
    this.post({ version: 1, type: "composer.focus" });
  }

  /**
   * Follows the active editor across workspace folders, like a terminal opened beside it would,
   * but only while the chat is empty and idle: a conversation is never swapped out from under you.
   */
  followEditor(editor: Pick<vscode.TextEditor, "document"> | undefined): void {
    const target = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
    if (!target || sameFolder(target, this.folder) || !this.session.isPristine) return;
    void this.switchFolder(target);
  }

  /** Re-scopes the chat when folders are added, removed or renamed. */
  /** Layout settings only need a fresh init; Pi keeps running. */
  configurationChanged(event: Pick<vscode.ConfigurationChangeEvent, "affectsConfiguration">): void {
    if (!this.ready) return;
    if (
      event.affectsConfiguration("piAgentManager.maxContentWidth") ||
      event.affectsConfiguration("piAgentManager.expandToolCards")
    ) {
      this.postInit();
    }
  }

  workspaceFoldersChanged(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const current = folders.find((folder) => sameFolder(folder, this.folder));
    if (current) {
      // Still present; its name or index may have changed, and multi-root may have toggled.
      this.folder = current;
      this.postInit();
      return;
    }
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    const target = (editorUri ? vscode.workspace.getWorkspaceFolder(editorUri) : undefined) ?? folders[0];
    const previous = this.folder;
    const hadChat = !this.session.isPristine;
    void this.switchFolder(target).then(() => {
      if (previous && target && hadChat) {
        this.notice("info", `“${previous.name}” was removed from the workspace, so Pi moved to “${target.name}”.`);
      }
    });
  }

  /** Lets the user pick the folder Pi works in (multi-root windows). */
  async pickFolder(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length < 2) return;
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: sameFolder(folder, this.folder) ? "current" : "",
        detail: folder.uri.fsPath,
        folder,
      })),
      { title: "Pi Agent Manager: Workspace Folder", placeHolder: "Choose the folder Pi works in and lists chats for" },
    );
    if (!picked || sameFolder(picked.folder, this.folder)) return;
    if (this.session.isBusy) {
      const answer = await vscode.window.showWarningMessage(
        `Pi is still working in “${this.folder?.name ?? "this folder"}”.`,
        { modal: true, detail: `Stop it and start a new chat in “${picked.folder.name}”? The current chat stays in history.` },
        "Stop and Switch",
      );
      if (answer !== "Stop and Switch") return;
    }
    await this.switchFolder(picked.folder);
    await this.reveal();
    this.post({ version: 1, type: "composer.focus" });
  }

  async toggleHistory(): Promise<void> {
    await this.reveal();
    this.post({ version: 1, type: "history.toggle" });
  }

  async focusInput(): Promise<void> {
    await this.reveal();
    this.post({ version: 1, type: "composer.focus" });
  }

  async sendSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a file and select code to add it to Pi Agent Manager.");
      return;
    }
    const document = editor.document;
    const relativePath =
      document.uri.scheme === "untitled" ? document.fileName : vscode.workspace.asRelativePath(document.uri, false);
    try {
      const selection = selectionFromEditor(editor, relativePath);
      const label = selectionLabel(selection);
      const text = formatEditorSelection(selection);
      await this.reveal();
      this.post({ version: 1, type: "composer.insert", text: `${label} `, references: [{ label, text }] });
      this.post({ version: 1, type: "composer.focus" });
    } catch (error) {
      void vscode.window.showWarningMessage(errorMessage(error));
    }
  }

  dispose(): void {
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.watcher?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    void this.session.dispose();
  }

  async shutdown(): Promise<void> {
    await this.session.dispose();
  }

  /** Restarts Pi on the current chat so it picks up a changed environment. */
  async restartPi(): Promise<void> {
    if (!this.folder) return;
    if (this.setupError) {
      await this.retrySetup();
      return;
    }
    await this.session.restart().catch((error) => this.notice("error", errorMessage(error)));
  }

  private async receive(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.ready = true;
        this.postInit();
        this.flushOutbox();
        if (this.setupError) return;
        void this.refreshSessions();
        if (this.session.running) {
          this.post({ version: 1, type: "process", status: "ready" });
          await this.session.postSnapshot();
        } else {
          await this.startSession();
        }
        return;
      case "prompt":
        await this.session.prompt(message.text, message.images, message.mode);
        return;
      case "abort":
        await this.session.abort();
        return;
      case "chat.new":
        await this.startNewChat();
        this.post({ version: 1, type: "composer.focus" });
        return;
      case "chat.open":
        if (!this.sessions.some((session) => session.path === message.path)) await this.refreshSessions();
        if (!this.sessions.some((session) => session.path === message.path)) {
          throw new Error("That chat is no longer available.");
        }
        await this.session.openSession(message.path);
        return;
      case "chat.rename":
        await this.renameChat();
        return;
      case "chat.delete":
        await this.deleteChat(message.path);
        return;
      case "sessions.refresh":
        await this.refreshSessions();
        return;
      case "folder.pick":
        await this.pickFolder();
        return;
      case "model.set":
        await this.session.setModel(message.provider, message.modelId);
        return;
      case "thinking.set":
        await this.session.setThinkingLevel(message.level);
        return;
      case "dialog.respond":
        this.session.respondToDialog(message.response);
        return;
      case "files.search":
        this.post({
          version: 1,
          type: "files.result",
          requestId: message.requestId,
          files: searchFiles(await this.workspaceFiles(), message.query),
        });
        return;
      case "attach.pick":
        await this.pickAttachments();
        return;
      case "file.open":
        await this.openFile(message.path, message.line);
        return;
      case "url.open":
        await vscode.env.openExternal(vscode.Uri.parse(message.url, true));
        return;
      case "compact":
        await this.session.compact();
        return;
      case "restart":
        await this.session.restart().catch(() => undefined);
        return;
      case "focus.changed":
        await vscode.commands.executeCommand("setContext", "piAgentManager.focused", message.focused);
        return;
      case "setup.action":
        await this.setupAction(message.action);
        return;
    }
  }

  private async startSession(): Promise<void> {
    try {
      await this.session.ensureStarted();
      this.setupError = undefined;
    } catch (error) {
      if (error instanceof Error && error.name === "PiCommandNotFoundError") {
        this.setupError = { kind: "executable", message: error.message };
        this.postInit();
      }
    }
  }

  private async createClient(listener: ConstructorParameters<typeof PiRpcClient>[1]): Promise<PiRpcClient> {
    const cwd = this.cwd;
    if (!cwd) throw new Error("Open a folder to chat with Pi.");
    const config = vscode.workspace.getConfiguration("piAgentManager");
    const environment = this.options.environment ? await this.options.environment.resolve() : process.env;
    const command = await resolvePiCommand({ configured: config.get<string>("command", "pi"), env: environment });
    const extraArgs = config.get<unknown>("extraArgs", []);
    const args = buildRpcArgs({
      extraArgs: Array.isArray(extraArgs) ? extraArgs.filter((value): value is string => typeof value === "string") : [],
    });
    const invocation = buildPiInvocation(command.path, args);
    const env: NodeJS.ProcessEnv = { ...environment, ...invocation.env, PATH: augmentPath(command.path, environment) };
    void this.options.environment?.checkMissing(cwd, env).catch(() => undefined);
    if (this.options.repository.useEnvironment?.(environment)) {
      // Pi will write transcripts where its environment says; list and watch the same place.
      this.watchSessions();
      this.scheduleSessions();
    }
    return new PiRpcClient({ file: invocation.file, args: invocation.args, cwd, env }, listener);
  }

  /** New chats start in the active editor's folder, so "+" always means "here". */
  private async startNewChat(): Promise<void> {
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    const target = editorUri ? vscode.workspace.getWorkspaceFolder(editorUri) : undefined;
    if (target && !sameFolder(target, this.folder)) {
      await this.switchFolder(target);
      return;
    }
    await this.session.newChat();
  }

  private switchFolder(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    const run = async () => {
      if (sameFolder(folder, this.folder)) return;
      this.folder = folder;
      this.fileCache = undefined;
      this.sessions = [];
      this.watchSessions();
      if (!folder) this.setupError = { kind: "workspace" };
      else if (this.setupError?.kind === "workspace") this.setupError = undefined;
      this.postInit();
      this.post({ version: 1, type: "sessions", sessions: [] });
      // A Pi process is bound to its working directory, so a new folder needs a new process.
      await this.session.stop();
      // Pi starts once the view is ready; until then only the scope changes.
      if (!folder || !this.ready || this.setupError) return;
      void this.refreshSessions();
      await this.startSession();
    };
    this.switching = this.switching.then(run, run);
    return this.switching;
  }

  private postInit(): void {
    this.post({
      version: 1,
      type: "init",
      workspaceName: this.folder?.name ?? "",
      platform: process.platform,
      ...((vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? { multiRoot: true } : {}),
      maxContentWidth: maxContentWidth(),
      ...(this.setupError ? { setupError: this.setupError } : {}),
      toolExpansion: toolExpansionSetting(),
    });
  }

  private scheduleSessions(): void {
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = undefined;
      void this.refreshSessions();
    }, SESSIONS_DEBOUNCE_MS);
  }

  private async refreshSessions(): Promise<void> {
    const cwd = this.cwd;
    if (!cwd) return;
    try {
      const sessions = await this.options.repository.list(cwd);
      if (cwd !== this.cwd) return; // The folder changed while listing; a newer refresh owns the list.
      this.sessions = sessions;
      this.post({ version: 1, type: "sessions", sessions });
    } catch (error) {
      this.notice("warning", `Could not read Pi sessions: ${errorMessage(error)}`);
    }
  }

  private async renameChat(): Promise<void> {
    const current = this.sessions.find((session) => session.path === this.session.sessionFile);
    const name = await vscode.window.showInputBox({
      title: "Rename Chat",
      prompt: "Enter a new name for this chat",
      value: current?.title ?? "",
      validateInput(value) {
        const length = value.replace(/\s+/g, " ").trim().length;
        return length >= 1 && length <= 80 ? undefined : "Names must contain 1 to 80 characters.";
      },
    });
    if (!name) return;
    await this.session.rename(name.replace(/\s+/g, " ").trim());
  }

  private async deleteChat(path: string): Promise<void> {
    const target = this.sessions.find((session) => session.path === path);
    if (!target) return;
    const answer = await vscode.window.showWarningMessage(
      `Delete “${target.title}”?`,
      { modal: true, detail: "This permanently deletes the Pi transcript." },
      "Delete",
    );
    if (answer !== "Delete") return;
    if (this.session.sessionFile === path) {
      await this.session.newChat();
      if (this.session.sessionFile === path) {
        // An extension vetoed new_session; Pi is still attached to this transcript.
        this.notice("warning", "This chat is still active, so it was not deleted.");
        return;
      }
    }
    await this.options.repository.delete(target);
    await this.refreshSessions();
  }

  private async workspaceFiles(): Promise<string[]> {
    const cwd = this.cwd;
    if (!cwd || !this.folder) return [];
    const cached = this.fileCache;
    if (cached?.cwd === cwd && Date.now() - cached.at < FILE_CACHE_MS) return cached.files;
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.folder, "**/*"),
      FILE_EXCLUDES,
      MAX_INDEXED_FILES,
    );
    const files = uris.map((uri) => relative(cwd, uri.fsPath).split("\\").join("/"));
    // A search that outlives a folder switch must not cache the old folder's files.
    if (cwd === this.cwd) this.fileCache = { at: Date.now(), cwd, files };
    return files;
  }

  private async pickAttachments(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: "Attach",
      ...(this.folder ? { defaultUri: this.folder.uri } : {}),
    });
    if (!selected?.length) return;
    const images: ImageAttachment[] = [];
    const mentions: string[] = [];
    for (const uri of selected) {
      const mimeType = imageMimeType(uri.fsPath);
      if (mimeType) {
        const data = await readFile(uri.fsPath);
        if (data.byteLength > MAX_ATTACH_IMAGE_BYTES) {
          this.notice("warning", `${uri.fsPath} is larger than 10 MB and was not attached.`);
          continue;
        }
        images.push({ data: data.toString("base64"), mimeType, name: uri.path.slice(uri.path.lastIndexOf("/") + 1) });
      } else {
        const cwd = this.cwd;
        const path = cwd ? relative(cwd, uri.fsPath).split("\\").join("/") : uri.fsPath;
        mentions.push(`@${path.startsWith("..") ? uri.fsPath : path}`);
      }
    }
    this.post({
      version: 1,
      type: "composer.insert",
      text: mentions.length ? `${mentions.join(" ")} ` : "",
      ...(images.length ? { images } : {}),
    });
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const cwd = this.cwd;
    const absolute = isAbsolute(path) ? path : cwd ? join(cwd, path) : path;
    const uri = vscode.Uri.file(absolute);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      this.notice("warning", `File not found: ${path}`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const position = boundFilePosition({ line: line ?? 0 }, document);
    const at = new vscode.Position(position.line, position.column);
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(at, at) });
  }

  private async setupAction(action: "openFolder" | "chooseExecutable" | "openSettings" | "retry"): Promise<void> {
    switch (action) {
      case "openFolder":
        await vscode.commands.executeCommand("workbench.action.files.openFolder");
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "piAgentManager");
        return;
      case "chooseExecutable": {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: "Use as Pi Executable",
        });
        const executable = selected?.[0];
        if (!executable) return;
        await vscode.workspace.getConfiguration("piAgentManager").update("command", executable.fsPath, vscode.ConfigurationTarget.Global);
        await this.retrySetup();
        return;
      }
      case "retry":
        await this.retrySetup();
        return;
    }
  }

  private async retrySetup(): Promise<void> {
    if (!this.folder) return;
    this.setupError = undefined;
    this.postInit();
    void this.refreshSessions();
    await this.startSession();
  }

  private post(message: HostToWebviewMessage): void {
    if (!this.view || !this.ready) {
      // Only state-bearing messages are worth replaying once the webview is ready.
      if (message.type === "composer.insert" || message.type === "notice") this.outbox.push(message);
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private flushOutbox(): void {
    const pending = this.outbox.splice(0);
    for (const message of pending) this.post(message);
  }

  private notice(level: "info" | "warning" | "error", message: string): void {
    this.post({ version: 1, type: "notice", level, message });
  }
}
