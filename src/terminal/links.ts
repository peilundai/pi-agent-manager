import { posix, win32 } from "node:path";

export interface ResolvedFileTarget {
  path: string;
  line?: number;
  column?: number;
}

export type ParsedTerminalTarget =
  | { kind: "url"; target: string }
  | { kind: "file"; target: ResolvedFileTarget };

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function unwrap(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if (
    trimmed.length >= 2 &&
    ((first === "`" && last === "`") ||
      (first === "\"" && last === "\"") ||
      (first === "'" && last === "'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function httpUrl(value: string): string | undefined {
  const target = unwrap(value);
  if (hasControlCharacter(target)) return undefined;
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseCoordinates(value: string): { path: string; line?: number; column?: number } {
  const fragment = /^(.*)#L(\d+)(?::?C?(\d+))?$/i.exec(value);
  const lineAndColumn = /^(.*):(\d+):(\d+)$/.exec(value);
  const lineOnly = /^(.*):(\d+)$/.exec(value);
  const match = fragment ?? lineAndColumn ?? lineOnly;
  if (!match) return { path: value };

  const path = match[1] ?? "";
  const line = Number(match[2]);
  const column = match[3] === undefined ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(line) || line < 1) throw new Error("File link line must be at least 1.");
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) {
    throw new Error("File link column must be at least 1.");
  }
  return {
    path,
    line: line - 1,
    ...(column === undefined ? {} : { column: column - 1 }),
  };
}

export function resolveFileTarget(
  value: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedFileTarget {
  const target = unwrap(value);
  if (!target || hasControlCharacter(target)) {
    throw new Error("File link contains an invalid path or control character.");
  }
  const parsed = parseCoordinates(target);
  if (!parsed.path) throw new Error("File link path must not be empty.");
  const path = pathApi(platform);
  const resolved = path.isAbsolute(parsed.path) ? path.normalize(parsed.path) : path.resolve(cwd, parsed.path);
  return {
    path: resolved,
    ...(parsed.line === undefined ? {} : { line: parsed.line }),
    ...(parsed.column === undefined ? {} : { column: parsed.column }),
  };
}

export function parseTerminalTarget(
  value: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): ParsedTerminalTarget {
  const url = httpUrl(value);
  return url
    ? { kind: "url", target: url }
    : { kind: "file", target: resolveFileTarget(value, cwd, platform) };
}
