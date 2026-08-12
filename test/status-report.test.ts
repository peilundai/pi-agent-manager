import { describe, expect, it } from "vitest";
import { StatusReportGate } from "../src/pi/status-report";

describe("StatusReportGate", () => {
  it("accepts a current authenticated report", () => {
    const gate = new StatusReportGate("secret");
    const report = {
      version: 1,
      token: "secret",
      tabId: "tab-1",
      sequence: 1,
      status: "waiting",
      timestamp: 20,
      sessionId: "session-1",
      sessionPath: "/sessions/one.jsonl",
      name: "Auth cleanup",
    } as const;
    expect(gate.accept(report)).toEqual(report);
  });

  it("rejects stale reports per tab", () => {
    const gate = new StatusReportGate("secret");
    expect(gate.accept({ version: 1, token: "secret", tabId: "tab-1", sequence: 2, status: "waiting", timestamp: 20 }))
      .toBeDefined();
    expect(gate.accept({ version: 1, token: "secret", tabId: "tab-1", sequence: 1, status: "working", timestamp: 10 }))
      .toBeUndefined();
  });

  it("rejects the wrong token and malformed fields", () => {
    const gate = new StatusReportGate("secret");
    expect(gate.accept({ version: 1, token: "wrong", tabId: "tab-1", sequence: 1, status: "waiting", timestamp: 20 }))
      .toBeUndefined();
    expect(gate.accept({ version: 1, token: "secret", tabId: "tab-1", sequence: -1, status: "idle", timestamp: 20 }))
      .toBeUndefined();
  });

  it("accepts null to signal a cleared Pi session name", () => {
    const gate = new StatusReportGate("secret");
    expect(gate.accept({ version: 1, token: "secret", tabId: "tab-1", sequence: 1, status: "waiting", timestamp: 20, name: null }))
      .toMatchObject({ name: null });
  });
});
