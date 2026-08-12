interface ManagerHeaderProps {
  title: string;
  paneVisible: boolean;
  onNew(): void;
  onRefresh(): void;
  onTogglePane(): void;
}

export function ManagerHeader({
  title,
  paneVisible,
  onNew,
  onRefresh,
  onTogglePane,
}: ManagerHeaderProps) {
  return (
    <header className="manager-header">
      <div className="manager-brand" aria-label="Pi Agent Manager">
        <span className="pi-mark" aria-hidden="true">π</span>
        <span className="manager-title" title={title}>{title}</span>
      </div>
      <div className="manager-toolbar" role="toolbar" aria-label="Agent manager actions">
        <button className="icon-button" type="button" aria-label="New Agent" title="New Agent" onClick={onNew}>
          <span className="codicon codicon-add" aria-hidden="true" />
        </button>
        <button className="icon-button" type="button" aria-label="Refresh agents" title="Refresh" onClick={onRefresh}>
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label={paneVisible ? "Hide agent list" : "Show agent list"}
          aria-pressed={paneVisible}
          title={paneVisible ? "Hide agent list" : "Show agent list"}
          onClick={onTogglePane}
        >
          <span className="codicon codicon-layout-sidebar-right" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
