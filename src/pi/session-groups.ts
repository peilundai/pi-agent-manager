import type { SessionSummary } from "../shared/model";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type SessionGroupId = "today" | "yesterday" | "last7" | "last30" | "older" | "archived";

export interface SessionGroup {
  id: SessionGroupId;
  label: string;
  sessions: SessionSummary[];
}

const GROUPS: ReadonlyArray<{ id: SessionGroupId; label: string }> = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7", label: "Last 7 Days" },
  { id: "last30", label: "Last 30 Days" },
  { id: "older", label: "Older" },
  { id: "archived", label: "Archived" },
];

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function bucketFor(session: SessionSummary, startToday: number): SessionGroupId {
  if (session.archived) return "archived";
  if (session.updatedAt >= startToday) return "today";
  if (session.updatedAt >= startToday - DAY_MS) return "yesterday";
  if (session.updatedAt >= startToday - 6 * DAY_MS) return "last7";
  if (session.updatedAt >= startToday - 29 * DAY_MS) return "last30";
  return "older";
}

export function groupSessions(sessions: readonly SessionSummary[], now = Date.now()): SessionGroup[] {
  const startToday = startOfLocalDay(now);
  const buckets = new Map<SessionGroupId, SessionSummary[]>();
  for (const session of sessions) {
    const id = bucketFor(session, startToday);
    const bucket = buckets.get(id) ?? [];
    bucket.push(session);
    buckets.set(id, bucket);
  }

  return GROUPS.flatMap(({ id, label }) => {
    const items = buckets.get(id);
    if (!items?.length) return [];
    return [{ id, label, sessions: [...items].sort((left, right) => right.updatedAt - left.updatedAt) }];
  });
}

export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
): SessionSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...sessions];
  return sessions.filter((session) =>
    [session.title, session.path, session.cwd].some((value) =>
      value.toLocaleLowerCase().includes(normalized),
    ),
  );
}
