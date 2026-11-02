import { describe, expect, it } from "vitest";
import { parseFileReference } from "../src/webview/components/context";
import { splitMarkdownBlocks } from "../src/webview/components/Markdown";

describe("splitMarkdownBlocks", () => {
  it("splits on blank lines but keeps fenced code together", () => {
    expect(splitMarkdownBlocks("# Title\n\nPara one\nline two\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nEnd")).toEqual([
      "# Title",
      "Para one\nline two",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "End",
    ]);
  });

  it("keeps indented continuation lines with their list item", () => {
    expect(splitMarkdownBlocks("1. Item\n\n    nested code\n\nNext")).toEqual(["1. Item\n\n    nested code", "Next"]);
  });

  it("keeps an unterminated streaming fence in one block", () => {
    expect(splitMarkdownBlocks("Intro\n\n```py\nprint(1)\n\nprint(2)")).toEqual(["Intro", "```py\nprint(1)\n\nprint(2)"]);
  });
});

describe("parseFileReference", () => {
  it("recognizes workspace paths with optional lines", () => {
    expect(parseFileReference("src/app.ts:12")).toEqual({ path: "src/app.ts", line: 11 });
    expect(parseFileReference("README.md")).toEqual({ path: "README.md" });
    expect(parseFileReference("./lib/util.py:3-9")).toEqual({ path: "./lib/util.py", line: 2 });
  });

  it("ignores non-paths", () => {
    expect(parseFileReference("1.5.0")).toBeUndefined();
    expect(parseFileReference("npm run build")).toBeUndefined();
    expect(parseFileReference("https://x.dev/a.ts")).toBeUndefined();
    expect(parseFileReference("value")).toBeUndefined();
  });
});
