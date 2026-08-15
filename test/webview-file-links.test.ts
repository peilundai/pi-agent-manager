import { describe, expect, it } from "vitest";
import {
  fileLinksForBuffer,
  type TerminalBuffer,
  type TerminalBufferLine,
} from "../src/webview/file-links";

function buffer(...rows: Array<{ text: string; wrapped?: boolean }>): TerminalBuffer {
  const lines: TerminalBufferLine[] = rows.map((row) => ({
    isWrapped: row.wrapped ?? false,
    translateToString: () => row.text,
  }));
  return { getLine: (index) => lines[index] };
}

describe("fileLinksForBuffer", () => {
  it("uses an inclusive end cell without overrunning the target", () => {
    expect(fileLinksForBuffer(buffer({ text: "src/a.ts:2" }), 1)).toEqual([{
      text: "src/a.ts:2",
      range: {
        start: { x: 1, y: 1 },
        end: { x: 10, y: 1 },
      },
    }]);
  });

  it("joins wrapped rows and returns a multi-row file link from either row", () => {
    const wrapped = buffer(
      { text: "prefix src/very/" },
      { text: "long/file.ts:42:7", wrapped: true },
    );
    const expected = [{
      text: "src/very/long/file.ts:42:7",
      range: {
        start: { x: 8, y: 1 },
        end: { x: 17, y: 2 },
      },
    }];

    expect(fileLinksForBuffer(wrapped, 1)).toEqual(expected);
    expect(fileLinksForBuffer(wrapped, 2)).toEqual(expected);
  });

  it("maps a link that crosses exactly at a row boundary", () => {
    expect(fileLinksForBuffer(buffer(
      { text: " src/a.t" },
      { text: "s:2 tail", wrapped: true },
    ), 2)).toEqual([{
      text: "src/a.ts:2",
      range: {
        start: { x: 2, y: 1 },
        end: { x: 3, y: 2 },
      },
    }]);
  });
});
