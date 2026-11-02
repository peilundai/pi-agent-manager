import type { WebviewToHostMessage } from "../shared/protocol";

export interface PersistedWebviewState {
  draft?: string;
  history?: string[];
}

export interface WebviewTransport {
  post(message: WebviewToHostMessage): void;
  getState(): PersistedWebviewState;
  setState(state: PersistedWebviewState): void;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

type VsCodeGlobal = typeof globalThis & {
  acquireVsCodeApi?: () => VsCodeApi;
};

export function createVsCodeTransport(): WebviewTransport {
  const api = (globalThis as VsCodeGlobal).acquireVsCodeApi?.();
  return {
    post: (message) => api?.postMessage(message),
    getState: () => {
      const value = api?.getState();
      return typeof value === "object" && value !== null ? (value as PersistedWebviewState) : {};
    },
    setState: (state) => api?.setState(state),
  };
}
