import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { isHostMessage, type HostToWebviewMessage, type ImageAttachment, type PromptMode, type WebviewToHostMessage } from "../shared/protocol";
import { chatReducer, initialChatState, type ChatState } from "./chat-state";
import { Composer, type ComposerHandle, type LocalCommand } from "./components/Composer";
import { ChatContext } from "./components/context";
import { EmptyState, PiMascot } from "./components/EmptyState";
import { Header, SessionPicker } from "./components/Header";
import { TranscriptItem } from "./components/Transcript";
import type { WebviewTransport } from "./vscode";
import { generateSessionTitle } from "../pi/session-title";

const MAX_HISTORY = 50;
const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const WORKING_WORDS = ["Working", "Thinking", "Pondering", "Computing", "Crunching", "Reasoning", "Iterating"];

function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, now - since) : 0;
}

function StatusLine({ state }: { state: ChatState }) {
  // The reducer stamps busySince whenever a run starts, so render stays pure.
  const since = state.busy ? state.busySince : undefined;
  const elapsed = useElapsed(since);
  // Vary the word per run, deterministically from when the run started.
  const word = WORKING_WORDS[Math.floor((since ?? 0) / 1000) % WORKING_WORDS.length];
  if (!state.busy && !state.activity) return null;
  const frame = SPINNER_FRAMES[Math.floor(elapsed / 120) % SPINNER_FRAMES.length];
  const seconds = Math.floor(elapsed / 1000);
  return (
    <div className="status-line" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true">
        {frame}
      </span>
      <span className="status-word shimmer">{state.activity ?? `${word}…`}</span>
      <span className="status-meta">
        {seconds > 0 ? `${seconds}s · ` : ""}esc to interrupt
      </span>
    </div>
  );
}

function QueueChips({ queue }: { queue: ChatState["queue"] }) {
  const entries = [
    ...queue.steering.map((text) => ({ text, kind: "steer" })),
    ...queue.followUp.map((text) => ({ text, kind: "queued" })),
  ];
  if (!entries.length) return null;
  return (
    <div className="queue">
      {entries.map((entry, index) => (
        <div key={index} className="queue-chip" title={entry.text}>
          <span className="badge">{entry.kind}</span>
          <span className="queue-text">{entry.text}</span>
        </div>
      ))}
    </div>
  );
}

function SetupView({ state, post }: { state: ChatState; post(message: WebviewToHostMessage): void }) {
  const error = state.setupError;
  if (!error) return null;
  if (error.kind === "workspace") {
    return (
      <div className="setup">
        <PiMascot size={6} />
        <h2>Open a folder to chat with Pi</h2>
        <p>Pi works inside a workspace folder and keeps its chats per folder.</p>
        <button type="button" className="button primary" onClick={() => post({ version: 1, type: "setup.action", action: "openFolder" })}>
          Open Folder
        </button>
      </div>
    );
  }
  return (
    <div className="setup">
      <PiMascot size={6} />
      <h2>Pi CLI not found</h2>
      <p>Pi Agent Manager uses your local Pi installation. Install it, run <code>pi</code> once in a terminal to sign in, then retry.</p>
      <pre className="setup-command">npm install -g @earendil-works/pi-coding-agent</pre>
      <p className="muted">{error.message}</p>
      <div className="setup-actions">
        <button type="button" className="button primary" onClick={() => post({ version: 1, type: "setup.action", action: "retry" })}>
          Retry
        </button>
        <button type="button" className="button" onClick={() => post({ version: 1, type: "setup.action", action: "chooseExecutable" })}>
          Choose Executable…
        </button>
        <button type="button" className="button" onClick={() => post({ version: 1, type: "setup.action", action: "openSettings" })}>
          Settings
        </button>
      </div>
    </div>
  );
}

function ProcessBanner({ state, post }: { state: ChatState; post(message: WebviewToHostMessage): void }) {
  const { process } = state;
  if (process.status === "starting" && !state.items.length) {
    return <div className="process-banner muted">Starting Pi…</div>;
  }
  if (process.status !== "exited" || !process.error) return null;
  return (
    <div className="process-banner error" role="alert">
      <div className="process-title">
        <span className="codicon codicon-error" aria-hidden="true" />
        {process.error}
      </div>
      {process.stderr && (
        <details>
          <summary>Details</summary>
          <pre>{process.stderr}</pre>
        </details>
      )}
      <button type="button" className="button primary" onClick={() => post({ version: 1, type: "restart" })}>
        Restart Pi
      </button>
    </div>
  );
}

export function App({ transport }: { transport: WebviewTransport }) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [files, setFiles] = useState<{ requestId: number; files: string[] }>({ requestId: -1, files: [] });
  // Persisted webview state is read once; the ref is only touched from callbacks.
  const [initialPersisted] = useState(() => transport.getState());
  const persisted = useRef(initialPersisted);
  const [history, setHistory] = useState<string[]>(() => initialPersisted.history ?? []);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const pending = useRef<HostToWebviewMessage[]>([]);
  const frame = useRef<number | undefined>(undefined);

  const post = useCallback((message: WebviewToHostMessage) => transport.post(message), [transport]);
  const context = useMemo(() => ({ post }), [post]);

  useEffect(() => {
    const flush = () => {
      frame.current = undefined;
      const messages = pending.current.splice(0);
      const now = Date.now();
      for (const message of messages) dispatch({ type: "host", message, now });
    };
    const onMessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isHostMessage(message)) return;
      switch (message.type) {
        case "composer.insert":
          composer.current?.insert(message.text, message.images);
          return;
        case "composer.focus":
          composer.current?.focus();
          return;
        case "history.toggle":
          setHistoryOpen((open) => !open);
          post({ version: 1, type: "sessions.refresh" });
          return;
        case "files.result":
          setFiles({ requestId: message.requestId, files: message.files });
          return;
        default:
          // Batch streaming updates to one render per animation frame.
          pending.current.push(message);
          frame.current ??= requestAnimationFrame(flush);
      }
    };
    window.addEventListener("message", onMessage);
    post({ version: 1, type: "ready" });
    const onFocus = () => post({ version: 1, type: "focus.changed", focused: true });
    const onBlur = () => post({ version: 1, type: "focus.changed", focused: false });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [post]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  });

  useEffect(() => {
    stickToBottom.current = true;
  }, [state.epoch]);

  const onDraftChange = useCallback(
    (draft: string) => {
      persisted.current = { ...persisted.current, draft };
      transport.setState(persisted.current);
    },
    [transport],
  );
  // The composer remounts after a setup error is retried; give it the latest draft, not the first one.
  const loadDraft = useCallback(() => persisted.current.draft ?? "", []);

  const submit = useCallback(
    (text: string, images: ImageAttachment[], mode: PromptMode) => {
      if (mode === "send") dispatch({ type: "user.send", text, images });
      stickToBottom.current = true;
      post({ version: 1, type: "prompt", text, images, mode });
      if (text) {
        setHistory((current) => {
          const next = [...current.filter((entry) => entry !== text), text].slice(-MAX_HISTORY);
          persisted.current = { ...persisted.current, history: next };
          transport.setState(persisted.current);
          return next;
        });
      }
    },
    [post, transport],
  );

  const newChat = useCallback(() => {
    setHistoryOpen(false);
    post({ version: 1, type: "chat.new" });
  }, [post]);

  const localCommands: LocalCommand[] = useMemo(
    () => [
      { name: "new", description: "Start a new chat", run: newChat },
      { name: "compact", description: "Summarize the conversation to free context", run: () => post({ version: 1, type: "compact" }) },
      { name: "model", description: "Choose model and thinking level", run: () => composer.current?.toggleModelPicker() },
      { name: "rename", description: "Rename this chat", run: () => post({ version: 1, type: "chat.rename" }) },
      { name: "history", description: "Browse past chats", run: () => setHistoryOpen(true) },
    ],
    [newChat, post],
  );

  const activeSession = state.sessions.find((session) => session.path === state.pi.sessionFile);
  const firstPrompt = state.items.find((item) => item.kind === "user");
  const title =
    state.pi.sessionName ||
    (state.items.length ? activeSession?.title : undefined) ||
    (firstPrompt?.kind === "user" && firstPrompt.text ? generateSessionTitle(firstPrompt.text) : undefined) ||
    "Untitled";
  const busy = state.busy;
  const disabled = Boolean(state.setupError) || state.process.status === "exited";

  return (
    <ChatContext.Provider value={context}>
      <div className="app">
        <Header
          title={title}
          historyOpen={historyOpen}
          canRename={Boolean(state.pi.sessionFile) && state.items.length > 0}
          folderName={state.multiRoot ? state.workspaceName : undefined}
          onToggleHistory={() => {
            if (!historyOpen) post({ version: 1, type: "sessions.refresh" });
            setHistoryOpen(!historyOpen);
          }}
          onNewChat={newChat}
        />
        {historyOpen && (
          <SessionPicker
            sessions={state.sessions}
            activePath={state.pi.sessionFile}
            folderName={state.multiRoot ? state.workspaceName : undefined}
            onClose={() => setHistoryOpen(false)}
          />
        )}
        {state.setupError ? (
          <SetupView state={state} post={post} />
        ) : (
          <>
            <div
              className="transcript"
              ref={scroller}
              onScroll={(event) => {
                const element = event.currentTarget;
                stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
              }}
            >
              {state.items.length === 0 ? (
                <EmptyState platform={state.platform} workspaceName={state.workspaceName} />
              ) : (
                <div className="messages">
                  {state.items.map((item) => (
                    <TranscriptItem
                      key={item.id}
                      item={item}
                      tools={state.tools}
                      onDialogAnswer={(id, answer) => dispatch({ type: "dialog.answer", id, answer })}
                      onDismiss={(id) => dispatch({ type: "notice.dismiss", id })}
                    />
                  ))}
                </div>
              )}
              <ProcessBanner state={state} post={post} />
            </div>
            <div className="bottom">
              <StatusLine state={state} />
              <QueueChips queue={state.queue} />
              <Composer
                ref={composer}
                busy={busy}
                disabled={disabled}
                platform={state.platform}
                models={state.models}
                model={state.pi.model}
                thinkingLevel={state.pi.thinkingLevel}
                commands={state.commands}
                localCommands={localCommands}
                stats={state.stats}
                loadDraft={loadDraft}
                history={history}
                onDraftChange={onDraftChange}
                onSubmit={submit}
                onAbort={() => post({ version: 1, type: "abort" })}
                files={files}
              />
            </div>
          </>
        )}
      </div>
    </ChatContext.Provider>
  );
}
