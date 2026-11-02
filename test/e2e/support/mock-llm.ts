import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny OpenAI-compatible `/v1/chat/completions` streaming server that scripts a
 * coding-agent conversation, so the real Pi CLI can run end to end without an API key.
 *
 * Scenarios are picked from the latest user message:
 * - contains "plain": one short markdown answer
 * - contains "slow":  a long, slow answer (for abort tests)
 * - contains "fail":  an HTTP 500 error
 * - otherwise:        thinking → read → edit → bash → final markdown
 */
export interface MockLlm {
  url: string;
  requests: Array<{ messages: Array<{ role: string; content?: unknown }> }>;
  close(): Promise<void>;
}

type Delta = Record<string, unknown>;

const words = (text: string): string[] => text.match(/\S+\s*|\s+/g) ?? [];

export const FINAL_ANSWER =
  "Done! I updated `src/greet.ts`:\n\n## Changes\n\n- Switched to a **template literal**\n- Capitalized the greeting\n\n```ts\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n```\n";

function stream(res: ServerResponse, deltas: Delta[], finish: string, delayMs: number): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-1" };
  let index = 0;
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const tick = () => {
    if (closed) return;
    if (index < deltas.length) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: deltas[index], finish_reason: null }] })}\n\n`);
      index += 1;
      setTimeout(tick, delayMs);
      return;
    }
    const usage = { prompt_tokens: 1_200, completion_tokens: 80, total_tokens: 1_280 };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  tick();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: { text?: string }) => part?.text ?? "").join(" ");
  return "";
}

function respond(req: IncomingMessage, res: ServerResponse, body: string, requests: MockLlm["requests"], delayMs: number): void {
  const json = JSON.parse(body || "{}") as { messages?: Array<{ role: string; content?: unknown }> };
  const messages = json.messages ?? [];
  requests.push({ messages });
  const toolResults = messages.filter((message) => message.role === "tool").length;
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const prompt = textOf(lastUser?.content);

  if (/fail/i.test(prompt)) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mock upstream exploded", type: "server_error" } }));
    return;
  }
  if (/plain/i.test(prompt)) {
    stream(res, words("Sure — a **short** answer referencing `src/greet.ts:2`.").map((content) => ({ content })), "stop", delayMs);
    return;
  }
  if (/slow/i.test(prompt)) {
    stream(res, words("tick ".repeat(400)).map((content) => ({ content })), "stop", 50);
    return;
  }
  if (toolResults === 0) {
    stream(
      res,
      [
        ...words("The user wants a greeting fix. Let me read the file first.").map((reasoning_content) => ({ reasoning_content })),
        ...words("I'll start by reading the greeting module.").map((content) => ({ content })),
        { tool_calls: [{ index: 0, id: "call_read_1", type: "function", function: { name: "read", arguments: "" } }] },
        { tool_calls: [{ index: 0, function: { arguments: '{"path":"src/gre' } }] },
        { tool_calls: [{ index: 0, function: { arguments: 'et.ts"}' } }] },
      ],
      "tool_calls",
      delayMs,
    );
    return;
  }
  if (toolResults === 1) {
    const args = JSON.stringify({ path: "src/greet.ts", edits: [{ oldText: 'return "hello " + name;', newText: "return `Hello, ${name}!`;" }] });
    stream(
      res,
      [
        ...words("Found it. Updating the string to use a template literal.").map((content) => ({ content })),
        { tool_calls: [{ index: 0, id: "call_edit_1", type: "function", function: { name: "edit", arguments: args } }] },
      ],
      "tool_calls",
      delayMs,
    );
    return;
  }
  if (toolResults === 2) {
    const args = JSON.stringify({ command: "cat src/greet.ts && echo done" });
    stream(res, [{ tool_calls: [{ index: 0, id: "call_bash_1", type: "function", function: { name: "bash", arguments: args } }] }], "tool_calls", delayMs);
    return;
  }
  stream(res, words(FINAL_ANSWER).map((content) => ({ content })), "stop", delayMs);
}

export async function startMockLlm(options: { delayMs?: number } = {}): Promise<MockLlm> {
  const requests: MockLlm["requests"] = [];
  const delayMs = options.delayMs ?? 5;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => respond(req, res, body, requests, delayMs));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
