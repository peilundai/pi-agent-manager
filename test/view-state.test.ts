import { describe, expect, it } from "vitest";
import { normalizeViewState } from "../src/view/view-state";

describe("normalizeViewState", () => {
  it("normalizes unsafe persisted pane values", () => {
    expect(normalizeViewState({
      paneVisible: "yes",
      paneWidth: 9999,
      collapsedGroups: ["Today", 3],
      openSessions: [{ id: "s", path: 7 }],
    })).toEqual({
      paneVisible: true,
      paneWidth: 248,
      collapsedGroups: ["Today"],
      openSessions: [],
    });
  });

  it("preserves bounded valid persisted values without sharing their arrays", () => {
    const collapsedGroups = ["today"];
    const openSessions = [{ id: "session-1", path: "/sessions/one.jsonl" }];
    const normalized = normalizeViewState({ paneVisible: false, paneWidth: 320, collapsedGroups, openSessions });
    expect(normalized).toEqual({ paneVisible: false, paneWidth: 320, collapsedGroups, openSessions });
    expect(normalized.collapsedGroups).not.toBe(collapsedGroups);
    expect(normalized.openSessions).not.toBe(openSessions);
  });
});
