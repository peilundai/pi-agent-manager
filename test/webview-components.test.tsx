import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SessionSummary, TerminalTab, ViewSnapshot } from "../src/shared/model";
import { App } from "../src/webview/App";
import { createInitialState } from "../src/webview/state";
import type { WebviewTransport } from "../src/webview/vscode";
import type { WebviewToHostMessage } from "../src/shared/protocol";

class RecordingTransport implements WebviewTransport {
  readonly messages: WebviewToHostMessage[] = [];

  post(message: WebviewToHostMessage): void {
    this.messages.push(message);
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

function stateWith(sessions: SessionSummary[], tabs: TerminalTab[] = [], activeTabId?: string) {
  const snapshot: ViewSnapshot = {
    sessions,
    tabs,
    ...(activeTabId ? { activeTabId } : {}),
    paneVisible: true,
    paneWidth: 248,
    collapsedGroups: [],
  };
  return createInitialState(snapshot);
}

describe("agent manager shell", () => {
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
    render(
      <App
        initialState={stateWith(
          [session("auth", "Auth cleanup", "waiting"), session("metrics", "Metrics fix")],
          [tab("tab-auth", "auth", "Auth cleanup")],
          "tab-auth",
        )}
        transport={transport}
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
    render(
      <App
        initialState={stateWith(
          [session("auth", "Auth cleanup", "waiting")],
          [tab("tab-auth", "auth", "Auth cleanup")],
          "tab-auth",
        )}
        transport={transport}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /auth cleanup/i }));
    await user.click(screen.getByRole("button", { name: /close auth cleanup tab/i }));
    expect(transport.messages).toContainEqual({ version: 1, type: "session.focus", tabId: "tab-auth" });
    expect(transport.messages).toContainEqual({ version: 1, type: "session.detach", tabId: "tab-auth" });
  });
});
