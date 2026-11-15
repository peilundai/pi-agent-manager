import { afterEach, describe, expect, it, vi } from "vitest";
import { createVsCodeTransport } from "../src/webview/vscode";

type Global = typeof globalThis & { acquireVsCodeApi?: () => unknown };

afterEach(() => {
  delete (globalThis as Global).acquireVsCodeApi;
  document.head.querySelector('meta[name="pi-agent-id"]')?.remove();
});

describe("createVsCodeTransport", () => {
  it("wraps the VS Code webview API", () => {
    const api = { postMessage: vi.fn(), getState: vi.fn(() => ({ draft: "hi" })), setState: vi.fn() };
    (globalThis as Global).acquireVsCodeApi = () => api;
    const transport = createVsCodeTransport();
    transport.post({ version: 1, type: "ready" });
    expect(api.postMessage).toHaveBeenCalledWith({ version: 1, type: "ready" });
    expect(transport.getState()).toEqual({ draft: "hi" });
    transport.setState({ history: ["a"] });
    expect(api.setState).toHaveBeenCalledWith({ history: ["a"] });
  });

  it("keeps an editor tab's agent id in every saved state, so VS Code can restore the tab", () => {
    const meta = document.createElement("meta");
    meta.name = "pi-agent-id";
    meta.content = "agent-1";
    document.head.append(meta);
    let saved: unknown = { draft: "hi" };
    const api = { postMessage: vi.fn(), getState: vi.fn(() => saved), setState: vi.fn((state: unknown) => (saved = state)) };
    (globalThis as Global).acquireVsCodeApi = () => api;
    const transport = createVsCodeTransport();
    expect(api.setState).toHaveBeenCalledWith({ draft: "hi", agentId: "agent-1" });
    transport.setState({ history: ["a"] });
    expect(saved).toEqual({ history: ["a"], agentId: "agent-1" });
  });

  it("degrades gracefully outside VS Code", () => {
    const transport = createVsCodeTransport();
    expect(() => transport.post({ version: 1, type: "ready" })).not.toThrow();
    expect(transport.getState()).toEqual({});
  });
});
