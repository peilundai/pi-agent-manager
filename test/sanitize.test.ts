import { describe, expect, it } from "vitest";
import type { PiMessage } from "../src/pi/rpc-types";
import { boundJson, sanitizeEvent, sanitizeMessages } from "../src/pi/sanitize";
import { MAX_IMAGE_BASE64_FOR_RAW, MAX_IMAGE_BYTES, MAX_SANITIZED_IMAGE_DATA } from "../src/shared/limits";

describe("sanitize", () => {
  it("bounds long strings and drops oversized image data", () => {
    const value = boundJson({ text: "x".repeat(200_000), image: { type: "image", data: "y".repeat(MAX_SANITIZED_IMAGE_DATA + 1), mimeType: "image/png" } }) as {
      text: string;
      image: { data: string };
    };
    expect(value.text.length).toBeLessThan(100_000);
    expect(value.text).toContain("more characters truncated");
    expect(value.image.data).toBe("");
  });

  it("keeps images up to the attachment limit", () => {
    // A 9 MB image is about 12.6 M base64 characters, well past the old 6 M cap.
    const nineMb = "y".repeat(Math.ceil((9 * 1024 * 1024) / 3) * 4);
    const atLimit = "z".repeat(MAX_IMAGE_BASE64_FOR_RAW);
    const message: PiMessage = {
      role: "user",
      content: [
        { type: "image", data: nineMb, mimeType: "image/png" },
        { type: "image", data: atLimit, mimeType: "image/jpeg" },
      ],
    };
    const event = sanitizeEvent({ type: "message_start", message }) as unknown as { message: { content: { data: string }[] } };
    expect(event.message.content[0]?.data).toBe(nineMb);
    expect(event.message.content[1]?.data).toBe(atLimit);
    expect((sanitizeMessages([message])[0]?.content as { data: string }[])[0]?.data).toBe(nineMb);
  });

  it("derives the sanitize cap from the raw attachment limit", () => {
    expect(MAX_IMAGE_BASE64_FOR_RAW).toBeGreaterThanOrEqual(Math.ceil((MAX_IMAGE_BYTES * 4) / 3));
    expect(MAX_SANITIZED_IMAGE_DATA).toBeGreaterThan(MAX_IMAGE_BASE64_FOR_RAW);
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
