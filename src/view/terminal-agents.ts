import { randomUUID } from "node:crypto";
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

/**
 * The terminal tab title: "Pi Agent" for the first terminal, "Pi Agent 2" and
 * so on for the others, plus the folder name in multi-root windows.
 */
export function terminalTitle(folderName?: string, number = 1): string {
  const base = number > 1 ? `${DEFAULT_AGENT_TITLE} ${number}` : DEFAULT_AGENT_TITLE;
  if (!folderName) return base;
  const title = `${base}: ${folderName}`;
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

/** workspaceState key: the open Pi terminals, oldest-used first, reopened after a reload. */
export const TERMINAL_AGENTS_KEY = "piAgentManager.terminalAgents";

/** One open Pi terminal, as saved in workspaceState. */
export interface StoredTerminalAgent {
  /** The Pi session the terminal runs, passed as `--session-id`. */
  sessionId: string;
  /** Pi's working directory. */
  folder: string;
  /** Workspace folder name, shown in the tab title in multi-root windows. */
  name?: string;
  /** The editor group the terminal was in. */
  viewColumn: number;
  /** The tab's number: 1 is "Pi Agent", 2 is "Pi Agent 2", and so on. */
  number?: number;
}

function isStoredTerminalAgent(value: unknown): value is StoredTerminalAgent {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sessionId === "string" &&
    entry.sessionId.length > 0 &&
    typeof entry.folder === "string" &&
    typeof entry.viewColumn === "number" &&
    (entry.name === undefined || typeof entry.name === "string") &&
    (entry.number === undefined || (typeof entry.number === "number" && Number.isInteger(entry.number) && entry.number >= 1))
  );
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
  /** Pi's session for this terminal, so a reload can reopen it. */
  sessionId: string;
  /** Tells same-folder tabs apart: "Pi Agent", "Pi Agent 2", … */
  number: number;
  folder: TerminalFolder;
  viewColumn: number;
  lastUsed: number;
}

export interface TerminalAgentsOptions {
  extensionUri: vscode.Uri;
  /** Where the open terminals are saved (workspaceState), so a reload can reopen them. */
  memento?: Pick<vscode.Memento, "get" | "update">;
  /** Test seam: new Pi session IDs. */
  createSessionId?: () => string;
  /** Builds Pi's environment (login shell, settings, secrets); defaults to VS Code's own. */
  environment?: Pick<PiEnvironment, "resolve" | "checkMissing">;
  /** Test seam: replaces locating the real `pi` executable. */
  resolveCommand?: typeof resolvePiCommand;
  platform?: NodeJS.Platform;
}

/**
 * Pi agents in editor-area terminals, as in pi-tabs. Each terminal runs plain
 * interactive `pi` (not `--mode rpc`) in a workspace folder with its own Pi
 * session (`--session-id`), so there is no webview, no session history UI and
 * no relay. VS Code does not restore the terminals itself (they are transient),
 * because a restored terminal would not be running Pi. Instead the open ones
 * are saved in workspaceState and `restore()` reopens each in its folder and
 * editor group with the same session after a reload.
 */
export class TerminalAgents implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, TerminalSession>();
  private readonly listeners: vscode.Disposable[] = [];
  private sequence = 0;
  /** Set once the window starts shutting down or reloading: the saved list must then stay as it is for `restore()`. */
  private shuttingDown = false;

  constructor(private readonly options: TerminalAgentsOptions) {
    this.listeners.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        // A window reload or shutdown also closes the terminals: keep them saved so they come back.
        if (this.closedByShutdown(terminal)) return;
        if (this.sessions.delete(terminal)) this.persist();
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
   * a fresh one in each folder, with the reloaded environment and the same Pi
   * session. Does nothing when no Pi terminal is open.
   */
  async restartAll(): Promise<void> {
    this.pruneSessions();
    const previous = this.orderedSessions().map(({ sessionId, folder, number }) => ({ sessionId, folder, number }));
    for (const { terminal } of this.sessions.values()) terminal.dispose();
    this.sessions.clear();
    // Sequential, so the last one opened (and focused) is the one used last.
    for (const { sessionId, folder, number } of previous) await this.createSession(folder, { sessionId, number });
    this.persist();
  }

  /**
   * After a window reload: reopens every saved Pi terminal in its folder and
   * editor group, running the same Pi session, in the order they were last
   * used, so the last one used ends up focused. Entries whose folder is no
   * longer in the workspace are dropped.
   */
  async restore(): Promise<void> {
    const stored = this.storedAgents();
    if (stored.length === 0) return;
    const folders = new Map((vscode.workspace.workspaceFolders ?? []).map((folder) => [folder.uri.fsPath, folder]));
    const multiRoot = folders.size > 1;
    for (const entry of stored) {
      const folder = folders.get(entry.folder);
      if (!folder) continue;
      const open = [...this.sessions.values()].some((session) => session.sessionId === entry.sessionId);
      if (open) continue;
      await this.createSession(
        { path: folder.uri.fsPath, name: multiRoot ? folder.name : undefined },
        { sessionId: entry.sessionId, viewColumn: entry.viewColumn, ...(entry.number ? { number: entry.number } : {}) },
      );
    }
    this.persist();
  }

  dispose(): void {
    for (const listener of this.listeners.splice(0)) listener.dispose();
    // Not persisted: on shutdown the saved list must survive for `restore()`.
    this.shuttingDown = true;
    this.sessions.clear();
  }

  private storedAgents(): StoredTerminalAgent[] {
    const value = this.options.memento?.get<unknown>(TERMINAL_AGENTS_KEY);
    return Array.isArray(value) ? value.filter(isStoredTerminalAgent) : [];
  }

  private orderedSessions(): TerminalSession[] {
    return [...this.sessions.values()].sort((left, right) => left.lastUsed - right.lastUsed);
  }

  /** Saves the open terminals, oldest-used first. */
  private persist(): void {
    const memento = this.options.memento;
    if (!memento || this.shuttingDown) return;
    const entries: StoredTerminalAgent[] = this.orderedSessions().map(({ sessionId, folder, viewColumn, number }) => ({
      sessionId,
      folder: folder.path,
      ...(folder.name ? { name: folder.name } : {}),
      viewColumn,
      number,
    }));
    void Promise.resolve(memento.update(TERMINAL_AGENTS_KEY, entries)).catch(() => undefined);
  }

  private defaultFolder(): TerminalFolder | undefined {
    const folder = resolveWorkspaceFolder(vscode.workspace, vscode.window.activeTextEditor);
    if (!folder) return undefined;
    return { path: folder.uri.fsPath, name: (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? folder.name : undefined };
  }

  private async createSession(
    target = this.defaultFolder(),
    reopen: { sessionId?: string; viewColumn?: number; number?: number } = {},
  ): Promise<TerminalSession | undefined> {
    if (!target) {
      void vscode.window.showErrorMessage("Open a workspace folder to start Pi in a terminal.");
      return undefined;
    }
    const environment = (await this.options.environment?.resolve().catch(() => undefined)) ?? process.env;
    const config = vscode.workspace.getConfiguration("piAgentManager");
    const platform = this.options.platform ?? process.platform;
    const sessionId = reopen.sessionId ?? (this.options.createSessionId ?? randomUUID)();
    let commandPath: string;
    let args: string[];
    try {
      const extraArgs = config.get<unknown>("extraArgs", []);
      args = buildTerminalArgs(
        Array.isArray(extraArgs) ? extraArgs.filter((value): value is string => typeof value === "string") : [],
        sessionId,
      );
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
    const viewColumn = reopen.viewColumn ?? this.targetViewColumn();
    const number = reopen.number ?? this.nextNumber();
    const terminal = vscode.window.createTerminal({
      name: terminalTitle(target.name, number),
      cwd: target.path,
      env,
      iconPath: {
        light: vscode.Uri.joinPath(this.options.extensionUri, "media", "pi-light.svg"),
        dark: vscode.Uri.joinPath(this.options.extensionUri, "media", "pi-dark.svg"),
      },
      // VS Code would restore a plain shell, not Pi: `restore()` reopens it with Pi instead.
      isTransient: true,
      location: { viewColumn, preserveFocus: false },
      ...(launch.shellPath ? { shellPath: launch.shellPath, shellArgs: launch.shellArgs } : {}),
    });
    const session: TerminalSession = { terminal, sessionId, number, folder: target, viewColumn, lastUsed: ++this.sequence };
    this.sessions.set(terminal, session);
    terminal.show(false);
    // `ViewColumn.Beside` is a placement sentinel, not the concrete column VS Code
    // creates: rebind right after reveal so the next terminal reuses the same group.
    // Also saves the new terminal for `restore()`.
    this.rememberActiveSession(terminal);
    return session;
  }

  /** The lowest tab number no open Pi terminal uses, so closed numbers are reused. */
  private nextNumber(): number {
    this.pruneSessions();
    const used = new Set([...this.sessions.values()].map((session) => session.number));
    let number = 1;
    while (used.has(number)) number += 1;
    return number;
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
    this.persist();
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
    this.persist();
  }

  /** Still open and still running Pi; a terminal whose Pi exited with an error stays open but is not reused. */
  private isAlive(terminal: vscode.Terminal): boolean {
    return vscode.window.terminals.includes(terminal) && !terminal.exitStatus;
  }

  /** A terminal closed by a window reload or shutdown; from then on the saved list is left alone. */
  private closedByShutdown(terminal: vscode.Terminal): boolean {
    if (terminal.exitStatus?.reason !== vscode.TerminalExitReason.Shutdown) return false;
    this.shuttingDown = true;
    return true;
  }

  /**
   * Drops terminals VS Code closed without a close event we handled, and saves
   * the shorter list so `restore()` does not reopen them. Terminals closed by a
   * shutdown stop all saving instead (see `closedByShutdown`).
   */
  private pruneSessions(): void {
    let pruned = false;
    for (const terminal of this.sessions.keys()) {
      if (vscode.window.terminals.includes(terminal)) continue;
      this.closedByShutdown(terminal);
      this.sessions.delete(terminal);
      pruned = true;
    }
    if (pruned) this.persist();
  }
}
