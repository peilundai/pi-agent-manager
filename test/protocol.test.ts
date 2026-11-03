import { describe, expect, it } from "vitest";
import { isHostMessage, isWebviewMessage } from "../src/shared/protocol";

describe("isWebviewMessage", () => {
  it("accepts valid messages", () => {
    expect(isWebviewMessage({ version: 1, type: "ready" })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "prompt", text: "hi", images: [], mode: "send" })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "prompt", text: "", images: [{ data: "AA", mimeType: "image/png" }], mode: "steer" })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "chat.open", path: "/s/a.jsonl" })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "thinking.set", level: "xhigh" })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "dialog.respond", response: { id: "d", confirmed: false } })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "dialog.respond", response: { id: "d", value: "" } })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "file.open", path: "src/a.ts", line: 3 })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "folder.pick" })).toBe(true);
  });

  it("rejects malformed or unsafe messages", () => {
    expect(isWebviewMessage({ version: 2, type: "ready" })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "prompt", text: "  ", images: [], mode: "send" })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "prompt", text: "hi", images: [{ data: "AA", mimeType: "image/svg+xml" }], mode: "send" })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "prompt", text: "hi", images: [], mode: "later" })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "chat.open", path: "/etc/passwd" })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "url.open", url: "javascript:alert(1)" })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "thinking.set", level: "ultra" })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "dialog.respond", response: { id: "d" } })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "file.open", path: "a", line: -1 })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "unknown" })).toBe(false);
  });
});

describe("isHostMessage", () => {
  it("checks the envelope", () => {
    expect(isHostMessage({ version: 1, type: "pi.events", events: [] })).toBe(true);
    expect(isHostMessage({ version: 1, type: "evil" })).toBe(false);
    expect(isHostMessage(null)).toBe(false);
  });
});
