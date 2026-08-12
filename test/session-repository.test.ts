import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeWorkspaceDirectory,
  PiSessionRepository,
  type ArchiveStore,
} from "../src/pi/session-repository";

class MemoryArchiveStore implements ArchiveStore {
  ids: string[];

  constructor(ids: string[] = []) {
    this.ids = ids;
  }

  read(): readonly string[] {
    return this.ids;
  }

  async write(ids: readonly string[]): Promise<void> {
    this.ids = [...ids];
  }
}

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PiSessionRepository", () => {
  it("lists only matching workspace sessions and applies archive metadata", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "project");
    const agentDir = join(root, "agent");
    const sessionDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
    await mkdir(sessionDir, { recursive: true });

    await writeFile(
      join(sessionDir, "matching.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "matching", cwd: workspace, timestamp: "2026-08-12T01:00:00.000Z" }),
        JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "x", message: { role: "user", content: "Fix login race", timestamp: 1 } }),
      ].join("\n"),
    );
    await writeFile(
      join(sessionDir, "other.jsonl"),
      JSON.stringify({ type: "session", version: 3, id: "other", cwd: join(root, "different") }),
    );

    const archiveStore = new MemoryArchiveStore(["matching"]);
    const repository = new PiSessionRepository({ agentDir, archiveStore });
    const sessions = await repository.list(workspace);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "matching", title: "Fix login race", archived: true, status: "stopped" });
  });

  it("persists sorted archive identifiers", async () => {
    const archiveStore = new MemoryArchiveStore(["zeta"]);
    const repository = new PiSessionRepository({ agentDir: "/unused", archiveStore });
    await repository.setArchived("alpha", true);
    await repository.setArchived("zeta", false);
    expect(archiveStore.ids).toEqual(["alpha"]);
  });

  it("deletes only a jsonl transcript and its exact sidecar", async () => {
    const root = await temporaryRoot();
    const transcript = join(root, "session.jsonl");
    const sidecar = join(root, "session");
    await writeFile(transcript, "session");
    await mkdir(sidecar);
    await writeFile(join(sidecar, "checkpoint"), "data");
    const repository = new PiSessionRepository({ agentDir: root, archiveStore: new MemoryArchiveStore() });

    await repository.delete({
      id: "session",
      path: transcript,
      cwd: root,
      title: "Session",
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      status: "stopped",
    });

    await expect(stat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(repository.delete({
      id: "bad",
      path: join(root, "bad.txt"),
      cwd: root,
      title: "Bad",
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      status: "stopped",
    })).rejects.toThrow(/jsonl/i);
  });

  it("leaves a readable transcript unchanged while archiving", async () => {
    const root = await temporaryRoot();
    const transcript = join(root, "session.jsonl");
    await writeFile(transcript, "durable transcript");
    const repository = new PiSessionRepository({ agentDir: root, archiveStore: new MemoryArchiveStore() });
    await repository.setArchived("session", true);
    expect(await readFile(transcript, "utf8")).toBe("durable transcript");
  });
});
