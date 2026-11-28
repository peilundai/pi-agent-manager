import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * A scriptable stand-in for a spawned Pi process, for orderings a real process makes hard to
 * reproduce, such as `exit` arriving before the stdio pipes have drained.
 */
export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly written: string[] = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk.toString("utf8")));
    queueMicrotask(() => this.emit("spawn"));
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** Emits `exit`, lets the given late output through, then ends the pipes and emits `close`. */
  async exitThenDrain(code: number | null, late: { stdout?: string; stderr?: string } = {}): Promise<void> {
    this.emit("exit", code, null);
    await tick();
    if (late.stderr) this.stderr.write(late.stderr);
    if (late.stdout) this.stdout.write(late.stdout);
    await tick();
    this.stdout.end();
    this.stderr.end();
    await Promise.all([ended(this.stdout), ended(this.stderr)]);
    this.emit("close", code, null);
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function ended(stream: PassThrough): Promise<void> {
  if (stream.readableEnded) return Promise.resolve();
  return new Promise((resolve) => stream.once("end", () => resolve()));
}
