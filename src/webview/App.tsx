import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { SessionSummary, TerminalTab } from "../shared/model";
import { isHostMessage } from "../shared/protocol";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ManagerHeader } from "./components/ManagerHeader";
import { SessionPane } from "./components/SessionPane";
import { SessionTabs } from "./components/SessionTabs";
import {
  createInitialState,
  webviewReducer,
  type WebviewState,
} from "./state";
import type { WebviewTransport } from "./vscode";

export interface AppProps {
  transport: WebviewTransport;
  initialState?: WebviewState;
}

function liveTabFor(session: SessionSummary, tabs: readonly TerminalTab[]): TerminalTab | undefined {
  return tabs.find(
    (tab) =>
      tab.attached &&
      (tab.sessionId === session.id || tab.sessionPath === session.path),
  );
}

function isNarrowViewport(): boolean {
  return window.matchMedia?.("(max-width: 680px)").matches ?? window.innerWidth <= 680;
}

export function App({ transport, initialState }: AppProps) {
  const [state, dispatch] = useReducer(
    webviewReducer,
    initialState ?? createInitialState(),
  );
  const activeTab = state.snapshot.tabs.find((tab) => tab.tabId === state.snapshot.activeTabId);
  const deleteSession = useMemo(
    () => state.snapshot.sessions.find((session) => session.id === state.confirmDeleteSessionId),
    [state.confirmDeleteSessionId, state.snapshot.sessions],
  );
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (isHostMessage(event.data)) dispatch({ type: "host.received", message: event.data });
    };
    window.addEventListener("message", receive);
    transport.post({ version: 1, type: "ready" });
    return () => window.removeEventListener("message", receive);
  }, [transport]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (state.openMenuSessionId) {
        dispatch({ type: "menu.toggled", sessionId: undefined });
        event.preventDefault();
      } else if (isNarrowViewport() && state.narrowOverlayOpen) {
        dispatch({ type: "narrow-overlay.visibility", visible: false });
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.narrowOverlayOpen, state.openMenuSessionId]);

  useEffect(() => {
    if (!state.confirmDeleteSessionId && deleteReturnFocusRef.current) {
      deleteReturnFocusRef.current.focus();
      deleteReturnFocusRef.current = null;
    }
  }, [state.confirmDeleteSessionId]);

  const postViewState = (
    paneVisible: boolean,
    paneWidth: number,
    collapsedGroups: string[],
  ): void => {
    transport.post({
      version: 1,
      type: "view.update",
      paneVisible,
      paneWidth,
      collapsedGroups,
    });
  };

  const toggleGroup = (groupId: string): void => {
    const collapsed = new Set(state.snapshot.collapsedGroups);
    if (collapsed.has(groupId)) collapsed.delete(groupId);
    else collapsed.add(groupId);
    const collapsedGroups = [...collapsed];
    dispatch({ type: "group.toggled", groupId });
    postViewState(state.snapshot.paneVisible, state.snapshot.paneWidth, collapsedGroups);
  };

  const togglePane = (): void => {
    if (isNarrowViewport()) {
      dispatch({ type: "narrow-overlay.visibility", visible: !state.narrowOverlayOpen });
      return;
    }
    const paneVisible = !state.snapshot.paneVisible;
    dispatch({ type: "pane.visibility", visible: paneVisible });
    postViewState(paneVisible, state.snapshot.paneWidth, state.snapshot.collapsedGroups);
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = state.snapshot.paneWidth;
    const move = (moveEvent: PointerEvent): void => {
      const width = Math.min(480, Math.max(180, startWidth + startX - moveEvent.clientX));
      dispatch({ type: "pane.width", width });
    };
    const finish = (upEvent: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      const width = Math.min(480, Math.max(180, startWidth + startX - upEvent.clientX));
      postViewState(state.snapshot.paneVisible, Math.round(width), state.snapshot.collapsedGroups);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };

  const openSession = (session: SessionSummary, liveTab?: TerminalTab): void => {
    const tab = liveTab ?? liveTabFor(session, state.snapshot.tabs);
    if (tab) transport.post({ version: 1, type: "session.focus", tabId: tab.tabId });
    else transport.post({ version: 1, type: "session.resume", sessionId: session.id });
  };

  const closeMenu = (): void => dispatch({ type: "menu.toggled", sessionId: undefined });

  const openDelete = (session: SessionSummary, returnFocus?: HTMLElement): void => {
    deleteReturnFocusRef.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dispatch({ type: "delete.opened", sessionId: session.id });
  };

  const handleRename = (session: SessionSummary, liveTab?: TerminalTab): void => {
    closeMenu();
    if (liveTab) transport.post({ version: 1, type: "session.rename", sessionId: session.id });
  };

  const handleStop = (_session: SessionSummary, liveTab?: TerminalTab): void => {
    closeMenu();
    if (liveTab) transport.post({ version: 1, type: "session.stop", tabId: liveTab.tabId });
  };

  return (
    <div className="app-shell">
      <ManagerHeader
        title={activeTab?.title ?? "Pi"}
        paneVisible={isNarrowViewport() ? state.narrowOverlayOpen : state.snapshot.paneVisible}
        onNew={() => transport.post({ version: 1, type: "session.new" })}
        onRefresh={() => transport.post({ version: 1, type: "history.refresh" })}
        onTogglePane={togglePane}
      />
      <SessionTabs
        tabs={state.snapshot.tabs}
        activeTabId={state.snapshot.activeTabId}
        onFocus={(tabId) => transport.post({ version: 1, type: "session.focus", tabId })}
        onClose={(tabId) => transport.post({ version: 1, type: "session.detach", tabId })}
        onNew={() => transport.post({ version: 1, type: "session.new" })}
      />
      <div
        className="manager-layout"
        style={{ "--session-pane-width": `${state.snapshot.paneWidth}px` } as CSSProperties}
      >
        <main className="terminal-area" aria-label="Pi terminal">
          {state.snapshot.tabs.some((tab) => tab.attached) ? (
            <div className="terminal-mount" data-testid="terminal-mount" />
          ) : (
            <div className="terminal-empty">
              <span className="empty-mark" aria-hidden="true">π</span>
              <h1>Start a Pi agent</h1>
              <p>Run a task in this workspace without leaving your editor.</p>
              <button className="button primary" type="button" onClick={() => transport.post({ version: 1, type: "session.new" })}>
                <span className="codicon codicon-send" aria-hidden="true" /> New Agent
              </button>
            </div>
          )}
        </main>
        {state.snapshot.paneVisible ? (
          <div
            className="pane-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize agent list"
            onPointerDown={beginResize}
          />
        ) : null}
        <SessionPane
          sessions={state.snapshot.sessions}
          tabs={state.snapshot.tabs}
          activeTabId={state.snapshot.activeTabId}
          query={state.searchQuery}
          visible={state.snapshot.paneVisible}
          narrowOverlayOpen={state.narrowOverlayOpen}
          collapsedGroups={state.snapshot.collapsedGroups}
          openMenuSessionId={state.openMenuSessionId}
          onSearch={(query) => dispatch({ type: "search.changed", query })}
          onNew={() => transport.post({ version: 1, type: "session.new" })}
          onOpen={openSession}
          onToggleGroup={toggleGroup}
          onToggleMenu={(sessionId) => dispatch({ type: "menu.toggled", sessionId })}
          onRename={handleRename}
          onStop={handleStop}
          onArchive={(session, archived) => {
            closeMenu();
            transport.post({ version: 1, type: "session.archive", sessionId: session.id, archived });
          }}
          onDelete={openDelete}
        />
      </div>

      {state.notice ? (
        <div className={`notice notice-${state.notice.level}`} role={state.notice.level === "error" ? "alert" : "status"}>
          <span>{state.notice.message}</span>
          <button className="icon-button" type="button" aria-label="Dismiss notification" onClick={() => dispatch({ type: "notice.closed" })}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {deleteSession ? (
        <ConfirmDialog
          title="Delete Agent?"
          description={`Delete “${deleteSession.title}” and its Pi transcript? This cannot be undone.`}
          confirmLabel="Delete"
          onCancel={() => dispatch({ type: "delete.closed" })}
          onConfirm={() => {
            transport.post({ version: 1, type: "session.delete", sessionId: deleteSession.id });
            dispatch({ type: "delete.closed" });
          }}
        />
      ) : null}
    </div>
  );
}
