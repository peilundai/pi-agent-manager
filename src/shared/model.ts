export type SessionStatus = "starting" | "working" | "waiting" | "stopped" | "failed";

export type SetupErrorState =
  | { kind: "workspace" }
  | { kind: "executable"; message: string };

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
