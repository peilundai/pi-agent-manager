import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Finds the environment variables Pi's own configuration depends on: custom providers and
 * gateways in `models.json` (`apiKey`, `headers`) and MCP servers in `mcp.json` (`env`,
 * `headers`). Used to tell the user, by name, which variable is missing instead of letting
 * a gateway reject a placeholder key.
 */

export interface EnvironmentReference {
  /** Variable name, for example `EXA_API_KEY`. */
  name: string;
  /** Config file the reference was found in. */
  file: string;
  /** Dotted JSON path of the value, for example `mcpServers.exa.headers.x-api-key`. */
  field: string;
}

export interface FindReferencesOptions {
  /** Pi's config directory; defaults to `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
  agentDir?: string;
  /** Workspace folder, for the project-level `.pi/mcp.json`. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `$NAME` or `${NAME}`; `$$` is an escaped dollar sign. */
const INTERPOLATION = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
/** Containers whose string values may reference variables. */
const CONTAINERS = new Set(["headers", "env"]);
/** Keys whose value is the name of a variable, such as `bearerTokenEnvVar`. */
const NAME_KEY = /(?:^env|EnvVar|EnvVariable|_env_var)$/i;

export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** Variable names referenced by one config value. */
export function referencedNames(value: string, key: string, legacyBareName = false): string[] {
  const text = value.trim();
  // `!command` values run a command; Pi does not interpolate them.
  if (text.startsWith("!")) return [];
  if (NAME_KEY.test(key)) return NAME.test(text) ? [text] : [];
  const names = [...text.matchAll(INTERPOLATION)].flatMap((match) => {
    const name = match[1] ?? match[2];
    return name ? [name] : [];
  });
  // Older Pi releases read an all-caps `apiKey` such as `GATEWAY_API_KEY` as a variable name.
  if (!names.length && legacyBareName && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(text)) return [text];
  return names;
}

function collect(value: unknown, path: string[], inContainer: boolean, file: string, out: EnvironmentReference[]): void {
  if (typeof value === "string") {
    const key = path[path.length - 1] ?? "";
    if (!inContainer && key !== "apiKey" && !NAME_KEY.test(key)) return;
    for (const name of referencedNames(value, key, key === "apiKey")) out.push({ name, file, field: path.join(".") });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, [...path, String(index)], inContainer, file, out));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    collect(child, [...path, key], inContainer || CONTAINERS.has(key), file, out);
  }
}

/** Parses one config file's text; malformed files contribute nothing. */
export function referencesInConfig(text: string, file: string): EnvironmentReference[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: EnvironmentReference[] = [];
  collect(parsed, [], false, file, out);
  return out;
}

/** Reads Pi's user and project config files and lists the variables they reference. */
export async function findEnvironmentReferences(options: FindReferencesOptions = {}): Promise<EnvironmentReference[]> {
  const agentDir = options.agentDir ?? defaultAgentDir(options.env);
  const read = options.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const files = [join(agentDir, "models.json"), join(agentDir, "mcp.json")];
  if (options.cwd) files.push(join(options.cwd, ".pi", "mcp.json"));
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        return referencesInConfig(await read(file), file);
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

/** References whose variable is unset or empty in `env`, one per name. */
export function missingReferences(references: readonly EnvironmentReference[], env: NodeJS.ProcessEnv): EnvironmentReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    if (seen.has(reference.name) || env[reference.name]) return false;
    seen.add(reference.name);
    return true;
  });
}
