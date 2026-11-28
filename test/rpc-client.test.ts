// @vitest-environment node
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiRpcClient, RpcError, STDIO_DRAIN_MS } from "../src/pi/rpc-client";
import type { PiEvent } from "../src/pi/rpc-types";
import { FakeChild } from "./support/fake-child";

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

  describe("when Pi exits before its output is drained", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function fakeClient() {
      const child = new FakeChild();
      const log: string[] = [];
      const exits: Array<{ code: number | null; stderr: string; expected: boolean }> = [];
      const client = new PiRpcClient(
        { file: "pi", args: [], cwd: process.cwd(), env: {} },
        {
          onEvent: (event) => log.push(`event:${event.type}`),
          onExit: (info) => {
            log.push("exit");
            exits.push(info);
          },
        },
        () => child.asChild(),
      );
      return { child, client, log, exits };
    }

    it("reports the exit with the late stderr after the last records", async () => {
      const { child, client, log, exits } = fakeClient();
      await client.start();
      const answered = client.request({ type: "get_state" });
      const unanswered = client.request({ type: "prompt" });
      // The final record has no trailing newline, so it only arrives when the decoder is flushed.
      const late = `${JSON.stringify({ type: "response", id: "req-1", command: "get_state", success: true, data: { ok: true } })}\n${JSON.stringify({ type: "agent_settled" })}`;
      const drained = child.exitThenDrain(1, { stderr: "fatal: no model\n", stdout: late });

      // Once the process is gone nothing more is written to its stdin, even before it closes.
      await Promise.resolve();
      expect(client.running).toBe(false);
      client.send({ type: "abort" });
      await drained;

      await expect(answered).resolves.toEqual({ ok: true });
      await expect(unanswered).rejects.toThrow("Pi exited with code 1.");
      expect(log).toEqual(["event:agent_settled", "exit"]);
      expect(exits).toEqual([{ code: 1, signal: null, stderr: "fatal: no model\n", expected: false }]);
      expect(child.written.join("")).not.toContain("abort");
    });

    it("waits for the drained exit when stopping", async () => {
      const { child, client, exits } = fakeClient();
      await client.start();
      child.stdin.on("finish", () => void child.exitThenDrain(0, { stderr: "bye\n" }));
      await client.stop();
      expect(exits).toEqual([{ code: 0, signal: null, stderr: "bye\n", expected: true }]);
      expect(child.killed).toBe(false);
      // Stopping again after the exit has nothing to do.
      await client.stop();
    });

    it("still reports the exit when the pipes never close", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { child, client, exits } = fakeClient();
      await client.start();
      child.emit("exit", null, "SIGTERM");
      child.stderr.write("killed\n");
      await vi.advanceTimersByTimeAsync(STDIO_DRAIN_MS - 1);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(exits).toEqual([{ code: null, signal: "SIGTERM", stderr: "killed\n", expected: false }]);
      // A late close does not report it twice.
      child.emit("close", null, "SIGTERM");
      expect(exits).toHaveLength(1);
    });
  });
});
