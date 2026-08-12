import { randomBytes } from "node:crypto";
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { StatusReportGate, type StatusReport } from "./status-report";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_LINE_BYTES = 65_536;

export interface PiStatusBridgeOptions {
  token?: string;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export class PiStatusBridge {
  private readonly token: string;
  private readonly gate: StatusReportGate;
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private port: number | undefined;

  constructor(
    private readonly onReport: (report: StatusReport) => void,
    options: PiStatusBridgeOptions = {},
  ) {
    this.token = options.token ?? randomBytes(32).toString("hex");
    this.gate = new StatusReportGate(this.token);
  }

  async start(): Promise<void> {
    if (this.port !== undefined) return;
    if (this.server) throw new Error("Pi status bridge is already starting.");

    const server = createServer((socket) => this.acceptSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
        server.off("error", onError);
        const address = server.address() as AddressInfo | null;
        if (!address) {
          reject(new Error("Pi status bridge did not receive a listening address."));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
    server.on("error", () => undefined);
    server.unref();
  }

  environmentFor(tabId: string): Record<string, string> {
    if (this.port === undefined) throw new Error("Start the Pi status bridge before creating an environment.");
    if (!tabId || tabId.length > 200) throw new Error("Invalid Pi tab identifier.");
    return {
      PI_VSCODE_STATUS_HOST: LOOPBACK_HOST,
      PI_VSCODE_STATUS_PORT: String(this.port),
      PI_VSCODE_STATUS_TOKEN: this.token,
      PI_VSCODE_TAB_ID: tabId,
    };
  }

  async dispose(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private acceptSocket(socket: Socket): void {
    if (!isLoopback(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          socket.destroy();
          return;
        }
        this.handleLine(line);
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) socket.destroy();
    });

    const forget = (): void => {
      this.sockets.delete(socket);
    };
    socket.on("close", forget);
    socket.on("error", forget);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      const report = this.gate.accept(JSON.parse(line));
      if (report) this.onReport(report);
    } catch {
      // A malformed or consumer-rejected status report must not affect Pi.
    }
  }
}
