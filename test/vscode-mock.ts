/**
 * Minimal, controllable stand-in for the `vscode` module (aliased in vitest.config.ts).
 * Every API is a `vi.fn()`; call `resetVscodeMock()` in `beforeEach` to restore defaults.
 */
import { vi } from "vitest";

export class Uri {
  constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {}

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

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export const configuration = new Map<string, unknown>();

function disposable() {
  return { dispose: vi.fn() };
}

export const window = {
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor: vi.fn(),
  registerWebviewViewProvider: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  showOpenDialog: vi.fn(),
  createOutputChannel: vi.fn(),
  showTextDocument: vi.fn(),
};

export const workspace = {
  workspaceFolders: undefined as unknown,
  onDidChangeWorkspaceFolders: vi.fn(),
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
};

export const env = {
  openExternal: vi.fn(),
};

export function resetVscodeMock(): void {
  configuration.clear();
  window.activeTextEditor = undefined;
  window.onDidChangeActiveTextEditor.mockReset().mockImplementation(disposable);
  window.registerWebviewViewProvider.mockReset().mockImplementation(disposable);
  window.showInformationMessage.mockReset().mockResolvedValue(undefined);
  window.showWarningMessage.mockReset().mockResolvedValue(undefined);
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
  env.openExternal.mockReset().mockResolvedValue(true);
}

resetVscodeMock();
