import type { SessionStatus, SessionSummary, SetupErrorState, TerminalTab, ViewSnapshot } from "./model";

const MAX_ID_LENGTH = 200;
const MAX_INPUT_LENGTH = 1_048_576;
const MAX_OUTPUT_LENGTH = 262_144;
const MAX_TARGET_LENGTH = 16_384;
const MAX_NOTICE_LENGTH = 8_192;
const MAX_SESSIONS = 10_000;
const MAX_TABS = 100;
const MIN_TERMINAL_SIZE = 1;
const MAX_TERMINAL_SIZE = 1_000;
const MIN_PANE_WIDTH = 180;
const MAX_PANE_WIDTH = 480;

export type WebviewToHostMessage =
  | { version: 1; type: "ready" }
  | { version: 1; type: "session.new" }
  | { version: 1; type: "session.focus"; tabId: string }
  | { version: 1; type: "session.detach"; tabId: string }
  | { version: 1; type: "session.stop"; tabId: string }
  | { version: 1; type: "session.resume"; sessionId: string }
  | { version: 1; type: "session.archive"; sessionId: string; archived: boolean }
  | { version: 1; type: "session.delete"; sessionId: string }
  | { version: 1; type: "session.rename"; sessionId: string }
  | { version: 1; type: "history.refresh" }
  | { version: 1; type: "setup.action"; action: "openFolder" | "chooseExecutable" | "openSettings" }
  | { version: 1; type: "link.open"; kind: "file" | "url"; target: string }
  | { version: 1; type: "terminal.input"; tabId: string; data: string }
  | { version: 1; type: "terminal.resize"; tabId: string; cols: number; rows: number }
  | {
      version: 1;
      type: "view.update";
      paneVisible: boolean;
      paneWidth: number;
      collapsedGroups: string[];
    };

export type HostToWebviewMessage =
  | { version: 1; type: "state.replace"; snapshot: ViewSnapshot }
  | { version: 1; type: "terminal.output"; tabId: string; data: string }
  | { version: 1; type: "terminal.focus"; tabId: string }
  | { version: 1; type: "notice"; level: "info" | "warning" | "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0)
  );
}

function isId(value: unknown): value is string {
  return isBoundedString(value, MAX_ID_LENGTH);
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStatus(value: unknown): value is SessionStatus {
  return (
    value === "starting" ||
    value === "working" ||
    value === "waiting" ||
    value === "stopped" ||
    value === "failed"
  );
}

function isSessionSummary(value: unknown): value is SessionSummary {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isBoundedString(value.path, MAX_TARGET_LENGTH) &&
    isBoundedString(value.cwd, MAX_TARGET_LENGTH) &&
    isBoundedString(value.title, 512) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    typeof value.archived === "boolean" &&
    isStatus(value.status)
  );
}

function isOptionalId(value: unknown): value is string | undefined {
  return value === undefined || isId(value);
}

function isOptionalPath(value: unknown): value is string | undefined {
  return value === undefined || isBoundedString(value, MAX_TARGET_LENGTH);
}

function isTerminalTab(value: unknown): value is TerminalTab {
  return (
    isRecord(value) &&
    isId(value.tabId) &&
    isOptionalId(value.sessionId) &&
    isOptionalPath(value.sessionPath) &&
    isBoundedString(value.title, 512) &&
    isStatus(value.status) &&
    typeof value.attached === "boolean"
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => isBoundedString(item, 80))
  );
}

function isSetupError(value: unknown): value is SetupErrorState | undefined {
  return value === undefined || (
    isRecord(value) && (
      value.kind === "workspace" ||
      (value.kind === "executable" && isBoundedString(value.message, MAX_NOTICE_LENGTH))
    )
  );
}

function isViewSnapshot(value: unknown): value is ViewSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.sessions) &&
    value.sessions.length <= MAX_SESSIONS &&
    value.sessions.every(isSessionSummary) &&
    Array.isArray(value.tabs) &&
    value.tabs.length <= MAX_TABS &&
    value.tabs.every(isTerminalTab) &&
    isOptionalId(value.activeTabId) &&
    typeof value.paneVisible === "boolean" &&
    isIntegerBetween(value.paneWidth, MIN_PANE_WIDTH, MAX_PANE_WIDTH) &&
    isStringArray(value.collapsedGroups) &&
    isSetupError(value.setupError)
  );
}

export function isWebviewMessage(value: unknown): value is WebviewToHostMessage {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") return false;

  switch (value.type) {
    case "ready":
    case "session.new":
    case "history.refresh":
      return true;
    case "setup.action":
      return value.action === "openFolder" || value.action === "chooseExecutable" || value.action === "openSettings";
    case "session.focus":
    case "session.detach":
    case "session.stop":
      return isId(value.tabId);
    case "session.resume":
    case "session.delete":
    case "session.rename":
      return isId(value.sessionId);
    case "session.archive":
      return isId(value.sessionId) && typeof value.archived === "boolean";
    case "link.open":
      return (
        (value.kind === "file" || value.kind === "url") &&
        isBoundedString(value.target, MAX_TARGET_LENGTH)
      );
    case "terminal.input":
      return isId(value.tabId) && isBoundedString(value.data, MAX_INPUT_LENGTH, true);
    case "terminal.resize":
      return (
        isId(value.tabId) &&
        isIntegerBetween(value.cols, MIN_TERMINAL_SIZE, MAX_TERMINAL_SIZE) &&
        isIntegerBetween(value.rows, MIN_TERMINAL_SIZE, MAX_TERMINAL_SIZE)
      );
    case "view.update":
      return (
        typeof value.paneVisible === "boolean" &&
        isIntegerBetween(value.paneWidth, MIN_PANE_WIDTH, MAX_PANE_WIDTH) &&
        isStringArray(value.collapsedGroups)
      );
    default:
      return false;
  }
}

export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") return false;

  switch (value.type) {
    case "state.replace":
      return isViewSnapshot(value.snapshot);
    case "terminal.output":
      return isId(value.tabId) && isBoundedString(value.data, MAX_OUTPUT_LENGTH, true);
    case "terminal.focus":
      return isId(value.tabId);
    case "notice":
      return (
        (value.level === "info" || value.level === "warning" || value.level === "error") &&
        isBoundedString(value.message, MAX_NOTICE_LENGTH)
      );
    default:
      return false;
  }
}
