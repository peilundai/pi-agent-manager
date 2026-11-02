// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcClient, RpcError } from "../src/pi/rpc-client";
import type { PiEvent } from "../src/pi/rpc-types";

const fakePi = join(process.cwd(), "test/fixtures/fake-pi.mjs");

function createClient() {
  const events: PiEvent[] = [];
  const exits: Array<{ code: number | null; stderr: string; expected: boolean }> = [];
  const client = new PiRpcClient(
    { file: process.execPath, args: [fakePi], cwd: process.cwd(), env: process.env },
    { onEvent: (event) => events.push(event), onExit: (info) => exits.push(info) },
  );
  return { client, events, exits };
}

describe("PiRpcClient", () => {
  it("correlates responses and streams events", async () => {
    const { client, events } = createClient();
    await client.start();
    await expect(client.request({ type: "get_state" })).resolves.toEqual({ sessionId: "s1", text: "a b" });
    await expect(client.request({ type: "prompt", message: "hi" })).resolves.toEqual({ disposition: "started" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.map((event) => event.type)).toEqual(["agent_start", "message_update", "agent_settled"]);
    expect(events[1]).toMatchObject({ assistantMessageEvent: { delta: "hi there" } });
    await client.stop();
    expect(client.running).toBe(false);
  });

  it("rejects failed commands with the Pi error", async () => {
    const { client } = createClient();
    await client.start();
    await expect(client.request({ type: "nope" })).rejects.toThrow(RpcError);
    await expect(client.request({ type: "nope" })).rejects.toThrow("Unknown command: nope");
    await client.stop();
  });

  it("reports unexpected exits with stderr and rejects pending requests", async () => {
    const { client, exits } = createClient();
    await client.start();
    const pending = client.request({ type: "crash" });
    await expect(pending).rejects.toThrow(/exited with code 3/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([{ code: 3, signal: null, stderr: "boom\n", expected: false }]);
    await expect(client.request({ type: "get_state" })).rejects.toThrow("Pi is not running.");
  });

  it("fails to start when the executable is missing", async () => {
    const client = new PiRpcClient(
      { file: "/definitely/not/pi", args: [], cwd: process.cwd(), env: process.env },
      { onEvent: () => undefined, onExit: () => undefined },
    );
    await expect(client.start()).rejects.toThrow(/ENOENT/);
  });
});
