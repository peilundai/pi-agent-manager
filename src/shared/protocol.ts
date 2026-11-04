import type { SessionSummary, SetupErrorState } from "./model";
import type { PiCommand, PiEvent, PiMessage, PiModel, PiSessionStats, PiState, ThinkingLevel } from "../pi/rpc-types";
import { THINKING_LEVELS } from "../pi/rpc-types";

const MAX_ID_LENGTH = 200;
const MAX_PROMPT_LENGTH = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 16_384;
const MAX_QUERY_LENGTH = 512;
const MAX_IMAGES = 20;
const MAX_IMAGE_BASE64 = 20 * 1024 * 1024;

export type ProcessStatus = "starting" | "ready" | "exited";

export interface ImageAttachment {
  data: string;
  mimeType: string;
  name?: string;
}

export type PromptMode = "send" | "steer" | "followUp";

/**
 * An editor selection shown in the composer as a compact `label` token, such as
 * `@src/app.ts#4-9`. `text` is the full context that replaces it when the prompt is sent.
 */
export interface ContextReference {
  label: string;
  text: string;
}

export type DialogResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export type WebviewToHostMessage =
  | { version: 1; type: "ready" }
  | { version: 1; type: "prompt"; text: string; images: ImageAttachment[]; mode: PromptMode }
  | { version: 1; type: "abort" }
  | { version: 1; type: "chat.new" }
  | { version: 1; type: "chat.open"; path: string }
  | { version: 1; type: "chat.rename" }
  | { version: 1; type: "chat.delete"; path: string }
  | { version: 1; type: "sessions.refresh" }
  | { version: 1; type: "folder.pick" }
  | { version: 1; type: "model.set"; provider: string; modelId: string }
  | { version: 1; type: "thinking.set"; level: ThinkingLevel }
  | { version: 1; type: "dialog.respond"; response: DialogResponse }
  | { version: 1; type: "files.search"; requestId: number; query: string }
  | { version: 1; type: "attach.pick" }
  | { version: 1; type: "file.open"; path: string; line?: number }
  | { version: 1; type: "url.open"; url: string }
  | { version: 1; type: "compact" }
  | { version: 1; type: "restart" }
  | { version: 1; type: "focus.changed"; focused: boolean }
  | { version: 1; type: "setup.action"; action: "openFolder" | "chooseExecutable" | "openSettings" | "retry" };

export interface ChatSnapshot {
  state: PiState;
  messages: PiMessage[];
  models: PiModel[];
  commands: PiCommand[];
  stats?: PiSessionStats;
}

/** Which tool cards start expanded: edits only, every tool, or none. */
export type ToolExpansion = "edits" | "all" | "none";

export const TOOL_EXPANSIONS: readonly ToolExpansion[] = ["edits", "all", "none"];

export type HostToWebviewMessage =
  | {
      version: 1;
      type: "init";
      workspaceName: string;
      platform: string;
      /** The window has several folders; the chat is scoped to `workspaceName` and can switch. */
      multiRoot?: boolean;
      /** Maximum width in pixels of the transcript and composer; 0 fills the view. */
      maxContentWidth?: number;
      setupError?: SetupErrorState;
      /** From the `piAgentManager.expandToolCards` setting. */
      toolExpansion?: ToolExpansion;
    }
  | { version: 1; type: "process"; status: ProcessStatus; error?: string; stderr?: string }
  | { version: 1; type: "snapshot"; snapshot: ChatSnapshot }
  | { version: 1; type: "pi.events"; events: PiEvent[] }
  | { version: 1; type: "state"; state: PiState }
  | { version: 1; type: "stats"; stats: PiSessionStats }
  | { version: 1; type: "sessions"; sessions: SessionSummary[] }
  | { version: 1; type: "prompt.result"; disposition?: string; error?: string }
  | { version: 1; type: "composer.insert"; text: string; images?: ImageAttachment[]; references?: ContextReference[] }
  | { version: 1; type: "composer.focus" }
  | { version: 1; type: "history.toggle" }
  | { version: 1; type: "files.result"; requestId: number; files: string[] }
  | { version: 1; type: "notice"; level: "info" | "warning" | "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

function isId(value: unknown): value is string {
  return isBoundedString(value, MAX_ID_LENGTH);
}

function isImage(value: unknown): value is ImageAttachment {
  return (
    isRecord(value) &&
    isBoundedString(value.data, MAX_IMAGE_BASE64) &&
    typeof value.mimeType === "string" &&
    /^image\/(png|jpeg|gif|webp)$/.test(value.mimeType) &&
    (value.name === undefined || isBoundedString(value.name, 512))
  );
}

function isDialogResponse(value: unknown): value is DialogResponse {
  if (!isRecord(value) || !isId(value.id)) return false;
  if ("value" in value) return isBoundedString(value.value, MAX_PROMPT_LENGTH, true);
  if ("confirmed" in value) return typeof value.confirmed === "boolean";
  return value.cancelled === true;
}

export function isWebviewMessage(value: unknown): value is WebviewToHostMessage {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") return false;
  switch (value.type) {
    case "ready":
    case "abort":
    case "chat.new":
    case "chat.rename":
    case "sessions.refresh":
    case "folder.pick":
    case "attach.pick":
    case "compact":
    case "restart":
      return true;
    case "prompt":
      return (
        isBoundedString(value.text, MAX_PROMPT_LENGTH, true) &&
        Array.isArray(value.images) &&
        value.images.length <= MAX_IMAGES &&
        value.images.every(isImage) &&
        (value.text.trim().length > 0 || value.images.length > 0) &&
        (value.mode === "send" || value.mode === "steer" || value.mode === "followUp")
      );
    case "chat.open":
    case "chat.delete":
      return isBoundedString(value.path, MAX_PATH_LENGTH) && value.path.endsWith(".jsonl");
    case "model.set":
      return isId(value.provider) && isId(value.modelId);
    case "thinking.set":
      return THINKING_LEVELS.includes(value.level as ThinkingLevel);
    case "dialog.respond":
      return isDialogResponse(value.response);
    case "files.search":
      return Number.isInteger(value.requestId) && isBoundedString(value.query, MAX_QUERY_LENGTH, true);
    case "file.open":
      return (
        isBoundedString(value.path, MAX_PATH_LENGTH) &&
        (value.line === undefined || (Number.isInteger(value.line) && Number(value.line) >= 0))
      );
    case "url.open":
      return isBoundedString(value.url, MAX_PATH_LENGTH) && /^https?:\/\//i.test(value.url);
    case "focus.changed":
      return typeof value.focused === "boolean";
    case "setup.action":
      return (
        value.action === "openFolder" ||
        value.action === "chooseExecutable" ||
        value.action === "openSettings" ||
        value.action === "retry"
      );
    default:
      return false;
  }
}

const HOST_TYPES = new Set<HostToWebviewMessage["type"]>([
  "init",
  "process",
  "snapshot",
  "pi.events",
  "state",
  "stats",
  "sessions",
  "prompt.result",
  "composer.insert",
  "composer.focus",
  "history.toggle",
  "files.result",
  "notice",
]);

/** Host messages come from the trusted extension host; only the envelope is checked. */
export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.type === "string" &&
    HOST_TYPES.has(value.type as HostToWebviewMessage["type"])
  );
}
