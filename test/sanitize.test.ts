import { describe, expect, it } from "vitest";
import { boundJson, sanitizeEvent, sanitizeMessages } from "../src/pi/sanitize";

describe("sanitize", () => {
  it("bounds long strings and drops oversized image data", () => {
    const value = boundJson({ text: "x".repeat(200_000), image: { type: "image", data: "y".repeat(7_000_000), mimeType: "image/png" } }) as {
      text: string;
      image: { data: string };
    };
    expect(value.text.length).toBeLessThan(100_000);
    expect(value.text).toContain("more characters truncated");
    expect(value.image.data).toBe("");
  });

  it("reduces aggregate events and hides system messages", () => {
    expect(sanitizeEvent({ type: "agent_end", messages: [1, 2, 3], willRetry: true })).toEqual({ type: "agent_end", willRetry: true });
    expect(sanitizeEvent({ type: "message_start", message: { role: "system" } })).toBeUndefined();
    expect(sanitizeEvent({ type: "entry_appended", entry: {} })).toBeUndefined();
    expect(sanitizeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a", partial: { big: 1 } } })).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "a" },
    });
  });

  it("filters invisible messages", () => {
    expect(sanitizeMessages([{ role: "system" }, { role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });
});
