import { describe, expect, it } from "vitest";
import type { StatusReport } from "../src/pi/status-report";
import type { PtyAdapter, PtyProcess, PtySpawnOptions } from "../src/pi/pty-adapter";
import {
  SessionController,
  type SessionControllerEvent,
} from "../src/pi/session-controller";

class FakePtyProcess implements PtyProcess {
  readonly pid = 123;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

class FakePtyAdapter implements PtyAdapter {
  readonly processes: FakePtyProcess[] = [];
  readonly spawns: Array<{ file: string; args: readonly string[]; options: PtySpawnOptions }> = [];

  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess {
    this.spawns.push({ file, args, options });
    const process = new FakePtyProcess();
    this.processes.push(process);
    return process;
  }
}

function harness(maxReplayBytes = 2 * 1_024 * 1_024): {
  adapter: FakePtyAdapter;
  controller: SessionController;
  events: SessionControllerEvent[];
} {
  const adapter = new FakePtyAdapter();
  const events: SessionControllerEvent[] = [];
  let nextId = 0;
  const controller = new SessionController({
    pty: adapter,
    invocationFor: (sessionPath) => ({
      file: "/opt/homebrew/bin/pi",
      args: sessionPath ? ["--session", sessionPath] : [],
    }),
    environmentFor: (tabId) => ({ PI_VSCODE_TAB_ID: tabId, PI_VSCODE_STATUS_TOKEN: "secret" }),
    baseEnvironment: { PATH: "/bin", UNDEFINED_VALUE: undefined },
    uuid: () => `tab-${++nextId}`,
    onEvent: (event) => events.push(event),
    maxReplayBytes,
  });
  return { adapter, controller, events };
}

function report(tabId: string, status: StatusReport["status"], sequence = 1): StatusReport {
  return {
    version: 1,
    token: "secret",
    tabId,
    sequence,
    status,
    timestamp: sequence,
    sessionId: "session-1",
    sessionPath: "/sessions/one.jsonl",
    name: "Auth cleanup",
  };
}

describe("SessionController", () => {
  it("detaches without killing and explicitly stops the process", async () => {
    const { adapter, controller } = harness();
    const tab = await controller.start({ cwd: "/repo" });

    controller.detach(tab.tabId);
    expect(adapter.processes[0]?.killed).toBe(false);
    expect(controller.snapshot().find((item) => item.tabId === tab.tabId)?.attached).toBe(false);

    await controller.stop(tab.tabId);
    expect(adapter.processes[0]?.killed).toBe(true);
    expect(controller.snapshot().find((item) => item.tabId === tab.tabId)).toMatchObject({
      status: "stopped",
      attached: false,
    });
  });

  it("reattaches an already-running transcript instead of spawning twice", async () => {
    const { adapter, controller } = harness();
    const first = await controller.start({ cwd: "/repo", sessionPath: "/sessions/one.jsonl" });
    controller.detach(first.tabId);
    const second = await controller.start({ cwd: "/repo", sessionPath: "/sessions/one.jsonl" });
    expect(second.tabId).toBe(first.tabId);
    expect(second.attached).toBe(true);
    expect(adapter.processes).toHaveLength(1);
  });

  it("binds status metadata and explicit names to the live tab", async () => {
    const { controller } = harness();
    const tab = await controller.start({ cwd: "/repo" });
    controller.applyStatusReport(report(tab.tabId, "waiting"));
    expect(controller.snapshot()[0]).toMatchObject({
      sessionId: "session-1",
      sessionPath: "/sessions/one.jsonl",
      title: "Auth cleanup",
      status: "waiting",
    });
  });

  it("clears a stale explicit title when Pi clears its session name", async () => {
    const { controller } = harness();
    const tab = await controller.start({ cwd: "/repo" });
    controller.applyStatusReport(report(tab.tabId, "waiting"));
    controller.applyStatusReport({ ...report(tab.tabId, "waiting", 2), name: null });
    expect(controller.snapshot()[0]?.title).toBe("New Agent");
  });

  it("rejects oversized input and invalid resize dimensions", async () => {
    const { controller } = harness();
    const tab = await controller.start({ cwd: "/repo" });
    expect(() => controller.input(tab.tabId, "x".repeat(1_048_577))).toThrow(/too large/i);
    expect(() => controller.resize(tab.tabId, 0, 24)).toThrow(/dimensions/i);
  });

  it("renames only a waiting session through Pi's native command", async () => {
    const { adapter, controller } = harness();
    const tab = await controller.start({ cwd: "/repo" });
    expect(() => controller.rename(tab.tabId, "New title")).toThrow(/waiting/i);
    controller.applyStatusReport(report(tab.tabId, "waiting"));
    controller.rename(tab.tabId, "  New title  ");
    expect(adapter.processes[0]?.writes).toEqual(["\u001b[200~/name New title\u001b[201~", "\r"]);
  });

  it("bounds replay output while forwarding every live chunk", async () => {
    const { adapter, controller, events } = harness(8);
    const tab = await controller.start({ cwd: "/repo" });
    adapter.processes[0]?.emitData("12345");
    adapter.processes[0]?.emitData("67890");
    expect(controller.replay(tab.tabId)).toBe("34567890");
    expect(events.filter((event) => event.type === "output").map((event) => event.data)).toEqual(["12345", "67890"]);
  });

  it("marks non-zero exits failed and zero exits stopped", async () => {
    const first = harness();
    const failed = await first.controller.start({ cwd: "/repo" });
    first.adapter.processes[0]?.emitExit(2);
    expect(first.controller.snapshot().find((item) => item.tabId === failed.tabId)).toMatchObject({ status: "failed", attached: false });

    const second = harness();
    const stopped = await second.controller.start({ cwd: "/repo" });
    second.adapter.processes[0]?.emitExit(0);
    expect(second.controller.snapshot().find((item) => item.tabId === stopped.tabId)).toMatchObject({ status: "stopped", attached: false });
  });

  it("merges bridge and process environment without undefined values", async () => {
    const { adapter, controller } = harness();
    await controller.start({ cwd: "/repo" });
    expect(adapter.spawns[0]?.options).toMatchObject({
      cwd: "/repo",
      cols: 80,
      rows: 24,
      env: { PATH: "/bin", PI_VSCODE_STATUS_TOKEN: "secret", PI_VSCODE_TAB_ID: "tab-1" },
    });
    expect(adapter.spawns[0]?.options.env).not.toHaveProperty("UNDEFINED_VALUE");
  });
});
