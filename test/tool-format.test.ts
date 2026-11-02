import { describe, expect, it } from "vitest";
import type { ToolState } from "../src/webview/chat-state";
import { describeTool, editArgsDiff, languageForPath, parsePiDiff, summarizeTool } from "../src/webview/tool-format";

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
    expect(summarizeTool(tool({ name: "grep", output: "No matches found" }))).toBe("No results");
  });

  it("parses Pi's numbered diff format", () => {
    expect(parsePiDiff(" 1 keep\n-2 old\n+2 new\n   ...")).toEqual([
      { kind: "ctx", line: 1, text: "keep" },
      { kind: "del", line: 2, text: "old" },
      { kind: "add", line: 2, text: "new" },
      { kind: "skip", text: "…" },
    ]);
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
