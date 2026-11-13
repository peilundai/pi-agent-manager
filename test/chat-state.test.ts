import { describe, expect, it } from "vitest";
import { applyPiEvents, chatReducer, initialChatState, type ChatState } from "../src/webview/chat-state";
import type { HostToWebviewMessage } from "../src/shared/protocol";
import type { PiEvent } from "../src/pi/rpc-types";

const host = (state: ChatState, message: HostToWebviewMessage) => chatReducer(state, { type: "host", message, now: 1_000 });
const update = (inner: Record<string, unknown>): PiEvent => ({ type: "message_update", assistantMessageEvent: inner });

describe("chat reducer: streaming", () => {
  it("reconstructs text, thinking and tool calls from deltas", () => {
    let state = applyPiEvents(initialChatState, [
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Fix it" }] } },
      // message_start can already contain the first chunk; it must not be duplicated.
      { type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "Hm" }] } },
      update({ type: "thinking_start", contentIndex: 0 }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "Hm" }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "m" }),
      update({ type: "text_start", contentIndex: 1 }),
      update({ type: "text_delta", contentIndex: 1, delta: "Reading " }),
    ], 5);
    state = applyPiEvents(state, [
      update({ type: "text_delta", contentIndex: 1, delta: "file" }),
      update({ type: "toolcall_start", contentIndex: 2, id: "t1", toolName: "read" }),
      update({ type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } } }),
    ], 6);
    expect(state.busy).toBe(true);
    expect(state.busySince).toBe(5);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "Fix it" });
    expect(state.items[1]).toMatchObject({
      kind: "assistant",
      streaming: true,
      blocks: [{ type: "thinking", text: "Hmm" }, { type: "text", text: "Reading file" }, { type: "tool", id: "t1" }],
    });
    expect(state.tools.t1).toMatchObject({ name: "read", args: { path: "a.ts" }, status: "running" });
  });

  it("applies tool execution results and the authoritative message_end", () => {
    const state = applyPiEvents(initialChatState, [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "text_delta", contentIndex: 0, delta: "partial" }),
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final" }, { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" } },
      { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_update", toolCallId: "t2", toolName: "bash", partialResult: { content: [{ type: "text", text: "a" }] } },
      { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [{ type: "text", text: "a\nb" }], details: { truncation: null } }, isError: false, durationMs: 1500 },
      { type: "agent_settled", aborted: false },
    ], 1);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "assistant", streaming: false, blocks: [{ type: "text", text: "Final" }, { type: "tool", id: "t2" }] });
    expect(state.tools.t2).toMatchObject({ status: "success", output: "a\nb", durationMs: 1500 });
    expect(state.busy).toBe(false);
  });

  it("marks errors, aborts and interrupted tools", () => {
    const state = applyPiEvents(initialChatState, [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "toolcall_start", contentIndex: 0, id: "t3", toolName: "edit" }),
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } },
      { type: "agent_settled", aborted: true },
    ], 1);
    expect(state.items[0]).toMatchObject({ kind: "assistant", error: "Interrupted", stopReason: "aborted" });
    expect(state.tools.t3?.status).toBe("interrupted");
  });

  it("turns extension UI requests into dialogs and notices", () => {
    let state = applyPiEvents(initialChatState, [
      { type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow?", message: "rm -rf", timeout: 5000 },
      { type: "extension_ui_request", id: "d2", method: "notify", message: "Heads up", notifyType: "warning" },
      { type: "extension_ui_request", id: "d3", method: "setStatus", statusKey: "x" },
    ], 100);
    expect(state.items).toEqual([
      { kind: "dialog", id: "d1", request: { id: "d1", method: "confirm", title: "Allow?", message: "rm -rf", deadline: 5100 } },
      { kind: "notice", id: "n2", level: "warning", text: "Heads up" },
    ]);
    state = chatReducer(state, { type: "dialog.answer", id: "d1", answer: "Yes" });
    expect(state.items[0]).toMatchObject({ answer: "Yes" });
  });

  it("shows one card per dialog request even when it is re-sent", () => {
    const dialog = { type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow?" };
    const state = applyPiEvents(initialChatState, [dialog, dialog], 1);
    expect(state.items.filter((item) => item.kind === "dialog")).toHaveLength(1);
  });

  it("tracks queue, retry, compaction and session metadata", () => {
    const state = applyPiEvents(initialChatState, [
      { type: "queue_update", steering: ["now"], followUp: ["later"] },
      { type: "compaction_end", reason: "manual", result: { tokensBefore: 50_000 }, aborted: false, willRetry: false },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" },
      { type: "session_info_changed", name: "Renamed" },
      { type: "thinking_level_changed", level: "high" },
    ], 1);
    expect(state.queue).toEqual({ steering: ["now"], followUp: ["later"] });
    expect(state.activity).toBe("Retrying in 2s (attempt 1/3)");
    expect(state.pi).toEqual({ sessionName: "Renamed", thinkingLevel: "high" });
    expect(state.items).toEqual([{ kind: "compaction", id: "c1", tokensBefore: 50_000 }]);
  });
});

describe("chat reducer: host messages", () => {
  it("hydrates a transcript snapshot", () => {
    const state = host(initialChatState, {
      version: 1,
      type: "snapshot",
      snapshot: {
        state: { sessionFile: "/s.jsonl", isStreaming: false },
        models: [],
        commands: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "Hi" }, { type: "image", data: "AA", mimeType: "image/png" }] },
          { role: "assistant", content: [{ type: "text", text: "Reading" }, { type: "toolCall", id: "t", name: "read", arguments: { path: "x" } }], stopReason: "toolUse" },
          { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "body" }], isError: false },
          { role: "assistant", content: [{ type: "toolCall", id: "u", name: "bash", arguments: {} }], stopReason: "error", errorMessage: "boom" },
          { role: "bashExecution", command: "ls", output: "a", exitCode: 0 },
          { role: "compactionSummary", summary: "s", tokensBefore: 10 },
        ],
      },
    });
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant", "assistant", "bash", "compaction"]);
    expect(state.items[0]).toMatchObject({ images: [{ data: "AA", mimeType: "image/png" }] });
    expect(state.items[2]).toMatchObject({ error: "boom" });
    expect(state.tools.t).toMatchObject({ status: "success", output: "body" });
    expect(state.tools.u?.status).toBe("interrupted");
    expect(state.epoch).toBe(1);
  });

  it("replaces optimistic user messages with Pi's echo", () => {
    let state = chatReducer(initialChatState, { type: "user.send", text: "Hello", images: [] });
    expect(state.items[0]).toMatchObject({ kind: "user", pending: true });
    state = applyPiEvents(state, [{ type: "message_start", message: { role: "user", content: "Hello (expanded)" } }], 1);
    expect(state.items).toEqual([{ kind: "user", id: "u1", text: "Hello (expanded)", images: [] }]);
  });

  it("drops optimistic messages for handled commands and errors", () => {
    let state = chatReducer(initialChatState, { type: "user.send", text: "/hello", images: [] });
    state = host(state, { version: 1, type: "prompt.result", disposition: "handled" });
    expect(state.items).toEqual([]);
    state = chatReducer(state, { type: "user.send", text: "hi", images: [] });
    state = host(state, { version: 1, type: "prompt.result", error: "No API key" });
    expect(state.items).toEqual([{ kind: "notice", id: "n3", level: "error", text: "No API key" }]);
  });

  it("clears busy state when the process exits", () => {
    let state = applyPiEvents(initialChatState, [{ type: "agent_start" }], 1);
    state = host(state, { version: 1, type: "process", status: "exited", error: "crashed", stderr: "trace" });
    expect(state.busy).toBe(false);
    expect(state.process).toEqual({ status: "exited", error: "crashed", stderr: "trace" });
  });

  it("tracks the folder and whether the window is multi-root", () => {
    let state = host(initialChatState, { version: 1, type: "init", workspaceName: "api", platform: "darwin", multiRoot: true });
    expect(state).toMatchObject({ workspaceName: "api", multiRoot: true });
    state = host(state, { version: 1, type: "init", workspaceName: "api", platform: "darwin" });
    expect(state.multiRoot).toBe(false);
  });
});

describe("chat reducer: nested tool calls", () => {
  const script = "// @options: {\"timeout_ms\": 1000}\nconst a = await tools.read({ path: \"a.ts\" });";
  const codemodeTurn: PiEvent[] = [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "codemode", arguments: { code: script } }], stopReason: "toolUse" } },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "codemode", args: { code: script } },
  ];

  it("keeps calls a script makes under the script instead of the transcript", () => {
    let state = applyPiEvents(initialChatState, codemodeTurn, 1);
    const parentBefore = state.tools.c1;
    state = applyPiEvents(state, [
      { type: "tool_execution_start", toolCallId: "c1/1", toolName: "read", args: { path: "a.ts" }, parentToolCallId: "c1" },
      { type: "tool_execution_end", toolCallId: "c1/1", toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false, parentToolCallId: "c1" },
      { type: "tool_execution_start", toolCallId: "c1/2", toolName: "edit", args: { path: "a.ts", oldText: "x", newText: "y" }, parentToolCallId: "c1" },
    ], 2);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ blocks: [{ type: "tool", id: "c1" }] });
    expect(state.tools.c1?.children).toEqual(["c1/1", "c1/2"]);
    expect(state.tools["c1/1"]).toMatchObject({ parentId: "c1", status: "success", output: "x" });
    // The parent is replaced so its memoized card re-renders.
    expect(state.tools.c1).not.toBe(parentBefore);
    state = applyPiEvents(state, [
      { type: "tool_execution_end", toolCallId: "c1", toolName: "codemode", result: { content: [{ type: "text", text: "Script completed" }] }, isError: false },
      { type: "agent_settled", aborted: true },
    ], 3);
    expect(state.tools.c1).toMatchObject({ status: "success", children: ["c1/1", "c1/2"] });
    expect(state.tools["c1/2"]?.status).toBe("interrupted");
  });

  it("falls back to the transcript when the parent is unknown", () => {
    const state = applyPiEvents(initialChatState, [
      { type: "tool_execution_start", toolCallId: "x/1", toolName: "read", args: { path: "a.ts" }, parentToolCallId: "x" },
    ], 1);
    expect(state.items[0]).toMatchObject({ kind: "assistant", blocks: [{ type: "tool", id: "x/1" }] });
    expect(state.tools["x/1"]?.parentId).toBeUndefined();
  });

  it("rebuilds the nested calls from the tool result when a chat is reloaded", () => {
    const state = host(initialChatState, {
      version: 1,
      type: "snapshot",
      snapshot: {
        state: { isStreaming: false },
        models: [],
        commands: [],
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "codemode", arguments: { code: script } }], stopReason: "toolUse" },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "codemode",
            content: [{ type: "text", text: "Script failed" }],
            isError: true,
            nestedCalls: {
              complete: false,
              calls: [
                { id: "c1/1", name: "read", arguments: { path: "a.ts" }, status: "ok", durationMs: 5 },
                { id: "c1/1/1", name: "ls", arguments: {}, status: "ok" },
                { id: "c1/2", name: "bash", argumentsBytes: 900_000, status: "error", error: "boom" },
                { id: "c1/3", name: "read", arguments: { path: "b.ts" }, status: "unfinished" },
              ],
            },
          },
        ],
      },
    } as HostToWebviewMessage);
    expect(state.items).toHaveLength(1);
    expect(state.tools.c1).toMatchObject({ status: "error", children: ["c1/1", "c1/2", "c1/3"], childrenIncomplete: true });
    expect(state.tools["c1/1"]).toMatchObject({ parentId: "c1", status: "success", durationMs: 5, children: ["c1/1/1"] });
    expect(state.tools["c1/1/1"]).toMatchObject({ parentId: "c1/1" });
    expect(state.tools["c1/2"]).toMatchObject({ status: "error", output: "boom", args: {} });
    expect(state.tools["c1/3"]?.status).toBe("interrupted");
  });

  it("keeps live output when the result's record arrives", () => {
    let state = applyPiEvents(initialChatState, [
      ...codemodeTurn,
      { type: "tool_execution_start", toolCallId: "c1/1", toolName: "read", args: { path: "a.ts" }, parentToolCallId: "c1" },
      { type: "tool_execution_end", toolCallId: "c1/1", toolName: "read", result: { content: [{ type: "text", text: "live" }] }, isError: false, parentToolCallId: "c1" },
    ], 1);
    state = applyPiEvents(state, [
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "codemode",
          content: [{ type: "text", text: "Script completed" }],
          isError: false,
          nestedCalls: { complete: true, calls: [{ id: "c1/1", name: "read", arguments: { path: "a.ts" }, status: "ok" }] },
        },
      },
    ], 2);
    expect(state.tools.c1).toMatchObject({ status: "success", children: ["c1/1"] });
    expect(state.tools.c1?.childrenIncomplete).toBeUndefined();
    expect(state.tools["c1/1"]?.output).toBe("live");
  });
});
