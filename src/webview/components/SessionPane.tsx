import type { KeyboardEvent } from "react";
import type { SessionSummary, TerminalTab } from "../../shared/model";
import { filterSessions, groupSessions } from "../../pi/session-groups";
import { SessionRow } from "./SessionRow";

interface SessionPaneProps {
  sessions: readonly SessionSummary[];
  tabs: readonly TerminalTab[];
  activeTabId: string | undefined;
  query: string;
  visible: boolean;
  narrowOverlayOpen: boolean;
  collapsedGroups: readonly string[];
  openMenuSessionId: string | undefined;
  onSearch(query: string): void;
  onNew(): void;
  onOpen(session: SessionSummary, liveTab?: TerminalTab): void;
  onToggleGroup(groupId: string): void;
  onToggleMenu(sessionId: string, returnFocus: HTMLElement): void;
  onRename(session: SessionSummary, liveTab?: TerminalTab): void;
  onStop(session: SessionSummary, liveTab?: TerminalTab): void;
  onArchive(session: SessionSummary, archived: boolean): void;
  onDelete(session: SessionSummary, returnFocus?: HTMLElement): void;
}

export function SessionPane({
  sessions,
  tabs,
  activeTabId,
  query,
  visible,
  narrowOverlayOpen,
  collapsedGroups,
  openMenuSessionId,
  onSearch,
  onNew,
  onOpen,
  onToggleGroup,
  onToggleMenu,
  onRename,
  onStop,
  onArchive,
  onDelete,
}: SessionPaneProps) {
  const shortcut = newAgentShortcut();
  const filtered = filterSessions(sessions, query);
  const groups = groupSessions(filtered);
  const collapsed = new Set(collapsedGroups);
  const liveFor = (session: SessionSummary): TerminalTab | undefined =>
    tabs.find(
      (tab) =>
        tab.attached &&
        (tab.sessionId === session.id || tab.sessionPath === session.path),
    );

  const moveFocus = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Delete") {
      const target = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("[data-session-id]") : null;
      const session = target ? filtered.find((item) => item.id === target.dataset.sessionId) : undefined;
      if (session) {
        onDelete(session, target ?? undefined);
        event.preventDefault();
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-session-row]")];
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const target = rows[(current + delta + rows.length) % rows.length];
    target?.focus();
    event.preventDefault();
  };

  return (
    <aside className="session-pane" data-visible={visible} data-narrow-visible={narrowOverlayOpen} aria-label="Agent sessions" onKeyDown={moveFocus}>
      <div className="session-pane-top">
        <label className="session-search">
          <span className="codicon codicon-search" aria-hidden="true" />
          <span className="sr-only">Search agents</span>
          <input
            type="search"
            aria-label="Search agents"
            placeholder="Search agents…"
            value={query}
            onChange={(event) => onSearch(event.currentTarget.value)}
          />
          {query ? (
            <button type="button" aria-label="Clear agent search" onClick={() => onSearch("")}>
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <button
          className="new-agent-row"
          type="button"
          aria-keyshortcuts={shortcut.aria}
          onClick={onNew}
        >
          <span className="codicon codicon-send" aria-hidden="true" />
          <span>New Agent</span>
          <kbd>{shortcut.label}</kbd>
        </button>
      </div>

      <div className="session-groups">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.id);
          return (
            <section className="session-group" key={group.id} aria-labelledby={`group-${group.id}`}>
              <button
                id={`group-${group.id}`}
                type="button"
                className="group-heading"
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.label}`}
                onClick={() => onToggleGroup(group.id)}
              >
                <span>{group.label}</span>
                <span className={`codicon codicon-chevron-${isCollapsed ? "right" : "down"}`} aria-hidden="true" />
              </button>
              {!isCollapsed ? (
                <div role="list" aria-label={group.label}>
                  {group.sessions.map((session) => {
                    const liveTab = liveFor(session);
                    return (
                      <div role="listitem" key={session.id}>
                        <SessionRow
                          session={session}
                          liveTab={liveTab}
                          active={Boolean(liveTab && activeTabId && liveTab.tabId === activeTabId)}
                          menuOpen={openMenuSessionId === session.id}
                          onOpen={() => onOpen(session, liveTab)}
                          onToggleMenu={(returnFocus) => onToggleMenu(session.id, returnFocus)}
                          onRename={() => onRename(session, liveTab)}
                          onStop={() => onStop(session, liveTab)}
                          onArchive={(archived) => onArchive(session, archived)}
                          onDelete={(returnFocus) => onDelete(session, returnFocus)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
        {!groups.length ? (
          <div className="session-empty">
            <span className="codicon codicon-search" aria-hidden="true" />
            <p>{query ? "No agents match your search." : "No Pi sessions in this workspace yet."}</p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export function newAgentShortcut(platform = globalThis.navigator?.platform ?? ""): {
  label: "⌘N" | "Ctrl+N";
  aria: "Meta+N" | "Control+N";
} {
  return /^(Mac|iPhone|iPad|iPod)/i.test(platform)
    ? { label: "⌘N", aria: "Meta+N" }
    : { label: "Ctrl+N", aria: "Control+N" };
}
