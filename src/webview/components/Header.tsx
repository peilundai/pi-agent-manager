import { useEffect, useMemo, useRef, useState } from "react";
import { filterSessions, groupSessions } from "../../pi/session-groups";
import type { SessionSummary } from "../../shared/model";
import { useChat } from "./context";

export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

export function SessionPicker({
  sessions,
  activePath,
  onClose,
}: {
  sessions: SessionSummary[];
  activePath: string | undefined;
  onClose(): void;
}) {
  const { post } = useChat();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());
  const groups = useMemo(
    () => groupSessions(filterSessions(sessions.filter((session) => !session.archived), query), now).filter((group) => group.sessions.length),
    [sessions, query, now],
  );
  const flat = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as Element).closest?.("[data-history-toggle]")) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);

  useEffect(() => setActive(0), [query]);

  const open = (session: SessionSummary) => {
    post({ version: 1, type: "chat.open", path: session.path });
    onClose();
  };

  let position = -1;
  return (
    <div className="popover session-picker" ref={ref} role="dialog" aria-label="Past chats">
      <div className="picker-search">
        <span className="codicon codicon-search" aria-hidden="true" />
        <input
          autoFocus
          value={query}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(value + 1, flat.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const session = flat[active];
              if (session) open(session);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <div className="picker-list" role="listbox" aria-label="Sessions">
        {flat.length === 0 && <div className="picker-empty">{query ? "No matching sessions." : "No past chats in this workspace yet."}</div>}
        {groups.map((group) => (
          <div key={group.id} role="group" aria-label={group.label}>
            <div className="picker-group">{group.label}</div>
            {group.sessions.map((session) => {
              position += 1;
              const index = position;
              const current = session.path === activePath;
              return (
                <div
                  key={session.path}
                  role="option"
                  aria-selected={current}
                  className={`picker-item session-item${index === active ? " active" : ""}${current ? " current" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => open(session)}
                >
                  <span className="picker-item-title">{session.title}</span>
                  <span className="session-time">{relativeTime(session.updatedAt, now)}</span>
                  <button
                    type="button"
                    className="icon-button small session-delete"
                    aria-label={`Delete ${session.title}`}
                    title="Delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      post({ version: 1, type: "chat.delete", path: session.path });
                    }}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Header({
  title,
  historyOpen,
  canRename,
  onToggleHistory,
  onNewChat,
}: {
  title: string;
  historyOpen: boolean;
  canRename: boolean;
  onToggleHistory(): void;
  onNewChat(): void;
}) {
  const { post } = useChat();
  return (
    <header className="header">
      <button
        type="button"
        className="header-title"
        title={canRename ? "Rename chat" : title}
        disabled={!canRename}
        onClick={() => post({ version: 1, type: "chat.rename" })}
      >
        {title}
      </button>
      <div className="header-actions">
        <button
          type="button"
          className={`icon-button${historyOpen ? " active" : ""}`}
          data-history-toggle
          title="Past chats"
          aria-label="Past chats"
          aria-expanded={historyOpen}
          onClick={onToggleHistory}
        >
          <span className="codicon codicon-history" />
        </button>
        <button type="button" className="icon-button" title="New chat" aria-label="New chat" onClick={onNewChat}>
          <span className="codicon codicon-add" />
        </button>
      </div>
    </header>
  );
}
