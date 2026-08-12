import { describe, expect, it } from "vitest";
import { isHostMessage, isWebviewMessage } from "../src/shared/protocol";

describe("isWebviewMessage", () => {
  it("accepts a bounded terminal input message", () => {
    expect(
      isWebviewMessage({
        version: 1,
        type: "terminal.input",
        tabId: "tab-1",
        data: "hello",
      }),
    ).toBe(true);
  });

  it("rejects unknown versions", () => {
    expect(isWebviewMessage({ version: 2, type: "ready" })).toBe(false);
  });

  it("rejects oversized terminal input", () => {
    expect(
      isWebviewMessage({
        version: 1,
        type: "terminal.input",
        tabId: "tab-1",
        data: "x".repeat(1_048_577),
      }),
    ).toBe(false);
  });
});

describe("isHostMessage", () => {
  it("accepts a bounded terminal output message", () => {
    expect(
      isHostMessage({
        version: 1,
        type: "terminal.output",
        tabId: "tab-1",
        data: "Pi is ready",
      }),
    ).toBe(true);
  });

  it("rejects oversized output and malformed snapshots", () => {
    expect(
      isHostMessage({
        version: 1,
        type: "terminal.output",
        tabId: "tab-1",
        data: "x".repeat(262_145),
      }),
    ).toBe(false);
    expect(
      isHostMessage({
        version: 1,
        type: "state.replace",
        snapshot: { sessions: "not-an-array" },
      }),
    ).toBe(false);
  });
});
