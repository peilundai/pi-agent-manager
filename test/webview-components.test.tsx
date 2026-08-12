import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, TerminalTab, ViewSnapshot } from "../src/shared/model";
import { App } from "../src/webview/App";
import {
  TerminalWorkspace,
  type TerminalWorkspaceBinding,
  type TerminalWorkspaceFactory,
} from "../src/webview/components/TerminalWorkspace";
import { createInitialState } from "../src/webview/state";
import type { WebviewTransport } from "../src/webview/vscode";
import type { WebviewToHostMessage } from "../src/shared/protocol";

class RecordingTransport implements WebviewTransport {
  readonly messages: WebviewToHostMessage[] = [];

  post(message: WebviewToHostMessage): void {
    this.messages.push(message);
  }
}

class FakeTerminalFactory implements TerminalWorkspaceFactory {
  readonly createdIds: string[] = [];
  readonly disposedIds: string[] = [];
  readonly writesById = new Map<string, string[]>();
  readonly focusedIds: string[] = [];
  private readonly dimensionsById = new Map<string, { cols: number; rows: number }>();
  private readonly options = new Map<string, Parameters<TerminalWorkspaceFactory["create"]>[0]>();

  create(options: Parameters<TerminalWorkspaceFactory["create"]>[0]): TerminalWorkspaceBinding {
    this.createdIds.push(options.tabId);
    this.options.set(options.tabId, options);
    this.dimensionsById.set(options.tabId, { cols: 80, rows: 24 });
    const dimensions = (): { cols: number; rows: number } =>
      this.dimensionsById.get(options.tabId) ?? { cols: 80, rows: 24 };
    return {
      get cols() { return dimensions().cols; },
      get rows() { return dimensions().rows; },
      write: (data) => {
        const writes = this.writesById.get(options.tabId) ?? [];
        writes.push(data);
        this.writesById.set(options.tabId, writes);
      },
      focus: () => this.focusedIds.push(options.tabId),
      fit: () => undefined,
      dispose: () => this.disposedIds.push(options.tabId),
    };
  }

  emitData(tabId: string, data: string): void {
    const callback = (this.options.get(tabId) as { onData?: (value: string) => void } | undefined)?.onData;
    if (!callback) throw new Error(`No input callback for ${tabId}`);
    callback(data);
  }

  emitLink(tabId: string, kind: "file" | "url", target: string): void {
    const callback = (this.options.get(tabId) as {
      onLink?: (linkKind: "file" | "url", linkTarget: string) => void;
    } | undefined)?.onLink;
    if (!callback) throw new Error(`No link callback for ${tabId}`);
    callback(kind, target);
  }

  setDimensions(tabId: string, cols: number, rows: number): void {
    this.dimensionsById.set(tabId, { cols, rows });
  }
}

const now = Date.now();

function session(id: string, title: string, status: SessionSummary["status"] = "stopped"): SessionSummary {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/repo",
    title,
    createdAt: now,
    updatedAt: now,
    archived: false,
    status,
  };
}

function tab(id: string, sessionId: string, title: string): TerminalTab {
  return {
    tabId: id,
    sessionId,
    sessionPath: `/sessions/${sessionId}.jsonl`,
    title,
    status: "waiting",
    attached: true,
  };
}

function stateWith(sessions: SessionSummary[], tabs: TerminalTab[] = [], activeTabId?: string, paneVisible = true) {
  const snapshot: ViewSnapshot = {
    sessions,
    tabs,
    ...(activeTabId ? { activeTabId } : {}),
    paneVisible,
    paneWidth: 248,
    collapsedGroups: [],
  };
  return createInitialState(snapshot);
}

describe("agent manager shell", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses New Agent as the manager title when no terminal tab is active", () => {
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([])} transport={transport} />);
    expect(document.querySelector(".manager-title")).toHaveTextContent("New Agent");
  });

  it("reclaims the pane width when the persisted wide pane is hidden", () => {
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([], [], undefined, false)} transport={transport} />);
    expect(document.querySelector(".manager-layout")).toHaveStyle({ "--session-pane-width": "0px" });
    expect(screen.queryByRole("separator", { name: /resize agent list/i })).toBeNull();
  });

  it("opens the narrow overlay even when the persisted wide pane is hidden", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([], [], undefined, false)} transport={transport} />);

    expect(document.querySelector(".manager-layout")).toHaveStyle({ "--session-pane-width": "0px" });
    await user.click(screen.getByRole("button", { name: /show agent list/i }));
    expect(document.querySelector(".manager-layout")).toHaveStyle({ "--session-pane-width": "248px" });
    expect(screen.getByRole("complementary", { name: /agent sessions/i })).toHaveAttribute("data-visible", "true");
    expect(transport.messages).not.toContainEqual(expect.objectContaining({ type: "view.update" }));
  });

  it("hides a narrow overlay after crossing to a wide viewport without another action", async () => {
    let narrow = true;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      get matches() { return narrow; },
      addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    }));
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([], [], undefined, false)} transport={transport} />);

    await user.click(screen.getByRole("button", { name: /show agent list/i }));
    expect(document.querySelector(".manager-layout")).toHaveStyle({ "--session-pane-width": "248px" });
    narrow = false;
    act(() => listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent)));
    expect(document.querySelector(".manager-layout")).toHaveStyle({ "--session-pane-width": "0px" });
    expect(screen.getByRole("complementary", { name: /agent sessions/i })).toHaveAttribute("data-visible", "false");
  });

  it("filters sessions while keeping New Agent available", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(
      <App
        initialState={stateWith([
          session("auth", "Auth middleware cleanup"),
          session("metrics", "Metrics query fix"),
        ])}
        transport={transport}
      />,
    );
    await user.type(screen.getByRole("searchbox", { name: /search agents/i }), "auth");
    expect(screen.getByText("Auth middleware cleanup")).toBeVisible();
    expect(screen.queryByText("Metrics query fix")).toBeNull();
    expect(screen.getAllByRole("button", { name: /new agent/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /open auth middleware cleanup/i }).closest(".session-row"))
      .toHaveAttribute("data-active", "false");
  });

  it("focuses an attached session and resumes a stopped one", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    const terminals = new FakeTerminalFactory();
    render(
      <App
        initialState={stateWith(
          [session("auth", "Auth cleanup", "waiting"), session("metrics", "Metrics fix")],
          [tab("tab-auth", "auth", "Auth cleanup")],
          "tab-auth",
        )}
        transport={transport}
        terminalFactory={terminals}
      />,
    );

    await user.click(screen.getByRole("button", { name: /open auth cleanup/i }));
    await user.click(screen.getByRole("button", { name: /open metrics fix/i }));
    expect(transport.messages).toContainEqual({ version: 1, type: "session.focus", tabId: "tab-auth" });
    expect(transport.messages).toContainEqual({ version: 1, type: "session.resume", sessionId: "metrics" });
  });

  it("names a session row with its current status", () => {
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([session("auth", "Auth cleanup", "stopped")])} transport={transport} />);
    expect(screen.getByRole("button", { name: /open auth cleanup, stopped/i })).toBeVisible();
  });

  it("asks for confirmation before deleting a session", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([session("auth", "Auth cleanup")])} transport={transport} />);

    await user.click(screen.getByRole("button", { name: /more actions for auth cleanup/i }));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(screen.getByRole("dialog", { name: /delete agent/i })).toBeVisible();
    expect(transport.messages).not.toContainEqual(expect.objectContaining({ type: "session.delete" }));

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^delete$/i }));
    expect(transport.messages).toContainEqual({ version: 1, type: "session.delete", sessionId: "auth" });
  });

  it("closes a session action menu with Escape", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([session("auth", "Auth cleanup")])} transport={transport} />);
    await user.click(screen.getByRole("button", { name: /more actions for auth cleanup/i }));
    expect(screen.getByRole("menu", { name: /actions for auth cleanup/i })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: /actions for auth cleanup/i })).toBeNull();
  });

  it("opens delete confirmation from a focused session row", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([session("auth", "Auth cleanup")])} transport={transport} />);

    screen.getByRole("button", { name: /open auth cleanup/i }).focus();
    await user.keyboard("{Delete}");
    expect(screen.getByRole("dialog", { name: /delete agent/i })).toBeVisible();
    expect(transport.messages).not.toContainEqual(expect.objectContaining({ type: "session.delete" }));
  });

  it("restores the action-menu trigger focus after cancelling deletion", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([session("auth", "Auth cleanup")])} transport={transport} />);

    const trigger = screen.getByRole("button", { name: /more actions for auth cleanup/i });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(trigger).toHaveFocus();
  });

  it("traps Tab focus in the delete confirmation and makes the manager inactive", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([session("auth", "Auth cleanup")])} transport={transport} />);
    const manager = document.querySelector(".app-content");

    await user.click(screen.getByRole("button", { name: /more actions for auth cleanup/i }));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    const dialog = screen.getByRole("dialog", { name: /delete agent/i });
    const cancel = within(dialog).getByRole("button", { name: /cancel/i });
    const confirm = within(dialog).getByRole("button", { name: /^delete$/i });
    expect(manager).toHaveAttribute("inert");
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it("collapses a date group and persists the new view state", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    render(<App initialState={stateWith([session("auth", "Auth cleanup")])} transport={transport} />);
    await user.click(screen.getByRole("button", { name: /collapse today/i }));
    expect(screen.queryByText("Auth cleanup")).toBeNull();
    expect(transport.messages).toContainEqual({
      version: 1,
      type: "view.update",
      paneVisible: true,
      paneWidth: 248,
      collapsedGroups: ["today"],
    });
  });

  it("switches and detaches horizontal terminal tabs", async () => {
    const user = userEvent.setup();
    const transport = new RecordingTransport();
    const terminals = new FakeTerminalFactory();
    render(
      <App
        initialState={stateWith(
          [session("auth", "Auth cleanup", "waiting")],
          [tab("tab-auth", "auth", "Auth cleanup")],
          "tab-auth",
        )}
        transport={transport}
        terminalFactory={terminals}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /auth cleanup/i }));
    await user.click(screen.getByRole("button", { name: /close auth cleanup tab/i }));
    expect(transport.messages).toContainEqual({ version: 1, type: "session.focus", tabId: "tab-auth" });
    expect(transport.messages).toContainEqual({ version: 1, type: "session.detach", tabId: "tab-auth" });
  });
});

describe("terminal workspace", () => {
  class FakeResizeObserver {
    static readonly instances: FakeResizeObserver[] = [];
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      FakeResizeObserver.instances.push(this);
    }

    observe(): void {}
    disconnect(): void {}
    trigger(): void { this.callback([], this as unknown as ResizeObserver); }
  }

  afterEach(() => {
    FakeResizeObserver.instances.splice(0);
  });

  it("preserves terminal instances while switching tabs", () => {
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    const { rerender } = render(
      <TerminalWorkspace tabs={[tab("a", "alpha", "Alpha"), tab("b", "beta", "Beta")]} activeTabId="a" transport={transport} factory={terminals} />,
    );

    rerender(
      <TerminalWorkspace tabs={[tab("a", "alpha", "Alpha"), tab("b", "beta", "Beta")]} activeTabId="b" transport={transport} factory={terminals} />,
    );

    expect(terminals.createdIds).toEqual(["a", "b"]);
    expect(terminals.disposedIds).toEqual([]);
  });

  it("disposes a terminal only after its tab is removed", () => {
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    const { rerender } = render(
      <TerminalWorkspace tabs={[tab("a", "alpha", "Alpha")]} activeTabId="a" transport={transport} factory={terminals} />,
    );

    rerender(<TerminalWorkspace tabs={[]} transport={transport} factory={terminals} />);

    expect(terminals.disposedIds).toEqual(["a"]);
  });

  it("forwards terminal input to the attached tab", () => {
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    render(<TerminalWorkspace tabs={[tab("a", "alpha", "Alpha")]} activeTabId="a" transport={transport} factory={terminals} />);

    terminals.emitData("a", "npm test\r");

    expect(transport.messages).toContainEqual({ version: 1, type: "terminal.input", tabId: "a", data: "npm test\r" });
  });

  it("writes queued terminal output in order once its tab is attached", () => {
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    const props = {
      tabs: [tab("a", "alpha", "Alpha")],
      activeTabId: "a",
      transport,
      factory: terminals,
      messages: [
        { id: 1, type: "terminal.output" as const, tabId: "a", data: "one" },
        { id: 2, type: "terminal.output" as const, tabId: "a", data: "two" },
      ],
    };

    render(<TerminalWorkspace {...(props as unknown as React.ComponentProps<typeof TerminalWorkspace>)} />);

    expect(terminals.writesById.get("a")).toEqual(["one", "two"]);
  });

  it("sends terminal dimensions only when an active terminal size changes", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    render(<TerminalWorkspace tabs={[tab("a", "alpha", "Alpha")]} activeTabId="a" transport={transport} factory={terminals} />);

    FakeResizeObserver.instances[0]?.trigger();
    FakeResizeObserver.instances[0]?.trigger();
    terminals.setDimensions("a", 120, 40);
    FakeResizeObserver.instances[0]?.trigger();

    expect(transport.messages.filter((message) => message.type === "terminal.resize")).toEqual([
      { version: 1, type: "terminal.resize", tabId: "a", cols: 80, rows: 24 },
      { version: 1, type: "terminal.resize", tabId: "a", cols: 120, rows: 40 },
    ]);
  });

  it("focuses the requested terminal after a terminal focus message", () => {
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    const props = {
      tabs: [tab("a", "alpha", "Alpha")],
      activeTabId: "a",
      transport,
      factory: terminals,
      messages: [{ id: 1, type: "terminal.focus" as const, tabId: "a" }],
    };

    render(<TerminalWorkspace {...(props as unknown as React.ComponentProps<typeof TerminalWorkspace>)} />);

    expect(terminals.focusedIds).toEqual(["a"]);
  });

  it("forwards activated file and URL links to the host", () => {
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    render(<TerminalWorkspace tabs={[tab("a", "alpha", "Alpha")]} activeTabId="a" transport={transport} factory={terminals} />);

    terminals.emitLink("a", "file", "src/App.tsx:42:7");
    terminals.emitLink("a", "url", "https://example.test/docs");

    expect(transport.messages).toContainEqual({ version: 1, type: "link.open", kind: "file", target: "src/App.tsx:42:7" });
    expect(transport.messages).toContainEqual({ version: 1, type: "link.open", kind: "url", target: "https://example.test/docs" });
  });

  it("routes host terminal output and focus messages through App", () => {
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    const props = {
      initialState: stateWith([session("alpha", "Alpha", "waiting")], [tab("a", "alpha", "Alpha")], "a"),
      transport,
      terminalFactory: terminals,
    };
    render(<App {...(props as unknown as React.ComponentProps<typeof App>)} />);

    act(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "terminal.output", tabId: "a", data: "hello" },
    })));
    act(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "terminal.focus", tabId: "a" },
    })));

    expect(terminals.createdIds).toEqual(["a"]);
    expect(terminals.writesById.get("a")).toEqual(["hello"]);
    expect(terminals.focusedIds).toEqual(["a"]);
  });

  it("selects the host-focused tab before focusing its terminal", () => {
    const terminals = new FakeTerminalFactory();
    const transport = new RecordingTransport();
    render(
      <App
        initialState={stateWith(
          [session("alpha", "Alpha", "waiting"), session("beta", "Beta", "waiting")],
          [tab("a", "alpha", "Alpha"), tab("b", "beta", "Beta")],
          "b",
        )}
        transport={transport}
        terminalFactory={terminals}
      />,
    );

    act(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "terminal.focus", tabId: "a" },
    })));

    expect(screen.getByTestId("terminal-mount-a")).toHaveAttribute("data-active", "true");
    expect(terminals.focusedIds).toEqual(["a"]);
  });
});
