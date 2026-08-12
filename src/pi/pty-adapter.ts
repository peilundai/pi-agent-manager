import * as nodePty from "node-pty";

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface PtyAdapter {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess;
}

export class NodePtyAdapter implements PtyAdapter {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess {
    return nodePty.spawn(file, [...args], {
      name: "xterm-256color",
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows,
    });
  }
}
