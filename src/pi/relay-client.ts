import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeJsonl, JsonlDecoder } from "./jsonl";
import { exitMessage, RpcPeer, type RpcClientListener, type RpcSpawnOptions } from "./rpc-client";
import type { PiEvent } from "./rpc-types";
import { RELAY_DIR_PREFIX, RELAY_PROTOCOL, type RelayConfig } from "./relay-server";

const LAUNCH_TIMEOUT_MS = 15_000;
const ATTACH_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const STDERR_TAIL_BYTES = 8_192;

/** Where a running relay listens, remembered across window reloads. */
export interface RelayEndpoint {
  socketPath: string;
  token: string;
  cwd: string;
}

export function isRelayEndpoint(value: unknown): value is RelayEndpoint {
  if (!value || typeof value !== "object") return false;
  const { socketPath, token, cwd } = value as Record<string, unknown>;
  return typeof socketPath === "string" && typeof token === "string" && typeof cwd === "string";
}

export interface RelayClientOptions {
  /** Pi's command line; only resolved when a new relay has to be launched. */
  spawnOptions(): Promise<RpcSpawnOptions>;
  /** The bundled relay script (`dist/relay.js`). */
  script: string;
  /** A Node runtime; in VS Code, Electron's own binary with `ELECTRON_RUN_AS_NODE=1`. */
  nodePath: string;
  /** The working directory Pi must run in; a remembered relay elsewhere is not reused. */
  cwd: string;
  /** A relay left running by the previous window, to reattach to. */
  endpoint?: RelayEndpoint;
  /** Persists (or, with `undefined`, forgets) the relay this client is attached to. */
  onEndpoint(endpoint: RelayEndpoint | undefined): void;
  graceMs?: number;
}

/**
 * Talks to Pi through a detached relay process (see `relay-server.ts`) so Pi survives a window
 * reload. `start()` reattaches to the previous window's relay when it is still there, and
 * launches a new one otherwise. `detach()` lets go without stopping Pi; `stop()` ends it.
 */
export class RelayClient extends RpcPeer {
  private socket: Socket | undefined;
  private attached = false;
  private stopping = false;
  private detaching = false;
  private stderrTail = "";
  private endpoint: RelayEndpoint | undefined;
  private resumed = false;

  constructor(
    private readonly options: RelayClientOptions,
    listener: RpcClientListener,
  ) {
    super(listener);
  }

  get running(): boolean {
    return this.attached;
  }

  /** True when `start()` found Pi still running from before the reload. */
  get reattached(): boolean {
    return this.resumed;
  }

  async start(): Promise<void> {
    const previous = this.options.endpoint;
    if (previous && previous.cwd === this.options.cwd) {
      try {
        await this.attach(previous);
        this.resumed = true;
        return;
      } catch {
        // The relay is gone (closed window, reboot) or refused us: start a new one.
        this.options.onEndpoint(undefined);
      }
    }
    const endpoint = await this.launch();
    this.options.onEndpoint(endpoint);
    await this.attach(endpoint);
  }

  stderr(): string {
    return this.stderrTail;
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.attached) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, STOP_TIMEOUT_MS);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.write(encodeJsonl({ type: "relay.stop" }));
    });
  }

  async detach(): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.attached) return;
    this.detaching = true;
    this.attached = false;
    this.rejectAll(new Error("Pi Agent Manager detached from Pi."));
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.end();
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1_000).unref();
    });
  }

  protected write(record: Record<string, unknown>): void {
    if (this.attached) this.socket?.write(encodeJsonl(record));
  }

  /** Starts a detached relay that owns a new Pi process, and returns where it listens. */
  private async launch(): Promise<RelayEndpoint> {
    const pi = await this.options.spawnOptions();
    const token = randomBytes(32).toString("hex");
    const directory = process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), RELAY_DIR_PREFIX));
    const socketPath = directory
      ? join(directory, "relay.sock")
      : `\\\\.\\pipe\\${RELAY_DIR_PREFIX}${randomBytes(16).toString("hex")}`;
    const config: RelayConfig = {
      protocol: RELAY_PROTOCOL,
      token,
      socketPath,
      pi,
      ...(this.options.graceMs !== undefined ? { graceMs: this.options.graceMs } : {}),
    };
    const relay = spawn(this.options.nodePath, [this.options.script], {
      cwd: pi.cwd,
      env: { ...pi.env, ELECTRON_RUN_AS_NODE: "1" },
      // Its own process group (or console), so closing the window does not signal it.
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          relay.kill();
          reject(new Error("Pi's relay did not start in time."));
        }, LAUNCH_TIMEOUT_MS);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const decoder = new JsonlDecoder((record) => {
          const reply = record as { type?: unknown; message?: unknown };
          if (reply.type === "relay.ready") finish();
          else finish(new Error(typeof reply.message === "string" ? reply.message : "Pi's relay failed to start."));
        });
        relay.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
        relay.once("error", (error) => finish(error));
        relay.once("exit", (code) => finish(new Error(`Pi's relay exited with code ${code ?? "unknown"}.`)));
        relay.stdin.on("error", () => undefined);
        relay.stdin.end(encodeJsonl(config));
      });
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    relay.stdout.destroy();
    relay.removeAllListeners();
    relay.unref();
    return { socketPath, token, cwd: pi.cwd };
  }

  /** Connects, authenticates, and delivers the relay's catch-up events before resolving. */
  private attach(endpoint: RelayEndpoint): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint.socketPath);
      let welcomed = false;
      let replaying: PiEvent[] | undefined;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("Pi's relay did not answer.")), ATTACH_TIMEOUT_MS);
      const decoder = new JsonlDecoder((record) => {
        const message = record as Record<string, unknown> & { type?: unknown };
        if (!welcomed) {
          if (message.type !== "relay.welcome") {
            fail(new Error(`Pi's relay refused the connection (${String(message.reason ?? "unknown")}).`));
            return;
          }
          welcomed = true;
          replaying = [];
          if (typeof message.stderr === "string") this.stderrTail = message.stderr;
          return;
        }
        if (replaying) {
          if (message.type !== "relay.replayed") {
            replaying.push(message as PiEvent);
            return;
          }
          // Hand over the catch-up events in one go, so they all land before the first snapshot.
          const events = replaying;
          replaying = undefined;
          settled = true;
          clearTimeout(timer);
          this.socket = socket;
          this.endpoint = endpoint;
          this.attached = true;
          for (const event of events) this.receive(event);
          resolve();
          return;
        }
        this.fromRelay(message);
      });
      socket.on("connect", () => socket.write(encodeJsonl({ type: "relay.hello", protocol: RELAY_PROTOCOL, token: endpoint.token })));
      socket.on("data", (chunk: Buffer) => decoder.push(chunk));
      socket.on("error", (error) => fail(error));
      socket.on("close", () => {
        if (!settled) {
          fail(new Error("Pi's relay closed the connection."));
          return;
        }
        if (this.socket === socket) this.closed(undefined);
      });
    });
  }

  private fromRelay(message: Record<string, unknown>): void {
    switch (message.type) {
      case "relay.stderr":
        if (typeof message.text === "string") this.stderrTail = (this.stderrTail + message.text).slice(-STDERR_TAIL_BYTES);
        return;
      case "relay.exit":
        this.closed({
          code: typeof message.code === "number" ? message.code : null,
          signal: typeof message.signal === "string" ? (message.signal as NodeJS.Signals) : null,
          expected: Boolean(message.expected),
        });
        return;
      default:
        this.receive(message);
    }
  }

  /** Pi exited (with its exit status) or the relay went away (without one). */
  private closed(exit: { code: number | null; signal: NodeJS.Signals | null; expected: boolean } | undefined): void {
    if (this.detaching || (!this.attached && !exit)) return;
    const wasAttached = this.attached;
    this.attached = false;
    this.socket = undefined;
    if (this.endpoint) this.options.onEndpoint(undefined);
    this.endpoint = undefined;
    const code = exit?.code ?? null;
    const signal = exit?.signal ?? null;
    this.rejectAll(new Error(exit ? exitMessage(code, signal) : "Pi's relay stopped."));
    if (!wasAttached && !exit) return;
    this.listener.onExit({ code, signal, stderr: this.stderrTail, expected: this.stopping || Boolean(exit?.expected) });
  }
}
