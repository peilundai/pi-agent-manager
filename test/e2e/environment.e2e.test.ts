// End to end: a key exported only from the user's login shell reaches the real Pi CLI,
// which uses it to call a company gateway (a mock that rejects requests without the key).
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatSession } from "../../src/pi/chat-session";
import { buildPiInvocation, buildRpcArgs } from "../../src/pi/command-resolver";
import { findEnvironmentReferences, missingReferences } from "../../src/pi/config-references";
import { PiRpcClient } from "../../src/pi/rpc-client";
import { mergeEnvironment, resolveShellEnvironment } from "../../src/pi/shell-environment";
import type { HostToWebviewMessage } from "../../src/shared/protocol";
import { chatReducer, initialChatState, type ChatState } from "../../src/webview/chat-state";
import { GATEWAY_REJECTION, startMockLlm, type MockLlm } from "./support/mock-llm";
import { piExecutable, waitFor } from "./support/pi-env";

const BASH = "/bin/bash";
const KEY = "gw-live-0123456789";
const supported = process.platform !== "win32" && existsSync(BASH);

let llm: MockLlm;
let home: string;
let agentDir: string;
let workspace: string;
/** What a Dock-launched VS Code sees: no gateway key. */
let editorEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  if (!supported) return;
  llm = await startMockLlm({ apiKey: KEY });
  home = await mkdtemp(join(tmpdir(), "pi-env-e2e-"));
  agentDir = join(home, ".pi", "agent");
  workspace = join(home, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        gateway: {
          name: "Company Gateway",
          baseUrl: llm.url,
          api: "openai-completions",
          apiKey: "${GATEWAY_API_KEY}",
          models: [{ id: "mock-1", name: "Gateway Model", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4_000 }],
        },
      },
    }),
  );
  // Login-shell startup files print noise and export the key, like a typical setup.
  await writeFile(join(home, ".bash_profile"), `echo "Welcome back"\nexport GATEWAY_API_KEY=${KEY}\n`);
  editorEnv = { ...process.env, HOME: home, USERPROFILE: home, SHELL: BASH, PI_CODING_AGENT_DIR: agentDir };
  delete editorEnv.GATEWAY_API_KEY;
  delete editorEnv.PI_CODING_AGENT_SESSION_DIR;
  delete editorEnv.BASH_ENV;
});

afterAll(async () => {
  await llm?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

async function runPlainTurn(env: NodeJS.ProcessEnv): Promise<ChatState> {
  let state: ChatState = initialChatState;
  const posted: HostToWebviewMessage[] = [];
  const session = new ChatSession({
    createClient: async (listener) => {
      const invocation = buildPiInvocation(piExecutable(), buildRpcArgs({ extraArgs: ["--provider", "gateway", "--model", "mock-1", "--offline"] }));
      return new PiRpcClient({ file: invocation.file, args: invocation.args, cwd: workspace, env: { ...env, ...invocation.env } }, listener);
    },
    post: (message) => {
      posted.push(message);
      state = chatReducer(state, { type: "host", message, now: Date.now() });
    },
    onSessionsChanged: () => undefined,
  });
  try {
    await session.ensureStarted();
    state = chatReducer(state, { type: "user.send", text: "plain answer please", images: [] });
    await session.prompt("plain answer please", [], "send");
    const failed = (): boolean => state.items.some((item) => item.kind === "notice" && item.level === "error");
    return await waitFor(() => (posted.some((message) => message.type === "stats") || failed()) && !state.busy && state, 30_000, "turn");
  } finally {
    await session.dispose();
  }
}

describe.skipIf(!supported)("login-shell environment", () => {
  it("loads variables that only the login shell exports, despite rc-file output", async () => {
    const result = await resolveShellEnvironment({ env: editorEnv, execPath: process.execPath });
    expect(result).toMatchObject({ status: "loaded", shell: BASH });
    expect(result.status === "loaded" && result.env.GATEWAY_API_KEY).toBe(KEY);
  });

  it("names the variable Pi's gateway config needs until the shell provides it", async () => {
    const references = await findEnvironmentReferences({ env: editorEnv, cwd: workspace });
    expect(missingReferences(references, editorEnv).map((reference) => reference.name)).toEqual(["GATEWAY_API_KEY"]);
    const result = await resolveShellEnvironment({ env: editorEnv, execPath: process.execPath });
    const merged = mergeEnvironment({ base: editorEnv, shell: result.status === "loaded" ? result.env : undefined });
    expect(missingReferences(references, merged)).toEqual([]);
  });

  it("fails against the gateway with VS Code's environment and works with the merged one", async () => {
    // Pi either refuses to send an unresolved key or the gateway rejects what it sent.
    const without = await runPlainTurn(editorEnv);
    const errors = without.items.flatMap((item) =>
      item.kind === "notice" && item.level === "error" ? [item.text] : item.kind === "assistant" && item.error ? [item.error] : [],
    );
    expect(errors.join("\n")).toMatch(new RegExp(`No API key found for gateway|${GATEWAY_REJECTION}`));
    expect(without.items.some((item) => item.kind === "assistant" && !item.error)).toBe(false);

    const result = await resolveShellEnvironment({ env: editorEnv, execPath: process.execPath });
    const merged = mergeEnvironment({ base: editorEnv, shell: result.status === "loaded" ? result.env : undefined });
    const withShell = await runPlainTurn(merged);
    const answer = withShell.items.find((item) => item.kind === "assistant" && !item.error);
    expect(answer).toBeDefined();
    expect(JSON.stringify(answer)).toContain("short");
  });
});
