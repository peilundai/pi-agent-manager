import { describe, expect, it } from "vitest";
import {
  formatEditorSelection,
  isSupportedDocumentScheme,
} from "../src/editor/selection";

describe("formatEditorSelection", () => {
  it("formats selected code with a one-based range", () => {
    const text = formatEditorSelection({
      scheme: "file",
      relativePath: "src/auth.ts",
      languageId: "typescript",
      startLine: 7,
      endLine: 11,
      text: "export function refresh() {}",
    });
    expect(text).toBe(
      "From `src/auth.ts` lines 8-12:\n\n```typescript\nexport function refresh() {}\n```\n\n",
    );
  });

  it("uses a longer fence when source contains backticks", () => {
    expect(
      formatEditorSelection({
        scheme: "file",
        relativePath: "README.md",
        languageId: "markdown",
        startLine: 0,
        endLine: 0,
        text: "```ts\nconst nested = true;\n```",
      }),
    ).toContain("````markdown\n```ts\nconst nested = true;\n```\n````");
  });

  it("normalizes CRLF while preserving source whitespace", () => {
    expect(
      formatEditorSelection({
        scheme: "untitled",
        relativePath: "Untitled-1",
        languageId: "plaintext",
        startLine: 0,
        endLine: 1,
        text: "  first\r\n\tsecond  ",
      }),
    ).toContain("  first\n\tsecond  \n```");
  });

  it("rejects oversized or terminal-control-bearing text", () => {
    const base = {
      scheme: "file",
      relativePath: "src/a.ts",
      languageId: "typescript",
      startLine: 0,
      endLine: 0,
    } as const;
    expect(() => formatEditorSelection({ ...base, text: "x".repeat(524_289) })).toThrow(/too large/i);
    expect(() => formatEditorSelection({ ...base, text: "safe\u0000unsafe" })).toThrow(/control/i);
    expect(() => formatEditorSelection({ ...base, text: "safe\u001b[201~unsafe" })).toThrow(/control/i);
  });
});

describe("isSupportedDocumentScheme", () => {
  it("accepts editable workspace schemes only", () => {
    expect(["file", "untitled", "vscode-remote"].map(isSupportedDocumentScheme)).toEqual([true, true, true]);
    expect(isSupportedDocumentScheme("git")).toBe(false);
  });
});
