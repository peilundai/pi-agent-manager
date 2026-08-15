import { useRef } from "react";
import type { SessionSummary, SessionStatus, TerminalTab } from "../../shared/model";

interface SessionRowProps {
  session: SessionSummary;
  liveTab: TerminalTab | undefined;
  active: boolean;
  menuOpen: boolean;
  onOpen(): void;
  onToggleMenu(returnFocus: HTMLButtonElement): void;
  onRename(): void;
  onStop(): void;
  onArchive(archived: boolean): void;
  onDelete(returnFocus?: HTMLElement): void;
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function SessionRow({
  session,
  liveTab,
  active,
  menuOpen,
  onOpen,
  onToggleMenu,
  onRename,
  onStop,
  onArchive,
  onDelete,
}: SessionRowProps) {
  const status = liveTab?.status ?? session.status;
  const live = liveTab !== undefined && status !== "stopped" && status !== "failed";
  const moreActionsRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="session-row" data-active={active} data-status={status}>
      <button
        type="button"
        className="session-primary"
        data-session-row
        data-session-id={session.id}
        aria-label={`Open ${session.title}, ${statusLabel(status)}`}
        onClick={onOpen}
      >
        <span className={`status-icon status-${status}`} aria-hidden="true">
          {status === "failed" ? "!" : status === "stopped" ? "" : "✓"}
        </span>
        <span className="session-copy">
          <span className="session-title">{session.title}</span>
          <span className="session-subtitle">
            <span>{statusLabel(status)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(session.updatedAt).toISOString()}>{relativeTime(session.updatedAt)}</time>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="row-more icon-button"
        ref={moreActionsRef}
        data-session-menu-trigger
        data-session-id={session.id}
        aria-label={`More actions for ${session.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => onToggleMenu(event.currentTarget)}
      >
        <span className="codicon codicon-ellipsis" aria-hidden="true" />
      </button>
      {menuOpen ? (
        <div className="session-menu" role="menu" aria-label={`Actions for ${session.title}`}>
          {live ? (
            <>
              <button type="button" role="menuitem" onClick={onRename}>
                <span className="codicon codicon-edit" aria-hidden="true" /> Rename
              </button>
              <button type="button" role="menuitem" onClick={onStop}>
                <span className="codicon codicon-debug-stop" aria-hidden="true" /> Stop Pi
              </button>
              <span className="menu-separator" role="separator" />
            </>
          ) : null}
          <button type="button" role="menuitem" onClick={() => onArchive(!session.archived)}>
            <span className={`codicon codicon-${session.archived ? "history" : "archive"}`} aria-hidden="true" />
            {session.archived ? "Restore" : "Archive"}
          </button>
          <button type="button" role="menuitem" className="danger-item" onClick={() => onDelete(moreActionsRef.current ?? undefined)}>
            <span className="codicon codicon-trash" aria-hidden="true" /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
