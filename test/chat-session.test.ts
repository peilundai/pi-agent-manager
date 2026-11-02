import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/pi/chat-session";
import { FakeClient } from "./support/fake-client";
import type { HostToWebviewMessage } from "../src/shared/protocol";

function setup(responses?: Record<string, unknown>) {
  const posted: HostToWebviewMessage[] = [];
  let client: FakeClient | undefined;
  const onSessionsChanged = vi.fn();
  const session = new ChatSession({
    createClient: async (listener) => (client = new FakeClient(listener, responses)),
    post: (message) => posted.push(message),
    onSessionsChanged,
  });
  return { session, posted, onSessionsChanged, client: () => client! };
}

describe("ChatSession", () => {
  it("starts Pi and posts a sanitized snapshot", async () => {
    const { session, posted } = setup();
    await session.ensureStarted();
    const snapshot = posted.find((message) => message.type === "snapshot");
    expect(snapshot && snapshot.type === "snapshot" && snapshot.snapshot).toMatchObject({
      state: { sessionFile: "/s/one.jsonl", thinkingLevel: "medium", model: { id: "m", provider: "p", name: "Model" } },
      messages: [{ role: "user", content: "hi" }],
      models: [{ id: "m", provider: "p", reasoning: false }],
      commands: [{ name: "skill:x", source: "skill", description: "" }],
      stats: { contextUsage: { percent: 12 } },
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(posted.map((message) => message.type)).toEqual(["process", "snapshot", "process"]);
    expect(session.running).toBe(true);
  });

  it("resumes a transcript through switch_session", async () => {
    const { session, client } = setup();
    await session.ensureStarted("/s/two.jsonl");
    expect(client().requests[0]).toEqual({ type: "switch_session", sessionPath: "/s/two.jsonl" });
  });

  it("sends prompts with images and uses follow-up while busy", async () => {
    const { session, client, posted } = setup({ prompt: { disposition: "queued" } });
    await session.ensureStarted();
    client().listener.onEvent({ type: "agent_start" });
    await session.prompt("next", [{ data: "AAAA", mimeType: "image/png" }], "send");
    expect(client().requests.at(-1)).toEqual({
      type: "prompt",
      message: "next",
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      streamingBehavior: "followUp",
    });
    await session.prompt("now", [], "steer");
    expect(client().requests.at(-1)).toMatchObject({ streamingBehavior: "steer" });
    expect(posted.filter((message) => message.type === "prompt.result")).toEqual([
      { version: 1, type: "prompt.result", disposition: "queued" },
      { version: 1, type: "prompt.result", disposition: "queued" },
    ]);
  });

  it("reports prompt failures to the webview", async () => {
    const { session, posted } = setup({ prompt: new Error("No API key") });
    await session.ensureStarted();
    await session.prompt("hi", [], "send");
    expect(posted.at(-1)).toEqual({ version: 1, type: "prompt.result", error: "No API key" });
  });

  it("batches and sanitizes events, then refreshes stats when settled", async () => {
    vi.useFakeTimers();
    try {
      const { session, client, posted, onSessionsChanged } = setup();
      await session.ensureStarted();
      posted.length = 0;
      client().listener.onEvent({ type: "agent_start" });
      client().listener.onEvent({ type: "message_start", message: { role: "system", content: "x" } });
      client().listener.onEvent({ type: "turn_end", message: { big: true }, toolResults: [1, 2] });
      expect(session.isBusy).toBe(true);
      await vi.advanceTimersByTimeAsync(20);
      expect(posted).toEqual([{ version: 1, type: "pi.events", events: [{ type: "agent_start" }, { type: "turn_end" }] }]);
      client().listener.onEvent({ type: "agent_settled", aborted: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.isBusy).toBe(false);
      expect(posted.map((message) => message.type)).toEqual(["pi.events", "pi.events", "state", "stats"]);
      expect(onSessionsChanged).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes set_editor_text to the composer and dialog answers back to Pi", async () => {
    const { session, client, posted } = setup();
    await session.ensureStarted();
    client().listener.onEvent({ type: "extension_ui_request", id: "e1", method: "set_editor_text", text: "draft" });
    expect(posted.at(-1)).toEqual({ version: 1, type: "composer.insert", text: "draft" });
    session.respondToDialog({ id: "d1", confirmed: true });
    expect(client().sent).toEqual([{ type: "extension_ui_response", id: "d1", confirmed: true }]);
  });

  it("reports an unexpected exit and restarts on demand", async () => {
    const { session, client, posted } = setup();
    await session.ensureStarted();
    const first = client();
    first.running = false;
    first.listener.onExit({ code: 1, signal: null, stderr: "fatal", expected: false });
    expect(posted.at(-1)).toEqual({ version: 1, type: "process", status: "exited", error: "Pi exited with code 1.", stderr: "fatal" });
    expect(session.running).toBe(false);
    await session.restart();
    expect(client()).not.toBe(first);
    expect(session.running).toBe(true);
  });

  it("aborts a busy run before switching sessions", async () => {
    const { session, client } = setup();
    await session.ensureStarted();
    client().listener.onEvent({ type: "agent_start" });
    await session.openSession("/s/other.jsonl");
    const types = client().requests.map((request) => request.type);
    expect(types.indexOf("abort")).toBeLessThan(types.indexOf("switch_session"));
  });
});
