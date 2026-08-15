import { randomBytes } from "node:crypto";
import type { SessionSummary, SetupErrorState, TerminalTab, ViewSnapshot } from "../shared/model";
import type { SessionControllerEvent } from "../pi/session-controller";
import type { StatusReport } from "../pi/status-report";
import { isWebviewMessage, type HostToWebviewMessage, type WebviewToHostMessage } from "../shared/protocol";
import { asBracketedPaste, formatEditorSelection, type EditorSelectionContext } from "../editor/selection";
import { httpUrl, resolveFileTarget } from "../terminal/links";
import { normalizeViewState, type PersistedViewState } from "./view-state";

const HISTORY_DEBOUNCE_MS = 150;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const MAX_TERMINAL_OUTPUT = 262_144;

interface Disposable {
  dispose(): void;
}

export interface UriLike {
  toString(): string;
}

export interface StateStore {
  get(): unknown;
  update(value: PersistedViewState): PromiseLike<void> | Promise<void> | void;
}

export interface SessionRepositoryLike {
  list(cwd: string): Promise<SessionSummary[]>;
  watch(cwd: string, onChange: () => void): Disposable;
  setArchived(sessionId: string, archived: boolean): Promise<void>;
  delete(session: SessionSummary): Promise<void>;
}

export interface SessionControllerLike {
  start(options: { cwd: string; sessionId?: string; sessionPath?: string }): Promise<TerminalTab>;
  detach(tabId: string): void;
  stop(tabId: string): Promise<void>;
  input(tabId: string, data: string): void;
  resize(tabId: string, cols: number, rows: number): void;
  rename(tabId: string, value: string): void;
  applyStatusReport(report: StatusReport): void;
  updateMetadata(session: SessionSummary): void;
  replay(tabId: string): string;
  snapshot(): TerminalTab[];
  dispose(): void;
}

export interface StatusBridgeLike {
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiViewHost {
  captureEditorSelection(): EditorSelectionContext | undefined;
  revealManager(): Promise<void>;
  confirmDelete(session: SessionSummary): Promise<boolean>;
  requestName(session: SessionSummary): Promise<string | undefined>;
  openUrl(target: string): Promise<void>;
  openFile(target: { path: string; line?: number; column?: number }): Promise<boolean>;
  closeBehavior(): "detach" | "stop";
  warn(message: string): void;
  openFolder(): Promise<void>;
  chooseExecutable(): Promise<boolean>;
  openSettings(): Promise<void>;
  setWebviewFocused(focused: boolean): Promise<void>;
}

interface WebviewLike {
  cspSource: string;
  options: unknown;
  html: string;
  asWebviewUri(uri: UriLike): UriLike;
  postMessage(message: unknown): PromiseLike<boolean> | Promise<boolean> | boolean;
  onDidReceiveMessage(listener: (message: unknown) => unknown): Disposable;
}

interface WebviewViewLike {
  webview: WebviewLike;
  show?(preserveFocus?: boolean): void;
}

export interface PiViewProviderOptions {
  cwd: string;
  distUri: UriLike;
  resourceUri(path: string): UriLike;
  state: StateStore;
  repository: SessionRepositoryLike;
  controller: SessionControllerLike;
  bridge: StatusBridgeLike;
  host: PiViewHost;
  startupTimeoutMs?: number;
}

interface StatusWaiter {
  resolve(waiting: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attachedOpenSessions(tabs: readonly TerminalTab[]): PersistedViewState["openSessions"] {
  const seen = new Set<string>();
  return tabs.flatMap((tab) => {
    if (!tab.attached || !tab.sessionId || !tab.sessionPath || seen.has(tab.sessionId)) return [];
    seen.add(tab.sessionId);
    return [{ id: tab.sessionId, path: tab.sessionPath }];
  });
}

function activeOpenSession(
  tabs: readonly TerminalTab[],
  activeTabId: string | undefined,
): PersistedViewState["activeSession"] {
  const active = tabs.find((tab) => tab.tabId === activeTabId && tab.attached);
  return active?.sessionId && active.sessionPath
    ? { id: active.sessionId, path: active.sessionPath }
    : undefined;
}

function managerWebviewHtml(
  webview: WebviewLike,
  resourceUri: (path: string) => UriLike,
): string {
  const nonce = randomBytes(18).toString("base64url");
  const script = webview.asWebviewUri(resourceUri("webview.js")).toString();
  const style = webview.asWebviewUri(resourceUri("webview.css")).toString();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style}" />
    <title>Pi Agent Manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}

export class PiViewProvider {
  private persisted: PersistedViewState;
  private view: WebviewViewLike | undefined;
  private receiver: Disposable | undefined;
  private watcher: Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private startPromise: Promise<void> | undefined;
  private sessions: SessionSummary[] = [];
  private activeTabId: string | undefined;
  private viewGeneration = 0;
  private readyGeneration: number | undefined;
  private preparingGeneration: number | undefined;
  private queuedOutput: Array<{ tabId: string; data: string }> = [];
  private readonly statusWaiters = new Map<string, StatusWaiter>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private readonly lastStatuses = new Map<string, TerminalTab["status"]>();
  private setupError: SetupErrorState | undefined;
  private bridgeWarningShown = false;
  private stopped = false;

  constructor(private readonly options: PiViewProviderOptions) {
    this.persisted = normalizeViewState(options.state.get());
  }

  resolveWebviewView(view: WebviewViewLike): void {
    this.receiver?.dispose();
    this.view = view;
    this.viewGeneration += 1;
    this.readyGeneration = undefined;
    this.preparingGeneration = undefined;
    this.queuedOutput = [];
    view.webview.options = { enableScripts: true, localResourceRoots: [this.options.distUri] };
    view.webview.html = this.webviewHtml(view.webview);
    this.receiver = view.webview.onDidReceiveMessage((message) => this.receiveMessage(message));
    if (this.startPromise) void this.startPromise.then(() => this.postSnapshot(), () => undefined);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("Pi Agent Manager has been disposed.");
    this.startPromise ??= this.initialize();
    await this.startPromise;
  }

  async open(): Promise<void> {
    await this.options.host.revealManager();
    this.view?.show?.(true);
    await this.start();
    await this.postSnapshot();
  }

  async newSession(): Promise<TerminalTab> {
    await this.options.host.revealManager();
    this.view?.show?.(true);
    await this.start();
    const tab = await this.options.controller.start({ cwd: this.options.cwd });
    if (tab.status !== "failed") this.setupError = undefined;
    if (this.isFocusable(tab)) this.activeTabId = tab.tabId;
    await this.persistAndPost();
    const current = this.currentTab(tab.tabId);
    if (current && this.isFocusable(current)) {
      await this.post({ version: 1, type: "terminal.focus", tabId: current.tabId });
    } else {
      this.chooseActiveTab(tab.tabId);
    }
    return tab;
  }

  async sendSelection(): Promise<void> {
    const selection = this.options.host.captureEditorSelection();
    if (!selection) return;
    await this.options.host.revealManager();
    this.view?.show?.(true);
    await this.start();
    const tabs = this.options.controller.snapshot();
    const active = tabs.find((candidate) => candidate.tabId === this.activeTabId && this.isFocusable(candidate))
      ?? tabs.find((candidate) => this.isFocusable(candidate));
    const tab = active ?? await this.options.controller.start({ cwd: this.options.cwd });
    if (tab.status !== "failed") this.setupError = undefined;
    if (this.isFocusable(tab)) this.activeTabId = tab.tabId;
    await this.persistAndPost();
    const waiting = tab.status === "waiting" || await this.waitForWaiting(tab.tabId);
    if (!waiting) {
      await this.notice("warning", "Pi is still starting. Your selection was not sent; try again when the agent is ready.");
      return;
    }
    const current = this.currentTab(tab.tabId);
    if (!current || !this.isFocusable(current) || current.status !== "waiting") {
      await this.notice("warning", "Pi is no longer ready. Your selection was not sent.");
      return;
    }
    this.options.controller.input(current.tabId, asBracketedPaste(formatEditorSelection(selection)));
    await this.post({ version: 1, type: "terminal.focus", tabId: current.tabId });
  }

  handleControllerEvent(event: SessionControllerEvent): void {
    if (event.type === "output") {
      const attached = this.options.controller.snapshot().some((tab) => tab.tabId === event.tabId && tab.attached);
      if (!attached) return;
      if (this.preparingGeneration === this.viewGeneration) {
        this.queuedOutput.push({ tabId: event.tabId, data: event.data });
      } else if (this.readyGeneration === this.viewGeneration) {
        void this.post({ version: 1, type: "terminal.output", tabId: event.tabId, data: event.data });
      }
      return;
    }
    if (event.type === "error") {
      if (event.setupError === "executable") {
        this.setupError = { kind: "executable", message: event.message };
        void this.postSnapshot();
        return;
      }
      void this.notice("error", event.message);
      void this.postSnapshot();
      return;
    }
    if (event.type === "changed") {
      const previousStatus = this.lastStatuses.get(event.tab.tabId);
      this.lastStatuses.set(event.tab.tabId, event.tab.status);
      if (event.tab.attached && (!this.activeTabId || event.tab.tabId === this.activeTabId)) {
        this.activeTabId = event.tab.tabId;
      }
      const waiter = this.statusWaiters.get(event.tab.tabId);
      if (waiter && (event.tab.status === "waiting" || event.tab.status === "failed" || event.tab.status === "stopped")) {
        clearTimeout(waiter.timer);
        this.statusWaiters.delete(event.tab.tabId);
        waiter.resolve(event.tab.status === "waiting");
      }
      if (previousStatus !== "waiting" && event.tab.status === "waiting") this.scheduleRefresh();
      this.schedulePersistence();
      return;
    }
    this.lastStatuses.delete(event.tabId);
    this.chooseActiveTab();
    this.scheduleRefresh();
    this.schedulePersistence();
  }

  handleStatusReport(report: StatusReport): void {
    this.options.controller.applyStatusReport(report);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.receiver?.dispose();
    this.receiver = undefined;
    this.watcher?.dispose();
    this.watcher = undefined;
    for (const waiter of this.statusWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.statusWaiters.clear();
    await this.options.host.setWebviewFocused(false);
    await this.persistenceTail;
    this.options.controller.dispose();
    await this.options.bridge.dispose();
    this.view = undefined;
  }

  private async initialize(): Promise<void> {
    const desiredActiveSession = this.persisted.activeSession
      ? { ...this.persisted.activeSession }
      : undefined;
    try {
      await this.options.bridge.start();
    } catch (error) {
      if (!this.bridgeWarningShown) {
        this.bridgeWarningShown = true;
        this.options.host.warn(`Pi live status is unavailable. Sessions will still run without it: ${errorMessage(error)}`);
      }
    }
    await this.refreshHistory(false);
    this.watcher = this.options.repository.watch(this.options.cwd, () => this.scheduleRefresh());
    for (const open of this.persisted.openSessions) {
      const session = this.sessions.find((item) => item.id === open.id && item.path === open.path);
      if (!session) continue;
      const tab = await this.options.controller.start({
        cwd: this.options.cwd,
        sessionId: session.id,
        sessionPath: session.path,
      });
      if (!this.isFocusable(tab)) continue;
      if (
        desiredActiveSession?.id === session.id &&
        desiredActiveSession.path === session.path
      ) this.activeTabId = tab.tabId;
      else this.activeTabId ??= tab.tabId;
    }
    await this.persistAndPost();
  }

  private async receiveMessage(value: unknown): Promise<void> {
    if (!isWebviewMessage(value)) return;
    try {
      await this.handleMessage(value);
    } catch (error) {
      await this.notice("error", errorMessage(error));
    }
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.prepareWebview();
        return;
      case "session.new":
        await this.newSession();
        return;
      case "session.focus":
        this.requireTab(message.tabId);
        this.activeTabId = message.tabId;
        await this.persistAndPost();
        await this.post({ version: 1, type: "terminal.focus", tabId: message.tabId });
        return;
      case "session.detach":
        if (this.options.host.closeBehavior() === "stop") await this.options.controller.stop(message.tabId);
        else this.options.controller.detach(message.tabId);
        this.chooseActiveTab(message.tabId);
        await this.persistAndPost();
        return;
      case "session.stop":
        await this.options.controller.stop(message.tabId);
        this.chooseActiveTab(message.tabId);
        await this.persistAndPost();
        return;
      case "session.resume":
        await this.resume(message.sessionId);
        return;
      case "session.archive":
        {
          const session = this.requiredSession(message.sessionId);
          const live = message.archived ? this.liveTab(session) : undefined;
          await this.options.repository.setArchived(message.sessionId, message.archived);
          if (live) {
            this.options.controller.detach(live.tabId);
            this.chooseActiveTab(live.tabId);
            await this.persistAndPost();
          }
          await this.refreshHistory();
          return;
        }
      case "session.delete":
        await this.deleteSession(message.sessionId);
        return;
      case "session.rename":
        await this.renameSession(message.sessionId);
        return;
      case "history.refresh":
        await this.refreshHistory();
        return;
      case "view.focus":
        await this.options.host.setWebviewFocused(message.focused);
        return;
      case "setup.action":
        if (message.action === "openFolder") await this.options.host.openFolder();
        else if (message.action === "openSettings") await this.options.host.openSettings();
        else if (await this.options.host.chooseExecutable()) {
          this.setupError = undefined;
          await this.postSnapshot();
        }
        return;
      case "link.open":
        await this.openLink(message.kind, message.target);
        return;
      case "terminal.input":
        this.options.controller.input(message.tabId, message.data);
        return;
      case "terminal.resize":
        this.options.controller.resize(message.tabId, message.cols, message.rows);
        return;
      case "view.update":
        {
          const tabs = this.options.controller.snapshot();
          const activeSession = activeOpenSession(tabs, this.activeTabId);
          this.persisted = {
            paneVisible: message.paneVisible,
            paneWidth: message.paneWidth,
            collapsedGroups: [...message.collapsedGroups],
            openSessions: attachedOpenSessions(tabs),
            ...(activeSession ? { activeSession } : {}),
          };
        }
        await this.persistAndPost();
        return;
    }
  }

  private async resume(sessionId: string): Promise<void> {
    const session = this.requiredSession(sessionId);
    const tab = await this.options.controller.start({
      cwd: this.options.cwd,
      sessionId: session.id,
      sessionPath: session.path,
    });
    if (tab.status !== "failed") this.setupError = undefined;
    if (this.isFocusable(tab)) this.activeTabId = tab.tabId;
    await this.persistAndPost();
    const current = this.currentTab(tab.tabId);
    if (!current || !this.isFocusable(current)) {
      this.chooseActiveTab(tab.tabId);
      return;
    }
    const replay = this.options.controller.replay(current.tabId);
    await this.postReplay(current.tabId, replay);
    const focusable = this.currentTab(current.tabId);
    if (focusable && this.isFocusable(focusable)) {
      await this.post({ version: 1, type: "terminal.focus", tabId: focusable.tabId });
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const session = this.requiredSession(sessionId);
    if (!(await this.options.host.confirmDelete(session))) return;
    const live = this.liveTab(session, false);
    if (live) await this.options.controller.stop(live.tabId);
    await this.options.repository.delete(session);
    this.chooseActiveTab(live?.tabId);
    await this.refreshHistory();
  }

  private async renameSession(sessionId: string): Promise<void> {
    const session = this.requiredSession(sessionId);
    const live = this.liveTab(session);
    if (!live) throw new Error("Open this Pi session before renaming it.");
    const name = await this.options.host.requestName(session);
    if (name === undefined) return;
    this.options.controller.rename(live.tabId, name);
  }

  private async openLink(kind: "file" | "url", target: string): Promise<void> {
    if (kind === "url") {
      const url = httpUrl(target);
      if (url) await this.options.host.openUrl(url);
      return;
    }
    const file = resolveFileTarget(target, this.options.cwd);
    await this.options.host.openFile(file);
  }

  private async refreshHistory(post = true): Promise<void> {
    const liveTabs = this.options.controller.snapshot();
    this.sessions = (await this.options.repository.list(this.options.cwd)).map((session) => {
      const tab = liveTabs.find((item) => item.sessionId === session.id || item.sessionPath === session.path);
      const updated = tab ? { ...session, status: tab.status } : session;
      this.options.controller.updateMetadata(updated);
      return updated;
    });
    if (post) await this.postSnapshot();
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshHistory().catch((error) => this.notice("error", errorMessage(error)));
    }, HISTORY_DEBOUNCE_MS);
  }

  private async waitForWaiting(tabId: string): Promise<boolean> {
    const current = this.options.controller.snapshot().find((tab) => tab.tabId === tabId);
    if (current?.status === "waiting") return true;
    if (current?.status === "failed" || current?.status === "stopped") return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.statusWaiters.delete(tabId);
        resolve(false);
      }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
      this.statusWaiters.set(tabId, { resolve, timer });
    });
  }

  private liveTab(session: SessionSummary, attachedOnly = true): TerminalTab | undefined {
    return this.options.controller.snapshot().find((tab) =>
      (!attachedOnly || tab.attached) && (tab.sessionId === session.id || tab.sessionPath === session.path));
  }

  private currentTab(tabId: string): TerminalTab | undefined {
    return this.options.controller.snapshot().find((tab) => tab.tabId === tabId);
  }

  private isFocusable(tab: TerminalTab): boolean {
    return tab.attached && tab.status !== "failed" && tab.status !== "stopped";
  }

  private requiredSession(sessionId: string): SessionSummary {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`Unknown Pi session: ${sessionId}`);
    return session;
  }

  private requireTab(tabId: string): TerminalTab {
    const tab = this.options.controller.snapshot().find((item) => item.tabId === tabId && item.attached);
    if (!tab) throw new Error(`Unknown Pi tab: ${tabId}`);
    return tab;
  }

  private chooseActiveTab(excluded?: string): void {
    const next = this.options.controller.snapshot().find((tab) => tab.attached && tab.tabId !== excluded);
    this.activeTabId = next?.tabId;
  }

  private async persistAndPost(): Promise<void> {
    const run = this.persistenceTail.then(async () => {
      this.persisted = {
        paneVisible: this.persisted.paneVisible,
        paneWidth: this.persisted.paneWidth,
        collapsedGroups: [...this.persisted.collapsedGroups],
        openSessions: attachedOpenSessions(this.options.controller.snapshot()),
      };
      const activeSession = activeOpenSession(this.options.controller.snapshot(), this.activeTabId);
      if (activeSession) this.persisted.activeSession = activeSession;
      const persisted = {
        ...this.persisted,
        collapsedGroups: [...this.persisted.collapsedGroups],
        openSessions: this.persisted.openSessions.map((session) => ({ ...session })),
      };
      await this.options.state.update(persisted);
      if (!this.stopped) await this.postSnapshot();
    });
    this.persistenceTail = run.catch(() => undefined);
    await run;
  }

  private schedulePersistence(): void {
    if (this.stopped) return;
    void this.persistAndPost().catch((error) => {
      if (this.stopped) return;
      void this.notice("error", errorMessage(error)).catch(() => undefined);
    });
  }

  private snapshot(): ViewSnapshot {
    const tabs = this.options.controller.snapshot();
    const sessions = this.sessions.map((session) => {
      const tab = tabs.find((item) => item.sessionId === session.id || item.sessionPath === session.path);
      return tab ? { ...session, status: tab.status } : session;
    });
    const active = this.activeTabId && tabs.some((tab) => tab.tabId === this.activeTabId && tab.attached)
      ? this.activeTabId
      : undefined;
    return {
      sessions,
      tabs,
      ...(active ? { activeTabId: active } : {}),
      paneVisible: this.persisted.paneVisible,
      paneWidth: this.persisted.paneWidth,
      collapsedGroups: [...this.persisted.collapsedGroups],
      ...(this.setupError ? { setupError: this.setupError } : {}),
    };
  }

  private async postSnapshot(): Promise<void> {
    await this.post({ version: 1, type: "state.replace", snapshot: this.snapshot() });
  }

  private async prepareWebview(): Promise<void> {
    const generation = this.viewGeneration;
    if (this.readyGeneration === generation || this.preparingGeneration === generation) return;
    await this.start();
    if (generation !== this.viewGeneration) return;
    if (this.readyGeneration === generation || this.preparingGeneration === generation) return;
    this.preparingGeneration = generation;
    this.queuedOutput = [];
    const replay = this.options.controller.snapshot()
      .filter((tab) => tab.attached)
      .map((tab) => ({ tabId: tab.tabId, data: this.options.controller.replay(tab.tabId) }));
    await this.postSnapshot();
    for (const item of replay) {
      if (generation !== this.viewGeneration) return;
      if (!this.currentTab(item.tabId)?.attached) continue;
      await this.postReplay(item.tabId, item.data);
    }
    let index = 0;
    while (index < this.queuedOutput.length) {
      if (generation !== this.viewGeneration) return;
      const output = this.queuedOutput[index++];
      if (output && this.currentTab(output.tabId)?.attached) {
        await this.post({ version: 1, type: "terminal.output", ...output });
      }
    }
    if (generation !== this.viewGeneration) return;
    const active = this.activeTabId
      ? this.options.controller.snapshot().find((tab) => tab.tabId === this.activeTabId)
      : undefined;
    if (active && this.isFocusable(active)) {
      await this.post({ version: 1, type: "terminal.focus", tabId: active.tabId });
    }
    if (generation !== this.viewGeneration) return;
    this.readyGeneration = generation;
    this.preparingGeneration = undefined;
    this.queuedOutput = [];
  }

  private async postReplay(tabId: string, replay: string): Promise<void> {
    for (let index = 0; index < replay.length; index += MAX_TERMINAL_OUTPUT) {
      if (!this.currentTab(tabId)?.attached) return;
      await this.post({
        version: 1,
        type: "terminal.output",
        tabId,
        data: replay.slice(index, index + MAX_TERMINAL_OUTPUT),
      });
    }
  }

  private async notice(level: "info" | "warning" | "error", message: string): Promise<void> {
    await this.post({ version: 1, type: "notice", level, message: message.slice(0, 8_192) });
  }

  private async post(message: HostToWebviewMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private webviewHtml(webview: WebviewLike): string {
    return managerWebviewHtml(webview, this.options.resourceUri);
  }
}

export interface PiSetupViewProviderOptions {
  distUri: UriLike;
  resourceUri(path: string): UriLike;
  setupError: SetupErrorState;
  host: Pick<PiViewHost, "revealManager" | "openFolder" | "chooseExecutable" | "openSettings" | "setWebviewFocused">;
}

export class PiSetupViewProvider {
  private view: WebviewViewLike | undefined;
  private receiver: Disposable | undefined;

  constructor(private readonly options: PiSetupViewProviderOptions) {}

  resolveWebviewView(view: WebviewViewLike): void {
    this.receiver?.dispose();
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.options.distUri] };
    view.webview.html = managerWebviewHtml(view.webview, this.options.resourceUri);
    this.receiver = view.webview.onDidReceiveMessage((message) => this.receiveMessage(message));
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  async open(): Promise<void> {
    await this.options.host.revealManager();
    this.view?.show?.(true);
    await this.postSnapshot();
  }

  async newSession(): Promise<void> {
    await this.recover();
  }

  async sendSelection(): Promise<void> {
    await this.recover();
  }

  async shutdown(): Promise<void> {
    this.receiver?.dispose();
    this.receiver = undefined;
    await this.options.host.setWebviewFocused(false);
    this.view = undefined;
  }

  private async recover(): Promise<void> {
    if (this.options.setupError.kind === "workspace") await this.options.host.openFolder();
    else await this.options.host.chooseExecutable();
  }

  private async receiveMessage(value: unknown): Promise<void> {
    if (!isWebviewMessage(value)) return;
    if (value.type === "ready") await this.postSnapshot();
    else if (value.type === "view.focus") await this.options.host.setWebviewFocused(value.focused);
    else if (value.type === "setup.action") {
      if (value.action === "openFolder") await this.options.host.openFolder();
      else if (value.action === "chooseExecutable") await this.options.host.chooseExecutable();
      else await this.options.host.openSettings();
    }
  }

  private async postSnapshot(): Promise<void> {
    await this.view?.webview.postMessage({
      version: 1,
      type: "state.replace",
      snapshot: {
        sessions: [],
        tabs: [],
        paneVisible: true,
        paneWidth: 248,
        collapsedGroups: [],
        setupError: this.options.setupError,
      },
    } satisfies HostToWebviewMessage);
  }
}
