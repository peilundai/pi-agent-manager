import { createConnection } from "node:net";
import type { SessionStatus } from "../src/shared/model";
import type { StatusReport } from "../src/pi/status-report";

export interface PiEventContext {
  isIdle(): boolean;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
  };
}

export interface PiExtensionApi {
  on(
    event: string,
    handler: (event: { name?: unknown }, context: PiEventContext) => void | Promise<void>,
  ): void;
}

export interface PiStatusRuntime {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  send?: (report: StatusReport) => void | Promise<void>;
}

function normalizedName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sendOverSocket(report: StatusReport, env: NodeJS.ProcessEnv): void {
  const host = env.PI_VSCODE_STATUS_HOST;
  const port = Number(env.PI_VSCODE_STATUS_PORT);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return;

  const socket = createConnection({ host, port });
  socket.setTimeout(1_000);
  socket.once("connect", () => socket.end(`${JSON.stringify(report)}\n`));
  socket.once("error", () => socket.destroy());
  socket.once("timeout", () => socket.destroy());
}

export default function registerPiStatus(
  pi: PiExtensionApi,
  runtime: PiStatusRuntime = {},
): void {
  const env = runtime.env ?? process.env;
  const token = env.PI_VSCODE_STATUS_TOKEN;
  const tabId = env.PI_VSCODE_TAB_ID;
  if (!token || !tabId) return;

  const now = runtime.now ?? Date.now;
  const send = runtime.send ?? ((report: StatusReport) => sendOverSocket(report, env));
  let sequence = 0;

  const report = async (
    status: SessionStatus,
    context: PiEventContext,
    nameOverride?: string | null,
    hasNameOverride = false,
  ): Promise<void> => {
    const sessionId = context.sessionManager.getSessionId();
    const sessionPath = context.sessionManager.getSessionFile();
    const name = hasNameOverride
      ? nameOverride ?? null
      : normalizedName(context.sessionManager.getSessionName());
    await send({
      version: 1,
      token,
      tabId,
      sequence: ++sequence,
      status,
      timestamp: now(),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      name,
    });
  };

  pi.on("session_start", async (_event, context) => report("waiting", context));
  pi.on("agent_start", async (_event, context) => report("working", context));
  pi.on("agent_settled", async (_event, context) => report("waiting", context));
  pi.on("session_shutdown", async (_event, context) => report("stopped", context));
  pi.on("session_info_changed", async (event, context) =>
    report(
      context.isIdle() ? "waiting" : "working",
      context,
      normalizedName(event.name),
      true,
    ),
  );
}
