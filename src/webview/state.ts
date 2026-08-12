import type { HostToWebviewMessage } from "../shared/protocol";
import type { ViewSnapshot } from "../shared/model";

export interface WebviewNotice {
  level: "info" | "warning" | "error";
  message: string;
}

export type TerminalMessage =
  | { id: number; type: "terminal.output"; tabId: string; data: string }
  | { id: number; type: "terminal.focus"; tabId: string };

export interface WebviewState {
  snapshot: ViewSnapshot;
  searchQuery: string;
  openMenuSessionId: string | undefined;
  confirmDeleteSessionId: string | undefined;
  narrowOverlayOpen: boolean;
  notice: WebviewNotice | undefined;
  terminalMessages: TerminalMessage[];
  nextTerminalMessageId: number;
}

export type WebviewAction =
  | { type: "host.received"; message: HostToWebviewMessage }
  | { type: "search.changed"; query: string }
  | { type: "menu.toggled"; sessionId: string | undefined }
  | { type: "delete.opened"; sessionId: string }
  | { type: "delete.closed" }
  | { type: "group.toggled"; groupId: string }
  | { type: "pane.visibility"; visible: boolean }
  | { type: "narrow-overlay.visibility"; visible: boolean }
  | { type: "pane.width"; width: number }
  | { type: "terminal.messages.handled"; ids: readonly number[] }
  | { type: "notice.closed" };

export const EMPTY_SNAPSHOT: ViewSnapshot = {
  sessions: [],
  tabs: [],
  paneVisible: true,
  paneWidth: 248,
  collapsedGroups: [],
};

export function createInitialState(snapshot: ViewSnapshot = EMPTY_SNAPSHOT): WebviewState {
  return {
    snapshot,
    searchQuery: "",
    openMenuSessionId: undefined,
    confirmDeleteSessionId: undefined,
    narrowOverlayOpen: false,
    notice: undefined,
    terminalMessages: [],
    nextTerminalMessageId: 1,
  };
}

export function webviewReducer(state: WebviewState, action: WebviewAction): WebviewState {
  switch (action.type) {
    case "host.received":
      if (action.message.type === "state.replace") {
        return { ...state, snapshot: action.message.snapshot };
      }
      if (action.message.type === "notice") {
        return {
          ...state,
          notice: { level: action.message.level, message: action.message.message },
        };
      }
      if (action.message.type === "terminal.output" || action.message.type === "terminal.focus") {
        return {
          ...state,
          snapshot: action.message.type === "terminal.focus"
            ? { ...state.snapshot, activeTabId: action.message.tabId }
            : state.snapshot,
          terminalMessages: [
            ...state.terminalMessages,
            { ...action.message, id: state.nextTerminalMessageId },
          ],
          nextTerminalMessageId: state.nextTerminalMessageId + 1,
        };
      }
      return state;
    case "search.changed":
      return { ...state, searchQuery: action.query };
    case "menu.toggled":
      return { ...state, openMenuSessionId: action.sessionId };
    case "delete.opened":
      return { ...state, openMenuSessionId: undefined, confirmDeleteSessionId: action.sessionId };
    case "delete.closed":
      return { ...state, confirmDeleteSessionId: undefined };
    case "group.toggled": {
      const collapsed = new Set(state.snapshot.collapsedGroups);
      if (collapsed.has(action.groupId)) collapsed.delete(action.groupId);
      else collapsed.add(action.groupId);
      return {
        ...state,
        snapshot: { ...state.snapshot, collapsedGroups: [...collapsed] },
      };
    }
    case "pane.visibility":
      return { ...state, snapshot: { ...state.snapshot, paneVisible: action.visible } };
    case "narrow-overlay.visibility":
      return { ...state, narrowOverlayOpen: action.visible };
    case "pane.width":
      return {
        ...state,
        snapshot: { ...state.snapshot, paneWidth: Math.min(480, Math.max(180, Math.round(action.width))) },
      };
    case "terminal.messages.handled": {
      const handled = new Set(action.ids);
      return {
        ...state,
        terminalMessages: state.terminalMessages.filter((message) => !handled.has(message.id)),
      };
    }
    case "notice.closed":
      return { ...state, notice: undefined };
  }
}
