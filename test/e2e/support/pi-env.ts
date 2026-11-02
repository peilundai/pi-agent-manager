import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPiInvocation, buildRpcArgs } from "../../../src/pi/command-resolver";
import { PiRpcClient, type RpcClientListener } from "../../../src/pi/rpc-client";
import { PiSessionRepository } from "../../../src/pi/session-repository";

export const GREET_SOURCE = 'export function greet(name: string): string {\n  return "hello " + name;\n}\n';

const CONFIRM_EXTENSION = `export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName === "bash") {
      const ok = await ctx.ui.confirm("Allow bash command?", String(event.input?.command ?? ""));
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });
  pi.registerCommand("hello", {
    description: "Say hello from an extension",
    handler: async (_args: string, ctx: any) => ctx.ui.notify("Hello from the extension!", "info"),
  });
}
`;

/** Path of the Pi CLI installed as a devDependency. */
export function piExecutable(): string {
  const bin = resolve("node_modules/.bin", process.platform === "win32" ? "pi.cmd" : "pi");
  if (!existsSync(bin)) throw new Error(`Pi CLI not found at ${bin}. Run npm install.`);
  return bin;
}

export interface PiTestEnv {
  home: string;
  agentDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  repository: PiSessionRepository;
  createClient(listener: RpcClientListener): Promise<PiRpcClient>;
  readGreet(): Promise<string>;
  resetGreet(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Creates an isolated HOME with a `mock` provider pointing at `llmUrl`, a confirm-before-bash
 * extension, and a workspace containing `src/greet.ts`.
 */
export async function createPiTestEnv(llmUrl: string): Promise<PiTestEnv> {
  const home = await mkdtemp(join(tmpdir(), "pi-chat-e2e-"));
  const agentDir = join(home, ".pi", "agent");
  const workspace = join(home, "workspace");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          name: "Mock",
          baseUrl: llmUrl,
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            { id: "mock-1", name: "Mock Sonnet", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
            { id: "mock-2", name: "Mock Haiku", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 } },
          ],
        },
      },
    }),
  );
  await writeFile(join(agentDir, "extensions", "confirm-bash.ts"), CONFIRM_EXTENSION);
  await writeFile(join(workspace, "src", "greet.ts"), GREET_SOURCE);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
  };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  const pi = piExecutable();
  const repository = new PiSessionRepository({ agentDir, env });

  return {
    home,
    agentDir,
    workspace,
    env,
    repository,
    async createClient(listener) {
      const invocation = buildPiInvocation(pi, buildRpcArgs({ extraArgs: ["--provider", "mock", "--model", "mock-1", "--offline"] }));
      return new PiRpcClient({ file: invocation.file, args: invocation.args, cwd: workspace, env: { ...env, ...invocation.env } }, listener);
    },
    readGreet: () => readFile(join(workspace, "src", "greet.ts"), "utf8"),
    resetGreet: () => writeFile(join(workspace, "src", "greet.ts"), GREET_SOURCE),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

/** Polls `predicate` until it returns a truthy value. */
export async function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 20_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
