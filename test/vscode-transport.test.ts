import { afterEach, describe, expect, it, vi } from "vitest";
import { createVsCodeTransport } from "../src/webview/vscode";

type Global = typeof globalThis & { acquireVsCodeApi?: () => unknown };

afterEach(() => {
  delete (globalThis as Global).acquireVsCodeApi;
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

  it("degrades gracefully outside VS Code", () => {
    const transport = createVsCodeTransport();
    expect(() => transport.post({ version: 1, type: "ready" })).not.toThrow();
    expect(transport.getState()).toEqual({});
  });
});
