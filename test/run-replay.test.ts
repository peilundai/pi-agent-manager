import { describe, expect, it } from "vitest";
import { RunReplay } from "../src/pi/run-replay";

const delta = (text: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });

describe("RunReplay", () => {
  it("keeps only the live part of a run", () => {
    const replay = new RunReplay();
    replay.track({ type: "agent_start" });
    replay.track({ type: "message_start", message: { role: "user" } });
    replay.track({ type: "message_end", message: { role: "user" } });
    replay.track({ type: "message_start", message: { role: "assistant" } });
    replay.track(delta("done"));
    replay.track({ type: "message_end", message: { role: "assistant" } });
    replay.track({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
    replay.track({ type: "tool_execution_end", toolCallId: "a" });
    replay.track({ type: "tool_execution_start", toolCallId: "b", toolName: "bash" });
    replay.track({ type: "tool_execution_update", toolCallId: "b", partialResult: { content: "1" } });
    replay.track({ type: "tool_execution_update", toolCallId: "b", partialResult: { content: "12" } });
    replay.track({ type: "queue_update", steering: [], followUp: ["a"] });
    replay.track({ type: "queue_update", steering: [], followUp: ["a", "b"] });
    replay.track({ type: "message_start", message: { role: "assistant" } });
    replay.track({ ...delta("Hel"), message: { role: "assistant", content: "Hel" } });
    expect(replay.running).toBe(true);
    expect(replay.replay()).toEqual([
      { type: "agent_start" },
      { type: "queue_update", steering: [], followUp: ["a", "b"] },
      { type: "tool_execution_start", toolCallId: "b", toolName: "bash" },
      { type: "tool_execution_update", toolCallId: "b", partialResult: { content: "12" } },
      { type: "message_start", message: { role: "assistant" } },
      delta("Hel"),
    ]);
  });

  it("forgets the run when it settles and tracks compaction and retries until they end", () => {
    const replay = new RunReplay();
    replay.track({ type: "agent_start" });
    replay.track({ type: "auto_retry_start", attempt: 1 });
    replay.track({ type: "compaction_start", reason: "threshold" });
    expect(replay.replay().map((event) => event.type)).toEqual(["agent_start", "compaction_start", "auto_retry_start"]);
    replay.track({ type: "auto_retry_end" });
    replay.track({ type: "compaction_end" });
    replay.track({ type: "agent_settled" });
    expect(replay.running).toBe(false);
    expect(replay.replay()).toEqual([]);
  });

  it("re-sends unanswered dialogs with their remaining time", () => {
    let now = 1_000;
    const replay = new RunReplay(() => now);
    replay.track({ type: "extension_ui_request", id: "c", method: "confirm", timeout: 10_000 });
    replay.track({ type: "extension_ui_request", id: "e", method: "editor" });
    replay.track({ type: "extension_ui_request", id: "n", method: "notify", message: "hi" });
    now += 4_000;
    expect(replay.replay()).toEqual([
      { type: "extension_ui_request", id: "c", method: "confirm", timeout: 6_000 },
      { type: "extension_ui_request", id: "e", method: "editor" },
    ]);
    replay.respond("e");
    now += 7_000;
    expect(replay.replay()).toEqual([]);
  });

  it("starts over on reset", () => {
    const replay = new RunReplay();
    replay.track({ type: "agent_start" });
    replay.track({ type: "extension_ui_request", id: "c", method: "confirm" });
    replay.reset();
    expect(replay.replay()).toEqual([]);
  });

  it("knows which events its replay stands in for", () => {
    expect(RunReplay.covers({ type: "message_update" })).toBe(true);
    expect(RunReplay.covers({ type: "extension_ui_request", id: "x", method: "select" })).toBe(true);
    expect(RunReplay.covers({ type: "extension_ui_request", id: "x", method: "notify" })).toBe(false);
    expect(RunReplay.covers({ type: "tool_execution_end" })).toBe(false);
  });
});
