import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/shared/model";
import { filterSessions, groupSessions } from "../src/pi/session-groups";

function session(id: string, updatedAt: number, archived = false, title = id): SessionSummary {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/repo",
    title,
    createdAt: updatedAt,
    updatedAt,
    archived,
    status: "stopped",
  };
}

describe("groupSessions", () => {
  it("places sessions into stable local-calendar buckets", () => {
    const now = new Date(2026, 7, 12, 12).getTime();
    const sessions = [
      session("today", new Date(2026, 7, 12, 8).getTime()),
      session("yesterday", new Date(2026, 7, 11, 8).getTime()),
      session("week", new Date(2026, 7, 8, 8).getTime()),
      session("month", new Date(2026, 6, 20, 8).getTime()),
      session("older", new Date(2026, 5, 1, 8).getTime()),
      session("archived", new Date(2026, 7, 12, 9).getTime(), true),
    ];

    expect(groupSessions(sessions, now).map((group) => [group.label, group.sessions.map((item) => item.id)])).toEqual([
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Last 7 Days", ["week"]],
      ["Last 30 Days", ["month"]],
      ["Older", ["older"]],
      ["Archived", ["archived"]],
    ]);
  });
});

describe("filterSessions", () => {
  it("matches title and path case-insensitively while preserving order", () => {
    const first = session("one", 2, false, "Auth Cleanup");
    const second = { ...session("two", 1, false, "Metrics"), path: "/sessions/AUTH-follow-up.jsonl" };
    expect(filterSessions([first, second], "auth").map((item) => item.id)).toEqual(["one", "two"]);
    expect(filterSessions([first, second], "  ")).toEqual([first, second]);
  });
});
