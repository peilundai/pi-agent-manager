import type { PiEvent } from "./rpc-types";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
/** Upper bound on the deltas kept for one streaming message (a runaway stream stops recording). */
const MAX_MESSAGE_EVENTS = 100_000;

/** Event types whose effect `RunReplay.replay()` reproduces, so a replay can stand in for them. */
const COVERED = new Set([
  "agent_start",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "queue_update",
  "compaction_start",
  "auto_retry_start",
]);

export function isDialogRequest(event: PiEvent): boolean {
  return event.type === "extension_ui_request" && typeof event.id === "string" && DIALOG_METHODS.has(String(event.method));
}

/**
 * Drops the cumulative copies Pi attaches to `message_update` (`message` and the inner `partial`).
 * The deltas alone rebuild the message, and keeping every snapshot would grow quadratically.
 */
function compactUpdate(event: PiEvent): PiEvent {
  const inner = event.assistantMessageEvent;
  if (!inner || typeof inner !== "object") return { type: event.type };
  const { partial: _partial, ...rest } = inner as Record<string, unknown>;
  void _partial;
  return { type: event.type, assistantMessageEvent: rest };
}

/**
 * The live part of a run that a `get_messages` snapshot cannot show: the run itself, the message
 * still streaming, running tools, queue/compaction/retry status and unanswered dialogs. Completed
 * messages are dropped as soon as they end, because the transcript already holds them.
 *
 * Feeding every Pi event through `track()` and calling `replay()` later yields the shortest event
 * list that brings a freshly hydrated chat to the same live state. The relay uses it to catch up a
 * reattaching window; `ChatSession` uses it to catch up a reloaded webview.
 */
export class RunReplay {
  private agentStart: PiEvent | undefined;
  private message: PiEvent[] | undefined;
  private readonly tools = new Map<string, PiEvent[]>();
  private queue: PiEvent | undefined;
  private compaction: PiEvent | undefined;
  private retry: PiEvent | undefined;
  private readonly dialogs = new Map<string, { event: PiEvent; expiresAt: number | undefined }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True when `replay()` reproduces the event's effect (or a snapshot already holds it). */
  static covers(event: PiEvent): boolean {
    return COVERED.has(event.type) || isDialogRequest(event);
  }

  get running(): boolean {
    return this.agentStart !== undefined;
  }

  track(event: PiEvent): void {
    const toolId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    switch (event.type) {
      case "agent_start":
        this.clearRun();
        this.agentStart = { type: "agent_start" };
        return;
      case "agent_settled":
        this.clearRun();
        return;
      case "message_start":
        this.message = [event];
        return;
      case "message_update":
        if (this.message && this.message.length < MAX_MESSAGE_EVENTS) this.message.push(compactUpdate(event));
        return;
      case "message_end":
        this.message = undefined;
        return;
      case "tool_execution_start":
        if (toolId) this.tools.set(toolId, [event]);
        return;
      case "tool_execution_update": {
        // Updates carry the tool's whole partial output, so only the latest matters.
        const start = toolId ? this.tools.get(toolId)?.[0] : undefined;
        if (toolId && start) this.tools.set(toolId, [start, event]);
        return;
      }
      case "tool_execution_end": {
        if (!toolId) return;
        const start = this.tools.get(toolId)?.[0];
        const parent = typeof start?.parentToolCallId === "string" ? start.parentToolCallId : undefined;
        // A call made by a tool that is still running (a codemode script) stays under its card.
        if (start && parent && this.tools.has(parent)) this.tools.set(toolId, [start, event]);
        else this.dropTool(toolId);
        return;
      }
      case "queue_update":
        this.queue = event;
        return;
      case "compaction_start":
        this.compaction = event;
        return;
      case "compaction_end":
        this.compaction = undefined;
        return;
      case "auto_retry_start":
        this.retry = event;
        return;
      case "auto_retry_end":
        this.retry = undefined;
        return;
      case "extension_ui_request":
        if (isDialogRequest(event)) {
          const timeout = typeof event.timeout === "number" && event.timeout > 0 ? event.timeout : undefined;
          this.dialogs.set(String(event.id), { event, expiresAt: timeout ? this.now() + timeout : undefined });
        }
        return;
    }
  }

  /** Forgets a dialog once it has been answered. */
  respond(id: string): void {
    this.dialogs.delete(id);
  }

  /** Forgets everything; used when the Pi process behind it changes. */
  reset(): void {
    this.clearRun();
    this.queue = undefined;
    this.compaction = undefined;
    this.dialogs.clear();
  }

  replay(): PiEvent[] {
    const events: PiEvent[] = [];
    if (this.agentStart) events.push(this.agentStart);
    if (this.queue) events.push(this.queue);
    if (this.compaction) events.push(this.compaction);
    if (this.retry) events.push(this.retry);
    for (const tool of this.tools.values()) events.push(...tool);
    if (this.message) events.push(...this.message);
    const now = this.now();
    for (const [id, entry] of this.dialogs) {
      if (entry.expiresAt === undefined) events.push(entry.event);
      else if (entry.expiresAt <= now) this.dialogs.delete(id);
      // Re-send with the time Pi has left before it auto-resolves the dialog.
      else events.push({ ...entry.event, timeout: entry.expiresAt - now });
    }
    return events;
  }

  /** Forgets a finished tool and the calls it made; its result is in the transcript. */
  private dropTool(id: string, depth = 0): void {
    this.tools.delete(id);
    if (depth >= 16) return;
    for (const [childId, [start]] of this.tools) {
      if (start?.parentToolCallId === id) this.dropTool(childId, depth + 1);
    }
  }

  private clearRun(): void {
    this.agentStart = undefined;
    this.message = undefined;
    this.tools.clear();
    this.retry = undefined;
  }
}
