import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import type { StatusReport } from "../src/pi/status-report";
import { PiStatusBridge } from "../src/pi/status-bridge";

function sendLine(port: number, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => socket.end(`${line}\n`, "utf8", resolve));
  });
}

describe("PiStatusBridge", () => {
  it("accepts an authenticated report over a loopback socket", async () => {
    let resolveReport: ((report: StatusReport) => void) | undefined;
    const received = new Promise<StatusReport>((resolve) => {
      resolveReport = resolve;
    });
    const bridge = new PiStatusBridge((report) => resolveReport?.(report), { token: "bridge-secret" });
    await bridge.start();
    const environment = bridge.environmentFor("tab-1");

    await sendLine(
      Number(environment.PI_VSCODE_STATUS_PORT),
      JSON.stringify({
        version: 1,
        token: environment.PI_VSCODE_STATUS_TOKEN,
        tabId: environment.PI_VSCODE_TAB_ID,
        sequence: 1,
        status: "working",
        timestamp: 100,
        sessionId: "session-1",
      }),
    );

    await expect(received).resolves.toMatchObject({ tabId: "tab-1", status: "working", sessionId: "session-1" });
    expect(environment.PI_VSCODE_STATUS_HOST).toBe("127.0.0.1");
    await bridge.dispose();
  });

  it("ignores malformed, unauthenticated, and oversized lines", async () => {
    const reports: StatusReport[] = [];
    const bridge = new PiStatusBridge((report) => reports.push(report), { token: "bridge-secret" });
    await bridge.start();
    const environment = bridge.environmentFor("tab-1");
    const port = Number(environment.PI_VSCODE_STATUS_PORT);

    await sendLine(port, "not-json");
    await sendLine(port, JSON.stringify({ version: 1, token: "wrong", tabId: "tab-1", sequence: 1, status: "waiting", timestamp: 1 }));
    await sendLine(port, "x".repeat(65_537));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(reports).toEqual([]);
    await bridge.dispose();
  });

  it("rejects environment access before start", () => {
    const bridge = new PiStatusBridge(() => undefined, { token: "bridge-secret" });
    expect(() => bridge.environmentFor("tab-1")).toThrow(/start/i);
  });
});
