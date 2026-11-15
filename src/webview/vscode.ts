import type { ContextReference, WebviewToHostMessage } from "../shared/protocol";

export interface PersistedWebviewState {
  draft?: string;
  /** Selections referenced by tokens in `draft`. */
  draftReferences?: ContextReference[];
  history?: string[];
  /** The editor-tab agent this webview belongs to, so VS Code can restore the tab after a reload. */
  agentId?: string;
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

/** The agent id the host put in the page for an editor tab; the sidebar has none. */
function pageAgentId(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLMetaElement>('meta[name="pi-agent-id"]')?.content || undefined;
}

export function createVsCodeTransport(): WebviewTransport {
  const api = (globalThis as VsCodeGlobal).acquireVsCodeApi?.();
  const agentId = pageAgentId();
  const getState = (): PersistedWebviewState => {
    const value = api?.getState();
    return typeof value === "object" && value !== null ? (value as PersistedWebviewState) : {};
  };
  // VS Code hands the saved state to the panel serializer after a reload; it must name the agent.
  const setState = (state: PersistedWebviewState) => api?.setState(agentId ? { ...state, agentId } : state);
  if (agentId && getState().agentId !== agentId) setState(getState());
  return { post: (message) => api?.postMessage(message), getState, setState };
}
