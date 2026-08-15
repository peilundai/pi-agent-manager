import type { ILink } from "@xterm/xterm";

export interface TerminalBufferLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface TerminalBuffer {
  getLine(index: number): TerminalBufferLine | undefined;
}

const FILE_LINK_PATTERN = /(?:^|\s)((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?[^\s"'`<>]+:\d+(?::\d+)?)/g;

function logicalLine(buffer: TerminalBuffer, bufferLineNumber: number): {
  startLine: number;
  rows: string[];
} | undefined {
  let startLine = bufferLineNumber - 1;
  const requested = buffer.getLine(startLine);
  if (!requested) return undefined;

  while (startLine > 0 && buffer.getLine(startLine)?.isWrapped) startLine -= 1;

  const rows: string[] = [];
  for (let index = startLine; ; index += 1) {
    const line = buffer.getLine(index);
    if (!line) break;
    rows.push(line.translateToString(false));
    if (!buffer.getLine(index + 1)?.isWrapped) break;
  }
  return { startLine, rows };
}

function positionForOffset(rows: readonly string[], startLine: number, offset: number): {
  x: number;
  y: number;
} {
  let remaining = offset;
  for (let row = 0; row < rows.length; row += 1) {
    const length = rows[row]?.length ?? 0;
    if (remaining < length || row === rows.length - 1) {
      return { x: remaining + 1, y: startLine + row + 1 };
    }
    remaining -= length;
  }
  return { x: 1, y: startLine + 1 };
}

export function fileLinksForBuffer(
  buffer: TerminalBuffer,
  bufferLineNumber: number,
): Array<Pick<ILink, "text" | "range">> {
  const logical = logicalLine(buffer, bufferLineNumber);
  if (!logical) return [];

  const text = logical.rows.join("");
  const links: Array<Pick<ILink, "text" | "range">> = [];
  for (const match of text.matchAll(FILE_LINK_PATTERN)) {
    const target = match[1];
    if (!target || match.index === undefined) continue;
    const startOffset = match.index + match[0].length - target.length;
    const endOffset = startOffset + target.length - 1;
    links.push({
      text: target,
      range: {
        start: positionForOffset(logical.rows, logical.startLine, startOffset),
        end: positionForOffset(logical.rows, logical.startLine, endOffset),
      },
    });
  }
  return links;
}
