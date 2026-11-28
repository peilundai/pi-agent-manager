import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { encodeJsonl, JsonlDecoder } from "./jsonl";
import type { PiEvent, PiResponse } from "./rpc-types";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 8_192;
/**
 * How long to wait for Pi's stdio to drain after it exits. Node emits `exit` before the pipes
 * are read to the end; `close` follows once they are, unless a process Pi left behind still
 * holds them open.
 */
export const STDIO_DRAIN_MS = 1_000;

export interface RpcSpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RpcClientListener {
  onEvent(event: PiEvent): void;
  onExit(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string; expected: boolean }): void;
  /**
   * Called synchronously when a response is read, before its promise settles. Responses and
   * events share one ordered stream, so this marks the exact boundary between them.
   */
  onResponse?(response: { command: string; success: boolean }): void;
}

/** Spawn function seam for tests. */
export type SpawnFn = (options: RpcSpawnOptions) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = ({ file, args, cwd, env }) =>
  spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Request/response bookkeeping shared by every way of talking to Pi's RPC stream: a child
 * process (`PiRpcClient`) or a relay that keeps Pi alive across window reloads (`RelayClient`).
 */
export abstract class RpcPeer {
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;

  constructor(protected readonly listener: RpcClientListener) {}

  abstract get running(): boolean;
  protected abstract write(record: Record<string, unknown>): void;

  /** Sends a command and resolves with its `data` (or rejects with its `error`). */
  request<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.running) {
      return Promise.reject(new RpcError("Pi is not running.", command.type));
    }
    const id = `req-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Pi did not answer “${command.type}” in time.`, command.type));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ ...command, id });
    });
  }

  /** Sends a record that has no response (for example `extension_ui_response`). */
  send(record: Record<string, unknown>): void {
    if (this.running) this.write(record);
  }

  protected receive(record: unknown): void {
    if (!isRecord(record) || typeof record.type !== "string") return;
    if (record.type === "response") {
      const response = record as unknown as PiResponse;
      const pending = typeof response.id === "string" ? this.pending.get(response.id) : undefined;
      if (!pending || typeof response.id !== "string") return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      this.listener.onResponse?.({ command: response.command, success: response.success });
      if (response.success) pending.resolve(response.data);
      else pending.reject(new RpcError(response.error || `Pi rejected “${response.command}”.`, response.command));
      return;
    }
    this.listener.onEvent(record as PiEvent);
  }

  protected rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `Pi exited (signal ${signal}).` : `Pi exited with code ${code ?? "unknown"}.`;
}

/** A single `pi --mode rpc` child process speaking JSONL over stdio. */
export class PiRpcClient extends RpcPeer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stderrTail = "";
  private stopping = false;
  private exited = false;
  private finished: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: RpcSpawnOptions,
    listener: RpcClientListener,
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {
    super(listener);
  }

  get running(): boolean {
    return Boolean(this.child) && !this.exited;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(this.options);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.child = child;
      let markFinished: () => void = () => undefined;
      this.finished = new Promise<void>((done) => (markFinished = done));
      const decoder = new JsonlDecoder((record) => this.receive(record));
      child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
      child.stdout.on("end", () => decoder.end());
      child.stderr.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
      });
      child.stdin.on("error", () => undefined);
      let settled = false;
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          this.exited = true;
          reject(error);
        }
      });
      let reported = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      // Report only once stdout and stderr are drained, so the last records and the stderr tail
      // (often Pi's fatal error) are not lost.
      const report = (code: number | null, signal: NodeJS.Signals | null) => {
        if (reported) return;
        reported = true;
        clearTimeout(drainTimer);
        this.exited = true;
        decoder.end();
        this.rejectAll(new Error(exitMessage(code, signal)));
        if (settled) {
          this.listener.onExit({ code, signal, stderr: this.stderrTail, expected: this.stopping });
        }
        markFinished();
      };
      child.once("exit", (code, signal) => {
        // Stop writing right away: stdin is gone even though stdout may still be draining.
        this.exited = true;
        drainTimer = setTimeout(() => report(code, signal), STDIO_DRAIN_MS);
      });
      child.once("close", (code, signal) => report(code, signal));
    });
  }

  stderr(): string {
    return this.stderrTail;
  }

  /**
   * Closes stdin (Pi's graceful shutdown) and kills the process if it lingers. Resolves once
   * Pi's exit has been reported, or after the grace period.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const running = !this.exited;
    if (running) this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.exited) child.kill();
        resolve();
      }, SHUTDOWN_GRACE_MS);
      void this.finished.then(() => {
        clearTimeout(timer);
        resolve();
      });
      if (running) child.stdin.end();
    });
  }

  protected write(record: Record<string, unknown>): void {
    if (!this.exited) this.child?.stdin.write(encodeJsonl(record));
  }
}
