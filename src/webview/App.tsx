import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { SessionSummary, SetupErrorState, TerminalTab } from "../shared/model";
import { isHostMessage } from "../shared/protocol";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ManagerHeader } from "./components/ManagerHeader";
import { SessionPane } from "./components/SessionPane";
import { SessionTabs } from "./components/SessionTabs";
import {
  browserTerminalFactory,
  TerminalWorkspace,
  type TerminalWorkspaceFactory,
} from "./components/TerminalWorkspace";
import {
  createInitialState,
  webviewReducer,
  type WebviewState,
} from "./state";
import type { WebviewTransport } from "./vscode";

export interface AppProps {
  transport: WebviewTransport;
  initialState?: WebviewState;
  terminalFactory?: TerminalWorkspaceFactory;
}

function liveTabFor(session: SessionSummary, tabs: readonly TerminalTab[]): TerminalTab | undefined {
  return tabs.find(
    (tab) =>
      tab.attached &&
      (tab.sessionId === session.id || tab.sessionPath === session.path),
  );
}

function SetupErrorView({ error, transport }: { error: SetupErrorState; transport: WebviewTransport }) {
  if (error.kind === "workspace") {
    return (
      <div className="terminal-empty setup-error">
        <span className="empty-mark codicon codicon-folder-opened" aria-hidden="true" />
        <h1>Open a workspace folder</h1>
        <p>Pi Agent Manager needs a workspace folder for sessions, history, and process working directories.</p>
        <button className="button primary" type="button" onClick={() => transport.post({ version: 1, type: "setup.action", action: "openFolder" })}>
          <span className="codicon codicon-folder-opened" aria-hidden="true" /> Open Folder
        </button>
      </div>
    );
  }
  return (
    <div className="terminal-empty setup-error">
      <span className="empty-mark codicon codicon-warning" aria-hidden="true" />
      <h1>Set up Pi executable</h1>
      <p>{error.message}</p>
      <div className="setup-error-actions">
        <button className="button primary" type="button" onClick={() => transport.post({ version: 1, type: "setup.action", action: "chooseExecutable" })}>
          Choose Executable
        </button>
        <button className="button secondary" type="button" onClick={() => transport.post({ version: 1, type: "setup.action", action: "openSettings" })}>
          Open Settings
        </button>
      </div>
    </div>
  );
}

const NARROW_VIEWPORT_QUERY = "(max-width: 680px)";
const MINIMUM_PANE_WIDTH = 180;
const MAXIMUM_PANE_WIDTH = 480;
const PANE_KEYBOARD_STEP = 10;

function clampPaneWidth(width: number): number {
  return Math.min(MAXIMUM_PANE_WIDTH, Math.max(MINIMUM_PANE_WIDTH, Math.round(width)));
}

function isNarrowViewport(): boolean {
  return window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches ?? window.innerWidth <= 680;
}

function useNarrowViewport(): boolean {
  const [narrowViewport, setNarrowViewport] = useState(isNarrowViewport);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.(NARROW_VIEWPORT_QUERY);
    if (!mediaQuery) {
      window.addEventListener("resize", syncViewport);
      return () => window.removeEventListener("resize", syncViewport);
    }

    const onChange = (event: MediaQueryListEvent): void => setNarrowViewport(event.matches);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onChange);
      return () => mediaQuery.removeEventListener("change", onChange);
    }
    if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onChange);
      return () => mediaQuery.removeListener(onChange);
    }
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);

    function syncViewport(): void {
      setNarrowViewport(isNarrowViewport());
    }
  }, []);

  return narrowViewport;
}

export function App({ transport, initialState, terminalFactory = browserTerminalFactory }: AppProps) {
  const [state, dispatch] = useReducer(
    webviewReducer,
    initialState ?? createInitialState(),
  );
  const activeTab = state.snapshot.tabs.find((tab) => tab.tabId === state.snapshot.activeTabId);
  const narrowViewport = useNarrowViewport();
  const paneVisible = narrowViewport ? state.narrowOverlayOpen : state.snapshot.paneVisible;
  const deleteSession = useMemo(
    () => state.snapshot.sessions.find((session) => session.id === state.confirmDeleteSessionId),
    [state.confirmDeleteSessionId, state.snapshot.sessions],
  );
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const menuReturnFocusRef = useRef<{
    sessionId: string;
    element: HTMLElement | null;
    archived?: boolean;
  } | null>(null);

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
    const reportFocused = (): void => transport.post({ version: 1, type: "view.focus", focused: true });
    const reportBlurred = (): void => transport.post({ version: 1, type: "view.focus", focused: false });
    if (document.hasFocus()) reportFocused();
    window.addEventListener("focus", reportFocused);
    window.addEventListener("blur", reportBlurred);
    return () => {
      window.removeEventListener("focus", reportFocused);
      window.removeEventListener("blur", reportBlurred);
      reportBlurred();
    };
  }, [transport]);

  useEffect(() => {
    if (!state.confirmDeleteSessionId && deleteReturnFocusRef.current) {
      deleteReturnFocusRef.current.focus();
      deleteReturnFocusRef.current = null;
    }
  }, [state.confirmDeleteSessionId]);

  useEffect(() => {
    const pending = menuReturnFocusRef.current;
    if (!pending || state.openMenuSessionId || state.confirmDeleteSessionId) return;
    if (pending.archived !== undefined) {
      const session = state.snapshot.sessions.find((candidate) => candidate.id === pending.sessionId);
      if (session?.archived !== pending.archived) return;
    }

    const original = pending.element?.isConnected ? pending.element : undefined;
    const relocated = [...document.querySelectorAll<HTMLButtonElement>("[data-session-menu-trigger]")]
      .find((button) => button.dataset.sessionId === pending.sessionId);
    (original ?? relocated)?.focus();
    menuReturnFocusRef.current = null;
  }, [state.confirmDeleteSessionId, state.openMenuSessionId, state.snapshot.sessions]);

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
      const width = clampPaneWidth(startWidth + startX - moveEvent.clientX);
      dispatch({ type: "pane.width", width });
    };
    const finish = (upEvent: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      const width = clampPaneWidth(startWidth + startX - upEvent.clientX);
      postViewState(state.snapshot.paneVisible, width, state.snapshot.collapsedGroups);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };

  const resizePaneWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    let width: number | undefined;
    switch (event.key) {
      case "ArrowLeft":
        width = state.snapshot.paneWidth + PANE_KEYBOARD_STEP;
        break;
      case "ArrowRight":
        width = state.snapshot.paneWidth - PANE_KEYBOARD_STEP;
        break;
      case "Home":
        width = MINIMUM_PANE_WIDTH;
        break;
      case "End":
        width = MAXIMUM_PANE_WIDTH;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextWidth = clampPaneWidth(width);
    dispatch({ type: "pane.width", width: nextWidth });
    postViewState(state.snapshot.paneVisible, nextWidth, state.snapshot.collapsedGroups);
  };

  const openSession = (session: SessionSummary, liveTab?: TerminalTab): void => {
    const tab = liveTab ?? liveTabFor(session, state.snapshot.tabs);
    if (tab) transport.post({ version: 1, type: "session.focus", tabId: tab.tabId });
    else transport.post({ version: 1, type: "session.resume", sessionId: session.id });
  };

  const closeMenu = (archived?: boolean): void => {
    if (menuReturnFocusRef.current && archived !== undefined) {
      menuReturnFocusRef.current.archived = archived;
    }
    dispatch({ type: "menu.toggled", sessionId: undefined });
  };

  const toggleMenu = (sessionId: string, returnFocus: HTMLElement): void => {
    menuReturnFocusRef.current = { sessionId, element: returnFocus };
    dispatch({
      type: "menu.toggled",
      sessionId: state.openMenuSessionId === sessionId ? undefined : sessionId,
    });
  };

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
      <div className="app-content" inert={deleteSession ? true : undefined} aria-hidden={deleteSession ? true : undefined}>
      <ManagerHeader
        title={state.snapshot.setupError ? "Setup required" : activeTab?.title ?? "New Agent"}
        paneVisible={paneVisible}
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
        style={{ "--session-pane-width": `${paneVisible ? state.snapshot.paneWidth : 0}px` } as CSSProperties}
      >
        <main className="terminal-area" aria-label="Pi terminal">
          {state.snapshot.setupError ? (
            <SetupErrorView error={state.snapshot.setupError} transport={transport} />
          ) : state.snapshot.tabs.some((tab) => tab.attached) ? (
            <TerminalWorkspace
              tabs={state.snapshot.tabs}
              {...(state.snapshot.activeTabId ? { activeTabId: state.snapshot.activeTabId } : {})}
              transport={transport}
              factory={terminalFactory}
              messages={state.terminalMessages}
              onMessagesHandled={(ids) => dispatch({ type: "terminal.messages.handled", ids })}
            />
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
        {paneVisible ? (
          <div
            className="pane-divider"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize agent list"
            aria-valuemin={MINIMUM_PANE_WIDTH}
            aria-valuemax={MAXIMUM_PANE_WIDTH}
            aria-valuenow={state.snapshot.paneWidth}
            onPointerDown={beginResize}
            onKeyDown={resizePaneWithKeyboard}
          />
        ) : null}
        <SessionPane
          sessions={state.snapshot.sessions}
          tabs={state.snapshot.tabs}
          activeTabId={state.snapshot.activeTabId}
          query={state.searchQuery}
          visible={paneVisible}
          narrowOverlayOpen={state.narrowOverlayOpen}
          collapsedGroups={state.snapshot.collapsedGroups}
          openMenuSessionId={state.openMenuSessionId}
          onSearch={(query) => dispatch({ type: "search.changed", query })}
          onNew={() => transport.post({ version: 1, type: "session.new" })}
          onOpen={openSession}
          onToggleGroup={toggleGroup}
          onToggleMenu={toggleMenu}
          onRename={handleRename}
          onStop={handleStop}
          onArchive={(session, archived) => {
            closeMenu(archived);
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
      </div>

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
