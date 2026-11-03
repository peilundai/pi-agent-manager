import { realpathSync, watch as watchDirectory, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import type { SessionSummary } from "../shared/model";
import { parseSessionFile, type ParsedSession } from "./session-parser";

const MAX_CONCURRENT_READS = 8;

export interface ArchiveStore {
  read(): readonly string[];
  write(ids: readonly string[]): Promise<void>;
}

export interface SessionRepositoryOptions {
  agentDir?: string;
  sessionDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  archiveStore?: ArchiveStore;
}

export interface Disposable {
  dispose(): void;
}

interface CachedSession {
  mtimeMs: number;
  size: number;
  parsed: ParsedSession;
}

const emptyArchiveStore: ArchiveStore = {
  read: () => [],
  write: async () => undefined,
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return resolve(path);
}

/** Pi names its session directory after its physical working directory, so resolve symlinks first. */
function workspacePath(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return platform === "win32" ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
}

export function encodeWorkspaceDirectory(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

export class PiSessionRepository {
  private options: SessionRepositoryOptions;
  private readonly archiveStore: ArchiveStore;
  private readonly cache = new Map<string, CachedSession>();

  constructor(options: SessionRepositoryOptions = {}) {
    this.options = options;
    this.archiveStore = options.archiveStore ?? emptyArchiveStore;
  }

  /**
   * Reads session locations from the environment Pi is started with, which can set
   * `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR` that VS Code itself lacks.
   * Returns true when the session directories moved, so callers can re-watch them.
   */
  useEnvironment(env: NodeJS.ProcessEnv): boolean {
    const before = this.locationKey();
    this.options = { ...this.options, env };
    return this.locationKey() !== before;
  }

  private locationKey(): string {
    const env = this.options.env ?? process.env;
    return `${env.PI_CODING_AGENT_SESSION_DIR ?? ""}\0${env.PI_CODING_AGENT_DIR ?? ""}`;
  }

  async list(cwd: string): Promise<SessionSummary[]> {
    const workspace = await realpath(cwd).catch(() => resolve(cwd));
    const directories = this.directories(workspace);
    const paths = (await Promise.all(directories.map((directory) => this.transcripts(directory)))).flat();
    const parsed = await this.readConcurrently(paths);
    const archived = new Set(this.archiveStore.read());
    const unique = new Map<string, SessionSummary>();
    const platform = this.options.platform ?? process.platform;

    for (const session of parsed) {
      if (!samePath(session.cwd, workspace, platform)) continue;
      unique.set(session.path, {
        id: session.id,
        path: session.path,
        cwd: session.cwd,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archived: archived.has(session.id),
        status: "stopped",
      });
    }

    return [...unique.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const ids = new Set(this.archiveStore.read());
    if (archived) ids.add(sessionId);
    else ids.delete(sessionId);
    await this.archiveStore.write([...ids].sort((left, right) => left.localeCompare(right)));
  }

  async delete(session: SessionSummary): Promise<void> {
    if (!session.path.endsWith(".jsonl")) {
      throw new Error(`Refusing to delete a non-JSONL session: ${session.path}`);
    }
    const transcript = resolve(session.path);
    const transcriptDirectory = dirname(transcript);
    const transcriptName = basename(transcript);
    const sidecarName = transcriptName.slice(0, -".jsonl".length);
    if (!sidecarName || sidecarName === "." || sidecarName === "..") {
      throw new Error(`Refusing to derive a sidecar from a dot-segment transcript: ${session.path}`);
    }
    const sidecar = resolve(transcriptDirectory, sidecarName);
    if (
      sidecar === transcript ||
      dirname(sidecar) !== transcriptDirectory ||
      basename(sidecar) !== sidecarName
    ) {
      throw new Error(`Refusing to delete an unsafe session sidecar: ${sidecar}`);
    }
    await rm(transcript, { force: true });
    await rm(sidecar, { recursive: true, force: true });
    this.cache.delete(transcript);
  }

  watch(cwd: string, onChange: () => void): Disposable {
    const watchers: FSWatcher[] = [];
    for (const directory of this.directories(workspacePath(cwd))) {
      try {
        watchers.push(watchDirectory(directory, { persistent: false }, onChange));
      } catch {
        // A session directory is optional until Pi writes its first transcript.
      }
    }
    return {
      dispose: () => {
        for (const watcher of watchers) watcher.close();
      },
    };
  }

  private directories(cwd: string): string[] {
    const env = this.options.env ?? process.env;
    const configuredSessionDir = this.options.sessionDir ?? env.PI_CODING_AGENT_SESSION_DIR;
    if (configuredSessionDir) return [expandHome(configuredSessionDir)];

    const agentDir = expandHome(
      this.options.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    );
    const encoded = encodeWorkspaceDirectory(cwd);
    return [join(agentDir, "sessions", encoded), join(agentDir, "session", encoded)];
  }

  private async transcripts(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(directory, entry.name));
    } catch {
      return [];
    }
  }

  private async readConcurrently(paths: readonly string[]): Promise<ParsedSession[]> {
    const sessions: ParsedSession[] = [];
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < paths.length) {
        const path = paths[nextIndex++];
        if (!path) continue;
        try {
          const file = await stat(path);
          const cached = this.cache.get(path);
          if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
            sessions.push(cached.parsed);
            continue;
          }
          const parsed = await parseSessionFile(path, file);
          if (!parsed) continue;
          this.cache.set(path, { mtimeMs: file.mtimeMs, size: file.size, parsed });
          sessions.push(parsed);
        } catch {
          // A transcript may disappear or be partially replaced while history refreshes.
        }
      }
    };

    const count = Math.min(paths.length, MAX_CONCURRENT_READS);
    await Promise.all(Array.from({ length: count }, worker));
    return sessions;
  }
}

export async function listWorkspaceSessions(
  cwd: string,
  options: SessionRepositoryOptions = {},
): Promise<SessionSummary[]> {
  return new PiSessionRepository(options).list(cwd);
}
