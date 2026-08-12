import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, TerminalTab } from "../src/shared/model";
import { PiViewProvider } from "../src/view/pi-view-provider";
import {
  activate,
  boundFilePosition,
  deactivate,
  resolveWorkspaceFolder,
  selectionFromEditor,
  selectionFromWorkspaceEditor,
} from "../src/extension";

const selectionFixture = {
  scheme: "file",
  relativePath: "src/auth.ts",
  languageId: "typescript",
  startLine: 7,
  endLine: 7,
  text: "await refreshToken();",
};

const sessionFixture: SessionSummary = {
  id: "session-1",
  path: "/repo/.pi/session-1.jsonl",
  cwd: "/repo",
  title: "Auth cleanup",
  createdAt: 100,
  updatedAt: 200,
  archived: false,
  status: "stopped",
};

class FakeController {
  readonly started: Array<{ cwd: string; sessionId?: string; sessionPath?: string }> = [];
  readonly inputs: Array<{ tabId: string; data: string }> = [];
  readonly detached: string[] = [];
  readonly stopped: string[] = [];
  readonly resizes: Array<{ tabId: string; cols: number; rows: number }> = [];
  readonly renames: Array<{ tabId: string; value: string }> = [];
  readonly reports: unknown[] = [];
  readonly metadata: SessionSummary[] = [];
  records: TerminalTab[] = [];
  replayText = "";
  startStatus: TerminalTab["status"] = "waiting";
  startAttached = true;
  disposed = false;
  failInput = false;
  bridgeStarted = () => true;

  async start(start: { cwd: string; sessionId?: string; sessionPath?: string }): Promise<TerminalTab> {
    if (!this.bridgeStarted()) throw new Error("bridge must start first");
    this.started.push(start);
    const existing = this.records.find((tab) =>
      (start.sessionId && tab.sessionId === start.sessionId) ||
      (start.sessionPath && tab.sessionPath === start.sessionPath));
    if (existing) {
      existing.attached = true;
      return { ...existing };
    }
    const tab: TerminalTab = {
      tabId: `tab-${this.started.length}`,
      ...(start.sessionId ? { sessionId: start.sessionId } : {}),
      ...(start.sessionPath ? { sessionPath: start.sessionPath } : {}),
      title: "New Agent",
      status: this.startStatus,
      attached: this.startAttached,
    };
    this.records.push(tab);
    return { ...tab };
  }

  input(tabId: string, data: string): void {
    if (this.failInput) throw new Error("input rejected");
    this.inputs.push({ tabId, data });
  }
  snapshot(): TerminalTab[] { return this.records.map((tab) => ({ ...tab })); }
  replay(): string { return this.replayText; }
  detach(tabId: string): void {
    this.detached.push(tabId);
    const tab = this.records.find((item) => item.tabId === tabId);
    if (tab) tab.attached = false;
  }
  async stop(tabId: string): Promise<void> {
    this.stopped.push(tabId);
    const tab = this.records.find((item) => item.tabId === tabId);
    if (tab) { tab.attached = false; tab.status = "stopped"; }
  }
  resize(tabId: string, cols: number, rows: number): void { this.resizes.push({ tabId, cols, rows }); }
  rename(tabId: string, value: string): void { this.renames.push({ tabId, value }); }
  applyStatusReport(report: unknown): void { this.reports.push(report); }
  updateMetadata(session: SessionSummary): void { this.metadata.push(session); }
  dispose(): void { this.disposed = true; }
}

function providerHarness(options: {
  activeSelection?: typeof selectionFixture;
  sessions?: SessionSummary[];
  persisted?: unknown;
  closeBehavior?: "detach" | "stop";
  confirmDelete?: boolean;
  requestedName?: string;
} = {}) {
  const order: string[] = [];
  const messages: unknown[] = [];
  const bridge = {
    started: false,
    disposed: false,
    async start() { order.push("bridge.start"); this.started = true; },
    async dispose() { this.disposed = true; },
  };
  const controller = new FakeController();
  controller.bridgeStarted = () => bridge.started;
  const repository = {
    sessions: options.sessions ?? [],
    listCalls: 0,
    deleted: [] as SessionSummary[],
    archived: [] as Array<{ sessionId: string; archived: boolean }>,
    watchCallback: undefined as (() => void) | undefined,
    watcherDisposed: false,
    async list() { order.push("repository.list"); this.listCalls += 1; return this.sessions.map((session) => ({ ...session })); },
    watch(_cwd: string, callback: () => void) {
      this.watchCallback = callback;
      return { dispose: () => { this.watcherDisposed = true; } };
    },
    async setArchived(sessionId: string, archived: boolean) {
      this.archived.push({ sessionId, archived });
      this.sessions = this.sessions.map((session) => session.id === sessionId ? { ...session, archived } : session);
    },
    async delete(session: SessionSummary) {
      this.deleted.push(session);
      this.sessions = this.sessions.filter((item) => item.id !== session.id);
    },
  };
  const host = {
    selection: options.activeSelection,
    reveals: 0,
    confirmed: options.confirmDelete ?? false,
    requestedName: options.requestedName,
    urls: [] as string[],
    files: [] as Array<{ path: string; line?: number; column?: number }>,
    captureEditorSelection() { order.push("selection.capture"); return this.selection; },
    async revealManager() { order.push("manager.reveal"); this.reveals += 1; },
    async confirmDelete() { return this.confirmed; },
    async requestName() { return this.requestedName; },
    async openUrl(target: string) { this.urls.push(target); },
    async openFile(target: { path: string; line?: number; column?: number }) { this.files.push(target); return true; },
    closeBehavior: () => options.closeBehavior ?? "detach" as const,
  };
  const state = {
    value: options.persisted,
    updates: [] as unknown[],
    delayAttached: false,
    releaseAttached: undefined as (() => void) | undefined,
    get() { return this.value; },
    async update(value: unknown) {
      this.updates.push(value);
      const openSessions = (value as { openSessions?: unknown[] }).openSessions ?? [];
      if (this.delayAttached && openSessions.length > 0) {
        await new Promise<void>((resolve) => { this.releaseAttached = resolve; });
      }
      this.value = value;
    },
  };
  let receive: ((message: unknown) => unknown) | undefined;
  let onPost: ((message: unknown) => void) | undefined;
  const webview = {
    cspSource: "vscode-webview:",
    options: {} as unknown,
    html: "",
    asWebviewUri: (uri: { toString(): string }) => uri,
    postMessage(message: unknown) { messages.push(message); onPost?.(message); return Promise.resolve(true); },
    onDidReceiveMessage(listener: (message: unknown) => unknown) {
      receive = listener;
      return { dispose() { receive = undefined; } };
    },
  };
  const view = { showCalls: 0, show() { this.showCalls += 1; }, webview };
  const distUri = { toString: () => "vscode-file:/extension/dist" };
  const provider = new PiViewProvider({
    cwd: "/repo",
    distUri,
    resourceUri: (path) => ({ toString: () => `vscode-file:/extension/dist/${path}` }),
    state,
    repository,
    controller,
    bridge,
    host,
    startupTimeoutMs: 50,
  });
  provider.resolveWebviewView(view);
  const send = async (message: unknown): Promise<void> => {
    await receive?.(message);
  };
  return {
    provider, controller, bridge, repository, host, state,
    webview: { messages, send, onPost(callback?: (message: unknown) => void) { onPost = callback; } },
    view, order, distUri,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await deactivate();
});

describe("PiViewProvider startup", () => {
  it("configures packaged roots and nonce CSP, owns watchers, and posts initial state", async () => {
    const harness = providerHarness({ sessions: [sessionFixture] });
    await harness.provider.start();

    expect(harness.webview.messages).toContainEqual(expect.objectContaining({
      version: 1,
      type: "state.replace",
      snapshot: expect.objectContaining({ sessions: [sessionFixture] }),
    }));
    expect(harness.view.webview.options).toEqual({ enableScripts: true, localResourceRoots: [harness.distUri] });
    expect(harness.view.webview.html).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(harness.view.webview.html).toContain("vscode-file:/extension/dist/webview.js");
    expect(harness.view.webview.html).toContain("vscode-file:/extension/dist/webview.css");
    expect(harness.view.webview.html).not.toContain("unsafe-inline");
    expect(harness.order.slice(0, 2)).toEqual(["bridge.start", "repository.list"]);

    await harness.provider.shutdown();
    expect(harness.repository.watcherDisposed).toBe(true);
    expect(harness.controller.disposed).toBe(true);
    expect(harness.bridge.disposed).toBe(true);
  });

  it("debounces transcript watcher refreshes by 150 milliseconds", async () => {
    vi.useFakeTimers();
    const harness = providerHarness();
    await harness.provider.start();
    harness.repository.watchCallback?.();
    harness.repository.watchCallback?.();
    await vi.advanceTimersByTimeAsync(149);
    expect(harness.repository.listCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.repository.listCalls).toBe(2);
  });
});

describe("PiViewProvider messages", () => {
  it("archives by detaching the matching tab without stopping its Pi process", async () => {
    const harness = providerHarness({ sessions: [sessionFixture] });
    await harness.provider.start();
    const tab: TerminalTab = {
      tabId: "tab-live", sessionId: sessionFixture.id, sessionPath: sessionFixture.path,
      title: sessionFixture.title, status: "waiting", attached: true,
    };
    harness.controller.records = [tab];
    harness.provider.handleControllerEvent({ type: "changed", tab });
    await vi.waitFor(() => expect((harness.state.value as { openSessions: unknown[] }).openSessions).toHaveLength(1));

    await harness.webview.send({ version: 1, type: "session.archive", sessionId: sessionFixture.id, archived: true });

    expect(harness.controller.detached).toEqual(["tab-live"]);
    expect(harness.controller.stopped).toEqual([]);
    expect(harness.controller.records[0]).toMatchObject({ tabId: "tab-live", attached: false, status: "waiting" });
    expect((harness.state.value as { openSessions: unknown[] }).openSessions).toEqual([]);
    const replacement = [...harness.webview.messages].reverse().find((message) =>
      (message as { type?: string }).type === "state.replace") as { snapshot: { tabs: TerminalTab[] } };
    expect(replacement.snapshot.tabs).toContainEqual(expect.objectContaining({ tabId: "tab-live", attached: false }));
  });

  it("does not replay or focus a tab detached while the ready snapshot is being delivered", async () => {
    const harness = providerHarness();
    await harness.provider.start();
    const tab: TerminalTab = { tabId: "tab-1", title: "Agent", status: "waiting", attached: true };
    harness.controller.records = [tab];
    harness.controller.replayText = "stale replay";
    await harness.webview.send({ version: 1, type: "session.focus", tabId: tab.tabId });
    const beforeReady = harness.webview.messages.length;
    let detachDuringSnapshot = true;
    harness.webview.onPost((message) => {
      if (!detachDuringSnapshot || (message as { type?: string }).type !== "state.replace") return;
      detachDuringSnapshot = false;
      harness.controller.detach(tab.tabId);
      harness.provider.handleControllerEvent({ type: "changed", tab: { ...tab, attached: false } });
    });

    await harness.webview.send({ version: 1, type: "ready" });

    expect(harness.webview.messages.slice(beforeReady)).not.toContainEqual(expect.objectContaining({ type: "terminal.output" }));
    expect(harness.webview.messages.slice(beforeReady)).not.toContainEqual(expect.objectContaining({ type: "terminal.focus" }));
  });

  it("serializes lifecycle persistence so a late attached write cannot restore a detached session", async () => {
    const harness = providerHarness({ sessions: [sessionFixture] });
    await harness.provider.start();
    harness.state.updates = [];
    harness.state.delayAttached = true;
    const attached: TerminalTab = {
      tabId: "tab-1", sessionId: sessionFixture.id, sessionPath: sessionFixture.path,
      title: sessionFixture.title, status: "working", attached: true,
    };
    harness.controller.records = [attached];
    harness.provider.handleControllerEvent({ type: "changed", tab: attached });
    await vi.waitFor(() => expect(harness.state.releaseAttached).toBeTypeOf("function"));

    const detached = { ...attached, attached: false };
    harness.controller.records = [detached];
    harness.provider.handleControllerEvent({ type: "changed", tab: detached });
    harness.state.releaseAttached?.();

    await vi.waitFor(() => expect(harness.state.updates).toHaveLength(2));
    await vi.waitFor(() => expect((harness.state.value as { openSessions: unknown[] }).openSessions).toEqual([]));
    await expect(harness.provider.shutdown()).resolves.toBeUndefined();
  });

  it("does not schedule lifecycle persistence after shutdown begins", async () => {
    const harness = providerHarness({ sessions: [sessionFixture] });
    await harness.provider.start();
    harness.state.updates = [];
    harness.state.delayAttached = true;
    const attached: TerminalTab = {
      tabId: "tab-1", sessionId: sessionFixture.id, sessionPath: sessionFixture.path,
      title: sessionFixture.title, status: "working", attached: true,
    };
    harness.controller.records = [attached];
    harness.provider.handleControllerEvent({ type: "changed", tab: attached });
    await vi.waitFor(() => expect(harness.state.releaseAttached).toBeTypeOf("function"));

    const shutdown = harness.provider.shutdown();
    const detached = { ...attached, attached: false };
    harness.controller.records = [detached];
    harness.provider.handleControllerEvent({ type: "changed", tab: detached });
    harness.state.releaseAttached?.();
    await shutdown;
    await Promise.resolve();

    expect(harness.state.updates).toHaveLength(1);
    expect(harness.controller.disposed).toBe(true);
  });

  it("forwards controller output and replaces session status after controller lifecycle changes", async () => {
    const harness = providerHarness({ sessions: [sessionFixture] });
    await harness.provider.start();
    const tab: TerminalTab = {
      tabId: "tab-1", sessionId: sessionFixture.id, sessionPath: sessionFixture.path,
      title: sessionFixture.title, status: "working", attached: true,
    };
    harness.controller.records = [tab];
    await harness.webview.send({ version: 1, type: "ready" });
    harness.provider.handleControllerEvent({ type: "changed", tab });
    harness.provider.handleControllerEvent({ type: "output", tabId: tab.tabId, data: "working\r\n" });
    await vi.waitFor(() => expect(harness.webview.messages).toContainEqual({
      version: 1, type: "terminal.output", tabId: "tab-1", data: "working\r\n",
    }));
    const replacement = [...harness.webview.messages].reverse().find((message) =>
      (message as { type?: string }).type === "state.replace") as { snapshot: { sessions: SessionSummary[] } };
    expect(replacement.snapshot.sessions[0]?.status).toBe("working");
  });

  it("handles ready once per webview and queues live output after the captured replay", async () => {
    const harness = providerHarness();
    await harness.provider.start();
    harness.controller.records = [{ tabId: "tab-1", title: "Agent", status: "waiting", attached: true }];
    harness.controller.replayText = "replay";
    let injected = false;
    harness.webview.onPost((message) => {
      if (!injected && (message as { type?: string }).type === "terminal.output") {
        injected = true;
        harness.provider.handleControllerEvent({ type: "output", tabId: "tab-1", data: "live" });
      }
    });
    await Promise.all([
      harness.webview.send({ version: 1, type: "ready" }),
      harness.webview.send({ version: 1, type: "ready" }),
    ]);
    const output = harness.webview.messages.filter((message) =>
      (message as { type?: string }).type === "terminal.output") as Array<{ data: string }>;
    expect(output.map((message) => message.data)).toEqual(["replay", "live"]);
  });

  it("drops detached output and does not focus failed new or resumed tabs", async () => {
    const fresh = providerHarness();
    await fresh.provider.start();
    fresh.controller.records = [{ tabId: "tab-detached", title: "Agent", status: "working", attached: false }];
    await fresh.webview.send({ version: 1, type: "ready" });
    const beforeOutput = fresh.webview.messages.length;
    fresh.provider.handleControllerEvent({ type: "output", tabId: "tab-detached", data: "background" });
    await Promise.resolve();
    expect(fresh.webview.messages.slice(beforeOutput)).toEqual([]);

    fresh.controller.records = [];
    fresh.controller.startStatus = "failed";
    fresh.controller.startAttached = false;
    const beforeNew = fresh.webview.messages.length;
    await fresh.webview.send({ version: 1, type: "session.new" });
    expect(fresh.webview.messages.slice(beforeNew)).not.toContainEqual(expect.objectContaining({ type: "terminal.focus" }));

    const resumed = providerHarness({ sessions: [sessionFixture] });
    await resumed.provider.start();
    resumed.controller.startStatus = "failed";
    resumed.controller.startAttached = false;
    await resumed.webview.send({ version: 1, type: "ready" });
    const beforeResume = resumed.webview.messages.length;
    await resumed.webview.send({ version: 1, type: "session.resume", sessionId: sessionFixture.id });
    expect(resumed.webview.messages.slice(beforeResume)).not.toContainEqual(expect.objectContaining({ type: "terminal.focus" }));
  });

  it("rechecks attachment after persistence before focusing new and resumed tabs", async () => {
    const fresh = providerHarness();
    await fresh.provider.start();
    fresh.controller.startStatus = "working";
    let detachNew = true;
    fresh.webview.onPost((message) => {
      if (detachNew && (message as { type?: string }).type === "state.replace" && fresh.controller.records[0]) {
        detachNew = false;
        fresh.controller.records[0].attached = false;
        fresh.controller.records[0].status = "failed";
      }
    });
    const beforeNew = fresh.webview.messages.length;
    await fresh.webview.send({ version: 1, type: "session.new" });
    expect(fresh.webview.messages.slice(beforeNew)).not.toContainEqual(expect.objectContaining({ type: "terminal.focus" }));

    const resumed = providerHarness({ sessions: [sessionFixture] });
    await resumed.provider.start();
    resumed.controller.startStatus = "waiting";
    let detachResume = true;
    resumed.webview.onPost((message) => {
      if (detachResume && (message as { type?: string }).type === "state.replace" && resumed.controller.records[0]) {
        detachResume = false;
        resumed.controller.records[0].attached = false;
        resumed.controller.records[0].status = "failed";
      }
    });
    const beforeResume = resumed.webview.messages.length;
    await resumed.webview.send({ version: 1, type: "session.resume", sessionId: sessionFixture.id });
    expect(resumed.webview.messages.slice(beforeResume)).not.toContainEqual(expect.objectContaining({ type: "terminal.focus" }));
  });

  it("rejects an unknown archive identifier without changing persisted archive state", async () => {
    const harness = providerHarness({ sessions: [sessionFixture] });
    await harness.provider.start();
    await harness.webview.send({ version: 1, type: "session.archive", sessionId: "forged", archived: true });
    expect(harness.repository.archived).toEqual([]);
    expect(harness.webview.messages).toContainEqual(expect.objectContaining({
      type: "notice", level: "error", message: expect.stringMatching(/unknown pi session/i),
    }));
  });

  it("replays bounded terminal chunks and focuses the active terminal when the webview is ready", async () => {
    const harness = providerHarness();
    await harness.provider.start();
    harness.controller.records = [{ tabId: "tab-1", title: "Agent", status: "waiting", attached: true }];
    harness.controller.replayText = "x".repeat(262_145);
    await harness.webview.send({ version: 1, type: "session.focus", tabId: "tab-1" });
    const beforeReady = harness.webview.messages.length;
    await harness.webview.send({ version: 1, type: "ready" });
    const readyMessages = harness.webview.messages.slice(beforeReady) as Array<{ type?: string; data?: string; tabId?: string }>;
    const output = readyMessages.filter((message) => message.type === "terminal.output");
    expect(output.map((message) => message.data?.length)).toEqual([262_144, 1]);
    expect(readyMessages).toContainEqual({ version: 1, type: "terminal.focus", tabId: "tab-1" });
  });

  it("guards malformed input and explicitly handles terminal and lifecycle messages", async () => {
    const harness = providerHarness({ sessions: [sessionFixture] });
    await harness.provider.start();
    harness.controller.records = [{
      tabId: "tab-live", sessionId: sessionFixture.id, sessionPath: sessionFixture.path,
      title: sessionFixture.title, status: "waiting", attached: true,
    }];

    await harness.webview.send({ version: 9, type: "session.stop", tabId: "tab-live" });
    await harness.webview.send({ version: 1, type: "terminal.input", tabId: "tab-live", data: "hello" });
    await harness.webview.send({ version: 1, type: "terminal.resize", tabId: "tab-live", cols: 100, rows: 30 });
    await harness.webview.send({ version: 1, type: "session.focus", tabId: "tab-live" });
    await harness.webview.send({ version: 1, type: "session.detach", tabId: "tab-live" });
    await harness.webview.send({ version: 1, type: "session.new" });
    await harness.webview.send({ version: 1, type: "session.resume", sessionId: sessionFixture.id });
    await harness.webview.send({ version: 1, type: "session.archive", sessionId: sessionFixture.id, archived: true });
    await harness.webview.send({ version: 1, type: "history.refresh" });

    expect(harness.controller.inputs).toContainEqual({ tabId: "tab-live", data: "hello" });
    expect(harness.controller.resizes).toContainEqual({ tabId: "tab-live", cols: 100, rows: 30 });
    expect(harness.controller.detached).toEqual(["tab-live", "tab-live"]);
    expect(harness.controller.started).toContainEqual({ cwd: "/repo" });
    expect(harness.controller.started).toContainEqual({ cwd: "/repo", sessionId: sessionFixture.id, sessionPath: sessionFixture.path });
    expect(harness.repository.archived).toEqual([{ sessionId: sessionFixture.id, archived: true }]);
    expect(harness.webview.messages).toContainEqual({ version: 1, type: "terminal.focus", tabId: "tab-live" });
    expect(harness.webview.messages.at(-1)).toMatchObject({ type: "state.replace" });
    expect(harness.controller.stopped).toEqual([]);
  });

  it("uses the configured stop behavior when closing a terminal tab", async () => {
    const harness = providerHarness({ closeBehavior: "stop" });
    await harness.provider.start();
    harness.controller.records = [{ tabId: "tab-1", title: "Agent", status: "working", attached: true }];
    await harness.webview.send({ version: 1, type: "session.detach", tabId: "tab-1" });
    expect(harness.controller.stopped).toEqual(["tab-1"]);
    expect(harness.controller.detached).toEqual([]);
  });

  it("requires host-modal deletion confirmation and renames through a waiting live tab", async () => {
    const rejected = providerHarness({ sessions: [sessionFixture], confirmDelete: false });
    await rejected.provider.start();
    await rejected.webview.send({ version: 1, type: "session.delete", sessionId: sessionFixture.id });
    expect(rejected.repository.deleted).toEqual([]);

    const accepted = providerHarness({ sessions: [sessionFixture], confirmDelete: true, requestedName: "New title" });
    await accepted.provider.start();
    accepted.controller.records = [{
      tabId: "tab-live", sessionId: sessionFixture.id, sessionPath: sessionFixture.path,
      title: sessionFixture.title, status: "waiting", attached: true,
    }];
    await accepted.webview.send({ version: 1, type: "session.rename", sessionId: sessionFixture.id });
    await accepted.webview.send({ version: 1, type: "session.delete", sessionId: sessionFixture.id });
    expect(accepted.controller.renames).toEqual([{ tabId: "tab-live", value: "New title" }]);
    expect(accepted.controller.stopped).toEqual(["tab-live"]);
    expect(accepted.repository.deleted).toEqual([sessionFixture]);
  });

  it("validates links and reports controller errors without rejecting message handling", async () => {
    const harness = providerHarness();
    await harness.provider.start();
    harness.controller.records = [{ tabId: "tab-1", title: "Agent", status: "waiting", attached: true }];
    harness.controller.failInput = true;
    await harness.webview.send({ version: 1, type: "link.open", kind: "url", target: "javascript:alert(1)" });
    await harness.webview.send({ version: 1, type: "link.open", kind: "url", target: "https://example.com/path" });
    await harness.webview.send({ version: 1, type: "link.open", kind: "file", target: "src/auth.ts:12:4" });
    await harness.webview.send({ version: 1, type: "terminal.input", tabId: "tab-1", data: "x" });
    expect(harness.host.urls).toEqual(["https://example.com/path"]);
    expect(harness.host.files).toEqual([{ path: "/repo/src/auth.ts", line: 11, column: 3 }]);
    expect(harness.webview.messages).toContainEqual(expect.objectContaining({
      type: "notice", level: "error", message: "input rejected",
    }));
  });
});

describe("PiViewProvider persistence and selection", () => {
  it("restores valid open sessions and persists view updates and attached transcripts", async () => {
    const harness = providerHarness({
      sessions: [sessionFixture],
      persisted: {
        paneVisible: false,
        paneWidth: 320,
        collapsedGroups: ["archived"],
        openSessions: [{ id: sessionFixture.id, path: sessionFixture.path }],
      },
    });
    await harness.provider.start();
    expect(harness.controller.started).toEqual([{ cwd: "/repo", sessionId: sessionFixture.id, sessionPath: sessionFixture.path }]);
    await harness.webview.send({
      version: 1, type: "view.update", paneVisible: true, paneWidth: 280, collapsedGroups: ["today"],
    });
    expect(harness.state.updates.at(-1)).toEqual({
      paneVisible: true,
      paneWidth: 280,
      collapsedGroups: ["today"],
      openSessions: [{ id: sessionFixture.id, path: sessionFixture.path }],
    });
  });

  it("opens a session and pastes selection without enter", async () => {
    const harness = providerHarness({ activeSelection: selectionFixture });
    await harness.provider.sendSelection();
    expect(harness.order.slice(0, 2)).toEqual(["selection.capture", "manager.reveal"]);
    expect(harness.controller.started).toHaveLength(1);
    expect(harness.controller.inputs[0]?.data.startsWith("\u001b[200~")).toBe(true);
    expect(harness.controller.inputs[0]?.data.endsWith("\u001b[201~")).toBe(true);
    expect(harness.controller.inputs[0]?.data).not.toContain("\r");
    expect(harness.webview.messages).toContainEqual(expect.objectContaining({ type: "terminal.focus" }));
  });

  it("waits for waiting status and leaves the manager open with a timeout notice", async () => {
    vi.useFakeTimers();
    const harness = providerHarness({ activeSelection: selectionFixture });
    harness.controller.startStatus = "starting";
    const sending = harness.provider.sendSelection();
    await vi.advanceTimersByTimeAsync(50);
    await sending;
    expect(harness.host.reveals).toBe(1);
    expect(harness.controller.inputs).toEqual([]);
    expect(harness.webview.messages).toContainEqual(expect.objectContaining({
      type: "notice", level: "warning", message: expect.stringMatching(/still starting/i),
    }));
  });
});

describe("extension activation", () => {
  const workspaceFolder = (name: string, fsPath: string, index: number) => ({
    name,
    index,
    uri: {
      scheme: "file",
      authority: "",
      path: fsPath,
      query: "",
      fragment: "",
      fsPath,
      toString: () => `file://${fsPath}`,
    },
  });

  const workspaceBoundary = (folders: ReturnType<typeof workspaceFolder>[]) => ({
    workspaceFolders: folders,
    getWorkspaceFolder(uri: { fsPath: string }) {
      return folders.find((folder) => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}/`));
    },
    asRelativePath(uri: { fsPath: string }) {
      const folder = this.getWorkspaceFolder(uri);
      return folder ? uri.fsPath.slice(folder.uri.fsPath.length + 1) : uri.fsPath;
    },
  });

  it("selects the active resource workspace and never guesses across multiple roots", () => {
    const first = workspaceFolder("first", "/repo-a", 0);
    const second = workspaceFolder("second", "/repo-b", 1);
    const workspace = workspaceBoundary([first, second]);
    const activeEditor = { document: { uri: { ...second.uri, fsPath: "/repo-b/src/auth.ts" } } };

    expect(resolveWorkspaceFolder(workspace, activeEditor)).toBe(second);
    expect(resolveWorkspaceFolder(workspace)).toBeUndefined();
    expect(resolveWorkspaceFolder(workspaceBoundary([first]))).toBe(first);
    expect(resolveWorkspaceFolder(workspaceBoundary([]))).toBeUndefined();
  });

  it("refuses to capture a selection from a different workspace root", () => {
    const first = workspaceFolder("first", "/repo-a", 0);
    const second = workspaceFolder("second", "/repo-b", 1);
    const workspace = workspaceBoundary([first, second]);
    const editor = {
      document: {
        uri: { ...second.uri, fsPath: "/repo-b/src/auth.ts" },
        fileName: "/repo-b/src/auth.ts",
        languageId: "typescript",
        lineAt: () => ({ text: "await refreshToken();" }),
        getText: () => "await refreshToken();",
      },
      selection: {
        isEmpty: true,
        active: { line: 4 },
        start: { line: 4 },
        end: { line: 4, character: 0 },
      },
    };

    expect(() => selectionFromWorkspaceEditor<typeof editor.document.uri, typeof first>(
      editor,
      first,
      workspace,
    )).toThrow(/different workspace.*first/i);
    expect(selectionFromWorkspaceEditor<typeof editor.document.uri, typeof second>(
      editor,
      second,
      workspace,
    )).toMatchObject({
      relativePath: "src/auth.ts",
      text: "await refreshToken();",
    });
  });

  it("prevents activation from starting a provider without an open workspace folder", async () => {
    const api = {
      window: { registerWebviewViewProvider: () => ({ dispose() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }) },
    };
    let providerCreated = false;
    await expect(activate(
      { subscriptions: [] } as never,
      {
        api: api as never,
        workspace: workspaceBoundary([]) as never,
        activeEditor: null,
        providerFactory: () => {
          providerCreated = true;
          throw new Error("provider must not be created");
        },
      },
    )).rejects.toThrow(/open a workspace folder/i);
    expect(providerCreated).toBe(false);
  });

  it("activates one provider scoped to the active folder in a multi-root workspace", async () => {
    const first = workspaceFolder("first", "/repo-a", 0);
    const second = workspaceFolder("second", "/repo-b", 1);
    const workspace = workspaceBoundary([first, second]);
    const activeEditor = { document: { uri: { ...second.uri, fsPath: "/repo-b/src/auth.ts" } } };
    const registered = new Map<string, () => unknown>();
    const api = {
      window: { registerWebviewViewProvider: () => ({ dispose() {} }) },
      commands: {
        registerCommand: (id: string, handler: () => unknown) => {
          registered.set(id, handler);
          return { dispose() {} };
        },
      },
    };
    const provider = {
      starts: 0,
      async start() { this.starts += 1; },
      async open() {},
      async newSession() {},
      async sendSelection() {},
      async shutdown() {},
    };
    let selected: typeof second | undefined;

    await activate(
      { subscriptions: [] } as never,
      {
        api: api as never,
        workspace: workspace as never,
        activeEditor: activeEditor as never,
        providerFactory: (folder) => {
          selected = folder as typeof second;
          return provider;
        },
      },
    );

    expect(selected).toBe(second);
    expect(provider.starts).toBe(1);
    expect([...registered.keys()]).toEqual(["piAgent.open", "piAgent.newSession", "piAgent.sendSelection"]);
  });

  it("bounds file-link positions to the opened document", () => {
    expect(boundFilePosition(
      { path: "/repo/src/auth.ts", line: 99, column: 99 },
      { lineCount: 2, lineAt: (line: number) => ({ text: line === 1 ? "short" : "first" }) },
    )).toEqual({ line: 1, column: 5 });
  });

  it("captures the current line when the editor selection is empty", () => {
    const selection = selectionFromEditor({
      document: {
        uri: { scheme: "file" },
        fileName: "/repo/src/auth.ts",
        languageId: "typescript",
        lineAt: (line: number) => ({ text: line === 4 ? "await refreshToken();" : "wrong line" }),
        getText: () => { throw new Error("empty selections must use lineAt"); },
      },
      selection: {
        isEmpty: true,
        active: { line: 4 },
        start: { line: 4 },
        end: { line: 4, character: 0 },
      },
    }, "src/auth.ts");
    expect(selection).toEqual({
      scheme: "file",
      relativePath: "src/auth.ts",
      languageId: "typescript",
      startLine: 4,
      endLine: 4,
      text: "await refreshToken();",
    });
  });

  it("registers the provider and all commands and delegates their actions", async () => {
    const registered = new Map<string, () => unknown>();
    const subscriptions: Array<{ dispose(): void }> = [];
    const provider = {
      starts: 0, opens: 0, news: 0, selections: 0, disposed: 0,
      async start() { this.starts += 1; },
      async open() { this.opens += 1; },
      async newSession() { this.news += 1; },
      async sendSelection() { this.selections += 1; },
      async shutdown() { this.disposed += 1; },
    };
    const api = {
      window: {
        registerWebviewViewProvider: (id: string) => {
          expect(id).toBe("piAgent.view");
          return { dispose() {} };
        },
      },
      commands: {
        registerCommand: (id: string, handler: () => unknown) => {
          registered.set(id, handler);
          return { dispose() {} };
        },
      },
    };
    const context = { subscriptions };
    await activate(context as never, { api: api as never, provider: provider as never });
    expect([...registered.keys()]).toEqual(["piAgent.open", "piAgent.newSession", "piAgent.sendSelection"]);
    await registered.get("piAgent.open")?.();
    await registered.get("piAgent.newSession")?.();
    await registered.get("piAgent.sendSelection")?.();
    expect(provider).toMatchObject({ starts: 1, opens: 1, news: 1, selections: 1 });
    await deactivate();
    expect(provider.disposed).toBe(1);
  });

  it("declares the exact command, view, keybinding, menu, and configuration contributions", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      contributes: {
        commands: [
          { command: "piAgent.open", title: "Pi: Open Agent Manager", icon: "media/pi.svg" },
          { command: "piAgent.newSession", title: "Pi: New Agent", icon: "$(add)" },
          { command: "piAgent.sendSelection", title: "Pi: Send Selection", icon: "$(send)" },
        ],
        keybindings: [{
          command: "piAgent.sendSelection", key: "ctrl+l", mac: "cmd+l",
          when: "editorTextFocus && resourceScheme =~ /^(file|untitled|vscode-remote)$/",
        }],
        viewsContainers: { secondarySidebar: [{ id: "piAgent", title: "Pi", icon: "media/pi.svg" }] },
        views: { piAgent: [{ type: "webview", id: "piAgent.view", name: "Agents", icon: "media/pi.svg" }] },
        menus: { "editor/title": [{ command: "piAgent.open", group: "navigation@1" }] },
        configuration: {
          title: "Pi Agent Manager",
          properties: {
            "piAgent.command": { type: "string", default: "pi", description: "Executable name or absolute path used to start Pi." },
            "piAgent.closeBehavior": { type: "string", enum: ["detach", "stop"], default: "detach", description: "Whether closing a session tab detaches its UI or stops Pi." },
          },
        },
      },
    });
  });
});
