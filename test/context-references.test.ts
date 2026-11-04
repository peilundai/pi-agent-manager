import { describe, expect, it } from "vitest";
import { formatEditorSelection, selectionLabel } from "../src/editor/selection";
import { expandReferences, parseReferencedPrompt } from "../src/shared/context-references";

function reference(relativePath: string, startLine: number, endLine: number, text: string) {
  const context = { scheme: "file", relativePath, languageId: "typescript", startLine, endLine, text };
  return { label: selectionLabel(context), text: formatEditorSelection(context) };
}

describe("parseReferencedPrompt", () => {
  it("recovers the message and every reference from an expanded prompt", () => {
    const a = reference("src/a.ts", 42, 47, "const a = 1;\n\nFrom `fake` line 1:\n```nested```");
    const b = reference("we`ird.ts", 4, 4, "");
    const sent = expandReferences("Compare @src/a.ts#43-48\nwith @we`ird.ts#5", [a, b]);
    const parsed = parseReferencedPrompt(sent);
    expect(parsed.message).toBe("Compare @src/a.ts#43-48\nwith @we`ird.ts#5");
    expect(parsed.references).toEqual([
      { label: "@src/a.ts#43-48", text: a.text, path: "src/a.ts", startLine: 43, endLine: 48, code: "const a = 1;\n\nFrom `fake` line 1:\n```nested```" },
      { label: "@we`ird.ts#5", text: b.text, path: "we`ird.ts", startLine: 5, endLine: 5, code: "" },
    ]);
    // Re-expanding a recalled prompt sends the same text again.
    expect(expandReferences(parsed.message, parsed.references)).toBe(sent);
  });

  it("leaves prompts without matching chips unchanged", () => {
    const block = reference("src/a.ts", 0, 0, "x").text.trim();
    for (const text of [`${block}\n\nexplain`, `explain this\n\n${block}`, `see @src/a.ts#1\n\n${block}\n\ntrailing words`, "plain"]) {
      expect(parseReferencedPrompt(text)).toEqual({ message: text, references: [] });
    }
  });
});
