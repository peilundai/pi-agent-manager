import type { SessionSummary, SessionStatus, TerminalTab } from "../shared/model";
import { PiCommandNotFoundError, type PiInvocation } from "./command-resolver";
import type { PtyAdapter, PtyProcess } from "./pty-adapter";
import type { StatusReport } from "./status-report";

const MAX_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_CHUNK = 262_144;
const DEFAULT_REPLAY_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_000;

export type SessionControllerEvent =
  | { type: "changed"; tab: TerminalTab }
  | { type: "output"; tabId: string; data: string }
  | { type: "exit"; tabId: string; exitCode: number; status: "stopped" | "failed" }
  | { type: "error"; tabId: string; message: string; setupError?: "executable" };

export interface SessionControllerOptions {
  pty: PtyAdapter;
  invocationFor: (sessionPath?: string) => PiInvocation | Promise<PiInvocation>;
  environmentFor: (tabId: string) => Record<string, string>;
  baseEnvironment?: NodeJS.ProcessEnv;
  uuid?: () => string;
  onEvent?: (event: SessionControllerEvent) => void;
  maxReplayBytes?: number;
  stopTimeoutMs?: number;
  killTimeoutMs?: number;
}

export interface StartSessionOptions {
  cwd: string;
  sessionId?: string;
  sessionPath?: string;
}

interface SessionRecord {
  tab: TerminalTab;
  cwd: string;
  process?: PtyProcess;
  replay: string;
  exited: boolean;
  intentionalStop: boolean;
  subscriptions: Array<{ dispose(): void }>;
  exitPromise: Promise<void>;
  resolveExit(): void;
}

function cloneTab(tab: TerminalTab): TerminalTab {
  return { ...tab };
}

function isLiveStatus(status: SessionStatus): boolean {
  return status === "starting" || status === "working" || status === "waiting";
}

function processEnvironment(value: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function boundedReplay(previous: string, chunk: string, maximumBytes: number): string {
  const value = Buffer.from(`${previous}${chunk}`, "utf8");
  if (value.byteLength <= maximumBytes) return value.toString("utf8");
  return value.subarray(value.byteLength - maximumBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bracketedPaste(value: string): string {
  return `\u001b[200~${value}\u001b[201~`;
}

export class SessionController {
  private readonly records = new Map<string, SessionRecord>();
  private readonly pty: PtyAdapter;
  private readonly invocationFor: SessionControllerOptions["invocationFor"];
  private readonly environmentFor: SessionControllerOptions["environmentFor"];
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly uuid: () => string;
  private readonly onEvent: (event: SessionControllerEvent) => void;
  private readonly maxReplayBytes: number;
  private readonly stopTimeoutMs: number;
  private readonly killTimeoutMs: number;

  constructor(options: SessionControllerOptions) {
    this.pty = options.pty;
    this.invocationFor = options.invocationFor;
    this.environmentFor = options.environmentFor;
    this.baseEnvironment = options.baseEnvironment ?? process.env;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.onEvent = options.onEvent ?? (() => undefined);
    this.maxReplayBytes = options.maxReplayBytes ?? DEFAULT_REPLAY_BYTES;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
    if (!Number.isInteger(this.maxReplayBytes) || this.maxReplayBytes < 1) {
      throw new Error("Replay size must be a positive integer.");
    }
    if (!Number.isInteger(this.stopTimeoutMs) || this.stopTimeoutMs < 1 || !Number.isInteger(this.killTimeoutMs) || this.killTimeoutMs < 1) {
      throw new Error("Stop timeouts must be positive integers.");
    }
  }

  async start(options: StartSessionOptions): Promise<TerminalTab> {
    const existing = this.findLive(options.sessionId, options.sessionPath);
    if (existing) {
      if (!existing.tab.attached) {
        existing.tab.attached = true;
        this.emitChanged(existing);
      }
      return cloneTab(existing.tab);
    }

    const tabId = this.uuid();
    const tab: TerminalTab = {
      tabId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
      title: "New Agent",
      status: "starting",
      attached: true,
    };
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
    const record: SessionRecord = {
      tab,
      cwd: options.cwd,
      replay: "",
      exited: false,
      intentionalStop: false,
      subscriptions: [],
      exitPromise,
      resolveExit,
    };
    this.records.set(tabId, record);
    this.emitChanged(record);

    try {
      const invocation = await this.invocationFor(options.sessionPath);
      let bridgeEnvironment: Record<string, string> = {};
      try {
        bridgeEnvironment = this.environmentFor(tabId);
      } catch {
        // Pi remains usable when the optional live-status bridge is unavailable.
      }
      const env = {
        ...processEnvironment(this.baseEnvironment),
        ...(invocation.env ?? {}),
        ...bridgeEnvironment,
        TERM_PROGRAM: "vscode",
        PI_VSCODE_MANAGER: "1",
      };
      const process = this.pty.spawn(invocation.file, invocation.args, {
        cwd: options.cwd,
        env,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      record.process = process;
      record.subscriptions.push(
        process.onData((data) => this.handleData(record, data)),
        process.onExit((event) => this.handleExit(record, event.exitCode)),
      );
    } catch (error) {
      record.tab.status = "failed";
      record.tab.attached = false;
      record.exited = true;
      this.emitChanged(record);
      this.onEvent({
        type: "error",
        tabId,
        message: errorMessage(error),
        ...(error instanceof PiCommandNotFoundError ? { setupError: "executable" as const } : {}),
      });
      this.records.delete(tabId);
      record.replay = "";
      record.resolveExit();
    }

    return cloneTab(record.tab);
  }

  detach(tabId: string): void {
    const record = this.required(tabId);
    if (!record.tab.attached) return;
    record.tab.attached = false;
    this.emitChanged(record);
  }

  async stop(tabId: string): Promise<void> {
    const record = this.required(tabId);
    record.intentionalStop = true;
    if (record.tab.attached) {
      record.tab.attached = false;
      this.emitChanged(record);
    }
    const process = record.process;
    if (!process) {
      this.handleExit(record, 0);
      return;
    }
    process.kill();
    if (await this.waitForExit(record, this.stopTimeoutMs)) return;
    if (record.exited) return;
    process.kill("SIGKILL");
    if (await this.waitForExit(record, this.killTimeoutMs)) return;
    if (record.exited) return;
    throw new Error(`Pi did not exit after forced termination: ${tabId}`);
  }

  input(tabId: string, data: string): void {
    const record = this.requiredRunning(tabId);
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
      throw new Error("Terminal input is too large.");
    }
    record.process.write(data);
  }

  resize(tabId: string, cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 1_000 ||
      rows > 1_000
    ) {
      throw new Error("Invalid terminal dimensions.");
    }
    this.requiredRunning(tabId).process.resize(cols, rows);
  }

  rename(tabId: string, value: string): void {
    const record = this.requiredRunning(tabId);
    if (record.tab.status !== "waiting") throw new Error("Pi must be waiting before renaming a session.");
    const name = value.replace(/\s+/g, " ").trim();
    if (!name || name.length > 80) throw new Error("Session names must contain 1 to 80 characters.");
    record.process.write(bracketedPaste(`/name ${name}`));
    record.process.write("\r");
  }

  applyStatusReport(report: StatusReport): void {
    const record = this.records.get(report.tabId);
    if (!record || record.exited) return;
    const nextSessionId = report.sessionId || record.tab.sessionId;
    const nextSessionPath = report.sessionPath || record.tab.sessionPath;
    const nextTitle = typeof report.name === "string" && report.name.trim()
      ? report.name.trim()
      : report.name === null ? "New Agent" : record.tab.title;
    if (
      record.tab.status === report.status &&
      record.tab.sessionId === nextSessionId &&
      record.tab.sessionPath === nextSessionPath &&
      record.tab.title === nextTitle
    ) return;
    record.tab.status = report.status;
    if (nextSessionId) record.tab.sessionId = nextSessionId;
    if (nextSessionPath) record.tab.sessionPath = nextSessionPath;
    record.tab.title = nextTitle;
    this.emitChanged(record);
  }

  updateMetadata(session: SessionSummary): void {
    for (const record of this.records.values()) {
      if (record.tab.sessionId !== session.id && record.tab.sessionPath !== session.path) continue;
      if (
        record.tab.sessionId === session.id &&
        record.tab.sessionPath === session.path &&
        record.tab.title === session.title
      ) continue;
      record.tab.sessionId = session.id;
      record.tab.sessionPath = session.path;
      record.tab.title = session.title;
      this.emitChanged(record);
    }
  }

  replay(tabId: string): string {
    return this.records.get(tabId)?.replay ?? "";
  }

  snapshot(): TerminalTab[] {
    return [...this.records.values()].map((record) => cloneTab(record.tab));
  }

  dispose(): void {
    for (const record of this.records.values()) {
      for (const subscription of record.subscriptions) subscription.dispose();
      if (!record.exited && record.process) record.process.kill();
      record.resolveExit();
    }
    this.records.clear();
  }

  private findLive(sessionId?: string, sessionPath?: string): SessionRecord | undefined {
    if (!sessionId && !sessionPath) return undefined;
    return [...this.records.values()].find(
      (record) =>
        !record.exited &&
        isLiveStatus(record.tab.status) &&
        ((sessionId && record.tab.sessionId === sessionId) ||
          (sessionPath && record.tab.sessionPath === sessionPath)),
    );
  }

  private required(tabId: string): SessionRecord {
    const record = this.records.get(tabId);
    if (!record) throw new Error(`Unknown Pi tab: ${tabId}`);
    return record;
  }

  private requiredRunning(tabId: string): SessionRecord & { process: PtyProcess } {
    const record = this.required(tabId);
    if (!record.process || record.exited || !isLiveStatus(record.tab.status)) {
      throw new Error(`Pi tab is not running: ${tabId}`);
    }
    return record as SessionRecord & { process: PtyProcess };
  }

  private emitChanged(record: SessionRecord): void {
    this.onEvent({ type: "changed", tab: cloneTab(record.tab) });
  }

  private async waitForExit(record: SessionRecord, timeoutMs: number): Promise<boolean> {
    if (record.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const exited = record.exitPromise.then(() => true as const);
    const result = await Promise.race([exited, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private handleData(record: SessionRecord, data: string): void {
    record.replay = boundedReplay(record.replay, data, this.maxReplayBytes);
    for (let index = 0; index < data.length; index += MAX_OUTPUT_CHUNK) {
      this.onEvent({ type: "output", tabId: record.tab.tabId, data: data.slice(index, index + MAX_OUTPUT_CHUNK) });
    }
  }

  private handleExit(record: SessionRecord, exitCode: number): void {
    if (record.exited) return;
    record.exited = true;
    record.tab.status = record.intentionalStop || exitCode === 0 ? "stopped" : "failed";
    record.tab.attached = false;
    for (const subscription of record.subscriptions) subscription.dispose();
    record.subscriptions = [];
    this.emitChanged(record);
    this.onEvent({ type: "exit", tabId: record.tab.tabId, exitCode, status: record.tab.status });
    this.records.delete(record.tab.tabId);
    delete record.process;
    record.replay = "";
    record.resolveExit();
  }
}
