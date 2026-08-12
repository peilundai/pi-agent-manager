import type { TerminalTab } from "../../shared/model";

interface SessionTabsProps {
  tabs: readonly TerminalTab[];
  activeTabId: string | undefined;
  onFocus(tabId: string): void;
  onClose(tabId: string): void;
  onNew(): void;
}

function statusLabel(tab: TerminalTab): string {
  if (tab.status === "starting") return "Starting";
  if (tab.status === "working") return "Working";
  if (tab.status === "waiting") return "Waiting";
  if (tab.status === "failed") return "Failed";
  return "Stopped";
}

export function SessionTabs({ tabs, activeTabId, onFocus, onClose, onNew }: SessionTabsProps) {
  const attached = tabs.filter((tab) => tab.attached);
  return (
    <div className="session-tabs-bar">
      <div className="session-tabs" role="tablist" aria-label="Open Pi agents">
        {attached.map((tab) => {
          const selected = tab.tabId === activeTabId;
          return (
            <div className="session-tab-wrap" data-active={selected} key={tab.tabId}>
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="session-tab"
                title={`${tab.title} — ${statusLabel(tab)}`}
                onClick={() => onFocus(tab.tabId)}
              >
                <span className={`status-dot status-${tab.status}`} aria-hidden="true" />
                <span className="tab-title">{tab.title}</span>
                <span className="sr-only">{statusLabel(tab)}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.title} tab`}
                title="Close"
                onClick={() => onClose(tab.tabId)}
              >
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button className="icon-button tab-new" type="button" aria-label="New Agent" title="New Agent" onClick={onNew}>
        <span className="codicon codicon-add" aria-hidden="true" />
      </button>
    </div>
  );
}
