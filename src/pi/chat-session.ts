import type { ChatSnapshot, DialogResponse, HostToWebviewMessage, ImageAttachment, PromptMode } from "../shared/protocol";
import type { RpcClientListener } from "./rpc-client";
import type { PiCommand, PiEvent, PiMessage, PiModel, PiSessionStats, PiState, ThinkingLevel } from "./rpc-types";
import { sanitizeEvent, sanitizeMessages } from "./sanitize";

const EVENT_FLUSH_MS = 16;
const PROMPT_TIMEOUT_MS = 10 * 60_000;
const ABORT_TIMEOUT_MS = 60_000;
const COMPACT_TIMEOUT_MS = 10 * 60_000;

export interface RpcClientLike {
  readonly running: boolean;
  start(): Promise<void>;
  request<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<T>;
  send(record: Record<string, unknown>): void;
  stderr(): string;
  stop(): Promise<void>;
}

export interface ChatSessionOptions {
  /** Creates (but does not start) a client for a fresh Pi process. */
  createClient(listener: RpcClientListener): Promise<RpcClientLike>;
  post(message: HostToWebviewMessage): void;
  /** Called when the session list may have changed (new transcript, rename). */
  onSessionsChanged(): void;
  /** Called after the active session file changes. */
  onActiveSessionChanged?(sessionFile: string | undefined): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the single live `pi --mode rpc` process for the chat view and translates
 * between webview intents and Pi RPC commands.
 */
export class ChatSession {
  private client: RpcClientLike | undefined;
  private starting: Promise<RpcClientLike> | undefined;
  private queue: PiEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private state: PiState = {};
  private busy = false;
  private disposed = false;
  private generation = 0;
  /**
   * Snapshot/event boundary. Pi writes responses and events to one ordered stream, and
   * `get_messages` returns only completed messages. While a snapshot is built, events read
   * before its `get_messages` response are collected in `beforeEvents` (completed messages among
   * them are already in the transcript), and events read after it in `afterEvents`. Both are
   * replayed, minus what the snapshot covers, once the snapshot is posted.
   */
  private snapshotGate: "idle" | "before" | "after" = "idle";
  private beforeEvents: PiEvent[] = [];
  private afterEvents: PiEvent[] = [];
  private snapshotInFlight: Promise<void> | undefined;
  /** Extension dialogs Pi is still waiting on; re-sent after each snapshot. */
  private readonly pendingDialogs = new Map<string, { event: PiEvent; expiresAt: number | undefined }>();

  constructor(private readonly options: ChatSessionOptions) {}

  get running(): boolean {
    return Boolean(this.client?.running);
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get sessionFile(): string | undefined {
    return this.state.sessionFile;
  }

  /** Starts Pi if needed, optionally resuming a transcript, and posts a snapshot. */
  async ensureStarted(sessionPath?: string): Promise<RpcClientLike> {
    if (this.client?.running) return this.client;
    this.starting ??= this.spawn(sessionPath).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async restart(sessionPath = this.state.sessionFile): Promise<void> {
    await this.stopProcess();
    await this.ensureStarted(sessionPath);
  }

  async prompt(text: string, images: ImageAttachment[], mode: PromptMode): Promise<void> {
    const client = await this.ensureStarted();
    const payloadImages = images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
    const command: Record<string, unknown> & { type: string } = { type: "prompt", message: text };
    if (payloadImages.length) command.images = payloadImages;
    if (this.busy || mode !== "send") command.streamingBehavior = mode === "steer" ? "steer" : "followUp";
    try {
      const result = await client.request<{ disposition?: string }>(command, PROMPT_TIMEOUT_MS);
      this.options.post({ version: 1, type: "prompt.result", disposition: result?.disposition ?? "started" });
      if (result?.disposition === "handled") await this.refreshState();
    } catch (error) {
      this.options.post({ version: 1, type: "prompt.result", error: errorMessage(error) });
    }
  }

  async abort(): Promise<void> {
    if (!this.client?.running) return;
    await this.client.request({ type: "abort" }, ABORT_TIMEOUT_MS).catch((error) => this.notice("warning", errorMessage(error)));
  }

  async newChat(): Promise<void> {
    const client = await this.ensureStarted();
    if (this.busy) await this.abort();
    const result = await client.request<{ cancelled?: boolean }>({ type: "new_session" });
    if (result?.cancelled) return;
    await this.postSnapshot();
  }

  async openSession(sessionPath: string): Promise<void> {
    if (!this.client?.running) {
      await this.ensureStarted(sessionPath);
      return;
    }
    if (sessionPath === this.state.sessionFile) return;
    if (this.busy) await this.abort();
    const result = await this.client.request<{ cancelled?: boolean }>({ type: "switch_session", sessionPath });
    if (result?.cancelled) return;
    await this.postSnapshot();
  }

  async rename(name: string): Promise<void> {
    const client = await this.ensureStarted();
    await client.request({ type: "set_session_name", name });
    await this.refreshState();
    this.options.onSessionsChanged();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const client = await this.ensureStarted();
    try {
      await client.request({ type: "set_model", provider, modelId });
    } catch (error) {
      this.notice("error", errorMessage(error));
    }
    await this.refreshState();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const client = await this.ensureStarted();
    try {
      await client.request({ type: "set_thinking_level", level });
    } catch (error) {
      this.notice("error", errorMessage(error));
    }
    await this.refreshState();
  }

  async compact(): Promise<void> {
    const client = await this.ensureStarted();
    try {
      await client.request({ type: "compact" }, COMPACT_TIMEOUT_MS);
    } catch (error) {
      this.notice("error", errorMessage(error));
    }
    await this.postSnapshot();
  }

  respondToDialog(response: DialogResponse): void {
    this.pendingDialogs.delete(response.id);
    this.client?.send({ type: "extension_ui_response", ...response });
  }

  /** Posts a full snapshot (state, transcript, models, commands, stats). */
  async postSnapshot(): Promise<void> {
    this.snapshotInFlight ??= this.buildSnapshot().finally(() => {
      this.snapshotInFlight = undefined;
    });
    return this.snapshotInFlight;
  }

  private async buildSnapshot(): Promise<void> {
    const client = this.client;
    if (!client?.running) return;
    const generation = this.generation;
    // Anything still queued predates get_messages; reconcile it with the snapshot below.
    this.beforeEvents = this.takeQueue();
    this.afterEvents = [];
    this.snapshotGate = "before";
    let posted = false;
    try {
      const [state, messages, models, commands, stats] = await Promise.all([
        client.request<PiState>({ type: "get_state" }),
        client.request<{ messages?: PiMessage[] }>({ type: "get_messages" }).then((data) => {
          // Fallback for clients that do not report responses synchronously.
          if (this.snapshotGate === "before") this.snapshotGate = "after";
          return data?.messages ?? [];
        }),
        client.request<{ models?: PiModel[] }>({ type: "get_available_models" }).then((data) => data?.models ?? []).catch(() => []),
        client.request<{ commands?: PiCommand[] }>({ type: "get_commands" }).then((data) => data?.commands ?? []).catch(() => []),
        client.request<PiSessionStats>({ type: "get_session_stats" }).catch(() => undefined),
      ]);
      if (generation !== this.generation) return;
      this.applyState(state);
      const snapshot: ChatSnapshot = {
        state: this.state,
        messages: sanitizeMessages(messages),
        models: models.map(compactModel),
        commands: commands.map(({ name, description, source }) => ({ name, description: description ?? "", source })),
        ...(stats ? { stats } : {}),
      };
      this.options.post({ version: 1, type: "snapshot", snapshot });
      posted = true;
    } finally {
      const before = this.beforeEvents;
      const after = this.afterEvents;
      this.snapshotGate = "idle";
      this.beforeEvents = [];
      this.afterEvents = [];
      if (generation === this.generation) {
        // Without a snapshot nothing is covered: replay everything in order.
        const replay = [...(posted ? withoutSnapshotCoverage(before) : before), ...after];
        if (posted) replay.push(...this.livePendingDialogs());
        for (const event of replay) this.enqueueSanitized(event);
        this.flush();
      }
    }
  }

  private livePendingDialogs(): PiEvent[] {
    const now = Date.now();
    const live: PiEvent[] = [];
    for (const [id, entry] of this.pendingDialogs) {
      if (entry.expiresAt === undefined) live.push(entry.event);
      else if (entry.expiresAt <= now) this.pendingDialogs.delete(id);
      // Re-send with the time Pi has left before it auto-resolves the dialog.
      else live.push({ ...entry.event, timeout: entry.expiresAt - now });
    }
    return live;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.stopProcess();
  }

  private async spawn(sessionPath: string | undefined): Promise<RpcClientLike> {
    if (this.disposed) throw new Error("Pi Agent Manager has been disposed.");
    this.generation += 1;
    const generation = this.generation;
    this.busy = false;
    this.options.post({ version: 1, type: "process", status: "starting" });
    let client: RpcClientLike;
    try {
      client = await this.options.createClient({
        onEvent: (event) => {
          if (generation === this.generation) this.handleEvent(event);
        },
        onResponse: ({ command }) => {
          if (generation === this.generation && command === "get_messages" && this.snapshotGate === "before") {
            this.snapshotGate = "after";
          }
        },
        onExit: ({ code, signal, stderr, expected }) => {
          if (generation !== this.generation) return;
          this.flush();
          this.busy = false;
          this.client = undefined;
          this.options.post({
            version: 1,
            type: "process",
            status: "exited",
            ...(expected ? {} : { error: signal ? `Pi stopped (signal ${signal}).` : `Pi exited with code ${code ?? "unknown"}.` }),
            ...(expected || !stderr ? {} : { stderr: stderr.slice(-4_000) }),
          });
        },
      });
      await client.start();
    } catch (error) {
      if (generation === this.generation) {
        this.options.post({ version: 1, type: "process", status: "exited", error: errorMessage(error) });
      }
      throw error;
    }
    if (this.disposed || generation !== this.generation) {
      // Disposed or restarted while Pi was starting: do not leave an orphaned process.
      await client.stop();
      throw new Error("Pi Agent Manager startup was cancelled.");
    }
    this.client = client;
    try {
      if (sessionPath) {
        // Switching through RPC avoids racing Pi's startup session selection.
        await client.request({ type: "switch_session", sessionPath });
      }
      await this.postSnapshot();
    } catch (error) {
      this.options.post({
        version: 1,
        type: "process",
        status: client.running ? "ready" : "exited",
        error: errorMessage(error),
        stderr: client.stderr().slice(-4_000),
      });
      if (!client.running) throw error;
      return client;
    }
    this.options.post({ version: 1, type: "process", status: "ready" });
    return client;
  }

  private async stopProcess(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.generation += 1;
    this.busy = false;
    this.pendingDialogs.clear();
    await client?.stop();
  }

  private handleEvent(event: PiEvent): void {
    switch (event.type) {
      case "agent_start":
        this.busy = true;
        break;
      case "agent_settled":
        this.busy = false;
        this.enqueue(event);
        this.flush();
        void this.afterSettled();
        return;
      case "session_info_changed":
        this.state = { ...this.state, ...(typeof event.name === "string" ? { sessionName: event.name } : {}) };
        if (typeof event.name !== "string") delete this.state.sessionName;
        this.options.onSessionsChanged();
        break;
      case "thinking_level_changed":
        this.state = { ...this.state, thinkingLevel: event.level as ThinkingLevel };
        break;
      case "extension_ui_request":
        if (event.method === "set_editor_text" && typeof event.text === "string") {
          this.options.post({ version: 1, type: "composer.insert", text: event.text });
          return;
        }
        if (typeof event.id === "string" && DIALOG_METHODS.has(String(event.method))) {
          const timeout = typeof event.timeout === "number" && event.timeout > 0 ? event.timeout : undefined;
          this.pendingDialogs.set(event.id, { event, expiresAt: timeout ? Date.now() + timeout : undefined });
        }
        break;
    }
    this.enqueue(event);
  }

  private enqueue(event: PiEvent): void {
    const sanitized = sanitizeEvent(event);
    if (!sanitized) return;
    if (this.snapshotGate === "before") this.beforeEvents.push(sanitized);
    else if (this.snapshotGate === "after") this.afterEvents.push(sanitized);
    else this.enqueueSanitized(sanitized);
  }

  private enqueueSanitized(event: PiEvent): void {
    this.queue.push(event);
    this.flushTimer ??= setTimeout(() => this.flush(), EVENT_FLUSH_MS);
  }

  private takeQueue(): PiEvent[] {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const events = this.queue;
    this.queue = [];
    return events;
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.queue.length) return;
    const events = this.queue;
    this.queue = [];
    this.options.post({ version: 1, type: "pi.events", events });
  }

  private async afterSettled(): Promise<void> {
    await this.refreshState();
    const client = this.client;
    if (!client?.running) return;
    const stats = await client.request<PiSessionStats>({ type: "get_session_stats" }).catch(() => undefined);
    if (stats) this.options.post({ version: 1, type: "stats", stats });
    this.options.onSessionsChanged();
  }

  private async refreshState(): Promise<void> {
    const client = this.client;
    if (!client?.running) return;
    try {
      this.applyState(await client.request<PiState>({ type: "get_state" }));
      this.options.post({ version: 1, type: "state", state: this.state });
    } catch {
      // A transient state query failure is not worth surfacing.
    }
  }

  private applyState(state: PiState | undefined): void {
    const previous = this.state.sessionFile;
    this.state = {
      ...(state?.model ? { model: compactModel(state.model) } : {}),
      ...(state?.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
      isStreaming: Boolean(state?.isStreaming),
      isCompacting: Boolean(state?.isCompacting),
      ...(state?.sessionFile ? { sessionFile: state.sessionFile } : {}),
      ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state?.sessionName ? { sessionName: state.sessionName } : {}),
      messageCount: state?.messageCount ?? 0,
      pendingMessageCount: state?.pendingMessageCount ?? 0,
    };
    this.busy = Boolean(state?.isStreaming) || this.busy;
    if (previous !== this.state.sessionFile) this.options.onActiveSessionChanged?.(this.state.sessionFile);
  }

  private notice(level: "info" | "warning" | "error", message: string): void {
    this.options.post({ version: 1, type: "notice", level, message });
  }
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const MESSAGE_EVENTS = new Set(["message_start", "message_update", "message_end"]);

/**
 * Removes events whose effect a `get_messages` snapshot already contains: the lifecycle of every
 * message that completed (`message_end`) before the boundary, and compaction results (the
 * snapshot holds the compaction summary). A message still streaming at the boundary is not in
 * the snapshot, so its `message_start`/`message_update` events are kept. Everything else
 * (tool progress, dialogs, queue and status changes) is not part of the transcript and is kept.
 */
export function withoutSnapshotCoverage(events: readonly PiEvent[]): PiEvent[] {
  const kept: PiEvent[] = [];
  let message: PiEvent[] = [];
  for (const event of events) {
    if (MESSAGE_EVENTS.has(event.type)) {
      if (event.type === "message_start") {
        kept.push(...message);
        message = [event];
      } else if (event.type === "message_update") {
        message.push(event);
      } else {
        message = [];
      }
      continue;
    }
    if (event.type === "compaction_end") {
      const { result: _covered, ...rest } = event;
      void _covered;
      kept.push(rest as PiEvent);
      continue;
    }
    kept.push(event);
  }
  kept.push(...message);
  return kept;
}

function compactModel(model: PiModel): PiModel {
  return {
    id: model.id,
    provider: model.provider,
    ...(model.name ? { name: model.name } : {}),
    reasoning: Boolean(model.reasoning),
    ...(model.input ? { input: model.input } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  };
}
