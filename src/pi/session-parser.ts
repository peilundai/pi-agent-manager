import { createReadStream } from "node:fs";
import { stat as fileStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { generateSessionTitle } from "./session-title";

export interface SessionFileStat {
  mtimeMs: number;
  birthtimeMs: number;
  size?: number;
}

export interface ParsedSession {
  id: string;
  path: string;
  cwd: string;
  title: string;
  explicitTitle?: string;
  generatedTitle?: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionHeader {
  id: string;
  cwd: string;
  timestamp?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function normalizedName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function userMessageText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = asRecord(entry.message);
  if (!message || message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;

  const text = message.content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block?.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

class SessionAccumulator {
  private header: SessionHeader | undefined;
  private invalidHeader = false;
  private explicitTitle: string | undefined;
  private generatedTitle: string | undefined;

  accept(line: string): void {
    const entry = parseLine(line);
    if (!entry || this.invalidHeader) return;

    if (!this.header) {
      if (entry.type !== "session" || typeof entry.id !== "string" || typeof entry.cwd !== "string") {
        this.invalidHeader = true;
        return;
      }
      this.header = {
        id: entry.id,
        cwd: entry.cwd,
        ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
      };
      return;
    }

    if (entry.type === "session_info") {
      this.explicitTitle = normalizedName(entry.name);
      return;
    }

    if (!this.generatedTitle) {
      const prompt = userMessageText(entry);
      if (prompt) this.generatedTitle = generateSessionTitle(prompt);
    }
  }

  result(path: string, stat: SessionFileStat): ParsedSession | undefined {
    if (!this.header || this.invalidHeader) return undefined;
    const timestamp = this.header.timestamp ? Date.parse(this.header.timestamp) : Number.NaN;
    const createdAt = Number.isFinite(timestamp)
      ? timestamp
      : stat.birthtimeMs > 0
        ? stat.birthtimeMs
        : stat.mtimeMs;
    const title = this.explicitTitle ?? this.generatedTitle ?? "New Agent";
    return {
      id: this.header.id,
      path,
      cwd: this.header.cwd,
      title,
      ...(this.explicitTitle ? { explicitTitle: this.explicitTitle } : {}),
      ...(this.generatedTitle ? { generatedTitle: this.generatedTitle } : {}),
      createdAt,
      updatedAt: stat.mtimeMs,
    };
  }
}

export function parseSessionLines(
  lines: Iterable<string>,
  path: string,
  stat: SessionFileStat,
): ParsedSession | undefined {
  const accumulator = new SessionAccumulator();
  for (const line of lines) accumulator.accept(line);
  return accumulator.result(path, stat);
}

export async function parseSessionFile(
  path: string,
  knownStat?: SessionFileStat,
): Promise<ParsedSession | undefined> {
  const stat = knownStat ?? (await fileStat(path));
  const accumulator = new SessionAccumulator();
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) accumulator.accept(line);
  return accumulator.result(path, stat);
}
