import { describe, expect, it, vi } from "vitest";
import { ChatSession, withoutSnapshotCoverage, type RpcClientLike } from "../src/pi/chat-session";
import type { RpcClientListener } from "../src/pi/rpc-client";
import type { HostToWebviewMessage } from "../src/shared/protocol";
import type { PiEvent } from "../src/pi/rpc-types";

class FakeClient implements RpcClientLike {
  running = false;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly sent: Array<Record<string, unknown>> = [];
  constructor(readonly listener: RpcClientListener, private readonly responses: Record<string, unknown> = {}) {}
  async start() {
    this.running = true;
  }
  async request<T>(command: Record<string, unknown> & { type: string }): Promise<T> {
    this.requests.push(command);
    if (command.type in this.responses) {
      const value = this.responses[command.type];
      if (value instanceof Error) throw value;
      return value as T;
    }
    switch (command.type) {
      case "get_state":
        return { sessionFile: "/s/one.jsonl", sessionId: "one", thinkingLevel: "medium", model: { id: "m", provider: "p", name: "Model", cost: {} } } as T;
      case "get_messages":
        return { messages: [{ role: "system", content: "hidden" }, { role: "user", content: "hi" }] } as T;
      case "get_available_models":
        return { models: [{ id: "m", provider: "p", baseUrl: "secret" }] } as T;
      case "get_commands":
        return { commands: [{ name: "skill:x", source: "skill", sourceInfo: { path: "/x" } }] } as T;
      case "get_session_stats":
        return { contextUsage: { percent: 12 } } as T;
      default:
        return {} as T;
    }
  }
  send(record: Record<string, unknown>) {
    this.sent.push(record);
  }
  stderr() {
    return "";
  }
  async stop() {
    this.running = false;
  }
}

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

describe("ChatSession races", () => {
  it("stops a Pi process that finishes starting after dispose", async () => {
    let release: () => void = () => undefined;
    let created: FakeClient | undefined;
    const session = new ChatSession({
      createClient: async (listener) => {
        created = new FakeClient(listener);
        const start = created.start.bind(created);
        created.start = () => new Promise<void>((resolve) => (release = () => void start().then(resolve)));
        created.stop = vi.fn(async () => {
          created!.running = false;
        });
        return created;
      },
      post: () => undefined,
      onSessionsChanged: () => undefined,
    });
    const starting = session.ensureStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.dispose();
    release();
    await expect(starting).rejects.toThrow("startup was cancelled");
    expect(created?.stop).toHaveBeenCalled();
    expect(session.running).toBe(false);
  });

  /** Starts a session whose fake client emits `before`/`after` events around the get_messages response. */
  async function snapshotHarness(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>) {
    const posted: HostToWebviewMessage[] = [];
    let client: FakeClient | undefined;
    const session = new ChatSession({
      createClient: async (listener) => (client = new FakeClient(listener)),
      post: (message) => posted.push(message),
      onSessionsChanged: () => undefined,
    });
    await session.ensureStarted();
    const fake = client!;
    const request = fake.request.bind(fake);
    fake.request = async <T,>(command: Record<string, unknown> & { type: string }) => {
      if (command.type === "get_messages") {
        for (const event of before) fake.listener.onEvent(event as PiEvent);
        fake.listener.onResponse?.({ command: "get_messages", success: true });
        for (const event of after) fake.listener.onEvent(event as PiEvent);
      }
      return request<T>(command);
    };
    return { session, posted, fake };
  }

  const replayed = (posted: HostToWebviewMessage[]) =>
    posted.flatMap((message) => (message.type === "pi.events" ? message.events : []));

  it("drops completed messages the snapshot covers and replays everything else in order", async () => {
    const { session, posted } = await snapshotHarness(
      [
        { type: "turn_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "old" } },
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
        { type: "compaction_end", reason: "manual", result: { tokensBefore: 10 }, aborted: false },
      ],
      [{ type: "message_start", message: { role: "assistant", content: [] } }],
    );
    posted.length = 0;
    await session.postSnapshot();
    expect(posted[0]?.type).toBe("snapshot");
    expect(replayed(posted)).toEqual([
      { type: "turn_start" },
      { type: "compaction_end", reason: "manual", aborted: false },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);
  });

  it("keeps a message that is still streaming at the boundary", async () => {
    const { session, posted } = await snapshotHarness(
      [
        { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
      ],
      [{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } }],
    );
    posted.length = 0;
    await session.postSnapshot();
    expect(replayed(posted).map((event) => event.type)).toEqual(["message_start", "message_update", "message_update"]);
  });

  it("never drops an extension dialog and re-sends pending ones after each snapshot", async () => {
    const dialog = { type: "extension_ui_request", id: "d1", method: "editor", title: "Commit message" };
    const { session, posted, fake } = await snapshotHarness([dialog], []);
    posted.length = 0;
    await session.postSnapshot();
    // Once from the replayed stream and once as a pending dialog; the webview dedupes by id.
    expect(replayed(posted).filter((event) => event.id === "d1")).toHaveLength(2);

    posted.length = 0;
    await session.postSnapshot();
    expect(replayed(posted).filter((event) => event.id === "d1").length).toBeGreaterThan(0);

    session.respondToDialog({ id: "d1", value: "fix: x" });
    expect(fake.sent).toEqual([{ type: "extension_ui_response", id: "d1", value: "fix: x" }]);
    posted.length = 0;
    fake.request = FakeClient.prototype.request.bind(fake);
    await session.postSnapshot();
    expect(replayed(posted).some((event) => event.id === "d1")).toBe(false);
  });

  it("re-sends timed dialogs with their remaining time and forgets expired ones", async () => {
    vi.useFakeTimers();
    try {
      const posted: HostToWebviewMessage[] = [];
      let client: FakeClient | undefined;
      const session = new ChatSession({
        createClient: async (listener) => (client = new FakeClient(listener)),
        post: (message) => posted.push(message),
        onSessionsChanged: () => undefined,
      });
      await session.ensureStarted();
      client!.listener.onEvent({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Allow?", timeout: 10_000 });
      await vi.advanceTimersByTimeAsync(4_000);
      posted.length = 0;
      await session.postSnapshot();
      const resent = replayed(posted).find((event) => event.id === "c1");
      expect(resent?.timeout).toBeLessThanOrEqual(6_000);
      expect(resent?.timeout).toBeGreaterThan(5_000);
      await vi.advanceTimersByTimeAsync(7_000);
      posted.length = 0;
      await session.postSnapshot();
      expect(replayed(posted).some((event) => event.id === "c1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

});

describe("withoutSnapshotCoverage", () => {
  it("drops orphan message ends and keeps unrelated events", () => {
    expect(
      withoutSnapshotCoverage([
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } },
        { type: "message_end", message: { role: "assistant" } },
        { type: "tool_execution_start", toolCallId: "t" },
        { type: "tool_execution_end", toolCallId: "t" },
        { type: "queue_update", steering: [], followUp: ["next"] },
      ]),
    ).toEqual([
      { type: "tool_execution_start", toolCallId: "t" },
      { type: "tool_execution_end", toolCallId: "t" },
      { type: "queue_update", steering: [], followUp: ["next"] },
    ]);
  });
});
