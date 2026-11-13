// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeJsonl, JsonlDecoder } from "../src/pi/jsonl";
import { RelayClient, type RelayEndpoint } from "../src/pi/relay-client";
import { RELAY_DIR_PREFIX, RELAY_PROTOCOL, startRelay } from "../src/pi/relay-server";
import type { RpcClientListener } from "../src/pi/rpc-client";
import type { PiEvent } from "../src/pi/rpc-types";
import { buildRelayScript } from "./support/relay-script";

// The fake Pi puts U+2028 in a string, which must survive the relay intact.
const STATE = { sessionId: "s1", text: "a\u2028b" };
const fakePi = join(process.cwd(), "test/fixtures/fake-pi.mjs");
let script: string;

beforeAll(async () => {
  script = await buildRelayScript();
}, 30_000);

const clients: RelayClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await wait(10);
  }
}

function relayClient(options: { endpoint?: RelayEndpoint; graceMs?: number; token?: string } = {}) {
  const events: PiEvent[] = [];
  const exits: Array<Parameters<RpcClientListener["onExit"]>[0]> = [];
  const endpoints: Array<RelayEndpoint | undefined> = [];
  const client = new RelayClient(
    {
      spawnOptions: async () => ({ file: process.execPath, args: [fakePi], cwd: process.cwd(), env: process.env }),
      script,
      nodePath: process.execPath,
      cwd: process.cwd(),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      graceMs: options.graceMs ?? 5_000,
      onEndpoint: (endpoint) => endpoints.push(endpoint),
    },
    { onEvent: (event) => events.push(event), onExit: (info) => exits.push(info) },
  );
  clients.push(client);
  return { client, events, exits, endpoints };
}

describe("RelayClient", () => {
  it("runs Pi behind a detached relay and answers requests", async () => {
    const { client, endpoints, exits } = relayClient();
    await client.start();
    expect(client.running).toBe(true);
    expect(client.reattached).toBe(false);
    expect(endpoints).toEqual([expect.objectContaining({ cwd: process.cwd(), token: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    await expect(client.request({ type: "get_state" })).resolves.toEqual(STATE);
    await expect(client.request({ type: "nope" })).rejects.toThrow("Unknown command: nope");

    await client.stop();
    expect(client.running).toBe(false);
    await until(() => exits.length > 0, "exit");
    expect(exits).toEqual([{ code: 0, signal: null, stderr: "", expected: true }]);
    expect(endpoints.at(-1)).toBeUndefined();
    if (process.platform !== "win32") await until(() => !existsSync(dirname(endpoints[0]!.socketPath)), "socket cleanup");
  });

  it("keeps Pi running through a detach and replays the run in progress on reattach", async () => {
    const first = relayClient();
    await first.client.start();
    const endpoint = first.endpoints[0]!;
    await first.client.request({ type: "stream" });
    await until(() => first.events.some((event) => event.type === "extension_ui_request"), "dialog");
    await first.client.detach();
    expect(first.exits).toEqual([]);

    const second = relayClient({ endpoint });
    await second.client.start();
    expect(second.client.reattached).toBe(true);
    // The catch-up events are delivered before start() resolves, without the cumulative copies.
    expect(second.events).toEqual([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
      { type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow?" },
    ]);
    // Request ids start over in the new window without clashing with the old one.
    await expect(second.client.request({ type: "get_state" })).resolves.toEqual(STATE);

    second.client.send({ type: "extension_ui_response", id: "d1", confirmed: true });
    await second.client.request({ type: "finish" });
    await until(() => second.events.some((event) => event.type === "agent_settled"), "settle");
    expect(second.events.map((event) => event.type).slice(4)).toEqual(["dialog_answered", "message_update", "message_end", "agent_settled"]);

    // A settled run and an answered dialog leave nothing to catch up on.
    await second.client.detach();
    const third = relayClient({ endpoint });
    await third.client.start();
    expect(third.client.reattached).toBe(true);
    expect(third.events).toEqual([]);
  });

  it("starts a new relay when the remembered one stopped after its grace period", async () => {
    const first = relayClient({ graceMs: 100 });
    await first.client.start();
    const endpoint = first.endpoints[0]!;
    await first.client.detach();
    await wait(400);

    const second = relayClient({ endpoint });
    await second.client.start();
    expect(second.client.reattached).toBe(false);
    expect(second.endpoints).toEqual([undefined, expect.objectContaining({ cwd: process.cwd() })]);
    expect(second.endpoints[1]?.socketPath).not.toBe(endpoint.socketPath);
  });

  it("refuses a client without the relay's token", async () => {
    const first = relayClient();
    await first.client.start();
    const endpoint = first.endpoints[0]!;
    const intruder = relayClient({ endpoint: { ...endpoint, token: "0".repeat(64) } });
    await intruder.client.start();
    // It could not reattach, so it got its own Pi; the first one is untouched.
    expect(intruder.client.reattached).toBe(false);
    await expect(first.client.request({ type: "get_state" })).resolves.toEqual(STATE);
  });

  it("does not reuse a relay that runs Pi in another folder", async () => {
    const first = relayClient();
    await first.client.start();
    const second = relayClient({ endpoint: { ...first.endpoints[0]!, cwd: "/elsewhere" } });
    await second.client.start();
    expect(second.client.reattached).toBe(false);
  });

  it("reports an unexpected Pi exit with its stderr", async () => {
    const { client, exits, endpoints } = relayClient();
    await client.start();
    await expect(client.request({ type: "crash" })).rejects.toThrow(/exited with code 3/);
    await until(() => exits.length > 0, "exit");
    expect(exits).toEqual([{ code: 3, signal: null, stderr: "boom\n", expected: false }]);
    expect(endpoints.at(-1)).toBeUndefined();
    await expect(client.request({ type: "get_state" })).rejects.toThrow("Pi is not running.");
  });

  it("fails to start when Pi cannot be spawned", async () => {
    const client = new RelayClient(
      {
        spawnOptions: async () => ({ file: "/definitely/not/pi", args: [], cwd: process.cwd(), env: process.env }),
        script,
        nodePath: process.execPath,
        cwd: process.cwd(),
        onEndpoint: () => undefined,
      },
      { onEvent: () => undefined, onExit: () => undefined },
    );
    await expect(client.start()).rejects.toThrow(/ENOENT/);
  });
});

describe("startRelay", () => {
  /** A raw socket client that collects the relay's records. */
  function rawClient(socketPath: string) {
    const records: Array<Record<string, unknown>> = [];
    const socket = connect(socketPath);
    const decoder = new JsonlDecoder((record) => records.push(record as Record<string, unknown>));
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    let closed = false;
    socket.on("close", () => (closed = true));
    socket.on("error", () => undefined);
    return { socket, records, send: (record: unknown) => socket.write(encodeJsonl(record)), closed: () => closed };
  }

  async function relay(graceMs = 5_000) {
    const directory = await mkdtemp(join(tmpdir(), RELAY_DIR_PREFIX));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\${RELAY_DIR_PREFIX}${Date.now()}` : join(directory, "relay.sock");
    const server = await startRelay({
      protocol: RELAY_PROTOCOL,
      token: "secret",
      socketPath,
      graceMs,
      pi: { file: process.execPath, args: [fakePi], cwd: process.cwd(), env: process.env },
    });
    return { server, socketPath, directory };
  }

  it("refuses bad tokens and other protocol versions, and lets the newest window take over", async () => {
    const { server, socketPath } = await relay();
    try {
      const wrong = rawClient(socketPath);
      wrong.send({ type: "relay.hello", protocol: RELAY_PROTOCOL, token: "nope" });
      await until(() => wrong.closed(), "refusal");
      expect(wrong.records).toEqual([{ type: "relay.refused", reason: "unauthorized" }]);

      const old = rawClient(socketPath);
      old.send({ type: "relay.hello", protocol: 99, token: "secret" });
      await until(() => old.closed(), "refusal");
      expect(old.records).toEqual([{ type: "relay.refused", reason: "protocol" }]);

      const first = rawClient(socketPath);
      first.send({ type: "relay.hello", protocol: RELAY_PROTOCOL, token: "secret" });
      await until(() => first.records.some((record) => record.type === "relay.replayed"), "welcome");
      expect(first.records[0]).toMatchObject({ type: "relay.welcome", pid: server.pid, cwd: process.cwd() });
      first.send({ type: "get_state", id: "req-1" });
      await until(() => first.records.some((record) => record.type === "response"), "response");
      expect(first.records.at(-1)).toMatchObject({ type: "response", id: "req-1", success: true });

      const second = rawClient(socketPath);
      second.send({ type: "relay.hello", protocol: RELAY_PROTOCOL, token: "secret" });
      await until(() => first.closed() && second.records.some((record) => record.type === "relay.replayed"), "takeover");
      // An answer meant for the old window never reaches the new one.
      second.send({ type: "get_state", id: "req-1" });
      await until(() => second.records.some((record) => record.type === "response"), "response");
      expect(second.records.filter((record) => record.type === "response")).toHaveLength(1);
    } finally {
      server.stop();
      await server.closed;
    }
  });

  it("stops Pi when no window comes back within the grace period, and cleans up", async () => {
    const { server, socketPath, directory } = await relay(100);
    const client = rawClient(socketPath);
    client.send({ type: "relay.hello", protocol: RELAY_PROTOCOL, token: "secret" });
    await until(() => client.records.some((record) => record.type === "relay.replayed"), "welcome");
    client.socket.end();
    await server.closed;
    if (process.platform !== "win32") expect(existsSync(directory)).toBe(false);
  });

  it("drops a connection that never says hello", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { server, socketPath } = await relay();
    try {
      const silent = rawClient(socketPath);
      await vi.waitFor(() => expect(silent.socket.readyState).toBe("open"), { timeout: 2_000 });
      await vi.advanceTimersByTimeAsync(5_001);
      vi.useRealTimers();
      await until(() => silent.closed(), "hello timeout");
    } finally {
      vi.useRealTimers();
      server.stop();
      await server.closed;
    }
  });

  it("forwards Pi's stderr and exit to the attached window", async () => {
    const { server, socketPath } = await relay();
    const client = rawClient(socketPath);
    client.send({ type: "relay.hello", protocol: RELAY_PROTOCOL, token: "secret" });
    await until(() => client.records.some((record) => record.type === "relay.replayed"), "welcome");
    client.send({ type: "crash", id: "req-1" });
    await server.closed;
    await until(() => client.closed(), "close");
    expect(client.records.filter((record) => String(record.type).startsWith("relay.") && record.type !== "relay.welcome" && record.type !== "relay.replayed")).toEqual([
      { type: "relay.stderr", text: "boom\n" },
      { type: "relay.exit", code: 3, signal: null, stderr: "boom\n", expected: false },
    ]);
  });
});
