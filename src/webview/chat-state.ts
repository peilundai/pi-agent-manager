import type { SessionSummary, SetupErrorState } from "../shared/model";
import type { ChatSnapshot, HostToWebviewMessage, ImageAttachment, ProcessStatus } from "../shared/protocol";
import type { PiCommand, PiContent, PiEvent, PiMessage, PiModel, PiSessionStats, PiState, ThinkingLevel } from "../pi/rpc-types";

export type ToolStatus = "streaming" | "running" | "success" | "error" | "interrupted";

export interface ToolState {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  output: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "tool"; id: string };

export interface DialogRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  deadline?: number;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; images: ImageAttachment[]; pending?: boolean }
  | { kind: "assistant"; id: string; blocks: AssistantBlock[]; streaming: boolean; stopReason?: string; error?: string }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string }
  | { kind: "dialog"; id: string; request: DialogRequest; answer?: string }
  | { kind: "bash"; id: string; command: string; output: string; exitCode?: number }
  | { kind: "compaction"; id: string; tokensBefore?: number };

export interface ChatState {
  workspaceName: string;
  /** Several folders are open, so the folder is shown and can be switched. */
  multiRoot: boolean;
  platform: string;
  setupError?: SetupErrorState;
  process: { status: ProcessStatus | "idle"; error?: string; stderr?: string };
  pi: PiState;
  models: PiModel[];
  commands: PiCommand[];
  stats?: PiSessionStats;
  sessions: SessionSummary[];
  items: ChatItem[];
  tools: Record<string, ToolState>;
  busy: boolean;
  busySince?: number | undefined;
  activity?: string | undefined;
  queue: { steering: string[]; followUp: string[] };
  seq: number;
  /** Bumped whenever the transcript is replaced, so views can reset scroll. */
  epoch: number;
}

export const initialChatState: ChatState = {
  workspaceName: "",
  multiRoot: false,
  platform: "",
  process: { status: "idle" },
  pi: {},
  models: [],
  commands: [],
  sessions: [],
  items: [],
  tools: {},
  busy: false,
  queue: { steering: [], followUp: [] },
  seq: 0,
  epoch: 0,
};

export type ChatAction =
  | { type: "host"; message: HostToWebviewMessage; now: number }
  | { type: "user.send"; text: string; images: ImageAttachment[] }
  | { type: "dialog.answer"; id: string; answer: string }
  | { type: "notice.dismiss"; id: string };

function contentText(content: PiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Extract<PiContent, { type: "text" }> => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function contentImages(content: PiMessage["content"]): ImageAttachment[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is Extract<PiContent, { type: "image" }> => block?.type === "image" && Boolean(block.data))
    .map((block) => ({ data: block.data, mimeType: block.mimeType }));
}

function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === "text" ? block.text ?? "" : block?.type === "image" ? "[image]" : "",
    )
    .filter(Boolean)
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface Draft {
  items: ChatItem[];
  tools: Record<string, ToolState>;
  seq: number;
}

function nextId(draft: Draft, prefix: string): string {
  draft.seq += 1;
  return `${prefix}${draft.seq}`;
}

function assistantBlocks(content: PiMessage["content"], draft: Draft, finalStatus?: ToolStatus): AssistantBlock[] {
  if (!Array.isArray(content)) return typeof content === "string" && content ? [{ type: "text", text: content }] : [];
  const blocks: AssistantBlock[] = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text") {
      if (block.text) blocks.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      if (block.thinking || block.redacted) {
        blocks.push({ type: "thinking", text: block.thinking ?? "", ...(block.redacted ? { redacted: true } : {}) });
      }
    } else if (block.type === "toolCall" && block.id) {
      const existing = draft.tools[block.id];
      draft.tools[block.id] = {
        id: block.id,
        name: block.name,
        output: "",
        status: finalStatus ?? "running",
        ...existing,
        args: asRecord(block.arguments),
      };
      blocks.push({ type: "tool", id: block.id });
    }
  }
  return blocks;
}

function applyToolResult(draft: Draft, message: PiMessage): void {
  const id = message.toolCallId;
  if (!id) return;
  const existing = draft.tools[id];
  draft.tools[id] = {
    id,
    name: existing?.name ?? message.toolName ?? "tool",
    args: existing?.args ?? {},
    output: toolOutput(message.content),
    status: message.isError ? "error" : "success",
    ...(message.details ? { details: message.details } : existing?.details ? { details: existing.details } : {}),
    ...(existing?.durationMs !== undefined ? { durationMs: existing.durationMs } : {}),
  };
}

function abortedError(stopReason: string | undefined, errorMessage: string | undefined): string | undefined {
  if (stopReason === "error") return errorMessage || "The model request failed.";
  if (stopReason === "aborted") return "Interrupted";
  return undefined;
}

function appendMessage(draft: Draft, message: PiMessage, live: boolean): void {
  switch (message.role) {
    case "user": {
      const text = contentText(message.content);
      const images = contentImages(message.content);
      if (live) {
        const pendingIndex = draft.items.findIndex((item) => item.kind === "user" && item.pending);
        if (pendingIndex !== -1) {
          const pending = draft.items[pendingIndex] as Extract<ChatItem, { kind: "user" }>;
          draft.items[pendingIndex] = { kind: "user", id: pending.id, text, images: images.length ? images : pending.images };
          return;
        }
      }
      draft.items.push({ kind: "user", id: nextId(draft, "u"), text, images });
      return;
    }
    case "assistant": {
      const error = abortedError(message.stopReason, message.errorMessage);
      draft.items.push({
        kind: "assistant",
        id: nextId(draft, "a"),
        blocks: assistantBlocks(message.content, draft, live ? undefined : "running"),
        streaming: false,
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(error ? { error } : {}),
      });
      return;
    }
    case "toolResult":
      applyToolResult(draft, message);
      return;
    case "bashExecution":
      draft.items.push({
        kind: "bash",
        id: nextId(draft, "b"),
        command: message.command ?? "",
        output: message.output ?? "",
        ...(typeof message.exitCode === "number" ? { exitCode: message.exitCode } : {}),
      });
      return;
    case "compactionSummary":
      draft.items.push({
        kind: "compaction",
        id: nextId(draft, "c"),
        ...(typeof message.tokensBefore === "number" ? { tokensBefore: message.tokensBefore } : {}),
      });
      return;
    case "branchSummary":
      draft.items.push({ kind: "notice", id: nextId(draft, "n"), level: "info", text: "Continued from another branch." });
      return;
    case "custom": {
      if (message.display === false) return;
      const text = contentText(message.content);
      if (text) draft.items.push({ kind: "notice", id: nextId(draft, "n"), level: "info", text });
      return;
    }
    default:
      return;
  }
}

function hydrate(state: ChatState, snapshot: ChatSnapshot): ChatState {
  const draft: Draft = { items: [], tools: {}, seq: state.seq };
  for (const message of snapshot.messages) appendMessage(draft, message, false);
  const busy = Boolean(snapshot.state.isStreaming);
  if (!busy) {
    for (const tool of Object.values(draft.tools)) {
      if (tool.status === "running" || tool.status === "streaming") tool.status = "interrupted";
    }
  }
  return {
    ...state,
    pi: snapshot.state,
    models: snapshot.models,
    commands: snapshot.commands,
    ...(snapshot.stats ? { stats: snapshot.stats } : {}),
    items: draft.items,
    tools: draft.tools,
    seq: draft.seq,
    busy,
    ...(busy ? {} : { busySince: undefined, activity: undefined }),
    queue: { steering: [], followUp: [] },
    epoch: state.epoch + 1,
  };
}

function currentAssistant(draft: Draft): Extract<ChatItem, { kind: "assistant" }> {
  for (let index = draft.items.length - 1; index >= 0; index -= 1) {
    const item = draft.items[index];
    if (item?.kind === "assistant" && item.streaming) {
      const copy = { ...item, blocks: [...item.blocks] };
      draft.items[index] = copy;
      return copy;
    }
    if (item?.kind === "user") break;
  }
  const created: Extract<ChatItem, { kind: "assistant" }> = { kind: "assistant", id: nextId(draft, "a"), blocks: [], streaming: true };
  draft.items.push(created);
  return created;
}

function ensureBlock(
  item: Extract<ChatItem, { kind: "assistant" }>,
  index: number,
  block: AssistantBlock,
): AssistantBlock {
  const existing = item.blocks[index];
  if (existing && existing.type === block.type) return existing;
  // Fill gaps (for example a block that was never announced) so indexes stay aligned.
  while (item.blocks.length < index) item.blocks.push({ type: "text", text: "" });
  item.blocks[index] = block;
  return block;
}

function applyMessageUpdate(draft: Draft, update: Record<string, unknown>): void {
  const type = String(update.type ?? "");
  const index = Number.isInteger(update.contentIndex) ? Number(update.contentIndex) : 0;
  if (!/^(text|thinking|toolcall)_/.test(type)) return;
  const item = currentAssistant(draft);
  switch (type) {
    case "text_start":
      ensureBlock(item, index, { type: "text", text: "" });
      return;
    case "text_delta": {
      const block = ensureBlock(item, index, { type: "text", text: "" }) as Extract<AssistantBlock, { type: "text" }>;
      item.blocks[index] = { type: "text", text: block.text + String(update.delta ?? "") };
      return;
    }
    case "text_end":
      ensureBlock(item, index, { type: "text", text: "" });
      if (typeof update.content === "string") item.blocks[index] = { type: "text", text: update.content };
      return;
    case "thinking_start":
      ensureBlock(item, index, { type: "thinking", text: "" });
      return;
    case "thinking_delta": {
      const block = ensureBlock(item, index, { type: "thinking", text: "" }) as Extract<AssistantBlock, { type: "thinking" }>;
      item.blocks[index] = { type: "thinking", text: block.text + String(update.delta ?? "") };
      return;
    }
    case "thinking_end":
      ensureBlock(item, index, { type: "thinking", text: "" });
      if (typeof update.content === "string") item.blocks[index] = { type: "thinking", text: update.content };
      return;
    case "toolcall_start": {
      const id = typeof update.id === "string" ? update.id : `pending-${index}`;
      item.blocks[index] = { type: "tool", id };
      draft.tools[id] = {
        id,
        name: typeof update.toolName === "string" ? update.toolName : "tool",
        args: {},
        output: "",
        status: "streaming",
        ...draft.tools[id],
      };
      return;
    }
    case "toolcall_end": {
      const call = asRecord(update.toolCall);
      const id = typeof call.id === "string" ? call.id : undefined;
      if (!id) return;
      const previous = item.blocks[index];
      if (previous?.type === "tool" && previous.id !== id) delete draft.tools[previous.id];
      item.blocks[index] = { type: "tool", id };
      const existing = draft.tools[id];
      draft.tools[id] = {
        id,
        name: typeof call.name === "string" ? call.name : existing?.name ?? "tool",
        output: existing?.output ?? "",
        status: existing && existing.status !== "streaming" ? existing.status : "running",
        ...(existing?.details ? { details: existing.details } : {}),
        args: asRecord(call.arguments),
      };
      return;
    }
    default:
      return;
  }
}

function applyMessageEnd(draft: Draft, message: PiMessage): void {
  if (message.role === "assistant") {
    let index = -1;
    for (let cursor = draft.items.length - 1; cursor >= 0; cursor -= 1) {
      const item = draft.items[cursor];
      if (item?.kind === "assistant" && item.streaming) {
        index = cursor;
        break;
      }
      if (item?.kind === "user") break;
    }
    const error = abortedError(message.stopReason, message.errorMessage);
    const blocks = assistantBlocks(message.content, draft);
    const finished: ChatItem = {
      kind: "assistant",
      id: index === -1 ? nextId(draft, "a") : (draft.items[index] as ChatItem).id,
      blocks,
      streaming: false,
      ...(message.stopReason ? { stopReason: message.stopReason } : {}),
      ...(error ? { error } : {}),
    };
    if (index === -1) draft.items.push(finished);
    else draft.items[index] = finished;
    return;
  }
  if (message.role === "toolResult") {
    applyToolResult(draft, message);
    return;
  }
  if (message.role !== "user") appendMessage(draft, message, true);
}

function dialogFrom(event: PiEvent, now: number): DialogRequest | undefined {
  const method = event.method;
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return undefined;
  if (typeof event.id !== "string") return undefined;
  const timeout = typeof event.timeout === "number" && event.timeout > 0 ? event.timeout : undefined;
  return {
    id: event.id,
    method,
    title: typeof event.title === "string" ? event.title : "Pi needs your input",
    ...(typeof event.message === "string" ? { message: event.message } : {}),
    ...(Array.isArray(event.options) ? { options: event.options.filter((option): option is string => typeof option === "string") } : {}),
    ...(typeof event.placeholder === "string" ? { placeholder: event.placeholder } : {}),
    ...(typeof event.prefill === "string" ? { prefill: event.prefill } : {}),
    ...(timeout ? { deadline: now + timeout } : {}),
  };
}

function finishRun(draft: Draft, aborted: boolean): void {
  draft.items = draft.items.map((item) => (item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item));
  for (const [id, tool] of Object.entries(draft.tools)) {
    if (tool.status === "running" || tool.status === "streaming") {
      draft.tools[id] = { ...tool, status: aborted ? "interrupted" : "success" };
    }
  }
}

export function applyPiEvents(state: ChatState, events: readonly PiEvent[], now: number): ChatState {
  const draft: Draft = { items: [...state.items], tools: { ...state.tools }, seq: state.seq };
  let next: ChatState = state;
  const patch = (update: Partial<ChatState>): void => {
    next = { ...next, ...update };
  };
  for (const event of events) {
    switch (event.type) {
      case "agent_start":
        if (!next.busy) patch({ busy: true, busySince: now });
        break;
      case "agent_settled":
        finishRun(draft, Boolean(event.aborted));
        patch({ busy: false, busySince: undefined, activity: undefined });
        break;
      case "message_start": {
        const message = event.message as PiMessage | undefined;
        if (!message) break;
        if (message.role === "user") appendMessage(draft, message, true);
        else if (message.role === "assistant") {
          // message_start may already hold the first chunk, which the following deltas
          // repeat; rebuild live content from deltas only (message_end is authoritative).
          draft.items.push({ kind: "assistant", id: nextId(draft, "a"), blocks: [], streaming: true });
        }
        break;
      }
      case "message_update":
        applyMessageUpdate(draft, asRecord(event.assistantMessageEvent));
        break;
      case "message_end": {
        const message = event.message as PiMessage | undefined;
        if (message) applyMessageEnd(draft, message);
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (!id) break;
        const existing = draft.tools[id];
        const result = asRecord(event.type === "tool_execution_end" ? event.result : event.partialResult);
        const isEnd = event.type === "tool_execution_end";
        const output = event.type === "tool_execution_start" ? existing?.output ?? "" : toolOutput(result.content);
        const details = Object.keys(result).length ? asRecord(result.details) : existing?.details;
        draft.tools[id] = {
          id,
          name: typeof event.toolName === "string" ? event.toolName : existing?.name ?? "tool",
          args: event.args !== undefined ? asRecord(event.args) : existing?.args ?? {},
          output,
          status: isEnd ? (event.isError ? "error" : "success") : "running",
          ...(details && Object.keys(details).length ? { details } : {}),
          ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        };
        if (!draft.items.some((item) => item.kind === "assistant" && item.blocks.some((block) => block.type === "tool" && block.id === id))) {
          const item = currentAssistant(draft);
          item.blocks.push({ type: "tool", id });
        }
        break;
      }
      case "queue_update":
        patch({
          queue: {
            steering: Array.isArray(event.steering) ? event.steering.map(String) : [],
            followUp: Array.isArray(event.followUp) ? event.followUp.map(String) : [],
          },
        });
        break;
      case "compaction_start":
        patch({ activity: "Compacting conversation…" });
        break;
      case "compaction_end": {
        patch({ activity: undefined });
        const result = asRecord(event.result);
        if (Object.keys(result).length) {
          draft.items.push({
            kind: "compaction",
            id: nextId(draft, "c"),
            ...(typeof result.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}),
          });
        } else if (typeof event.errorMessage === "string") {
          draft.items.push({ kind: "notice", id: nextId(draft, "n"), level: "error", text: `Compaction failed: ${event.errorMessage}` });
        }
        break;
      }
      case "auto_retry_start": {
        const seconds = Math.max(1, Math.round(Number(event.delayMs ?? 0) / 1000));
        patch({ activity: `Retrying in ${seconds}s (attempt ${String(event.attempt ?? "?")}/${String(event.maxAttempts ?? "?")})` });
        break;
      }
      case "auto_retry_end":
        patch({ activity: undefined });
        if (event.success === false && typeof event.finalError === "string") {
          draft.items.push({ kind: "notice", id: nextId(draft, "n"), level: "error", text: event.finalError });
        }
        break;
      case "extension_error":
        draft.items.push({
          kind: "notice",
          id: nextId(draft, "n"),
          level: "warning",
          text: `Extension error: ${String(event.error ?? "unknown error")}`,
        });
        break;
      case "extension_ui_request": {
        if (event.method === "notify" && typeof event.message === "string") {
          const level = event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warning" : "info";
          draft.items.push({ kind: "notice", id: nextId(draft, "n"), level, text: event.message });
          break;
        }
        const request = dialogFrom(event, now);
        // Pending dialogs are re-sent after a snapshot; keep a single card per request.
        if (request && !draft.items.some((item) => item.kind === "dialog" && item.request.id === request.id)) {
          draft.items.push({ kind: "dialog", id: nextId(draft, "d"), request });
        }
        break;
      }
      case "session_info_changed": {
        const pi = { ...next.pi };
        if (typeof event.name === "string") pi.sessionName = event.name;
        else delete pi.sessionName;
        patch({ pi });
        break;
      }
      case "thinking_level_changed":
        patch({ pi: { ...next.pi, thinkingLevel: event.level as ThinkingLevel } });
        break;
      default:
        break;
    }
  }
  return { ...next, items: draft.items, tools: draft.tools, seq: draft.seq };
}

function pushNotice(state: ChatState, level: "info" | "warning" | "error", text: string): ChatState {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, { kind: "notice", id: `n${seq}`, level, text }] };
}

function handleHost(state: ChatState, message: HostToWebviewMessage, now: number): ChatState {
  switch (message.type) {
    case "init": {
      const next: ChatState = {
        ...state,
        workspaceName: message.workspaceName,
        multiRoot: Boolean(message.multiRoot),
        platform: message.platform,
      };
      if (message.setupError) next.setupError = message.setupError;
      else delete next.setupError;
      return next;
    }
    case "process": {
      const process: ChatState["process"] = { status: message.status };
      if (message.error) process.error = message.error;
      if (message.stderr) process.stderr = message.stderr;
      const exited = message.status === "exited";
      return { ...state, process, ...(exited ? { busy: false, busySince: undefined, activity: undefined } : {}) };
    }
    case "snapshot": {
      const next = hydrate(state, message.snapshot);
      return next.busy && !next.busySince ? { ...next, busySince: now } : next;
    }
    case "pi.events":
      return applyPiEvents(state, message.events, now);
    case "state": {
      const busy = state.busy || Boolean(message.state.isStreaming);
      return { ...state, pi: message.state, busy, ...(busy && !state.busySince ? { busySince: now } : {}) };
    }
    case "stats":
      return { ...state, stats: message.stats };
    case "sessions":
      return { ...state, sessions: message.sessions };
    case "prompt.result": {
      const removePending = message.error || message.disposition === "handled" || message.disposition === "queued";
      const items = removePending ? state.items.filter((item) => !(item.kind === "user" && item.pending)) : state.items;
      const next = { ...state, items };
      return message.error ? pushNotice(next, "error", message.error) : next;
    }
    case "notice":
      return pushNotice(state, message.level, message.message);
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "host":
      return handleHost(state, action.message, action.now);
    case "user.send": {
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        items: [...state.items, { kind: "user", id: `u${seq}`, text: action.text, images: action.images, pending: true }],
      };
    }
    case "dialog.answer":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "dialog" && item.request.id === action.id ? { ...item, answer: action.answer } : item,
        ),
      };
    case "notice.dismiss":
      return { ...state, items: state.items.filter((item) => item.id !== action.id) };
    default:
      return state;
  }
}
