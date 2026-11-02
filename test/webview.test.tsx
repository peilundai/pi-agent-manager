import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/shared/protocol";
import { App } from "../src/webview/App";
import { mentionAt, slashQuery } from "../src/webview/components/Composer";
import type { WebviewTransport } from "../src/webview/vscode";

function setup() {
  const posted: WebviewToHostMessage[] = [];
  const transport: WebviewTransport = { post: (message) => posted.push(message), getState: () => ({}), setState: vi.fn() };
  const view = render(<App transport={transport} />);
  const send = async (...messages: HostToWebviewMessage[]) => {
    await act(async () => {
      for (const message of messages) window.dispatchEvent(new MessageEvent("message", { data: message }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };
  return { posted, send, view };
}

const snapshot: HostToWebviewMessage = {
  version: 1,
  type: "snapshot",
  snapshot: {
    state: { sessionFile: "/s/a.jsonl", thinkingLevel: "medium", model: { id: "m1", provider: "anthropic", name: "Claude Sonnet", reasoning: true } },
    models: [
      { id: "m1", provider: "anthropic", name: "Claude Sonnet", reasoning: true },
      { id: "m2", provider: "openai", name: "GPT", reasoning: false },
    ],
    commands: [{ name: "skill:review", description: "Review code", source: "skill" }],
    messages: [],
  },
};

describe("composer helpers", () => {
  it("detects mention and slash tokens", () => {
    expect(mentionAt("see @src/ap", 11)).toEqual({ start: 4, query: "src/ap" });
    expect(mentionAt("email a@b", 9)).toBeUndefined();
    expect(slashQuery("/rev", 4)).toBe("rev");
    expect(slashQuery("hi /rev", 7)).toBeUndefined();
  });
});

describe("App", () => {
  it("announces readiness and renders the empty state with the current model", async () => {
    const { posted, send } = setup();
    expect(posted[0]).toEqual({ version: 1, type: "ready" });
    await send({ version: 1, type: "init", workspaceName: "demo", platform: "darwin" }, snapshot);
    expect(screen.getByText("Untitled")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pi" })).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
  });

  it("sends a prompt on Enter and shows it optimistically", async () => {
    const { posted, send } = setup();
    await send(snapshot);
    const input = screen.getByLabelText("Message Pi");
    fireEvent.change(input, { target: { value: "Explain this repo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(posted.at(-1)).toEqual({ version: 1, type: "prompt", text: "Explain this repo", images: [], mode: "send" });
    expect(screen.getAllByText("Explain this repo").length).toBeGreaterThan(0);
  });

  it("queues follow-ups while busy, steers with the modifier and aborts on Escape", async () => {
    const { posted, send } = setup();
    await send({ version: 1, type: "init", workspaceName: "demo", platform: "linux" }, snapshot, { version: 1, type: "pi.events", events: [{ type: "agent_start" }] });
    expect(screen.getByRole("status")).toHaveTextContent("esc to interrupt");
    const input = screen.getByLabelText("Message Pi");
    fireEvent.change(input, { target: { value: "also tests" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(posted.at(-1)).toMatchObject({ type: "prompt", mode: "followUp" });
    fireEvent.change(input, { target: { value: "stop that" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(posted.at(-1)).toMatchObject({ type: "prompt", mode: "steer" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(posted.at(-1)).toEqual({ version: 1, type: "abort" });
  });

  it("offers local and Pi slash commands", async () => {
    const { posted, send } = setup();
    await send(snapshot);
    const input = screen.getByLabelText("Message Pi");
    fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    expect(screen.getByText("/skill:review")).toBeInTheDocument();
    fireEvent.click(screen.getByText("/compact"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "compact" });
  });

  it("renders tool cards with diffs and answers dialogs", async () => {
    const { posted, send } = setup();
    await send(snapshot, {
      version: 1,
      type: "pi.events",
      events: [
        { type: "agent_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/a.ts", edits: [] } }], stopReason: "toolUse" } },
        { type: "tool_execution_end", toolCallId: "e1", toolName: "edit", result: { content: [{ type: "text", text: "ok" }], details: { diff: "-1 old line\n+1 new line" } }, isError: false },
        { type: "extension_ui_request", id: "q1", method: "select", title: "Pick one", options: ["Alpha", "Beta"] },
      ],
    });
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("new line")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Beta"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "dialog.respond", response: { id: "q1", value: "Beta" } });
    expect(screen.getByText("Pick one")).toBeInTheDocument();
  });

  it("lists past chats and opens one", async () => {
    const { posted, send } = setup();
    await send(snapshot, {
      version: 1,
      type: "sessions",
      sessions: [{ id: "b", path: "/s/b.jsonl", cwd: "/w", title: "Refactor auth", createdAt: Date.now(), updatedAt: Date.now(), archived: false, status: "stopped" }],
    });
    fireEvent.click(screen.getByLabelText("Past chats"));
    expect(screen.getByText("Today")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Refactor auth"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "chat.open", path: "/s/b.jsonl" });
  });

  it("shows setup guidance when Pi is missing", async () => {
    const { posted, send } = setup();
    await send({ version: 1, type: "init", workspaceName: "demo", platform: "darwin", setupError: { kind: "executable", message: "Checked 3 locations." } });
    expect(screen.getByText("Pi CLI not found")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Retry"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "setup.action", action: "retry" });
  });

  it("offers a restart when Pi exits", async () => {
    const { posted, send } = setup();
    await send(snapshot, { version: 1, type: "process", status: "exited", error: "Pi exited with code 1.", stderr: "fatal" });
    expect(screen.getByRole("alert")).toHaveTextContent("Pi exited with code 1.");
    fireEvent.click(screen.getByText("Restart Pi"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "restart" });
  });
});
