/**
 * Minimal, structural types for the subset of Pi's RPC protocol this extension uses.
 * See `docs/rpc.md`, `docs/rpc-commands.md` and `docs/json.md` in the pi-coding-agent package.
 * Every field is treated as untrusted input; consumers must tolerate missing values.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface PiState {
  model?: PiModel;
  thinkingLevel?: ThinkingLevel;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
}

export interface PiCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | string;
}

export interface PiSessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type PiContent = PiTextContent | PiThinkingContent | PiImageContent | PiToolCall;

export interface PiToolResult {
  content?: PiContent[];
  details?: Record<string, unknown>;
}

export interface PiNestedToolCallRecord {
  id: string;
  name: string;
  /** Omitted when over Pi's size limits; `argumentsBytes` then gives their size. */
  arguments?: Record<string, unknown>;
  argumentsBytes?: number;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
}

export interface PiNestedToolCalls {
  calls: PiNestedToolCallRecord[];
  /** False when Pi dropped calls, omitted arguments, or calls had not finished. */
  complete: boolean;
}

export interface PiMessage {
  role: string;
  content?: string | PiContent[];
  timestamp?: number;
  // assistant
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  // toolResult
  toolCallId?: string;
  toolName?: string;
  details?: Record<string, unknown>;
  isError?: boolean;
  /** Calls the tool made to other tools (for example from a codemode script). Results are not recorded. */
  nestedCalls?: PiNestedToolCalls;
  // bashExecution
  command?: string;
  output?: string;
  exitCode?: number;
  // compactionSummary / branchSummary
  summary?: string;
  tokensBefore?: number;
  // custom
  customType?: string;
  display?: boolean;
}

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  | { type: "extension_ui_request"; id: string; method: string; [key: string]: unknown };

/** A record emitted by Pi on stdout that is not a command response. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
