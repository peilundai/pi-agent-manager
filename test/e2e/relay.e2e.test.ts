// A window reload in the middle of a run, against the real Pi CLI behind the relay.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatSession } from "../../src/pi/chat-session";
import { RelayClient, type RelayEndpoint } from "../../src/pi/relay-client";
import type { HostToWebviewMessage } from "../../src/shared/protocol";
import { chatReducer, initialChatState, type ChatItem, type ChatState } from "../../src/webview/chat-state";
import { buildRelayScript } from "../support/relay-script";
import { startMockLlm, type MockLlm } from "./support/mock-llm";
import { createPiTestEnv, waitFor, type PiTestEnv } from "./support/pi-env";

let llm: MockLlm;
let pi: PiTestEnv;
let script: string;
let endpoint: RelayEndpoint | undefined;

beforeAll(async () => {
  [llm, script] = await Promise.all([startMockLlm(), buildRelayScript()]);
  pi = await createPiTestEnv(llm.url);
});

afterAll(async () => {
  await pi?.cleanup();
  await llm?.close();
});

/** One "window": a ChatSession behind a relay, wired to the webview reducer. */
function window() {
  let state: ChatState = initialChatState;
  const session = new ChatSession({
    createClient: async (listener) =>
      new RelayClient(
        {
          spawnOptions: async () => pi.spawnOptions(),
          script,
          nodePath: process.execPath,
          cwd: pi.workspace,
          ...(endpoint ? { endpoint } : {}),
          onEndpoint: (next) => (endpoint = next),
        },
        listener,
      ),
    post: (message: HostToWebviewMessage) => {
      state = chatReducer(state, { type: "host", message, now: Date.now() });
    },
    onSessionsChanged: () => undefined,
  });
  return {
    session,
    get state() {
      return state;
    },
    async send(text: string) {
      state = chatReducer(state, { type: "user.send", text, images: [] });
      await session.prompt(text, [], "send");
    },
  };
}

const assistants = (items: ChatItem[]) => items.filter((item): item is Extract<ChatItem, { kind: "assistant" }> => item.kind === "assistant");
const text = (items: ChatItem[]) =>
  assistants(items)
    .flatMap((item) => item.blocks)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

describe("Pi behind the relay", () => {
  it("keeps streaming through a window reload and shows the run where it left off", async () => {
    const before = window();
    await before.session.ensureStarted();
    await before.send("Write something slow");
    await waitFor(() => text(before.state.items).includes("tick tick tick"), 15_000, "streaming text");
    const sessionFile = before.state.pi.sessionFile;
    const seen = text(before.state.items);
    await before.session.detach(); // the window reloads

    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = window();
    await after.session.ensureStarted();
    const resumed = await waitFor(() => after.state.busy && text(after.state.items).length > seen.length && after.state, 15_000, "reattached run");
    // Same chat, one user message, one streaming answer that kept growing while we were away.
    expect(resumed.pi.sessionFile).toBe(sessionFile);
    expect(resumed.items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(assistants(resumed.items)).toHaveLength(1);
    expect(assistants(resumed.items)[0]?.streaming).toBe(true);
    expect(text(resumed.items).startsWith(seen)).toBe(true);
    expect(text(resumed.items)).toMatch(/^(tick )+(tick)?$/);

    await after.session.abort();
    const settled = await waitFor(() => !after.state.busy && after.state, 15_000, "abort to settle");
    expect(assistants(settled.items)).toEqual([expect.objectContaining({ stopReason: "aborted", streaming: false })]);
    await after.session.dispose();
    expect(endpoint).toBeUndefined();
  });
});
