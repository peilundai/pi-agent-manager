import { afterEach, describe, expect, it, vi } from "vitest";
import { PiCommandNotFoundError } from "../src/pi/command-resolver";
import type { StatusReport } from "../src/pi/status-report";
import type { PtyAdapter, PtyProcess, PtySpawnOptions } from "../src/pi/pty-adapter";
import { isHostMessage } from "../src/shared/protocol";
import {
  SessionController,
  type SessionControllerEvent,
} from "../src/pi/session-controller";

afterEach(() => vi.useRealTimers());

class FakePtyProcess implements PtyProcess {
  readonly pid = 123;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  killed = false;
  exitOnKill = true;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.exitOnKill) this.emitExit(0);
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
    expect(controller.snapshot().find((item) => item.tabId === tab.tabId)).toBeUndefined();
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

  it("emits changed only when status or session metadata actually changes", async () => {
    const { controller, events } = harness();
    const tab = await controller.start({ cwd: "/repo" });
    events.splice(0);

    controller.applyStatusReport(report(tab.tabId, "waiting"));
    expect(events.filter((event) => event.type === "changed")).toHaveLength(1);
    events.splice(0);

    controller.applyStatusReport(report(tab.tabId, "waiting", 2));
    controller.updateMetadata({
      id: "session-1",
      path: "/sessions/one.jsonl",
      cwd: "/repo",
      title: "Auth cleanup",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      status: "waiting",
    });
    expect(events.filter((event) => event.type === "changed")).toHaveLength(0);

    controller.updateMetadata({
      id: "session-1",
      path: "/sessions/one.jsonl",
      cwd: "/repo",
      title: "Renamed auth cleanup",
      createdAt: 1,
      updatedAt: 3,
      archived: false,
      status: "waiting",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "changed",
      tab: expect.objectContaining({ title: "Renamed auth cleanup" }),
    }));
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
    expect(first.controller.snapshot().find((item) => item.tabId === failed.tabId)).toBeUndefined();
    expect(first.events).toContainEqual({ type: "exit", tabId: failed.tabId, exitCode: 2, status: "failed" });

    const second = harness();
    const stopped = await second.controller.start({ cwd: "/repo" });
    second.adapter.processes[0]?.emitExit(0);
    expect(second.controller.snapshot().find((item) => item.tabId === stopped.tabId)).toBeUndefined();
    expect(second.events).toContainEqual({ type: "exit", tabId: stopped.tabId, exitCode: 0, status: "stopped" });
  });

  it("escalates a stop and resolves only after the PTY confirms exit", async () => {
    vi.useFakeTimers();
    const adapter = new FakePtyAdapter();
    const controller = new SessionController({
      pty: adapter,
      invocationFor: () => ({ file: "/bin/pi", args: [] }),
      environmentFor: () => ({}),
      uuid: () => "tab-stop",
      stopTimeoutMs: 10,
      killTimeoutMs: 10,
    });
    const tab = await controller.start({ cwd: "/repo" });
    const process = adapter.processes[0];
    expect(process).toBeDefined();
    if (!process) throw new Error("missing fake process");
    process.exitOnKill = false;

    let settled = false;
    const stopping = controller.stop(tab.tabId).then(() => { settled = true; });
    await Promise.resolve();
    expect(process.killSignals).toEqual([undefined]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    expect(process.killSignals).toEqual([undefined, "SIGKILL"]);
    expect(settled).toBe(false);

    process.emitExit(0);
    await stopping;
    expect(settled).toBe(true);
    expect(controller.snapshot()).toEqual([]);
  });

  it("purges more than the protocol tab limit after delivering every exit", async () => {
    const { adapter, controller, events } = harness();
    for (let index = 0; index < 101; index += 1) {
      const tab = await controller.start({ cwd: "/repo" });
      adapter.processes[index]?.emitData(`output-${index}`);
      adapter.processes[index]?.emitExit(index % 2);
      expect(controller.replay(tab.tabId)).toBe("");
    }

    expect(events.filter((event) => event.type === "exit")).toHaveLength(101);
    expect(controller.snapshot()).toEqual([]);
    expect(isHostMessage({
      version: 1,
      type: "state.replace",
      snapshot: {
        sessions: [],
        tabs: controller.snapshot(),
        paneVisible: true,
        paneWidth: 248,
        collapsedGroups: [],
      },
    })).toBe(true);
  });

  it("starts a PTY without bridge variables when bridge environment lookup fails", async () => {
    const adapter = new FakePtyAdapter();
    const controller = new SessionController({
      pty: adapter,
      invocationFor: () => ({ file: "/bin/pi", args: [] }),
      environmentFor: () => { throw new Error("bridge unavailable"); },
      baseEnvironment: { PATH: "/bin" },
      uuid: () => "tab-fallback",
    });

    const tab = await controller.start({ cwd: "/repo" });

    expect(tab.status).toBe("starting");
    expect(adapter.spawns).toHaveLength(1);
    expect(adapter.spawns[0]?.options.env).toMatchObject({ PATH: "/bin", PI_VSCODE_MANAGER: "1" });
    expect(adapter.spawns[0]?.options.env).not.toHaveProperty("PI_VSCODE_STATUS_TOKEN");
  });

  it("classifies a missing Pi executable as actionable setup state and purges the failed record", async () => {
    const adapter = new FakePtyAdapter();
    const events: SessionControllerEvent[] = [];
    const controller = new SessionController({
      pty: adapter,
      invocationFor: () => { throw new PiCommandNotFoundError(["/missing/pi"]); },
      environmentFor: () => ({}),
      uuid: () => "tab-missing",
      onEvent: (event) => events.push(event),
    });

    const tab = await controller.start({ cwd: "/repo" });

    expect(tab).toMatchObject({ status: "failed", attached: false });
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      tabId: "tab-missing",
      setupError: "executable",
    }));
    expect(controller.snapshot()).toEqual([]);
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
