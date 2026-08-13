const DEFAULT_PANE_WIDTH = 248;
const MIN_PANE_WIDTH = 180;
const MAX_PANE_WIDTH = 480;
const MAX_COLLAPSED_GROUPS = 64;
const MAX_GROUP_LENGTH = 80;
const MAX_OPEN_SESSIONS = 100;
const MAX_ID_LENGTH = 200;
const MAX_PATH_LENGTH = 16_384;

export interface PersistedOpenSession {
  id: string;
  path: string;
}

export interface PersistedViewState {
  paneVisible: boolean;
  paneWidth: number;
  collapsedGroups: string[];
  openSessions: PersistedOpenSession[];
  activeSession?: PersistedOpenSession;
}

export const DEFAULT_VIEW_STATE: PersistedViewState = {
  paneVisible: true,
  paneWidth: DEFAULT_PANE_WIDTH,
  collapsedGroups: [],
  openSessions: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenSession(value: unknown): value is PersistedOpenSession {
  return isRecord(value) &&
    typeof value.id === "string" && value.id.length > 0 && value.id.length <= MAX_ID_LENGTH &&
    typeof value.path === "string" && value.path.length > 0 && value.path.length <= MAX_PATH_LENGTH;
}

export function normalizeViewState(value: unknown): PersistedViewState {
  if (!isRecord(value)) return { ...DEFAULT_VIEW_STATE };
  const paneWidth = Number.isInteger(value.paneWidth) && Number(value.paneWidth) >= MIN_PANE_WIDTH && Number(value.paneWidth) <= MAX_PANE_WIDTH
    ? Number(value.paneWidth)
    : DEFAULT_PANE_WIDTH;
  const collapsedGroups = Array.isArray(value.collapsedGroups)
    ? value.collapsedGroups
        .filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= MAX_GROUP_LENGTH)
        .slice(0, MAX_COLLAPSED_GROUPS)
    : [];
  const openSessions = Array.isArray(value.openSessions)
    ? value.openSessions
        .filter(isOpenSession)
        .slice(0, MAX_OPEN_SESSIONS)
    : [];
  const activeSession = isOpenSession(value.activeSession) ? { ...value.activeSession } : undefined;
  return {
    paneVisible: typeof value.paneVisible === "boolean" ? value.paneVisible : true,
    paneWidth,
    collapsedGroups,
    openSessions,
    ...(activeSession ? { activeSession } : {}),
  };
}
