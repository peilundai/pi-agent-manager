import { describe, expect, it } from "vitest";
import registerPiStatus, {
  type PiEventContext,
  type PiExtensionApi,
} from "../resources/pi-status";
import type { StatusReport } from "../src/pi/status-report";

class FakePi implements PiExtensionApi {
  readonly handlers = new Map<string, (event: { name?: unknown }, context: PiEventContext) => void | Promise<void>>();

  on(event: string, handler: (event: { name?: unknown }, context: PiEventContext) => void | Promise<void>): void {
    this.handlers.set(event, handler);
  }

  async emit(event: string, context: PiEventContext, payload: { name?: unknown } = {}): Promise<void> {
    await this.handlers.get(event)?.(payload, context);
  }
}

function context(idle: boolean): PiEventContext {
  return {
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/one.jsonl",
      getSessionName: () => "Existing name",
    },
  };
}

describe("Pi status resource", () => {
  it("maps Pi lifecycle events to ordered status reports", async () => {
    const pi = new FakePi();
    const reports: StatusReport[] = [];
    registerPiStatus(pi, {
      env: {
        PI_VSCODE_STATUS_TOKEN: "secret",
        PI_VSCODE_TAB_ID: "tab-1",
        PI_VSCODE_STATUS_HOST: "127.0.0.1",
        PI_VSCODE_STATUS_PORT: "1234",
      },
      now: () => 50,
      send: (report) => {
        reports.push(report);
      },
    });

    await pi.emit("session_start", context(true));
    await pi.emit("agent_start", context(false));
    await pi.emit("session_info_changed", context(false), { name: "Renamed" });
    await pi.emit("agent_settled", context(true));
    await pi.emit("session_info_changed", context(true), { name: undefined });
    await pi.emit("session_shutdown", context(true));

    expect(reports.map(({ sequence, status, name }) => ({ sequence, status, name }))).toEqual([
      { sequence: 1, status: "waiting", name: "Existing name" },
      { sequence: 2, status: "working", name: "Existing name" },
      { sequence: 3, status: "working", name: "Renamed" },
      { sequence: 4, status: "waiting", name: "Existing name" },
      { sequence: 5, status: "waiting", name: null },
      { sequence: 6, status: "stopped", name: "Existing name" },
    ]);
  });
});
