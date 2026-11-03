import { createContext, useContext } from "react";
import type { ToolExpansion, WebviewToHostMessage } from "../../shared/protocol";

export interface ChatContextValue {
  post(message: WebviewToHostMessage): void;
  /** Which tool cards start expanded; defaults to edits and writes. */
  toolExpansion?: ToolExpansion;
}

export const ChatContext = createContext<ChatContextValue>({ post: () => undefined });

export function useChat(): ChatContextValue {
  return useContext(ChatContext);
}

const FILE_LIKE = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8}(?::(\d+)(?:[-:]\d+)?)?$/;

/** Detects inline code that names a workspace file, optionally with a `:line` suffix. */
export function parseFileReference(text: string): { path: string; line?: number } | undefined {
  const trimmed = text.trim();
  if (trimmed.length > 300 || /^https?:/i.test(trimmed) || !trimmed.includes(".")) return undefined;
  const match = FILE_LIKE.exec(trimmed);
  if (!match) return undefined;
  // Require a directory separator or a source-like extension to avoid matching `1.5` or `e.g`.
  if (!trimmed.includes("/") && !/\.[a-z]{1,5}(?::\d+.*)?$/i.test(trimmed)) return undefined;
  const lineText = match[1];
  const path = lineText ? trimmed.slice(0, trimmed.indexOf(`:${lineText}`)) : trimmed;
  if (/^\d+(\.\d+)+$/.test(path)) return undefined;
  return { path, ...(lineText ? { line: Math.max(0, Number(lineText) - 1) } : {}) };
}
