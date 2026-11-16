import type { PiEvent, PiMessage } from "./rpc-types";

const MAX_STRING = 96 * 1024;
const MAX_IMAGE_DATA = 6 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_ARRAY = 2_000;

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const omitted = value.length - limit;
  return `${value.slice(0, limit)}\n… [${omitted.toLocaleString("en-US")} more characters truncated]`;
}

/** Deep-copies a JSON value, bounding strings, arrays and depth for the webview. */
export function boundJson(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value, MAX_STRING);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => boundJson(item, depth + 1));
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const isImage = record.type === "image" && typeof record.data === "string";
  for (const [key, item] of Object.entries(record)) {
    if (isImage && key === "data") {
      output.data = (item as string).length <= MAX_IMAGE_DATA ? item : "";
      continue;
    }
    output[key] = boundJson(item, depth + 1);
  }
  return output;
}

const HIDDEN_ROLES = new Set(["system"]);

export function isVisibleMessage(message: PiMessage | undefined): boolean {
  return Boolean(message && typeof message.role === "string" && !HIDDEN_ROLES.has(message.role));
}

/**
 * Converts a raw Pi event into what the webview needs, or `undefined` to drop it.
 * Large aggregate events (`agent_end`, `turn_end`) are reduced to their type.
 */
export function sanitizeEvent(event: PiEvent): PiEvent | undefined {
  switch (event.type) {
    case "agent_end":
      return { type: "agent_end", willRetry: Boolean(event.willRetry) };
    case "turn_end":
      return { type: "turn_end" };
    case "message_start":
    case "message_end": {
      const message = event.message as PiMessage | undefined;
      if (!isVisibleMessage(message)) return undefined;
      return { type: event.type, message: boundJson(message) };
    }
    case "message_update": {
      const inner = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!inner) return undefined;
      // 0.x versions also sent cumulative snapshots; drop them to keep the stream linear.
      const { partial: _partial, ...rest } = inner;
      void _partial;
      return { type: "message_update", assistantMessageEvent: boundJson(rest) };
    }
    case "entry_appended":
    case "bash_execution_update":
      return undefined;
    default:
      return boundJson(event) as PiEvent;
  }
}

export function sanitizeMessages(messages: readonly PiMessage[]): PiMessage[] {
  return messages.filter(isVisibleMessage).map((message) => boundJson(message) as PiMessage);
}
