import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { encodeJsonl, JsonlDecoder } from "./jsonl";
import type { RpcSpawnOptions } from "./rpc-client";
import type { PiEvent } from "./rpc-types";
import { RunReplay } from "./run-replay";

/**
 * The relay is a small detached Node process that owns `pi --mode rpc` on behalf of a VS Code
 * window. Reloading the window ends the extension host but not the relay, so Pi keeps working
 * and the next extension host reattaches over a local socket (a Unix domain socket in a private
 * temporary directory, or a named pipe on Windows) instead of starting over.
 *
 * Wire format: JSONL both ways. Pi's own records pass through unchanged, except that request ids
 * are scoped to one connection. Relay control records use `relay.*` types, which Pi never sends.
 */
export const RELAY_PROTOCOL = 1;
/** How long Pi outlives its window when nothing reattaches (a closed window, not a reload). */
export const RELAY_GRACE_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 8_192;
/** Prefix of the private directory that holds a relay's Unix socket. */
export const RELAY_DIR_PREFIX = "pi-agent-manager-";

export interface RelayConfig {
  protocol: typeof RELAY_PROTOCOL;
  /** Shared secret a client must present before it can talk to Pi. */
  token: string;
  socketPath: string;
  pi: RpcSpawnOptions;
  graceMs?: number;
}

export type RelaySpawnFn = (options: RpcSpawnOptions) => ChildProcessWithoutNullStreams;

const defaultSpawn: RelaySpawnFn = ({ file, args, cwd, env }) =>
  spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameSecret(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RelayServer {
  readonly pid: number | undefined;
  /** Settles once Pi has exited and the socket is closed. */
  readonly closed: Promise<void>;
  /** Stops Pi gracefully (stdin close, then kill). */
  stop(): void;
}

/** Spawns Pi, listens on the socket and resolves once both are up. */
export async function startRelay(config: RelayConfig, spawnFn: RelaySpawnFn = defaultSpawn): Promise<RelayServer> {
  const graceMs = config.graceMs ?? RELAY_GRACE_MS;
  const replay = new RunReplay();
  let client: { socket: Socket; connection: number } | undefined;
  let connections = 0;
  let stderrTail = "";
  let stopping = false;
  let exited = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const child = spawnFn(config.pi);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.stdin.on("error", () => undefined);

  const toClient = (record: unknown) => {
    if (client && !client.socket.destroyed) client.socket.write(encodeJsonl(record));
  };

  const stop = () => {
    if (exited || stopping) return;
    stopping = true;
    if (graceTimer) clearTimeout(graceTimer);
    const timer = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS);
    child.once("exit", () => clearTimeout(timer));
    child.stdin.end();
  };

  const startGrace = () => {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(stop, graceMs);
  };

  const fromPi = new JsonlDecoder((record) => {
    if (!isRecord(record) || typeof record.type !== "string") return;
    if (record.type === "response") {
      // Only the connection that asked gets the answer; a reloaded window starts its ids over.
      const id = typeof record.id === "string" ? /^(\d+):(.*)$/s.exec(record.id) : null;
      if (!id) return toClient(record);
      if (client && Number(id[1]) === client.connection) toClient({ ...record, id: id[2] });
      return;
    }
    replay.track(record as PiEvent);
    toClient(record);
  });
  child.stdout.on("data", (chunk: Buffer) => fromPi.push(chunk));
  child.stdout.on("end", () => fromPi.end());
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
    toClient({ type: "relay.stderr", text });
  });

  const fromClient = (connection: number, record: unknown) => {
    if (!isRecord(record) || typeof record.type !== "string" || client?.connection !== connection) return;
    if (record.type === "relay.stop") return stop();
    if (record.type === "extension_ui_response") {
      if (typeof record.id === "string") replay.respond(record.id);
    } else if (typeof record.id === "string") {
      record = { ...record, id: `${connection}:${record.id}` };
    }
    if (!exited) child.stdin.write(encodeJsonl(record));
  };

  const server: Server = createServer((socket) => {
    const connection = ++connections;
    let accepted = false;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const decoder = new JsonlDecoder((record) => {
      if (accepted) return fromClient(connection, record);
      clearTimeout(helloTimer);
      if (!isRecord(record) || record.type !== "relay.hello" || !sameSecret(config.token, record.token)) {
        socket.end(encodeJsonl({ type: "relay.refused", reason: "unauthorized" }));
        return;
      }
      if (record.protocol !== RELAY_PROTOCOL || exited || stopping) {
        socket.end(encodeJsonl({ type: "relay.refused", reason: exited || stopping ? "stopping" : "protocol" }));
        return;
      }
      accepted = true;
      if (graceTimer) clearTimeout(graceTimer);
      // The newest window wins: a reloaded window's old socket may not have closed yet.
      const previous = client;
      client = { socket, connection };
      previous?.socket.destroy();
      toClient({ type: "relay.welcome", pid: child.pid, cwd: config.pi.cwd, stderr: stderrTail });
      for (const event of replay.replay()) toClient(event);
      toClient({ type: "relay.replayed" });
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (client?.connection !== connection) return;
      client = undefined;
      if (!exited && !stopping) startGrace();
    });
  });

  child.once("exit", (code, signal) => {
    exited = true;
    if (graceTimer) clearTimeout(graceTimer);
    toClient({ type: "relay.exit", code, signal, stderr: stderrTail, expected: stopping });
    client?.socket.end();
    server.close(() => {
      removeSocketDirectory(config.socketPath);
      resolveClosed();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      child.kill();
      reject(error);
    });
    server.listen(config.socketPath, () => resolve());
  });
  // Nobody is attached yet; the window that launched us connects right away.
  startGrace();
  return { pid: child.pid, closed, stop };
}

/** Removes a Unix socket and the private directory created for it. Named pipes need nothing. */
function removeSocketDirectory(socketPath: string): void {
  if (process.platform === "win32") return;
  const directory = dirname(socketPath);
  if (!basename(directory).startsWith(RELAY_DIR_PREFIX)) return;
  rmSync(directory, { recursive: true, force: true });
}
