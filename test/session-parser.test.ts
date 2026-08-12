import { describe, expect, it } from "vitest";
import { parseSessionLines } from "../src/pi/session-parser";

describe("parseSessionLines", () => {
  it("uses the latest explicit name and tolerates a partial trailing line", () => {
    const parsed = parseSessionLines(
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          cwd: "/repo",
          timestamp: "2026-08-12T01:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          id: "a",
          parentId: null,
          timestamp: "2026-08-12T01:00:01.000Z",
          message: { role: "user", content: "Refactor the auth middleware", timestamp: 1 },
        }),
        JSON.stringify({
          type: "session_info",
          id: "b",
          parentId: "a",
          timestamp: "2026-08-12T01:00:02.000Z",
          name: "Old name",
        }),
        JSON.stringify({
          type: "session_info",
          id: "c",
          parentId: "b",
          timestamp: "2026-08-12T01:00:03.000Z",
          name: "Auth middleware cleanup",
        }),
        "{partial",
      ],
      "/sessions/session-1.jsonl",
      { mtimeMs: 20, birthtimeMs: 10 },
    );

    expect(parsed).toEqual({
      id: "session-1",
      path: "/sessions/session-1.jsonl",
      cwd: "/repo",
      title: "Auth middleware cleanup",
      explicitTitle: "Auth middleware cleanup",
      generatedTitle: "Refactor the auth middleware",
      createdAt: Date.parse("2026-08-12T01:00:00.000Z"),
      updatedAt: 20,
    });
  });

  it("derives a fallback from text content blocks after a cleared name", () => {
    const parsed = parseSessionLines(
      [
        JSON.stringify({ type: "session", version: 3, id: "session-2", cwd: "/repo" }),
        JSON.stringify({ type: "session_info", id: "a", parentId: null, timestamp: "x", name: "" }),
        JSON.stringify({
          type: "message",
          id: "b",
          parentId: "a",
          timestamp: "x",
          message: {
            role: "user",
            content: [
              { type: "image", data: "base64", mimeType: "image/png" },
              { type: "text", text: "Could you repair the metrics query?" },
            ],
            timestamp: 1,
          },
        }),
      ],
      "/sessions/session-2.jsonl",
      { mtimeMs: 40, birthtimeMs: 30 },
    );

    expect(parsed?.title).toBe("Repair the metrics query");
    expect(parsed?.explicitTitle).toBeUndefined();
    expect(parsed?.createdAt).toBe(30);
  });

  it("rejects a file without a valid session header", () => {
    expect(
      parseSessionLines([JSON.stringify({ type: "message", id: "a" })], "/sessions/bad.jsonl", {
        mtimeMs: 1,
        birthtimeMs: 1,
      }),
    ).toBeUndefined();
  });
});
