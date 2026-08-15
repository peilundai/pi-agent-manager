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

  it("accepts only the bounded setup recovery actions", () => {
    expect(isWebviewMessage({ version: 1, type: "setup.action", action: "openFolder" })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "setup.action", action: "chooseExecutable" })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "setup.action", action: "openSettings" })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "setup.action", action: "runShell" })).toBe(false);
  });

  it("accepts only boolean webview focus state", () => {
    expect(isWebviewMessage({ version: 1, type: "view.focus", focused: true })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "view.focus", focused: false })).toBe(true);
    expect(isWebviewMessage({ version: 1, type: "view.focus", focused: "yes" })).toBe(false);
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

  it("accepts actionable workspace and executable setup errors in snapshots", () => {
    const base = {
      sessions: [],
      tabs: [],
      paneVisible: true,
      paneWidth: 248,
      collapsedGroups: [],
    };
    expect(isHostMessage({
      version: 1,
      type: "state.replace",
      snapshot: { ...base, setupError: { kind: "workspace" } },
    })).toBe(true);
    expect(isHostMessage({
      version: 1,
      type: "state.replace",
      snapshot: { ...base, setupError: { kind: "executable", message: "Pi was not found." } },
    })).toBe(true);
    expect(isHostMessage({
      version: 1,
      type: "state.replace",
      snapshot: { ...base, setupError: { kind: "executable", message: "x".repeat(8_193) } },
    })).toBe(false);
  });
});
