import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WebviewToHostMessage } from "../src/shared/protocol";
import type { ToolState } from "../src/webview/chat-state";
import { Composer, type ComposerHandle, type ComposerProps } from "../src/webview/components/Composer";
import { ChatContext } from "../src/webview/components/context";
import { Header, relativeTime, SessionPicker } from "../src/webview/components/Header";
import { LinkText, splitLinks, trimUrl } from "../src/webview/components/LinkText";
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

  it("follows the tool card expansion setting", () => {
    const edit: ToolState = { ...base, name: "edit", args: { path: "a.ts", oldText: "old", newText: "new" }, output: "" };
    const { rerender } = render(
      <ChatContext.Provider value={{ post: () => undefined, toolExpansion: "all" }}>
        <ToolCard tool={base} />
      </ChatContext.Provider>,
    );
    expect(screen.getByText("$ npm test")).toBeInTheDocument();
    rerender(
      <ChatContext.Provider value={{ post: () => undefined, toolExpansion: "none" }}>
        <ToolCard key="edit" tool={edit} />
      </ChatContext.Provider>,
    );
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.queryByText("old")).not.toBeInTheDocument();
    expect(screen.getByText("Added 1 line, removed 1 line")).toBeInTheDocument();
  });

  it("opens edits by default with a diff fallback from arguments", () => {
    const { posted } = withContext(
      <ToolCard tool={{ ...base, name: "edit", args: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] }, output: "" }} />,
    );
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByLabelText("1 added, 1 removed")).toHaveTextContent("+1-1");
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.getByText("+1")).toHaveClass("tool-stat-add");
    expect(screen.getByText("-1")).toHaveClass("tool-stat-del");
    fireEvent.click(screen.getByText("src/a.ts"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "file.open", path: "src/a.ts" });
  });

  it("shows write content as added lines and errors in red", () => {
    const { rerender } = withContext(<ToolCard tool={{ ...base, name: "write", args: { path: "b.txt", content: "one\ntwo\n" } }} />);
    expect(screen.getByText("Wrote 2 lines")).toBeInTheDocument();
    expect(screen.queryByText("two")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("two")).toBeInTheDocument();
    rerender(
      <ChatContext.Provider value={{ post: () => undefined }}>
        <ToolCard key="error" tool={{ ...base, status: "error", output: "exit 1: boom" }} />
      </ChatContext.Provider>,
    );
    expect(screen.getByText("exit 1: boom")).toHaveClass("tool-summary", "error");
  });

  it("summarizes a failed command by its exit code and keeps its stdout neutral", () => {
    const output = "/Users/me/work\nfatal: not a git repository\n\nCommand exited with code 128";
    withContext(<ToolCard tool={{ ...base, name: "bash", args: { command: "pwd; git remote -v" }, status: "error", output }} />);
    expect(screen.getByText("Exit code 128")).toHaveClass("tool-summary", "error");
    expect(screen.queryByText(/\/Users\/me\/work/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const status = screen.getByText("Command exited with code 128");
    expect(status).toHaveClass("tool-output-status", "error");
    expect(status.closest("pre")).toHaveClass("tool-output");
    expect(status.closest("pre")).not.toHaveClass("error");
    expect(status.closest("pre")).toHaveTextContent("/Users/me/work");
  });
});

describe("TranscriptItem", () => {
  const noop = () => undefined;

  it("collapses long user messages", () => {
    withContext(<TranscriptItem item={{ kind: "user", id: "u", text: "x\n".repeat(30), images: [] }} tools={{}} onDialogAnswer={noop} onDismiss={noop} />);
    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });

  it("shows attached selections in sent messages as chips that open the file", () => {
    const text = "Explain @src/a.ts#43-48 please\n\nFrom `src/a.ts` lines 43-48:\n\n```ts\nconst secret = 1;\n```";
    const { posted } = withContext(<TranscriptItem item={{ kind: "user", id: "u", text, images: [] }} tools={{}} onDialogAnswer={noop} onDismiss={noop} />);
    const chip = screen.getByRole("button", { name: "@src/a.ts#43-48" });
    expect(chip.closest(".user-text")).toHaveTextContent(/^Explain @src\/a\.ts#43-48 please$/);
    expect(chip).toHaveAttribute("title", "src/a.ts lines 43-48\n\nconst secret = 1;");
    expect(screen.queryByText("Show more")).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(posted.at(-1)).toEqual({ version: 1, type: "file.open", path: "src/a.ts", line: 42 });
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

describe("LinkText", () => {
  const long = "https://auth.example.com/authorize?response_type=code&client_id=abc&state=0123456789";

  it("splits short URLs inline and long URLs into blocks", () => {
    expect(splitLinks("See https://x.io/docs, then retry.")).toEqual([
      { type: "text", text: "See " },
      { type: "url", url: "https://x.io/docs", block: false },
      { type: "text", text: ", then retry." },
    ]);
    expect(splitLinks(`Sign in:\n${long}\n`)).toEqual([
      { type: "text", text: "Sign in:" },
      { type: "url", url: long, block: true },
    ]);
    expect(splitLinks("no links")).toEqual([{ type: "text", text: "no links" }]);
  });

  it("keeps brackets that belong to the URL and drops prose punctuation", () => {
    expect(trimUrl("https://en.wikipedia.org/wiki/Function_(mathematics)")).toBe("https://en.wikipedia.org/wiki/Function_(mathematics)");
    expect(trimUrl("https://en.wikipedia.org/wiki/Function_(mathematics))")).toBe("https://en.wikipedia.org/wiki/Function_(mathematics)");
    expect(trimUrl("https://x.io/docs).")).toBe("https://x.io/docs");
    expect(trimUrl("https://x.io/a?q=[1]")).toBe("https://x.io/a?q=[1]");
    expect(splitLinks("(see https://x.io/a_(b)).")).toEqual([
      { type: "text", text: "(see " },
      { type: "url", url: "https://x.io/a_(b)", block: false },
      { type: "text", text: ")." },
    ]);
  });

  it("opens and copies links", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { posted } = withContext(<LinkText text={`Open https://x.io or ${long}`} />);
    fireEvent.click(screen.getByText("https://x.io"));
    expect(posted.at(-1)).toEqual({ version: 1, type: "url.open", url: "https://x.io" });
    fireEvent.click(screen.getByTitle(long));
    expect(posted.at(-1)).toEqual({ version: 1, type: "url.open", url: long });
    expect(screen.getByText("auth.example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Copy link"));
    expect(writeText).toHaveBeenCalledWith(long);
    await waitFor(() => expect(screen.getByLabelText("Copied")).toBeInTheDocument());
  });

  it("links URLs in notices and shows URL answers in a receipt", () => {
    const noop = () => undefined;
    const { rerender } = withContext(
      <TranscriptItem item={{ kind: "notice", id: "n", level: "info", text: `Sign in:\n${long}` }} tools={{}} onDialogAnswer={noop} onDismiss={noop} />,
    );
    expect(screen.getByLabelText("Copy link")).toBeInTheDocument();
    rerender(
      <ChatContext.Provider value={{ post: noop }}>
        <TranscriptItem item={{ kind: "dialog", id: "d", request: { id: "q", method: "input", title: "Paste the URL" }, answer: long }} tools={{}} onDialogAnswer={noop} onDismiss={noop} />
      </ChatContext.Provider>,
    );
    expect(screen.getByTitle(long)).toHaveClass("dialog-receipt-answer", "mono");
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
      loadDraft: () => ({ text: "", references: [] }),
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

  it("inserts an editor selection as a chip and expands it on send", async () => {
    const ref = createRef<ComposerHandle>();
    const props: ComposerProps = {
      busy: false,
      disabled: false,
      platform: "darwin",
      models,
      model: models[0],
      thinkingLevel: "medium",
      commands: [],
      localCommands: [],
      stats: undefined,
      loadDraft: () => ({ text: "Explain", references: [] }),
      history: [],
      onDraftChange: vi.fn(),
      onSubmit: vi.fn(),
      onAbort: vi.fn(),
      files: { requestId: -1, files: [] },
    };
    const { container } = withContext(<Composer ref={ref} {...props} />);
    const input = screen.getByLabelText("Message Pi") as HTMLTextAreaElement;
    input.setSelectionRange(7, 7);
    const reference = { label: "@CLAUDE.md#43-48", text: "From `CLAUDE.md` lines 43-48:\n\n```md\nbody\n```\n\n" };
    act(() => ref.current?.insert(`${reference.label} `, undefined, [reference]));
    expect(input.value).toBe("Explain @CLAUDE.md#43-48 ");
    expect(container.querySelector("mark.composer-reference")).toHaveTextContent("@CLAUDE.md#43-48");
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ text: "Explain @CLAUDE.md#43-48 ", references: [reference] });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledWith(
      "Explain @CLAUDE.md#43-48\n\nFrom `CLAUDE.md` lines 43-48:\n\n```md\nbody\n```",
      [],
      "send",
    );
    await waitFor(() => expect(container.querySelector("mark.composer-reference")).not.toBeInTheDocument());
  });

  it("removes a whole chip with one Backspace", async () => {
    const reference = { label: "@src/a.ts#3", text: "context" };
    const { input, props } = renderComposer({ loadDraft: () => ({ text: "see @src/a.ts#3", references: [reference] }) });
    input.setSelectionRange(15, 15);
    fireEvent.keyDown(input, { key: "Backspace" });
    await waitFor(() => expect(input.value).toBe("see "));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledWith("see", [], "send");
  });

  it("offers the live editor selection and sends it with the next message", async () => {
    const selection = { label: "@src/a.ts#2-7", text: "From `src/a.ts` lines 2-7:\n\n```ts\ncode\n```\n\n", lineCount: 6 };
    const { input, props } = renderComposer({ selection });
    expect(screen.getByRole("button", { name: /6 lines selected/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Explain", selectionStart: 7 } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenLastCalledWith("Explain @src/a.ts#2-7\n\nFrom `src/a.ts` lines 2-7:\n\n```ts\ncode\n```", [], "send");
    // Sent once: the indicator waits for a new selection.
    await waitFor(() => expect(screen.queryByRole("button", { name: /lines selected/ })).not.toBeInTheDocument());
  });

  it("skips the live selection for slash commands and when dismissed", () => {
    const selection = { label: "@a.ts#1", text: "From `a.ts` line 1:\n\n```ts\nx\n```\n\n", lineCount: 1 };
    const { input, props } = renderComposer({ selection });
    fireEvent.change(input, { target: { value: "/compact", selectionStart: 8 } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenLastCalledWith("/compact", [], "send");
    fireEvent.click(screen.getByRole("button", { name: "Don't send this selection" }));
    expect(screen.queryByRole("button", { name: /1 line selected/ })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "hi", selectionStart: 2 } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenLastCalledWith("hi", [], "send");
  });

  it("offers a selection again only after it changes, and not after sending it inline", async () => {
    const make = () => ({ label: "@a.ts#1", text: "From `a.ts` line 1:\n\n```ts\nx\n```\n\n", lineCount: 1 });
    const { input, props, posted, rerender } = renderComposer({ selection: make() });
    const render = (selection: ComposerProps["selection"]) =>
      rerender(
        <ChatContext.Provider value={{ post: (message) => posted.push(message) }}>
          <Composer {...props} selection={selection} />
        </ChatContext.Provider>,
      );
    const indicator = () => screen.queryByRole("button", { name: /1 line selected/ });
    fireEvent.click(screen.getByRole("button", { name: "Don't send this selection" }));
    expect(indicator()).not.toBeInTheDocument();
    // Cleared, then the same lines selected again.
    render(undefined);
    render(make());
    expect(indicator()).toBeInTheDocument();
    // Sent as an inline chip: not attached again to the next message.
    fireEvent.click(indicator()!);
    await waitFor(() => expect(input.value).toBe("@a.ts#1 "));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenLastCalledWith("@a.ts#1\n\nFrom `a.ts` line 1:\n\n```ts\nx\n```", [], "send");
    await waitFor(() => expect(input.value).toBe(""));
    expect(indicator()).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "next", selectionStart: 4 } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenLastCalledWith("next", [], "send");
  });

  it("places the live selection in the text as a chip when clicked", async () => {
    const selection = { label: "@a.ts#1", text: "ctx", lineCount: 1 };
    const { input, container } = renderComposer({ selection });
    fireEvent.click(screen.getByRole("button", { name: /1 line selected/ }));
    await waitFor(() => expect(input.value).toBe("@a.ts#1 "));
    expect(container.querySelector("mark.composer-reference")).toHaveTextContent("@a.ts#1");
    expect(screen.queryByRole("button", { name: /1 line selected/ })).not.toBeInTheDocument();
  });

  it("turns attached selections back into chips when recalling history", () => {
    const sent = "Explain @a.ts#1\n\nFrom `a.ts` line 1:\n\n```ts\nx\n```";
    const { input, props, container } = renderComposer({ history: [sent] });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("Explain @a.ts#1");
    expect(container.querySelector("mark.composer-reference")).toHaveTextContent("@a.ts#1");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenLastCalledWith(sent, [], "send");
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
