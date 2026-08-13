import { constants } from "node:fs";
import { access as fileAccess } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix, win32 } from "node:path";

const execFileAsync = promisify(execFile);
const INVALID_SHIM_ENV_VALUE = /[\r\n\0"]/;
const SHIM_COMMAND_ENV = "PI_AGENT_MANAGER_SHIM_COMMAND";
const SHIM_ARGUMENT_ENV_PREFIX = "PI_AGENT_MANAGER_SHIM_ARG_";

export interface ResolvedPiCommand {
  path: string;
  source: "configured" | "path" | "npm" | "common";
  attempts: string[];
}

export interface PiInvocation {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ResolvePiCommandOptions {
  configured?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  access?: (path: string) => Promise<boolean>;
  npmRoot?: () => Promise<string | undefined>;
  commonPaths?: readonly string[];
}

export class PiCommandNotFoundError extends Error {
  readonly attempts: string[];

  constructor(attempts: readonly string[]) {
    super(`Pi executable was not found. Checked ${attempts.length} location${attempts.length === 1 ? "" : "s"}.`);
    this.name = "PiCommandNotFoundError";
    this.attempts = [...attempts];
  }
}

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

async function defaultAccess(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await fileAccess(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultNpmRoot(): Promise<string | undefined> {
  try {
    const result = await execFileAsync("npm", ["root", "-g"], { encoding: "utf8" });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function executableNames(configured: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32" || /\.(?:cmd|bat|exe)$/i.test(configured)) return [configured];
  return [`${configured}.cmd`, `${configured}.exe`, configured];
}

function npmCandidates(root: string, executable: string, platform: NodeJS.Platform): string[] {
  const path = pathApi(platform);
  const names = executableNames(executable, platform);
  const binDirectory = platform === "win32" ? path.dirname(root) : path.join(path.dirname(path.dirname(root)), "bin");
  return names.map((name) => path.join(binDirectory, name));
}

function defaultCommonPaths(
  executable: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const path = pathApi(platform);
  if (platform === "win32") {
    const directories = [env.APPDATA ? path.join(env.APPDATA, "npm") : undefined].filter(
      (value): value is string => Boolean(value),
    );
    return directories.flatMap((directory) =>
      executableNames(executable, platform).map((name) => path.join(directory, name)),
    );
  }
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map((directory) =>
    path.join(directory, executable),
  );
}

export async function resolvePiCommand(
  options: ResolvePiCommandOptions = {},
): Promise<ResolvedPiCommand> {
  const platform = options.platform ?? process.platform;
  const path = pathApi(platform);
  const env = options.env ?? process.env;
  const configured = options.configured?.trim() || "pi";
  const canAccess = options.access ?? ((candidate: string) => defaultAccess(candidate, platform));
  const attempts: string[] = [];
  const seen = new Set<string>();

  const attempt = async (
    candidate: string,
    source: ResolvedPiCommand["source"],
  ): Promise<ResolvedPiCommand | undefined> => {
    if (seen.has(candidate)) return undefined;
    seen.add(candidate);
    attempts.push(candidate);
    if (!(await canAccess(candidate))) return undefined;
    return { path: candidate, source, attempts: [...attempts] };
  };

  if (path.isAbsolute(configured)) {
    const resolved = await attempt(path.normalize(configured), "configured");
    if (resolved) return resolved;
    throw new PiCommandNotFoundError(attempts);
  }

  if (configured.includes("/") || configured.includes("\\")) {
    throw new PiCommandNotFoundError([configured]);
  }

  const pathDirectories = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of pathDirectories) {
    for (const name of executableNames(configured, platform)) {
      const resolved = await attempt(path.join(directory, name), "path");
      if (resolved) return resolved;
    }
  }

  const npmRoot = await (options.npmRoot ?? defaultNpmRoot)().catch(() => undefined);
  if (npmRoot) {
    for (const candidate of npmCandidates(npmRoot, configured, platform)) {
      const resolved = await attempt(candidate, "npm");
      if (resolved) return resolved;
    }
  }

  const commonPaths = options.commonPaths ?? defaultCommonPaths(configured, platform, env);
  for (const candidate of commonPaths) {
    const resolved = await attempt(candidate, "common");
    if (resolved) return resolved;
  }

  throw new PiCommandNotFoundError(attempts);
}

export function buildPiInvocation(
  command: string,
  piArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): PiInvocation {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { file: command, args: [...piArgs] };
  }

  const values = [command, ...piArgs];
  if (values.some((value) => INVALID_SHIM_ENV_VALUE.test(value))) {
    throw new Error("Invalid character in Windows command path or argument.");
  }
  const variableNames = [
    SHIM_COMMAND_ENV,
    ...piArgs.map((_value, index) => `${SHIM_ARGUMENT_ENV_PREFIX}${index}`),
  ];
  // Keep legal path characters out of cmd.exe's source text. Quoted one-pass
  // environment expansion with delayed expansion disabled treats &, ^, %, and
  // Unicode as argument data instead of shell syntax.
  const env = Object.fromEntries(variableNames.map((name, index) => [name, values[index] ?? ""]));
  const commandLine = variableNames.map((name) => `"%${name}%"`).join(" ");
  return {
    file: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
    env,
  };
}

export function buildPiArgs(statusExtensionPath: string, sessionPath?: string): string[] {
  const args = ["--extension", statusExtensionPath];
  if (sessionPath) args.push("--session", sessionPath);
  return args;
}
