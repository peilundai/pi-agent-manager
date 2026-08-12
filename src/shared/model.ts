export type SessionStatus = "starting" | "working" | "waiting" | "stopped" | "failed";

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  status: SessionStatus;
}

export interface TerminalTab {
  tabId: string;
  sessionId?: string;
  sessionPath?: string;
  title: string;
  status: SessionStatus;
  attached: boolean;
}

export interface ViewSnapshot {
  sessions: SessionSummary[];
  tabs: TerminalTab[];
  activeTabId?: string;
  paneVisible: boolean;
  paneWidth: number;
  collapsedGroups: string[];
}
