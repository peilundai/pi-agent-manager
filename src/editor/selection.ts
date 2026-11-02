const MAX_SELECTION_BYTES = 512 * 1_024;
const SUPPORTED_SCHEMES = new Set(["file", "untitled", "vscode-remote"]);

export interface EditorSelectionContext {
  scheme: string;
  relativePath: string;
  languageId: string;
  startLine: number;
  endLine: number;
  text: string;
}

export function isSupportedDocumentScheme(scheme: string): boolean {
  return SUPPORTED_SCHEMES.has(scheme);
}

function hasUnsafeTerminalControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

function markdownFence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function languageTag(languageId: string): string {
  return languageId.replace(/[^a-z0-9_+-]/gi, "") || "text";
}

export function formatEditorSelection(context: EditorSelectionContext): string {
  if (!isSupportedDocumentScheme(context.scheme)) {
    throw new Error(`Unsupported editor document scheme: ${context.scheme}`);
  }
  if (
    !Number.isInteger(context.startLine) ||
    !Number.isInteger(context.endLine) ||
    context.startLine < 0 ||
    context.endLine < context.startLine
  ) {
    throw new Error("Invalid editor selection line range.");
  }
  if (!context.relativePath || context.relativePath.length > 16_384) {
    throw new Error("Invalid editor document path.");
  }
  if (hasUnsafeTerminalControl(context.relativePath) || hasUnsafeTerminalControl(context.text)) {
    throw new Error("Editor selection contains an unsafe terminal control character.");
  }
  if (Buffer.byteLength(context.text, "utf8") > MAX_SELECTION_BYTES) {
    throw new Error("Editor selection is too large to send to Pi.");
  }

  const text = context.text.replace(/\r\n?/g, "\n");
  const fence = markdownFence(text);
  const start = context.startLine + 1;
  const end = context.endLine + 1;
  const location = start === end ? `line ${start}` : `lines ${start}-${end}`;
  const path = context.relativePath.replace(/`/g, "\\`");
  return `From \`${path}\` ${location}:\n\n${fence}${languageTag(context.languageId)}\n${text}\n${fence}\n\n`;
}
