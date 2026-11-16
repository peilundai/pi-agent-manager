import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Strict JSONL splitter for Pi's RPC stream: records end with LF only. Unlike
 * `readline`, U+2028/U+2029 inside JSON strings are not treated as line breaks.
 */
export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discarding = false;

  constructor(
    private readonly onRecord: (value: unknown) => void,
    private readonly onInvalid: (line: string, error: unknown) => void = () => undefined,
    private readonly maxLineLength = DEFAULT_MAX_LINE_BYTES,
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.discarding) this.discarding = false;
      else this.emit(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxLineLength) {
      // Drop an oversized record instead of growing without bound.
      this.onInvalid(this.buffer.slice(0, 200), new Error("JSONL record exceeds the size limit."));
      this.buffer = "";
      this.discarding = true;
    }
  }

  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer && !this.discarding) this.emit(this.buffer);
    this.buffer = "";
  }

  private emit(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    try {
      this.onRecord(JSON.parse(line));
    } catch (error) {
      this.onInvalid(line.slice(0, 200), error);
    }
  }
}

export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
