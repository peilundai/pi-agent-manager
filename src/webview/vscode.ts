import type { WebviewToHostMessage } from "../shared/protocol";

export interface WebviewTransport {
  post(message: WebviewToHostMessage): void;
}

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

type VsCodeGlobal = typeof globalThis & {
  acquireVsCodeApi?: () => VsCodeApi;
};

export function createVsCodeTransport(): WebviewTransport {
  const api = (globalThis as VsCodeGlobal).acquireVsCodeApi?.();
  return {
    post: (message) => api?.postMessage(message),
  };
}
