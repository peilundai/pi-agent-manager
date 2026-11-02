import type { RpcClientLike } from "../../src/pi/chat-session";
import type { RpcClientListener } from "../../src/pi/rpc-client";

/** In-memory `RpcClientLike` with canned responses for the RPC commands Pi Chat uses. */
export class FakeClient implements RpcClientLike {
  running = false;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly sent: Array<Record<string, unknown>> = [];
  constructor(readonly listener: RpcClientListener, private readonly responses: Record<string, unknown> = {}) {}
  async start() {
    this.running = true;
  }
  async request<T>(command: Record<string, unknown> & { type: string }): Promise<T> {
    this.requests.push(command);
    if (command.type in this.responses) {
      const value = this.responses[command.type];
      if (value instanceof Error) throw value;
      return value as T;
    }
    switch (command.type) {
      case "get_state":
        return { sessionFile: "/s/one.jsonl", sessionId: "one", thinkingLevel: "medium", model: { id: "m", provider: "p", name: "Model", cost: {} } } as T;
      case "get_messages":
        return { messages: [{ role: "system", content: "hidden" }, { role: "user", content: "hi" }] } as T;
      case "get_available_models":
        return { models: [{ id: "m", provider: "p", baseUrl: "secret" }] } as T;
      case "get_commands":
        return { commands: [{ name: "skill:x", source: "skill", sourceInfo: { path: "/x" } }] } as T;
      case "get_session_stats":
        return { contextUsage: { percent: 12 } } as T;
      default:
        return {} as T;
    }
  }
  send(record: Record<string, unknown>) {
    this.sent.push(record);
  }
  stderr() {
    return "";
  }
  async stop() {
    this.running = false;
  }
}
