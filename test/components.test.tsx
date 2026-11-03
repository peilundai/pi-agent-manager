import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WebviewToHostMessage } from "../src/shared/protocol";
import type { ToolState } from "../src/webview/chat-state";
import { Composer, type ComposerProps } from "../src/webview/components/Composer";
import { ChatContext } from "../src/webview/components/context";
import { Header, relativeTime, SessionPicker } from "../src/webview/components/Header";
import { Markdown } from "../src/webview/components/Markdown";
import { modelLabel, ModelPicker, supportedLevels, thinkingLabel } from "../src/webview/components/ModelPicker";
import { ToolCard } from "../src/webview/components/ToolCard";
import { TranscriptItem } from "../src/webview/components/Transcript";

function withContext(ui: React.ReactElement) {
  const posted: WebviewToHostMessage[] = [];
  const result = render(<ChatContext.Provider value={{ post: (message) => posted.push(message) }}>{ui}</ChatContext.Provider>);
  return { posted, ...result };
}

const models = [
  { id: "sonnet", provider: "anthropic", name: "Claude Sonnet", reasoning: true },
  { id: "gpt", provider: "openai", name: "GPT", reasoning: false },
  { id: "deep", provider: "openai", name: "Deep", reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh" } },
];

describe("ModelPicker helpers", () => {
  it("derives supported thinking levels", () => {
    expect(supportedLevels(undefined)).toEqual(["off"]);
    expect(supportedLevels(models[1])).toEqual(["off"]);
    expect(supportedLevels(models[0])).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(supportedLevels(models[2])).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(modelLabel(undefined)).toBe("No model");
    expect(modelLabel({ id: "raw", provider: "x" })).toBe("raw");
    expect(thinkingLabel("xhigh")).toBe("X-High");
  });

  it("filters, navigates and selects models", () => {
    const onSelectModel = vi.fn();
    const onSelectLevel = vi.fn();
    const onClose = vi.fn();
    render(<ModelPicker models={models} current={models[0]} thinkingLevel="medium" onSelectModel={onSelectModel} onSelectLevel={onSelectLevel} onClose={onClose} />);
    expect(screen.getByRole("radio", { name: "Medium" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    expect(onSelectLevel).toHaveBeenCalledWith("high");
    const search = screen.getByLabelText("Search models");
    fireEvent.change(search, { target: { value: "openai" } });
    expect(screen.queryByText("Claude Sonnet")).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelectModel).toHaveBeenCalledWith(models[1]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No models match.")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("relativeTime", () => {
  it("formats compact ages", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 9 * 86_400_000, now)).toBe("9d");
    expect(relativeTime(now - 90 * 86_400_000, now)).toBe("3mo");
    expect(relativeTime(now - 800 * 86_400_000, now)).toBe("2y");
  });
});

describe("SessionPicker", () => {
  const sessions = [
    { id: "a", path: "/s/a.jsonl", cwd: "/w", title: "Fix login race", createdAt: Date.now(), updatedAt: Date.now(), archived: false, status: "stopped" as const },
    { id: "b", path: "/s/b.jsonl", cwd: "/w", title: "Write docs", createdAt: 0, updatedAt: Date.now() - 40 * 86_400_000, archived: false, status: "stopped" as const },
    { id: "c", path: "/s/c.jsonl", cwd: "/w", title: "Archived one", createdAt: 0, updatedAt: Date.now(), archived: true, status: "stopped" as const },
  ];

  it("searches, opens with the keyboard and deletes", () => {
    const onClose = vi.fn();
    const { posted } = withContext(<SessionPicker sessions={sessions} activePath="/s/a.jsonl" onClose={onClose} />);
    expect(screen.queryByText("Archived one")).not.toBeInTheDocument();
    expect(screen.getByText("Older")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Delete Write docs"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "chat.delete", path: "/s/b.jsonl" });
    const search = screen.getByLabelText("Search sessions");
    fireEvent.change(search, { target: { value: "docs" } });
    expect(screen.queryByText("Fix login race")).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(posted.at(-1)).toEqual({ version: 1, type: "chat.open", path: "/s/b.jsonl" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an empty state", () => {
    withContext(<SessionPicker sessions={[]} activePath={undefined} onClose={vi.fn()} />);
    expect(screen.getByText("No past chats in this workspace yet.")).toBeInTheDocument();
  });

  it("names the folder in the empty state of a multi-root window", () => {
    withContext(<SessionPicker sessions={[]} activePath={undefined} folderName="api" onClose={vi.fn()} />);
    expect(screen.getByText("No past chats in “api” yet.")).toBeInTheDocument();
  });
});

describe("Header", () => {
  const props = { title: "Chat", historyOpen: false, canRename: false, onToggleHistory: vi.fn(), onNewChat: vi.fn() };

  it("hides the folder switcher in a single-folder window", () => {
    withContext(<Header {...props} />);
    expect(screen.queryByRole("button", { name: /Workspace folder/ })).not.toBeInTheDocument();
  });

  it("shows the folder and asks the host to switch it", () => {
    const { posted } = withContext(<Header {...props} folderName="api" />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace folder: api. Switch folder" }));
    expect(posted.at(-1)).toEqual({ version: 1, type: "folder.pick" });
  });
});

describe("Markdown", () => {
  it("renders GFM, highlights code and routes links", async () => {
    const { posted, container } = withContext(
      <Markdown text={"# Title\n\nSee [docs](https://pi.dev) and `src/app.ts:4`.\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |"} />,
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(container.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(screen.getByRole("table")).toBeInTheDocument();
    fireEvent.click(screen.getByText("docs"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "url.open", url: "https://pi.dev" });
    fireEvent.click(screen.getByText("src/app.ts:4"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "file.open", path: "src/app.ts", line: 3 });
  });

  it("copies code blocks", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    withContext(<Markdown text={"```\nnpm test\n```"} />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Copy code"));
    });
    expect(writeText).toHaveBeenCalledWith("npm test");
  });
});

describe("ToolCard", () => {
  const base: ToolState = { id: "t", name: "bash", args: { command: "npm test" }, status: "success", output: "ok\nall good" };

  it("collapses output behind a summary and expands on click", () => {
    withContext(<ToolCard tool={base} />);
    expect(screen.getByText("2 lines of output")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("$ npm test")).toBeInTheDocument();
    expect(screen.getByText(/all good/)).toBeInTheDocument();
  });

  it("opens edits by default with a diff fallback from arguments", () => {
    const { posted } = withContext(
      <ToolCard tool={{ ...base, name: "edit", args: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] }, output: "" }} />,
    );
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
    fireEvent.click(screen.getByText("src/a.ts"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "file.open", path: "src/a.ts" });
  });

  it("shows write content as added lines and errors in red", () => {
    const { rerender } = withContext(<ToolCard tool={{ ...base, name: "write", args: { path: "b.txt", content: "one\ntwo\n" } }} />);
    expect(screen.getByText("two")).toBeInTheDocument();
    rerender(
      <ChatContext.Provider value={{ post: () => undefined }}>
        <ToolCard tool={{ ...base, status: "error", output: "exit 1: boom" }} />
      </ChatContext.Provider>,
    );
    expect(screen.getByText("exit 1: boom")).toHaveClass("tool-summary", "error");
  });
});

describe("TranscriptItem", () => {
  const noop = () => undefined;

  it("collapses long user messages", () => {
    withContext(<TranscriptItem item={{ kind: "user", id: "u", text: "x\n".repeat(30), images: [] }} tools={{}} onDialogAnswer={noop} onDismiss={noop} />);
    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });

  it("dismisses notices and renders compaction dividers", () => {
    const onDismiss = vi.fn();
    const { rerender } = withContext(<TranscriptItem item={{ kind: "notice", id: "n1", level: "warning", text: "Careful" }} tools={{}} onDialogAnswer={noop} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("n1");
    rerender(<TranscriptItem item={{ kind: "compaction", id: "c", tokensBefore: 42_000 }} tools={{}} onDialogAnswer={noop} onDismiss={noop} />);
    expect(screen.getByText(/Conversation compacted · 42k tokens summarized/)).toBeInTheDocument();
  });

  it("answers input dialogs and shows a receipt", () => {
    const onAnswer = vi.fn();
    const { posted } = withContext(
      <TranscriptItem item={{ kind: "dialog", id: "d", request: { id: "q", method: "input", title: "Branch name?" } }} tools={{}} onDialogAnswer={onAnswer} onDismiss={noop} />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feat/x" } });
    fireEvent.click(screen.getByText("Submit"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "dialog.respond", response: { id: "q", value: "feat/x" } });
    expect(onAnswer).toHaveBeenCalledWith("q", "feat/x");
  });

  it("renders a timed-out dialog as a receipt", () => {
    withContext(
      <TranscriptItem item={{ kind: "dialog", id: "d", request: { id: "q", method: "confirm", title: "Allow?", deadline: Date.now() - 1 } }} tools={{}} onDialogAnswer={noop} onDismiss={noop} />,
    );
    expect(screen.getByText("Timed out")).toBeInTheDocument();
  });

  it("renders assistant errors and thinking", () => {
    withContext(
      <TranscriptItem
        item={{ kind: "assistant", id: "a", streaming: false, stopReason: "error", error: "Rate limited", blocks: [{ type: "thinking", text: "plan" }, { type: "text", text: "Hi" }] }}
        tools={{}}
        onDialogAnswer={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText("Rate limited")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Thought"));
    expect(screen.getByText("plan")).toBeInTheDocument();
  });
});

describe("Composer", () => {
  function renderComposer(overrides: Partial<ComposerProps> = {}) {
    const props: ComposerProps = {
      busy: false,
      disabled: false,
      platform: "darwin",
      models,
      model: models[0],
      thinkingLevel: "medium",
      commands: [],
      localCommands: [],
      stats: { contextUsage: { percent: 85, tokens: 170_000, contextWindow: 200_000 }, cost: 1.234 },
      loadDraft: () => "",
      history: ["first prompt", "second prompt"],
      onDraftChange: vi.fn(),
      onSubmit: vi.fn(),
      onAbort: vi.fn(),
      files: { requestId: -1, files: [] },
      ...overrides,
    };
    const utils = withContext(<Composer {...props} />);
    return { ...utils, props, input: screen.getByLabelText("Message Pi") as HTMLTextAreaElement };
  }

  it("recalls prompt history with the arrow keys", () => {
    const { input } = renderComposer();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("second prompt");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("first prompt");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("second prompt");
  });

  it("requests files for @ mentions and inserts the chosen path", () => {
    const { input, posted, rerender, props } = renderComposer();
    fireEvent.change(input, { target: { value: "look at @ap", selectionStart: 11 } });
    const request = posted.find((message) => message.type === "files.search");
    expect(request).toMatchObject({ query: "ap" });
    rerender(
      <ChatContext.Provider value={{ post: (message) => posted.push(message) }}>
        <Composer {...props} files={{ requestId: (request as { requestId: number }).requestId, files: ["src/app.ts", "src/apple.ts"] }} />
      </ChatContext.Provider>,
    );
    expect(screen.getByRole("listbox", { name: "Files" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("look at @src/apple.ts ");
  });

  it("searches again when the same @ mention is re-entered", () => {
    const { input, posted } = renderComposer();
    const searches = () => posted.filter((message) => message.type === "files.search");
    fireEvent.change(input, { target: { value: "@", selectionStart: 1 } });
    expect(searches()).toHaveLength(1);
    fireEvent.change(input, { target: { value: "", selectionStart: 0 } });
    fireEvent.change(input, { target: { value: "@", selectionStart: 1 } });
    expect(searches()).toHaveLength(2);
    expect(searches()[1]).toMatchObject({ query: "" });
  });

  it("attaches pasted images and submits them", async () => {
    const { input, props } = renderComposer();
    const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    await waitFor(() => expect(screen.getByAltText("shot.png")).toBeInTheDocument());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledWith("", [expect.objectContaining({ mimeType: "image/png", name: "shot.png" })], "send");
  });

  it("removes attachments, inserts / and shows the context ring", async () => {
    const { input } = renderComposer();
    const file = new File([new Uint8Array([1])], "a.webp", { type: "image/webp" });
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    await waitFor(() => expect(screen.getByAltText("a.webp")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Remove a.webp"));
    expect(screen.queryByAltText("a.webp")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Commands and skills"));
    await waitFor(() => expect(input.value).toBe("/"));
    expect(screen.getByRole("button", { name: /Context 85% used \(170k \/ 200k tokens\) · \$1\.23/ })).toBeInTheDocument();
  });

  it("opens context usage details when the ring is clicked", () => {
    renderComposer();
    const ring = screen.getByRole("button", { name: /Context 85% used/ });
    expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument();
    fireEvent.click(ring);
    const popover = screen.getByRole("dialog", { name: "Context usage" });
    expect(ring).toHaveAttribute("aria-expanded", "true");
    expect(popover).toHaveTextContent("85%");
    expect(popover).toHaveTextContent("170k / 200k tokens");
    expect(popover).toHaveTextContent("$1.23");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument();
    fireEvent.click(ring);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument();
  });

  it("opens the model picker and posts model changes", () => {
    const { posted } = renderComposer();
    fireEvent.click(screen.getByTitle("Choose model and thinking level"));
    fireEvent.click(screen.getByText("GPT"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "model.set", provider: "openai", modelId: "gpt" });
  });

  it("asks the host to pick attachments", () => {
    const { posted } = renderComposer();
    fireEvent.click(screen.getByLabelText("Attach files or images"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "attach.pick" });
  });

  it("shows a stop button while busy", () => {
    const { props } = renderComposer({ busy: true });
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(props.onAbort).toHaveBeenCalled();
  });
});
