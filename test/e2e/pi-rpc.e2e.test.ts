// End-to-end tests against the real Pi CLI (devDependency) talking to a mock LLM.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChatSession } from "../../src/pi/chat-session";
import type { PiCommand, PiModel, PiState } from "../../src/pi/rpc-types";
import type { HostToWebviewMessage } from "../../src/shared/protocol";
import { chatReducer, initialChatState, type ChatItem, type ChatState } from "../../src/webview/chat-state";
import { FINAL_ANSWER, startMockLlm, type MockLlm } from "./support/mock-llm";
import { createPiTestEnv, waitFor, type PiTestEnv } from "./support/pi-env";

let llm: MockLlm;
let pi: PiTestEnv;

beforeAll(async () => {
  llm = await startMockLlm();
  pi = await createPiTestEnv(llm.url);
});

afterAll(async () => {
  await pi?.cleanup();
  await llm?.close();
});

/** A ChatSession wired to a reducer, mirroring what the webview does. */
function harness(extraArgs: string[] = []) {
  const posted: HostToWebviewMessage[] = [];
  let state: ChatState = initialChatState;
  const session = new ChatSession({
    createClient: (listener) => pi.createClient(listener, extraArgs),
    post: (message) => {
      posted.push(message);
      state = chatReducer(state, { type: "host", message, now: Date.now() });
    },
    onSessionsChanged: () => undefined,
  });
  const send = async (text: string) => {
    state = chatReducer(state, { type: "user.send", text, images: [] });
    await session.prompt(text, [], "send");
  };
  const settled = (label: string) =>
    waitFor(() => posted.some((message) => message.type === "stats") && !state.busy && state, 30_000, label);
  return {
    session,
    posted,
    get state() {
      return state;
    },
    send,
    settled,
    resetPosted() {
      posted.length = 0;
    },
  };
}

const sessions: ChatSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await pi.resetGreet();
});

function track<T extends { session: ChatSession }>(value: T): T {
  sessions.push(value.session);
  return value;
}

function assistantText(items: ChatItem[]): string {
  return items
    .flatMap((item) => (item.kind === "assistant" ? item.blocks : []))
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

describe("Pi RPC contract", () => {
  it("answers the state, model and command queries with the shapes Pi Agent Manager expects", async () => {
    const h = track(harness());
    await h.session.ensureStarted();
    const snapshot = h.posted.find((message): message is Extract<HostToWebviewMessage, { type: "snapshot" }> => message.type === "snapshot");
    expect(snapshot).toBeDefined();
    const { state, models, commands } = snapshot!.snapshot as { state: PiState; models: PiModel[]; commands: PiCommand[] };
    expect(state).toMatchObject({ model: { id: "mock-1", provider: "mock", name: "Mock Sonnet", reasoning: true }, isStreaming: false });
    expect(typeof state.thinkingLevel).toBe("string");
    expect(state.sessionFile).toMatch(/\.jsonl$/);
    expect(models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "mock-2", provider: "mock", reasoning: false })]));
    expect(commands).toEqual(expect.arrayContaining([{ name: "hello", description: "Say hello from an extension", source: "extension" }]));
    expect(h.posted.filter((message) => message.type === "process").map((message) => (message as { status: string }).status)).toEqual(["starting", "ready"]);
  });
});

describe("Pi conversation", () => {
  it("streams a full tool-using turn, including an extension confirm dialog", async () => {
    const h = track(harness());
    await h.session.ensureStarted();
    await h.send("Fix the greeting in src/greet.ts");

    const dialog = await waitFor(() => h.state.items.find((item) => item.kind === "dialog"), 30_000, "confirm dialog");
    expect(dialog).toMatchObject({ request: { method: "confirm", title: "Allow bash command?", message: "cat src/greet.ts && echo done" } });
    // The live stream must not repeat the first delta that Pi includes in message_start.
    expect(assistantText(h.state.items)).toContain("I'll start by reading the greeting module.");
    expect(assistantText(h.state.items)).not.toMatch(/I'll I'll|Found Found/);
    h.session.respondToDialog({ id: (dialog as Extract<ChatItem, { kind: "dialog" }>).request.id, confirmed: true });

    const state = await h.settled("turn to settle");
    const tools = Object.values(state.tools);
    expect(tools.map((tool) => [tool.name, tool.status])).toEqual([
      ["read", "success"],
      ["edit", "success"],
      ["bash", "success"],
    ]);
    const edit = tools.find((tool) => tool.name === "edit");
    expect(String(edit?.details?.diff)).toMatch(/-\s*2\s+return "hello " \+ name;/);
    expect(String(edit?.details?.diff)).toMatch(/\+\s*2\s+return `Hello, \$\{name\}!`;/);
    expect(tools.find((tool) => tool.name === "bash")?.output).toContain("done");
    expect(assistantText(state.items)).toContain(FINAL_ANSWER.trim());
    expect(state.items[0]).toEqual(expect.objectContaining({ kind: "user", text: "Fix the greeting in src/greet.ts" }));
    expect(state.items.some((item) => item.kind === "user" && item.pending)).toBe(false);
    expect(state.stats?.contextUsage).toBeDefined();
    expect(await pi.readGreet()).toContain("return `Hello, ${name}!`;");
    // Thinking from the provider's reasoning stream is kept as a collapsible block.
    expect(state.items.some((item) => item.kind === "assistant" && item.blocks.some((block) => block.type === "thinking"))).toBe(true);
  });

  it("blocks the tool when the dialog is declined", async () => {
    const h = track(harness());
    await h.session.ensureStarted();
    await h.send("Fix the greeting again");
    const dialog = await waitFor(() => h.state.items.find((item) => item.kind === "dialog"), 30_000, "confirm dialog");
    h.session.respondToDialog({ id: (dialog as Extract<ChatItem, { kind: "dialog" }>).request.id, confirmed: false });
    const state = await h.settled("declined turn");
    const bash = Object.values(state.tools).find((tool) => tool.name === "bash");
    expect(bash?.status).toBe("error");
    expect(bash?.output).toContain("Blocked by user");
  });

  it("runs extension commands without a model turn", async () => {
    const h = track(harness());
    await h.session.ensureStarted();
    await h.send("/hello");
    await waitFor(() => h.state.items.find((item) => item.kind === "notice"), 10_000, "notify");
    expect(h.posted).toContainEqual({ version: 1, type: "prompt.result", disposition: "handled" });
    expect(h.state.items).toEqual([expect.objectContaining({ kind: "notice", level: "info", text: "Hello from the extension!" })]);
  });

  it("interrupts a streaming answer", async () => {
    const h = track(harness());
    await h.session.ensureStarted();
    await h.send("Write something slow");
    await waitFor(() => assistantText(h.state.items).includes("tick tick"), 15_000, "streaming text");
    await h.session.abort();
    const state = await waitFor(() => !h.state.busy && h.state, 15_000, "abort to settle");
    const last = state.items.at(-1);
    expect(last).toMatchObject({ kind: "assistant", stopReason: "aborted", error: "Interrupted", streaming: false });
  });

  it("surfaces provider errors on the assistant message", async () => {
    const h = track(harness());
    await h.session.ensureStarted();
    await h.send("please fail now");
    const state = await waitFor(() => (h.state.items.find((item) => item.kind === "assistant" && item.error) ? h.state : undefined), 60_000, "error");
    const failed = state.items.find((item) => item.kind === "assistant" && item.error);
    expect(failed).toMatchObject({ stopReason: "error" });
  });

  it("resumes a saved session and rebuilds the same transcript", async () => {
    const first = track(harness());
    await first.session.ensureStarted();
    await first.send("Give me a plain answer");
    const live = await first.settled("plain answer");
    const sessionFile = live.pi.sessionFile;
    expect(sessionFile).toBeTruthy();
    expect(assistantText(live.items)).toContain("a **short** answer");
    await first.session.dispose();

    const listed = await pi.repository.list(pi.workspace);
    expect(listed.map((session) => session.path)).toContain(sessionFile);
    expect(listed.find((session) => session.path === sessionFile)?.title).toBe("Give me a plain answer");

    const second = track(harness());
    await second.session.ensureStarted(sessionFile);
    const resumed = await waitFor(() => second.state.items.length > 0 && second.state, 15_000, "hydrated transcript");
    const shape = (items: ChatItem[]) => items.map((item) => (item.kind === "assistant" ? { kind: item.kind, blocks: item.blocks } : { kind: item.kind, text: (item as { text?: string }).text }));
    expect(shape(resumed.items)).toEqual(shape(live.items));
    expect(resumed.pi.sessionFile).toBe(sessionFile);
  });

  it("groups the calls of a codemode script under it, live and after a resume", async () => {
    const first = track(harness(["--tools", "+codemode"]));
    await first.session.ensureStarted();
    await first.send("Use codemode to read the module");
    const live = await first.settled("codemode turn");
    const blocks = live.items.flatMap((item) => (item.kind === "assistant" ? item.blocks : []));
    expect(blocks.filter((block) => block.type === "tool").map((block) => (block as { id: string }).id)).toEqual(["call_code_1"]);
    const script = live.tools.call_code_1!;
    expect(script).toMatchObject({ name: "codemode", status: "success" });
    expect(script.children).toHaveLength(2);
    const [read, missing] = script.children!.map((id) => live.tools[id]!);
    expect(read).toMatchObject({ name: "read", parentId: "call_code_1", status: "success", args: { path: "src/greet.ts" } });
    expect(read!.output).toContain("hello");
    expect(missing).toMatchObject({ name: "read", parentId: "call_code_1", status: "error" });

    const sessionFile = live.pi.sessionFile;
    await first.session.dispose();
    const second = track(harness(["--tools", "+codemode"]));
    await second.session.ensureStarted(sessionFile);
    const resumed = await waitFor(() => second.state.tools.call_code_1 && second.state, 15_000, "hydrated codemode");
    const tree = (state: ChatState) =>
      state.tools.call_code_1!.children!.map((id) => {
        const { name, args, status, parentId } = state.tools[id]!;
        return { id, name, args, status, parentId };
      });
    expect(tree(resumed)).toEqual(tree(live));
    expect(resumed.items.flatMap((item) => (item.kind === "assistant" ? item.blocks : [])).filter((block) => block.type === "tool")).toHaveLength(1);
  });

  it("switches models and thinking levels", async () => {
    const h = track(harness());
    await h.session.ensureStarted();
    await h.session.setThinkingLevel("high");
    expect(h.state.pi.thinkingLevel).toBe("high");
    await h.session.setModel("mock", "mock-2");
    expect(h.state.pi.model).toMatchObject({ id: "mock-2", reasoning: false });
  });

  it("starts a new chat with an empty transcript", async () => {
    const h = track(harness());
    await h.session.ensureStarted();
    await h.send("plain please");
    const before = await h.settled("plain");
    await h.session.newChat();
    await waitFor(() => h.state.items.length === 0 && h.state.pi.sessionFile !== before.pi.sessionFile, 10_000, "new session");
    expect(h.state.epoch).toBeGreaterThan(before.epoch);
  });
});
