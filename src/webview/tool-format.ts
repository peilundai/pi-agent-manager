import type { ToolState } from "./chat-state";
import type { ToolExpansion } from "../shared/protocol";

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
    case "codemode": {
      const line = scriptSource(args).split("\n").find((text) => text.trim()) ?? "";
      return { verb: "Codemode", target: firstLine(line.trim(), 120) };
    }
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

const SHELL_STATUS = /(?:^|\n\n)(Command (?:exited with code -?\d+|timed out after [^\n]+|aborted|terminated without an exit code))\s*$/;

/**
 * Splits the status line Pi appends to a failed shell command ("Command exited with code 128")
 * from the command's own output, which is usually ordinary stdout rather than an error.
 */
export function splitShellStatus(output: string): { body: string; status?: string } {
  const match = SHELL_STATUS.exec(output);
  if (!match) return { body: output };
  return { body: output.slice(0, match.index), status: match[1]! };
}

function shellStatusSummary(status: string): string {
  const code = /^Command exited with code (-?\d+)$/.exec(status)?.[1];
  return code !== undefined ? `Exit code ${code}` : capitalize(status.replace(/^Command /, ""));
}

/** The one-line "⎿" result summary shown under a finished tool. */
export function summarizeTool(tool: ToolState): string | undefined {
  if (tool.status === "streaming") return undefined;
  if (tool.status === "running") return tool.name === "bash" ? "Running…" : undefined;
  if (tool.status === "interrupted") return "Interrupted";
  if (tool.status === "error") {
    const status = tool.name === "bash" || tool.name === "powershell" ? splitShellStatus(tool.output).status : undefined;
    return status ? shellStatusSummary(status) : firstLine(tool.output || "Failed", 160);
  }
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
      const { added, removed } = diffStats(tool) ?? { added: 0, removed: 0 };
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

export interface DiffStats {
  added: number;
  removed: number;
}

/** Rows of the diff an edit or write tool shows, from Pi's diff when present. */
export function toolDiffRows(tool: Pick<ToolState, "name" | "args" | "details">): DiffRow[] {
  if (tool.name === "edit") {
    const rows = parsePiDiff(str(tool.details?.diff) ?? "");
    return rows.length ? rows : editArgsDiff(tool.args);
  }
  if (tool.name === "write" && typeof tool.args.content === "string") {
    return tool.args.content
      .replace(/\n$/, "")
      .split("\n")
      .map((text, index) => ({ kind: "add", line: index + 1, text }));
  }
  return [];
}

/** Added and removed line counts for an edit or write, or undefined for other tools. */
export function diffStats(tool: Pick<ToolState, "name" | "args" | "details">): DiffStats | undefined {
  if (tool.name !== "edit" && tool.name !== "write") return undefined;
  let added = 0;
  let removed = 0;
  for (const row of toolDiffRows(tool)) {
    if (row.kind === "add") added++;
    else if (row.kind === "del") removed++;
  }
  return added || removed ? { added, removed } : undefined;
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

const OPTIONS_LINE = /^\s*\/\/\s*@options:/;

/** A codemode script without its `// @options:` line, which only tunes limits. */
export function scriptSource(args: Record<string, unknown>): string {
  const code = str(args.code) ?? "";
  const [first = "", ...rest] = code.split("\n");
  return (OPTIONS_LINE.test(first) ? rest.join("\n") : code).replace(/^\n+/, "").replace(/\s+$/, "");
}

const MAX_TREE_DEPTH = 16;

/** The calls `tool` made, then the calls those made, depth first. */
export function descendants(tool: ToolState, tools: Record<string, ToolState>): ToolState[] {
  const found: ToolState[] = [];
  const seen = new Set<string>([tool.id]);
  const visit = (parent: ToolState, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) return;
    for (const id of parent.children ?? []) {
      const child = tools[id];
      if (!child || seen.has(id)) continue;
      seen.add(id);
      found.push(child);
      visit(child, depth + 1);
    }
  };
  visit(tool, 0);
  return found;
}

/** Lines changed by the edits and writes among a tool's nested calls that were applied. */
export function nestedDiffStats(tool: ToolState, tools: Record<string, ToolState>): DiffStats | undefined {
  let added = 0;
  let removed = 0;
  for (const child of descendants(tool, tools)) {
    if (child.status !== "success" && child.status !== "running") continue;
    const stats = diffStats(child);
    added += stats?.added ?? 0;
    removed += stats?.removed ?? 0;
  }
  return added || removed ? { added, removed } : undefined;
}

/** Whether a tool's card starts open under the `toolExpansion` setting. */
export function autoExpands(tool: ToolState, tools: Record<string, ToolState>, expansion: ToolExpansion): boolean {
  if (expansion === "all") return true;
  if (expansion !== "edits") return false;
  // An edit opens to show its diff; a tool whose calls made edits opens so those diffs are visible too.
  return tool.name === "edit" || descendants(tool, tools).some((child) => child.name === "edit");
}

/** The "⎿" summary of a tool that made calls: its own result, the call count and failures. */
export function summarizeCalls(tool: ToolState, tools: Record<string, ToolState>): string | undefined {
  const calls = (tool.children ?? []).map((id) => tools[id]).filter((child): child is ToolState => Boolean(child));
  if (!calls.length) return summarizeTool(tool);
  if (tool.status === "running") {
    const current = [...calls].reverse().find((child) => child.status === "running");
    return current ? `${describeTool(current).verb}…` : `${plural(calls.length, "tool call")}…`;
  }
  const failed = calls.filter((child) => child.status === "error").length;
  const own = tool.name === "codemode" ? (tool.status === "error" ? "Script failed" : tool.status === "interrupted" ? "Interrupted" : undefined) : summarizeTool(tool);
  return [own, plural(calls.length, "tool call"), failed ? `${failed} failed` : undefined].filter(Boolean).join(" · ");
}
