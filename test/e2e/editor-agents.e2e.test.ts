// Two Pi agents in editor tabs, driven through the real extension activation against the real Pi
// CLI behind the relay: each tab runs its own Pi and session, and both come back after a reload.
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../../src/extension";
import type { HostToWebviewMessage } from "../../src/shared/protocol";
import { chatReducer, initialChatState, type ChatItem, type ChatState } from "../../src/webview/chat-state";
import { buildRelayScript } from "../support/relay-script";
import { configuration, resetVscodeMock, type MockWebviewPanel } from "../vscode-mock";
import type * as VscodeMock from "../vscode-mock";
import { startMockLlm, type MockLlm } from "./support/mock-llm";
import { createPiTestEnv, piExecutable, waitFor, type PiTestEnv } from "./support/pi-env";

const mock = vscode as unknown as typeof VscodeMock;
const AGENTS_KEY = "piAgentManager.editorAgents";
const secrets = { keys: async () => [], get: async () => undefined, store: async () => undefined, delete: async () => undefined };

let llm: MockLlm;
let pi: PiTestEnv;
let extensionDir: string;
const savedEnv: Record<string, string | undefined> = {};

/** The workspace state VS Code keeps across a window reload. */
const workspaceState = (() => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
    },
  };
})();

beforeAll(async () => {
  let script: string;
  [llm, script] = await Promise.all([startMockLlm(), buildRelayScript()]);
  pi = await createPiTestEnv(llm.url);
  // activate() runs the relay from <extension>/dist/relay.js.
  extensionDir = await mkdtemp(join(tmpdir(), "pi-ext-e2e-"));
  await mkdir(join(extensionDir, "dist"));
  await copyFile(script, join(extensionDir, "dist", "relay.js"));
  // The extension reads Pi's environment and transcripts from the process environment.
  for (const name of ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
    savedEnv[name] = process.env[name];
    const value = pi.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(async () => {
  await deactivate();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await pi?.cleanup();
  await llm?.close();
  if (extensionDir) await rm(extensionDir, { recursive: true, force: true });
});

/** One VS Code window: fresh API mocks, the same settings and workspace state. */
async function openWindow(tabs = 0) {
  resetVscodeMock();
  configuration.set("loadShellEnvironment", false);
  configuration.set("command", piExecutable());
  configuration.set("extraArgs", ["--provider", "mock", "--model", "mock-1", "--offline"]);
  mock.workspace.workspaceFolders = [{ name: "workspace", index: 0, uri: mock.Uri.file(pi.workspace) }];
  mock.commands.getCommands.mockResolvedValue(["workbench.view.extension.piAgentManager"]);
  // Tabs VS Code put back in the editor area; their webviews are restored when shown.
  mock.window.tabGroups.all = [{ tabs: Array.from({ length: tabs }, () => ({ input: new mock.TabInputWebview("mainThreadWebview-piAgentManager.agent") })) }];
  await activate({ extensionUri: mock.Uri.file(extensionDir), subscriptions: [], workspaceState, secrets } as never);
}

function command(name: string): () => Promise<void> {
  const handler = mock.commands.registerCommand.mock.calls.find((call) => call[0] === name)?.[1] as (() => Promise<void>) | undefined;
  if (!handler) throw new Error(`${name} was not registered`);
  return handler;
}

/** A tab's webview: the React reducer applied to everything the host posts, plus its saved state. */
function webviewOf(panel: MockWebviewPanel) {
  let seen = 0;
  let state: ChatState = initialChatState;
  const sync = () => {
    for (const message of panel.posted.slice(seen)) {
      state = chatReducer(state, { type: "host", message: message as HostToWebviewMessage, now: Date.now() });
    }
    seen = panel.posted.length;
    return state;
  };
  return {
    panel,
    get state() {
      return sync();
    },
    /** What the webview keeps with `setState`; VS Code hands it back when it restores the tab. */
    get agentId() {
      return /<meta name="pi-agent-id" content="([\w-]+)"/.exec(panel.webview.html)?.[1];
    },
    ready() {
      panel.receive({ version: 1, type: "ready" });
    },
    send(text: string) {
      state = chatReducer(sync(), { type: "user.send", text, images: [] });
      panel.receive({ version: 1, type: "prompt", text, images: [], mode: "send" });
    },
  };
}

type Webview = ReturnType<typeof webviewOf>;

const users = (items: ChatItem[]) => items.filter((item) => item.kind === "user").map((item) => (item.kind === "user" ? item.text : ""));
const answer = (items: ChatItem[]) =>
  items
    .flatMap((item) => (item.kind === "assistant" ? item.blocks : []))
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
const settled = (view: Webview) => view.state.process.status === "ready" && !view.state.busy && answer(view.state.items).length > 0;

describe("editor-tab agents with the real Pi CLI", () => {
  it("runs two independent agents in their own tabs and restores both after a reload", async () => {
    await openWindow();
    await command("piAgentManager.newAgent")();
    await command("piAgentManager.newAgent")();
    expect(mock.window.panels).toHaveLength(2);
    const [one, two] = mock.window.panels.map(webviewOf) as [Webview, Webview];
    one.ready();
    two.ready();
    await waitFor(() => one.state.process.status === "ready" && two.state.process.status === "ready", 30_000, "both agents' Pi");
    expect(one.agentId).toBeTruthy();
    expect(two.agentId).toBeTruthy();
    expect(one.agentId).not.toBe(two.agentId);

    // A message in each tab, at the same time.
    one.send("plain answer for agent one");
    two.send("plain answer for agent two");
    await waitFor(() => settled(one) && settled(two), 30_000, "both answers");
    expect(users(one.state.items)).toEqual(["plain answer for agent one"]);
    expect(users(two.state.items)).toEqual(["plain answer for agent two"]);

    // Each agent has its own Pi session; the tab is named after it.
    const fileOne = await waitFor(() => one.state.pi.sessionFile, 10_000, "agent one's transcript");
    const fileTwo = await waitFor(() => two.state.pi.sessionFile, 10_000, "agent two's transcript");
    expect(fileOne).not.toBe(fileTwo);
    await waitFor(() => one.panel.title.includes("agent one") && two.panel.title.includes("agent two"), 10_000, "tab titles");
    expect(workspaceState.values.get(AGENTS_KEY)).toEqual([one.agentId, two.agentId]);

    // Reload the window: the extension host goes away, the tabs and their Pi processes stay.
    const restoredStates = [{ agentId: one.agentId }, { agentId: two.agentId }];
    const relayOf = (id: string | undefined) => workspaceState.values.get(`piAgentManager.relay.${id}`) as { socketPath: string } | undefined;
    const relays = [relayOf(one.agentId)?.socketPath, relayOf(two.agentId)?.socketPath];
    expect(relays[0]).toBeTruthy();
    expect(relays[0]).not.toBe(relays[1]);
    await deactivate();
    one.panel.dispose();
    two.panel.dispose();
    expect(workspaceState.values.get(AGENTS_KEY)).toHaveLength(2);

    await openWindow(2);
    const serializer = mock.window.registerWebviewPanelSerializer.mock.calls[0]?.[1] as vscode.WebviewPanelSerializer;
    // VS Code restores the tabs in the other order; each must find its own agent.
    const restoredTwo = webviewOf(new mock.MockWebviewPanel("piAgentManager.agent", two.panel.title));
    const restoredOne = webviewOf(new mock.MockWebviewPanel("piAgentManager.agent", one.panel.title));
    await serializer.deserializeWebviewPanel(restoredTwo.panel as never, restoredStates[1]);
    await serializer.deserializeWebviewPanel(restoredOne.panel as never, restoredStates[0]);
    restoredTwo.ready();
    restoredOne.ready();
    await waitFor(() => settled(restoredOne) && settled(restoredTwo), 30_000, "restored transcripts");
    expect(mock.window.createWebviewPanel).not.toHaveBeenCalled();
    // Both reattached to the Pi that kept running behind its relay; neither was restarted.
    expect([relayOf(one.agentId)?.socketPath, relayOf(two.agentId)?.socketPath]).toEqual(relays);
    expect(restoredOne.state.pi.sessionFile).toBe(fileOne);
    expect(restoredTwo.state.pi.sessionFile).toBe(fileTwo);
    expect(users(restoredOne.state.items)).toEqual(["plain answer for agent one"]);
    expect(users(restoredTwo.state.items)).toEqual(["plain answer for agent two"]);
    expect(answer(restoredOne.state.items)).toBe(answer(one.state.items));
    expect(restoredOne.panel.title).toBe(one.panel.title);

    // Still independent after the reload: a follow-up in one tab leaves the other alone.
    restoredOne.send("plain follow-up for agent one");
    await waitFor(() => users(restoredOne.state.items).length === 2 && settled(restoredOne), 30_000, "follow-up answer");
    expect(users(restoredTwo.state.items)).toEqual(["plain answer for agent two"]);

    // Closing a tab ends that agent for good.
    restoredOne.panel.dispose();
    await waitFor(() => (workspaceState.values.get(AGENTS_KEY) as string[]).length === 1, 10_000, "closed agent forgotten");
    expect(workspaceState.values.get(AGENTS_KEY)).toEqual([two.agentId]);
    restoredTwo.panel.dispose();
    await waitFor(() => (workspaceState.values.get(AGENTS_KEY) as string[]).length === 0, 10_000, "all agents forgotten");
  });
});
