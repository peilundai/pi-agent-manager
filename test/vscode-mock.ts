/**
 * Minimal, controllable stand-in for the `vscode` module (aliased in vitest.config.ts).
 * Every API is a `vi.fn()`; call `resetVscodeMock()` in `beforeEach` to restore defaults.
 */
import { vi } from "vitest";

export class Uri {
  readonly authority: string = "";
  readonly query: string = "";
  readonly fragment: string = "";

  constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {}

  with(change: { scheme?: string; path?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.fsPath);
  }

  toJSON(): unknown {
    return { scheme: this.scheme, path: this.path };
  }

  get path(): string {
    return this.fsPath.split("\\").join("/");
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  static file(path: string): Uri {
    return new Uri("file", path);
  }

  static parse(value: string): Uri {
    const scheme = /^([a-z][\w+.-]*):/i.exec(value)?.[1] ?? "file";
    return new Uri(scheme, value);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.fsPath, ...segments].join("/"));
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 } as const;

export class TabInputTerminal {}

export class TabInputWebview {
  constructor(readonly viewType: string) {}
}

type Listener<T> = (value: T) => void;

/** A controllable `WebviewPanel`: `receive()` plays a webview message, `posted` collects host messages. */
export class MockWebviewPanel {
  title: string;
  iconPath: unknown;
  active = true;
  visible = true;
  disposed = false;
  readonly posted: unknown[] = [];
  readonly reveal = vi.fn();
  private readonly messageListeners = new Set<Listener<unknown>>();
  private readonly disposeListeners = new Set<Listener<void>>();
  private readonly viewStateListeners = new Set<Listener<unknown>>();
  readonly webview: {
    options: unknown;
    html: string;
    cspSource: string;
    asWebviewUri(uri: unknown): unknown;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage(listener: Listener<unknown>): { dispose(): void };
  };

  constructor(
    readonly viewType: string,
    title: string,
    readonly options: unknown = {},
  ) {
    this.title = title;
    this.webview = {
      options: undefined,
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri) => uri,
      postMessage: async (message) => {
        if (this.disposed) return false;
        this.posted.push(message);
        return true;
      },
      onDidReceiveMessage: (listener) => subscribe(this.messageListeners, listener),
    };
  }

  /** Delivers a message from the webview to the extension host. */
  receive(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message);
  }

  onDidDispose(listener: Listener<void>): { dispose(): void } {
    return subscribe(this.disposeListeners, listener);
  }

  onDidChangeViewState(listener: Listener<unknown>): { dispose(): void } {
    return subscribe(this.viewStateListeners, listener);
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const listener of [...this.viewStateListeners]) listener({ webviewPanel: this });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const listener of [...this.disposeListeners]) listener();
  }
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => void listeners.delete(listener) };
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export const configuration = new Map<string, unknown>();

/** A controllable `Terminal`: `sent` collects `sendText` calls, `show` is a `vi.fn()`. */
export class MockTerminal {
  exitStatus: { code: number | undefined } | undefined = undefined;
  disposed = false;
  readonly sent: Array<{ text: string; addNewLine: boolean }> = [];
  readonly show = vi.fn();
  readonly sendText = vi.fn((text: string, addNewLine = true) => {
    this.sent.push({ text, addNewLine });
  });

  constructor(
    readonly name: string,
    readonly options: unknown = {},
  ) {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const index = window.terminals.indexOf(this);
    if (index !== -1) window.terminals.splice(index, 1);
  }
}

function disposable() {
  return { dispose: vi.fn() };
}

export const window = {
  activeTextEditor: undefined as unknown,
  activeTerminal: undefined as unknown,
  terminals: [] as MockTerminal[],
  onDidChangeActiveTextEditor: vi.fn(),
  onDidChangeTextEditorSelection: vi.fn(),
  onDidChangeActiveTerminal: vi.fn(),
  onDidCloseTerminal: vi.fn(),
  registerWebviewViewProvider: vi.fn(),
  registerWebviewPanelSerializer: vi.fn(),
  createWebviewPanel: vi.fn(),
  /** Panels made by `createWebviewPanel`, in order. */
  panels: [] as MockWebviewPanel[],
  createTerminal: vi.fn(),
  tabGroups: {
    all: [] as Array<{ tabs: Array<{ input: unknown }> }>,
    activeTabGroup: { viewColumn: 1, activeTab: undefined as { input: unknown } | undefined },
  },
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  showOpenDialog: vi.fn(),
  createOutputChannel: vi.fn(),
  showTextDocument: vi.fn(),
};

export const workspace = {
  workspaceFolders: undefined as Array<{ name: string; index: number; uri: Uri }> | undefined,
  onDidChangeWorkspaceFolders: vi.fn(),
  onDidChangeConfiguration: vi.fn(),
  getWorkspaceFolder: vi.fn(),
  getConfiguration: vi.fn(),
  asRelativePath: vi.fn(),
  findFiles: vi.fn(),
  openTextDocument: vi.fn(),
  fs: { stat: vi.fn() },
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
  getCommands: vi.fn(),
};

export const env = {
  openExternal: vi.fn(),
};

export function resetVscodeMock(): void {
  configuration.clear();
  window.activeTextEditor = undefined;
  window.activeTerminal = undefined;
  window.terminals = [];
  window.onDidChangeActiveTextEditor.mockReset().mockImplementation(disposable);
  window.onDidChangeTextEditorSelection.mockReset().mockImplementation(disposable);
  window.onDidChangeActiveTerminal.mockReset().mockImplementation(disposable);
  window.onDidCloseTerminal.mockReset().mockImplementation(disposable);
  window.registerWebviewViewProvider.mockReset().mockImplementation(disposable);
  window.registerWebviewPanelSerializer.mockReset().mockImplementation(disposable);
  window.panels = [];
  window.createWebviewPanel.mockReset().mockImplementation((viewType: string, title: string, _column: unknown, options: unknown) => {
    const panel = new MockWebviewPanel(viewType, title, options);
    window.panels.push(panel);
    return panel;
  });
  window.createTerminal.mockReset().mockImplementation((options: { name?: string }) => {
    const terminal = new MockTerminal(options?.name ?? "Pi Agent", options);
    window.terminals.push(terminal);
    return terminal;
  });
  window.tabGroups = { all: [], activeTabGroup: { viewColumn: 1, activeTab: undefined } };
  window.showInformationMessage.mockReset().mockResolvedValue(undefined);
  window.showWarningMessage.mockReset().mockResolvedValue(undefined);
  window.showErrorMessage.mockReset().mockResolvedValue(undefined);
  window.showInputBox.mockReset().mockResolvedValue(undefined);
  window.showQuickPick.mockReset().mockResolvedValue(undefined);
  window.createOutputChannel.mockReset().mockImplementation(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }));
  window.showOpenDialog.mockReset().mockResolvedValue(undefined);
  window.showTextDocument.mockReset().mockResolvedValue(undefined);
  workspace.workspaceFolders = undefined;
  workspace.onDidChangeWorkspaceFolders.mockReset().mockImplementation(disposable);
  workspace.onDidChangeConfiguration.mockReset().mockImplementation(disposable);
  workspace.getWorkspaceFolder.mockReset().mockReturnValue(undefined);
  workspace.getConfiguration.mockReset().mockImplementation(() => ({
    get: (key: string, fallback?: unknown) => (configuration.has(key) ? configuration.get(key) : fallback),
    update: vi.fn(async (key: string, value: unknown) => {
      configuration.set(key, value);
    }),
  }));
  workspace.asRelativePath.mockReset().mockImplementation((uri: Uri) => uri.fsPath);
  workspace.findFiles.mockReset().mockResolvedValue([]);
  workspace.openTextDocument.mockReset().mockResolvedValue({ lineCount: 1, lineAt: () => ({ text: "" }) });
  workspace.fs.stat.mockReset().mockResolvedValue({});
  commands.registerCommand.mockReset().mockImplementation(disposable);
  commands.executeCommand.mockReset().mockResolvedValue(undefined);
  commands.getCommands.mockReset().mockResolvedValue(["workbench.view.extension.piAgentManager"]);
  env.openExternal.mockReset().mockResolvedValue(true);
}

resetVscodeMock();
