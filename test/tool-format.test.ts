import { describe, expect, it } from "vitest";
import type { ToolState } from "../src/webview/chat-state";
import { describeTool, diffStats, editArgsDiff, languageForPath, parsePiDiff, splitShellStatus, summarizeTool } from "../src/webview/tool-format";

const tool = (overrides: Partial<ToolState>): ToolState => ({ id: "t", name: "read", args: {}, status: "success", output: "", ...overrides });

describe("tool formatting", () => {
  it("describes built-in tools", () => {
    expect(describeTool(tool({ name: "read", args: { path: "a.ts", offset: 10, limit: 5 } }))).toEqual({ verb: "Read", target: "a.ts:10-14", path: "a.ts", line: 9 });
    expect(describeTool(tool({ name: "bash", args: { command: "npm test\nnpm run lint" } }))).toEqual({ verb: "Bash", target: "npm test …" });
    expect(describeTool(tool({ name: "grep", args: { pattern: "TODO", path: "src" } }))).toEqual({ verb: "Search", target: '"TODO" in src' });
    expect(describeTool(tool({ name: "web_fetch", args: { url: "https://x.dev" } }))).toEqual({ verb: "Web fetch", target: "https://x.dev" });
  });

  it("summarizes results", () => {
    expect(summarizeTool(tool({ output: "a\nb\nc\n" }))).toBe("Read 3 lines");
    expect(summarizeTool(tool({ name: "edit", details: { diff: " 1 a\n-2 b\n+2 c\n+3 d" } }))).toBe("Added 2 lines, removed 1 line");
    expect(summarizeTool(tool({ name: "bash", status: "error", output: "command not found\nmore" }))).toBe("command not found …");
    expect(summarizeTool(tool({ status: "streaming" }))).toBeUndefined();
    expect(summarizeTool(tool({ name: "bash", status: "error", output: "/Users/me/work\n\nCommand exited with code 128" }))).toBe("Exit code 128");
    expect(summarizeTool(tool({ name: "bash", status: "error", output: "Command timed out after 30 seconds" }))).toBe("Timed out after 30 seconds");
    expect(summarizeTool(tool({ name: "powershell", status: "error", output: "partial\n\nCommand aborted" }))).toBe("Aborted");
    expect(summarizeTool(tool({ name: "grep", output: "No matches found" }))).toBe("No results");
  });

  it("separates Pi's shell status line from the command output", () => {
    expect(splitShellStatus("/Users/me\nfatal: not a git repository\n\nCommand exited with code 128")).toEqual({
      body: "/Users/me\nfatal: not a git repository",
      status: "Command exited with code 128",
    });
    expect(splitShellStatus("Command aborted")).toEqual({ body: "", status: "Command aborted" });
    expect(splitShellStatus("echo Command aborted")).toEqual({ body: "echo Command aborted" });
  });

  it("parses Pi's numbered diff format", () => {
    expect(parsePiDiff(" 1 keep\n-2 old\n+2 new\n   ...")).toEqual([
      { kind: "ctx", line: 1, text: "keep" },
      { kind: "del", line: 2, text: "old" },
      { kind: "add", line: 2, text: "new" },
      { kind: "skip", text: "…" },
    ]);
  });

  it("counts added and removed lines for edits and writes", () => {
    expect(diffStats(tool({ name: "edit", details: { diff: " 1 a\n-2 b\n+2 c\n+3 d" } }))).toEqual({ added: 2, removed: 1 });
    expect(diffStats(tool({ name: "edit", args: { oldText: "x\ny", newText: "z" } }))).toEqual({ added: 1, removed: 2 });
    expect(diffStats(tool({ name: "write", args: { content: "one\ntwo\n" } }))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(tool({ name: "bash" }))).toBeUndefined();
  });

  it("falls back to edit arguments", () => {
    expect(editArgsDiff({ edits: [{ oldText: "a", newText: "b" }] })).toEqual([
      { kind: "del", text: "a" },
      { kind: "add", text: "b" },
    ]);
    expect(editArgsDiff({ oldText: "x", newText: "y" })).toHaveLength(2);
  });

  it("maps file extensions to languages", () => {
    expect(languageForPath("src/a.tsx")).toBe("typescript");
    expect(languageForPath("Makefile")).toBeUndefined();
  });
});
