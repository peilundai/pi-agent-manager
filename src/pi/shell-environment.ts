import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { basename } from "node:path";

/**
 * Editors started from the Dock, a desktop launcher or an auto-update restart do not run
 * the user's shell startup files, so variables exported there (gateway keys, MCP tokens,
 * nvm/Homebrew PATH entries) are missing from VS Code's environment and therefore from Pi.
 * This module asks the user's login shell for its environment, the way a terminal would
 * see it, so Pi gets the same variables however VS Code was started.
 */

export const SHELL_ENVIRONMENT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MARKER_VARIABLE = "PI_AGENT_MANAGER_ENV_MARKER";
const RESOLVING_VARIABLE = "PI_AGENT_MANAGER_RESOLVING_ENVIRONMENT";

/** Variables that describe the probe process itself rather than the user's environment. */
const PROBE_VARIABLES = new Set([
  MARKER_VARIABLE,
  RESOLVING_VARIABLE,
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "VSCODE_RESOLVING_ENVIRONMENT",
  "SHLVL",
  "PWD",
  "OLDPWD",
  "_",
]);

/** Prints the environment between two markers, so output from rc files cannot corrupt it. */
const PROBE_SCRIPT = `const m=process.env.${MARKER_VARIABLE};delete process.env.${MARKER_VARIABLE};process.stdout.write(m+JSON.stringify(process.env)+m)`;

export type ShellEnvironmentResult =
  | { status: "loaded"; shell: string; env: Record<string, string>; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; shell: string; error: string; durationMs: number };

/** The subset of a spawned child process this module uses (a test seam). */
export interface ProbeProcess {
  readonly pid?: number | undefined;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ProbeSpawn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "ignore"]; windowsHide: boolean },
) => ProbeProcess;

export interface ShellEnvironmentOptions {
  platform?: NodeJS.Platform;
  /** Login shell to ask; defaults to `$SHELL`, then the account's shell. */
  shell?: string;
  /** Environment the shell starts from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** A Node-compatible executable; in VS Code this is the Electron helper run as Node. */
  execPath?: string;
  timeoutMs?: number;
  spawn?: ProbeSpawn;
}

/** Quotes a value for POSIX shells, fish and csh. */
export function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (env.SHELL?.trim()) return env.SHELL.trim();
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // Fall through to the platform default.
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/** Arguments that start `shell` as an interactive login shell running `command`. */
export function shellArguments(shell: string, command: string): string[] | undefined {
  const name = basename(shell).toLowerCase().replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell" || name === "cmd") return undefined;
  if (name === "csh" || name === "tcsh") return ["-ic", command];
  return ["-i", "-l", "-c", command];
}

/** Extracts the JSON environment printed between `marker`s, ignoring anything around it. */
export function parseShellEnvironment(output: string, marker: string): Record<string, string> | undefined {
  const start = output.indexOf(marker);
  if (start === -1) return undefined;
  const end = output.lastIndexOf(marker);
  if (end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start + marker.length, end));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string" && !PROBE_VARIABLES.has(name)) env[name] = value;
  }
  return env;
}

const defaultSpawn: ProbeSpawn = (file, args, options) => nodeSpawn(file, args, options);

function stop(child: ProbeProcess): void {
  try {
    // The shell runs detached in its own process group; end anything it started too.
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Runs the user's interactive login shell once and returns the environment it sets up. */
export async function resolveShellEnvironment(options: ShellEnvironmentOptions = {}): Promise<ShellEnvironmentResult> {
  const platform = options.platform ?? process.platform;
  const baseEnv = options.env ?? process.env;
  if (platform === "win32") return { status: "skipped", reason: "Windows editors already inherit the user environment." };
  if (baseEnv[RESOLVING_VARIABLE]) return { status: "skipped", reason: "Already resolving the shell environment." };

  const shell = defaultShell(platform, baseEnv);
  const execPath = options.execPath ?? process.execPath;
  const marker = `__PI_AGENT_MANAGER_${randomBytes(12).toString("hex")}__`;
  const args = shellArguments(shell, `${quoteForShell(execPath)} -e ${quoteForShell(PROBE_SCRIPT)}`);
  if (!args) return { status: "skipped", reason: `${basename(shell)} is not supported as a login shell.` };

  const timeoutMs = options.timeoutMs ?? SHELL_ENVIRONMENT_TIMEOUT_MS;
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const failed = (error: string): ShellEnvironmentResult => ({ status: "failed", shell, error, durationMs: elapsed() });

  return new Promise((resolve) => {
    let child: ProbeProcess;
    try {
      child = (options.spawn ?? defaultSpawn)(shell, args, {
        env: {
          ...baseEnv,
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_NO_ATTACH_CONSOLE: "1",
          // Lets rc files skip slow or interactive work, as they already do for VS Code.
          VSCODE_RESOLVING_ENVIRONMENT: "1",
          [RESOLVING_VARIABLE]: "1",
          [MARKER_VARIABLE]: marker,
        },
        detached: true,
        // Startup files can trace exported secrets to stderr (`set -x`), so it is never read.
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      resolve(failed(error instanceof Error ? error.message : String(error)));
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (result: ShellEnvironmentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      stop(child);
      finish(failed(`${shell} did not finish within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stop(child);
        finish(failed(`${shell} printed more than ${MAX_OUTPUT_BYTES} bytes.`));
      }
    });
    child.on("error", (error) => finish(failed(error.message)));
    child.on("close", (code, signal) => {
      const env = parseShellEnvironment(stdout, marker);
      if (env) {
        finish({ status: "loaded", shell, env, durationMs: elapsed() });
        return;
      }
      const reason = signal ? `was stopped by ${signal}` : `exited with code ${String(code)}`;
      // Shell output is not quoted: it may contain secret values.
      finish(failed(`${shell} ${reason} without printing its environment.`));
    });
  });
}

/** Splits a PATH-like value into its non-empty entries. */
function pathEntries(value: string | undefined, delimiter: string): string[] {
  return (value ?? "").split(delimiter).filter(Boolean);
}

export interface MergeEnvironmentOptions {
  /** VS Code's own environment (`process.env`). */
  base: NodeJS.ProcessEnv;
  /** Variables from the login shell; they fill in what `base` lacks. */
  shell?: Record<string, string> | undefined;
  /** Explicit values (setting and stored secrets); they win over everything. */
  overrides?: Record<string, string> | undefined;
  delimiter?: string;
}

/**
 * Builds Pi's environment. Variables VS Code already has are kept, so a terminal-launched
 * editor (for example with a virtualenv active) behaves as before; the shell only adds
 * missing or empty variables and PATH entries. Explicit overrides always win.
 */
export function mergeEnvironment(options: MergeEnvironmentOptions): NodeJS.ProcessEnv {
  const delimiter = options.delimiter ?? (process.platform === "win32" ? ";" : ":");
  const env: NodeJS.ProcessEnv = { ...options.base };
  for (const [name, value] of Object.entries(options.shell ?? {})) {
    if (name === "PATH") {
      const current = pathEntries(env.PATH, delimiter);
      const missing = pathEntries(value, delimiter).filter((entry) => !current.includes(entry));
      env.PATH = [...current, ...missing].join(delimiter);
    } else if (env[name] === undefined || env[name] === "") {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(options.overrides ?? {})) env[name] = value;
  return env;
}
