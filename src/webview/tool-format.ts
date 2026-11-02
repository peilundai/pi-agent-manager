import type { ToolState } from "./chat-state";

export interface ToolDescription {
  verb: string;
  target: string;
  /** Workspace path the target refers to, when it can be opened. */
  path?: string;
  line?: number;
}

export interface DiffRow {
  kind: "add" | "del" | "ctx" | "skip";
  line?: number;
  text: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstLine(value: string, max = 120): string {
  const line = value.split("\n", 1)[0] ?? "";
  const more = value.includes("\n") ? " …" : "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : `${line}${more}`;
}

export function displayPath(path: string, workspaceRoot?: string): string {
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`)) return path.slice(workspaceRoot.length + 1);
  return path;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function describeTool(tool: Pick<ToolState, "name" | "args">): ToolDescription {
  const args = tool.args;
  const path = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
  switch (tool.name) {
    case "read": {
      const offset = num(args.offset);
      const limit = num(args.limit);
      const range = offset !== undefined || limit !== undefined
        ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
        : "";
      return { verb: "Read", target: `${path ?? "file"}${range}`, ...(path ? { path } : {}), ...(offset ? { line: offset - 1 } : {}) };
    }
    case "write":
      return { verb: "Write", target: path ?? "file", ...(path ? { path } : {}) };
    case "edit":
      return { verb: "Edit", target: path ?? "file", ...(path ? { path } : {}) };
    case "bash":
    case "powershell":
      return { verb: tool.name === "bash" ? "Bash" : "PowerShell", target: firstLine(str(args.command) ?? "") };
    case "grep": {
      const where = str(args.path) ?? str(args.glob);
      return { verb: "Search", target: `"${str(args.pattern) ?? ""}"${where ? ` in ${where}` : ""}` };
    }
    case "find":
      return { verb: "Find", target: `${str(args.pattern) ?? ""}${str(args.path) ? ` in ${str(args.path)}` : ""}` };
    case "ls":
      return { verb: "List", target: str(args.path) ?? "." };
    default: {
      const firstString = Object.values(args).find((value): value is string => typeof value === "string" && value.length > 0);
      return { verb: capitalize(tool.name.replace(/[_-]+/g, " ")), target: firstString ? firstLine(firstString, 80) : "" };
    }
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/** The one-line "⎿" result summary shown under a finished tool. */
export function summarizeTool(tool: ToolState): string | undefined {
  if (tool.status === "streaming") return undefined;
  if (tool.status === "running") return tool.name === "bash" ? "Running…" : undefined;
  if (tool.status === "interrupted") return "Interrupted";
  if (tool.status === "error") return firstLine(tool.output || "Failed", 160);
  switch (tool.name) {
    case "read": {
      const lines = countLines(tool.output);
      return lines ? `Read ${plural(lines, "line")}` : "Read";
    }
    case "write": {
      const lines = countLines(str(tool.args.content) ?? "");
      return `Wrote ${plural(lines, "line")}`;
    }
    case "edit": {
      const rows = parsePiDiff(str(tool.details?.diff) ?? "");
      const added = rows.filter((row) => row.kind === "add").length;
      const removed = rows.filter((row) => row.kind === "del").length;
      if (!added && !removed) return "Applied edit";
      const parts = [];
      if (added) parts.push(`Added ${plural(added, "line")}`);
      if (removed) parts.push(`${added ? "removed" : "Removed"} ${plural(removed, "line")}`);
      return parts.join(", ");
    }
    case "bash":
    case "powershell": {
      const lines = countLines(tool.output.trim());
      return lines ? plural(lines, "line") + " of output" : "No output";
    }
    case "grep":
    case "find":
    case "ls": {
      const text = tool.output.trim();
      if (!text || /^no (files|matches)/i.test(text)) return "No results";
      return plural(countLines(text), "result");
    }
    default:
      return tool.output ? firstLine(tool.output, 120) : "Done";
  }
}

const DIFF_LINE = /^([+\- ])(\s*\d*) (.*)$/;

/** Parses the line-numbered diff Pi's edit tool returns in `details.diff`. */
export function parsePiDiff(diff: string): DiffRow[] {
  if (!diff) return [];
  const rows: DiffRow[] = [];
  for (const raw of diff.split("\n")) {
    const match = DIFF_LINE.exec(raw);
    if (!match) {
      if (raw.trim()) rows.push({ kind: "ctx", text: raw });
      continue;
    }
    const [, sign, number, text = ""] = match;
    const line = number?.trim() ? Number(number.trim()) : undefined;
    if (sign === " " && line === undefined && text.trim() === "...") {
      rows.push({ kind: "skip", text: "…" });
      continue;
    }
    rows.push({ kind: sign === "+" ? "add" : sign === "-" ? "del" : "ctx", ...(line !== undefined ? { line } : {}), text });
  }
  return rows;
}

/** Fallback diff for edits without `details.diff`: old text removed, new text added. */
export function editArgsDiff(args: Record<string, unknown>): DiffRow[] {
  const edits = Array.isArray(args.edits)
    ? args.edits
    : str(args.oldText) !== undefined || str(args.newText) !== undefined
      ? [{ oldText: args.oldText, newText: args.newText }]
      : [];
  const rows: DiffRow[] = [];
  edits.forEach((edit: Record<string, unknown>, index: number) => {
    if (index > 0) rows.push({ kind: "skip", text: "…" });
    for (const line of (str(edit?.oldText) ?? "").split("\n")) rows.push({ kind: "del", text: line });
    for (const line of (str(edit?.newText) ?? "").split("\n")) rows.push({ kind: "add", text: line });
  });
  return rows;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  swift: "swift",
  sh: "bash",
  zsh: "bash",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "xml",
  xml: "xml",
  sql: "sql",
  lua: "lua",
};

export function languageForPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension];
}
