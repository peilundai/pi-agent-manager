import { describe, expect, it } from "vitest";
import { boundFilePosition, fuzzyScore, imageMimeType, resolveWorkspaceFolder, searchFiles, selectionFromEditor } from "../src/editor/editor-context";

function editor(selection: { isEmpty: boolean; start: number; end: number; endCharacter?: number; active?: number }) {
  return {
    document: {
      uri: { scheme: "file" },
      fileName: "/w/a.ts",
      languageId: "typescript",
      lineAt: (line: number) => ({ text: `line ${line}` }),
      getText: () => "selected",
    },
    selection: {
      isEmpty: selection.isEmpty,
      active: { line: selection.active ?? selection.start },
      start: { line: selection.start },
      end: { line: selection.end, character: selection.endCharacter ?? 3 },
    },
  };
}

describe("editor context", () => {
  it("uses the current line for an empty selection", () => {
    expect(selectionFromEditor(editor({ isEmpty: true, start: 4, end: 4 }), "a.ts")).toMatchObject({ startLine: 4, endLine: 4, text: "line 4" });
  });

  it("excludes a trailing line selected only at column zero", () => {
    expect(selectionFromEditor(editor({ isEmpty: false, start: 2, end: 5, endCharacter: 0 }), "a.ts")).toMatchObject({ startLine: 2, endLine: 4, text: "selected" });
  });

  it("resolves the workspace folder", () => {
    const workspace = { workspaceFolders: ["one", "two"], getWorkspaceFolder: (uri: string) => (uri === "in-two" ? "two" : undefined) };
    expect(resolveWorkspaceFolder(workspace, { document: { uri: "in-two" } })).toBe("two");
    expect(resolveWorkspaceFolder(workspace)).toBe("one");
    expect(resolveWorkspaceFolder({ workspaceFolders: undefined, getWorkspaceFolder: () => undefined })).toBeUndefined();
  });

  it("clamps file positions", () => {
    const document = { lineCount: 3, lineAt: () => ({ text: "abc" }) };
    expect(boundFilePosition({ line: 99, column: 99 }, document)).toEqual({ line: 2, column: 3 });
  });

  it("ranks file matches by basename, substring and fuzzy order", () => {
    const files = ["src/app.ts", "src/components/AppHeader.tsx", "docs/apple.md", "lib/a_p_p.js"];
    expect(searchFiles(files, "app")).toEqual(["src/app.ts", "docs/apple.md", "src/components/AppHeader.tsx", "lib/a_p_p.js"]);
    expect(fuzzyScore("src/app.ts", "zzz")).toBeUndefined();
    expect(searchFiles(files, "", 2)).toHaveLength(2);
  });

  it("detects supported image types", () => {
    expect(imageMimeType("/x/shot.PNG")).toBe("image/png");
    expect(imageMimeType("/x/a.svg")).toBeUndefined();
  });
});
