import { describe, expect, it } from "vitest";
import type { ViewSnapshot } from "../src/shared/model";
import { createInitialState, webviewReducer } from "../src/webview/state";

const snapshot: ViewSnapshot = {
  sessions: [],
  tabs: [],
  paneVisible: true,
  paneWidth: 248,
  collapsedGroups: [],
};

describe("webviewReducer", () => {
  it("replaces host state without discarding local search", () => {
    const searched = webviewReducer(createInitialState(snapshot), { type: "search.changed", query: "auth" });
    const replaced = webviewReducer(searched, {
      type: "host.received",
      message: { version: 1, type: "state.replace", snapshot: { ...snapshot, paneWidth: 280 } },
    });
    expect(replaced.searchQuery).toBe("auth");
    expect(replaced.snapshot.paneWidth).toBe(280);
  });

  it("toggles a collapsed group without mutating the previous snapshot", () => {
    const initial = createInitialState(snapshot);
    const collapsed = webviewReducer(initial, { type: "group.toggled", groupId: "today" });
    expect(collapsed.snapshot.collapsedGroups).toEqual(["today"]);
    expect(initial.snapshot.collapsedGroups).toEqual([]);
    expect(webviewReducer(collapsed, { type: "group.toggled", groupId: "today" }).snapshot.collapsedGroups).toEqual([]);
  });

  it("opens and closes a delete confirmation", () => {
    const initial = createInitialState(snapshot);
    const open = webviewReducer(initial, { type: "delete.opened", sessionId: "session-1" });
    expect(open.confirmDeleteSessionId).toBe("session-1");
    expect(webviewReducer(open, { type: "delete.closed" }).confirmDeleteSessionId).toBeUndefined();
  });

  it("keeps the narrow overlay local when host state is replaced", () => {
    const open = webviewReducer(createInitialState(snapshot), { type: "narrow-overlay.visibility", visible: true });
    const replaced = webviewReducer(open, {
      type: "host.received",
      message: { version: 1, type: "state.replace", snapshot: { ...snapshot, paneVisible: false } },
    });
    expect(replaced.narrowOverlayOpen).toBe(true);
    expect(replaced.snapshot.paneVisible).toBe(false);
  });
});
