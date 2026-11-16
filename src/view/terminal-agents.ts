import { isAbsolute, relative, sep } from "node:path";
import * as vscode from "vscode";
import { resolveWorkspaceFolder, selectionFromEditor } from "../editor/editor-context";
import { isSupportedDocumentScheme, selectionLabel, type EditorSelectionContext } from "../editor/selection";
import { augmentPath, buildPiInvocation, buildTerminalArgs, resolvePiCommand } from "../pi/command-resolver";
import { defaultShell, quoteForShell, shellArguments } from "../pi/shell-environment";
import { DEFAULT_AGENT_TITLE } from "./chat-view-provider";
import type { PiEnvironment } from "./pi-environment";

export type TabMode = "chat" | "terminal";

/** Which editor-tab UI new agents use, from `piAgentManager.tabMode`. Unknown values mean chat. */
export function tabMode(): TabMode {
  const value = vscode.workspace.getConfiguration("piAgentManager").get<unknown>("tabMode", "chat");
  return value === "terminal" ? "terminal" : "chat";
}

/** Longest terminal tab title, as pi-tabs' `titleMaxLength`. */
export const TERMINAL_TITLE_MAX_LENGTH = 24;

/** The terminal tab title: "Pi Agent", plus the folder name in multi-root windows. */
export function terminalTitle(folderName?: string): string {
  if (!folderName) return DEFAULT_AGENT_TITLE;
  const title = `${DEFAULT_AGENT_TITLE}: ${folderName}`;
  return title.length <= TERMINAL_TITLE_MAX_LENGTH ? title : `${title.slice(0, TERMINAL_TITLE_MAX_LENGTH - 1)}…`;
}

export interface TerminalLaunch {
  shellPath?: string;
  shellArgs: string[];
  env?: Record<string, string>;
}

/**
 * How to start interactive Pi in a terminal, borrowed from pi-tabs
 * (`PiTerminalManager`): on macOS/Linux run it through the user's login shell
 * so the shell's PATH and startup files apply (`exec` replaces the shell, so
 * the terminal closes when Pi exits); on Windows run the resolved executable
 * directly, or its `.cmd`/`.bat` shim through `cmd.exe`.
 */
export function buildTerminalLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalLaunch {
  if (platform === "win32") {
    const invocation = buildPiInvocation(command, args, platform, env);
    return { shellPath: invocation.file, shellArgs: invocation.args, ...(invocation.env ? { env: invocation.env } : {}) };
  }
  const shell = defaultShell(platform, env);
  const commandLine = [command, ...args].map((value) => quoteForShell(value)).join(" ");
  const shellArgs = shellArguments(shell, `exec ${commandLine}`);
  if (!shellArgs) return { shellPath: command, shellArgs: [...args] };
  return { shellPath: shell, shellArgs };
}

/** Any control character, including newlines: typed into a terminal, they could submit or edit Pi's input. */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/**
 * The `@path#lines` mention a terminal Pi understands; paths with spaces are
 * quoted, as in pi-tabs. Paths with control characters are rejected, because
 * the mention is typed into the terminal as keystrokes.
 */
export function terminalMention(context: Pick<EditorSelectionContext, "relativePath" | "startLine" | "endLine">): string {
  const path = context.relativePath;
  if (!path || hasControlCharacter(path)) throw new Error("This file's path cannot be typed into the Pi terminal.");
  const label = selectionLabel(context);
  if (!/[\s"]/.test(path)) return label;
  const suffix = label.slice(label.lastIndexOf("#"));
  return `@"${path.replace(/"/g, '\\"')}"${suffix}`;
}

/**
 * The document's path as the terminal's Pi sees it: relative to the terminal's
 * working directory, or absolute when the file is outside it (another root of a
 * multi-root window, for example). Unsaved documents have no path Pi can read.
 */
export function terminalPath(document: Pick<vscode.TextDocument, "uri">, cwd: string): string | undefined {
  const { uri } = document;
  if (uri.scheme === "untitled") return undefined;
  if (uri.scheme !== "file") return vscode.workspace.asRelativePath(uri, false);
  const path = relative(cwd, uri.fsPath);
  const outside = path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  // Forward slashes on every platform, as in the chat's mentions; Pi accepts them on Windows too.
  return !path || outside ? uri.fsPath : path.split(sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TerminalFolder {
  /** Pi's working directory. */
  path: string;
  /** Shown in the tab title in multi-root windows. */
  name?: string | undefined;
}

interface TerminalSession {
  terminal: vscode.Terminal;
  folder: TerminalFolder;
  viewColumn: number;
  lastUsed: number;
}

export interface TerminalAgentsOptions {
  extensionUri: vscode.Uri;
  /** Builds Pi's environment (login shell, settings, secrets); defaults to VS Code's own. */
  environment?: Pick<PiEnvironment, "resolve" | "checkMissing">;
  /** Test seam: replaces locating the real `pi` executable. */
  resolveCommand?: typeof resolvePiCommand;
  platform?: NodeJS.Platform;
}

/**
 * Pi agents in editor-area terminals, as in pi-tabs. Each terminal runs plain
 * interactive `pi` (not `--mode rpc`) in a workspace folder, so there is no
 * webview, no session history UI and no relay: the terminals are transient, a
 * window reload closes them, and Pi's own session history stays inside Pi
 * (`/resume`, `pi --continue`).
 */
export class TerminalAgents implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, TerminalSession>();
  private readonly listeners: vscode.Disposable[] = [];
  private sequence = 0;

  constructor(private readonly options: TerminalAgentsOptions) {
    this.listeners.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        this.sessions.delete(terminal);
      }),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        this.rememberActiveSession(terminal);
      }),
    );
  }

  /** How many Pi terminals are currently open. */
  get count(): number {
    this.pruneSessions();
    return this.sessions.size;
  }

  /** Reveals the terminal the user worked in last, or opens a new one. */
  async open(): Promise<vscode.Terminal | undefined> {
    const session = this.preferredSession();
    if (session) {
      this.reveal(session);
      return session.terminal;
    }
    return (await this.createSession())?.terminal;
  }

  /** Always opens a new Pi terminal in its own editor tab. */
  async newAgent(): Promise<vscode.Terminal | undefined> {
    return (await this.createSession())?.terminal;
  }

  /** Reveals the current Pi terminal, opening one if none is open. */
  async focus(): Promise<void> {
    await this.open();
  }

  /**
   * A running Pi is bound to its folder, so in a multi-root window this opens a
   * new Pi terminal in the folder the user picks. With one folder it just
   * reveals the current terminal.
   */
  async pickFolder(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length < 2) {
      await this.open();
      return;
    }
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, detail: folder.uri.fsPath, folder })),
      { title: "Pi Coding Agent for VS Code: Workspace Folder", placeHolder: "Choose the folder the new Pi terminal works in" },
    );
    if (!picked) return;
    await this.createSession({ path: picked.folder.uri.fsPath, name: picked.folder.name });
  }

  /**
   * Inserts the active editor's selection (or the cursor line) as an
   * `@path#lines` mention into the current Pi terminal, without submitting it,
   * so the user can keep typing. Pi reads the file from disk itself.
   */
  async sendSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a file and select code to add it to Pi Coding Agent for VS Code.");
      return;
    }
    try {
      const { scheme } = editor.document.uri;
      if (!isSupportedDocumentScheme(scheme)) throw new Error(`Unsupported editor document scheme: ${scheme}`);
      if (scheme === "untitled") throw new Error("Save the file first: Pi in a terminal reads files from disk.");
      const session = this.preferredSession();
      if (!session) {
        // Keystrokes sent now would land while the login shell and Pi start up,
        // and Pi's TUI can drop them, so open Pi and let the user send again.
        if (await this.createSession()) {
          void vscode.window.showInformationMessage("Pi is starting in a new terminal. Run Add Selection to Chat again once it is ready.");
        }
        return;
      }
      const path = terminalPath(editor.document, session.folder.path);
      if (!path) return;
      const mention = terminalMention(selectionFromEditor(editor, path));
      this.reveal(session);
      session.terminal.sendText(`${mention} `, false);
    } catch (error) {
      void vscode.window.showWarningMessage(errorMessage(error));
    }
  }

  /**
   * For "Reload Environment and Restart Pi": stops every Pi terminal and opens
   * a fresh one in each folder, with the reloaded environment. Pi's sessions
   * stay in Pi's history. Does nothing when no Pi terminal is open.
   */
  async restartAll(): Promise<void> {
    this.pruneSessions();
    const folders = [...this.sessions.values()].sort((left, right) => left.lastUsed - right.lastUsed).map((session) => session.folder);
    for (const { terminal } of this.sessions.values()) terminal.dispose();
    this.sessions.clear();
    // Sequential, so the last one opened (and focused) is the one used last.
    for (const folder of folders) await this.createSession(folder);
  }

  dispose(): void {
    for (const listener of this.listeners.splice(0)) listener.dispose();
    this.sessions.clear();
  }

  private defaultFolder(): TerminalFolder | undefined {
    const folder = resolveWorkspaceFolder(vscode.workspace, vscode.window.activeTextEditor);
    if (!folder) return undefined;
    return { path: folder.uri.fsPath, name: (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? folder.name : undefined };
  }

  private async createSession(target = this.defaultFolder()): Promise<TerminalSession | undefined> {
    if (!target) {
      void vscode.window.showErrorMessage("Open a workspace folder to start Pi in a terminal.");
      return undefined;
    }
    const environment = (await this.options.environment?.resolve().catch(() => undefined)) ?? process.env;
    const config = vscode.workspace.getConfiguration("piAgentManager");
    const platform = this.options.platform ?? process.platform;
    let commandPath: string;
    let args: string[];
    try {
      const extraArgs = config.get<unknown>("extraArgs", []);
      args = buildTerminalArgs(Array.isArray(extraArgs) ? extraArgs.filter((value): value is string => typeof value === "string") : []);
      const resolved = await (this.options.resolveCommand ?? resolvePiCommand)({
        configured: config.get<string>("command", "pi"),
        env: environment,
      });
      commandPath = resolved.path;
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
      return undefined;
    }
    const launch = buildTerminalLaunch(commandPath, args, platform, environment);
    const env: NodeJS.ProcessEnv = {
      ...environment,
      ...launch.env,
      COLORTERM: "truecolor",
      PATH: augmentPath(commandPath, environment, platform),
    };
    void this.options.environment?.checkMissing(target.path, env).catch(() => undefined);
    const viewColumn = this.targetViewColumn();
    const terminal = vscode.window.createTerminal({
      name: terminalTitle(target.name),
      cwd: target.path,
      env,
      iconPath: {
        light: vscode.Uri.joinPath(this.options.extensionUri, "media", "pi-light.svg"),
        dark: vscode.Uri.joinPath(this.options.extensionUri, "media", "pi-dark.svg"),
      },
      // Not restored after a reload: the restored terminal would not be running Pi.
      isTransient: true,
      location: { viewColumn, preserveFocus: false },
      ...(launch.shellPath ? { shellPath: launch.shellPath, shellArgs: launch.shellArgs } : {}),
    });
    const session: TerminalSession = { terminal, folder: target, viewColumn, lastUsed: ++this.sequence };
    this.sessions.set(terminal, session);
    terminal.show(false);
    // `ViewColumn.Beside` is a placement sentinel, not the concrete column VS Code
    // creates: rebind right after reveal so the next terminal reuses the same group.
    this.rememberActiveSession(terminal);
    return session;
  }

  /** Beside the editor for the first terminal, then the group the last one is in. */
  private targetViewColumn(): vscode.ViewColumn {
    return this.preferredSession()?.viewColumn ?? vscode.ViewColumn.Beside;
  }

  private preferredSession(): TerminalSession | undefined {
    this.pruneSessions();
    const active = vscode.window.activeTerminal;
    const activeSession = active ? this.sessions.get(active) : undefined;
    if (activeSession && this.isAlive(activeSession.terminal)) return activeSession;
    return [...this.sessions.values()]
      .filter((session) => this.isAlive(session.terminal))
      .sort((left, right) => right.lastUsed - left.lastUsed)[0];
  }

  private reveal(session: TerminalSession): void {
    session.lastUsed = ++this.sequence;
    session.terminal.show(false);
  }

  private rememberActiveSession(terminal: vscode.Terminal | undefined): void {
    if (!terminal) return;
    const session = this.sessions.get(terminal);
    if (!session) return;
    session.lastUsed = ++this.sequence;
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    if (activeGroup?.activeTab?.input instanceof vscode.TabInputTerminal) {
      session.viewColumn = activeGroup.viewColumn;
    }
  }

  /** Still open and still running Pi; a terminal whose Pi exited with an error stays open but is not reused. */
  private isAlive(terminal: vscode.Terminal): boolean {
    return vscode.window.terminals.includes(terminal) && !terminal.exitStatus;
  }

  private pruneSessions(): void {
    for (const terminal of this.sessions.keys()) {
      if (!vscode.window.terminals.includes(terminal)) this.sessions.delete(terminal);
    }
  }
}
