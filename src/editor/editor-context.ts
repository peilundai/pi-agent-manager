import type { EditorSelectionContext } from "./selection";

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

/** Captures the selection, or the current line when nothing is selected. */
export function selectionFromEditor(editor: EditorSelectionSource, relativePath: string): EditorSelectionContext {
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
  const endLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
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

/** Picks the folder of the active editor, or the only folder of a single-root window. */
export function resolveWorkspaceFolder<TFolder, TUri>(
  workspace: WorkspaceBoundary<TFolder, TUri>,
  activeEditor?: { document: { uri: TUri } },
): TFolder | undefined {
  const activeFolder = activeEditor ? workspace.getWorkspaceFolder(activeEditor.document.uri) : undefined;
  if (activeFolder) return activeFolder;
  return workspace.workspaceFolders?.[0];
}

/** Clamps a requested zero-based position to the document bounds. */
export function boundFilePosition(
  target: { line?: number; column?: number },
  document: { lineCount: number; lineAt(line: number): { text: string } },
): { line: number; column: number } {
  const line = Math.min(Math.max(target.line ?? 0, 0), Math.max(document.lineCount - 1, 0));
  const column = Math.min(Math.max(target.column ?? 0, 0), document.lineAt(line).text.length);
  return { line, column };
}

/** Case-insensitive fuzzy match used for @-mention file search. Lower score is better. */
export function fuzzyScore(path: string, query: string): number | undefined {
  if (!query) return path.length;
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  const base = haystack.slice(haystack.lastIndexOf("/") + 1);
  if (base.startsWith(needle)) return base.length - needle.length;
  const contiguous = haystack.indexOf(needle);
  if (contiguous !== -1) return 100 + contiguous;
  let position = 0;
  let gaps = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found === -1) return undefined;
    gaps += found - position;
    position = found + 1;
  }
  return 1_000 + gaps;
}

export function searchFiles(files: readonly string[], query: string, limit = 20): string[] {
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const score = fuzzyScore(path, query.trim());
    if (score !== undefined) scored.push({ path, score });
  }
  scored.sort((left, right) => left.score - right.score || left.path.localeCompare(right.path));
  return scored.slice(0, limit).map((entry) => entry.path);
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function imageMimeType(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return IMAGE_MIME[extension];
}
