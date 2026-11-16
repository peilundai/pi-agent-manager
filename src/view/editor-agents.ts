import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { AGENT_PANEL_TYPE, agentViewColumn, isAgentPanelTab, type AgentTabTest } from "./agent-placement";
import { ACTIVE_CHAT_KEY, agentStateKey, DEFAULT_AGENT_TITLE, RELAY_KEY, type ChatViewProvider } from "./chat-view-provider";

export { AGENT_PANEL_TYPE } from "./agent-placement";
/** The ids of the editor-tab agents open in this workspace, so a reload can restore them. */
export const AGENTS_KEY = "piAgentManager.editorAgents";

export type ChatLocation = "editor" | "sidebar";

/** Where new agents open, from `piAgentManager.defaultLocation`. Unknown values mean editor tabs. */
export function defaultLocation(): ChatLocation {
  const value = vscode.workspace.getConfiguration("piAgentManager").get<unknown>("defaultLocation", "editor");
  return value === "sidebar" ? "sidebar" : "editor";
}

const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/;

function agentIdFrom(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const id = (state as Record<string, unknown>).agentId;
  return typeof id === "string" && AGENT_ID.test(id) ? id : undefined;
}

/** How many agent tabs the window has, restored or not. */
function openAgentTabs(): number {
  const tabs = vscode.window.tabGroups?.all.flatMap((group) => group.tabs) ?? [];
  return tabs.filter(isAgentPanelTab).length;
}

interface Agent {
  readonly id: string;
  readonly chat: ChatViewProvider;
  panel?: vscode.WebviewPanel | undefined;
  listeners: vscode.Disposable[];
}

export interface EditorAgentsOptions {
  extensionUri: vscode.Uri;
  memento: Pick<vscode.Memento, "get" | "update">;
  /** Builds one agent's chat; every agent gets its own Pi process and session. */
  createChat(agentId: string): ChatViewProvider;
  /** Which tabs are Pi tabs when placing a new one; defaults to chat tabs. Lets Pi terminals share the group. */
  isAgentTab?: AgentTabTest;
}

/**
 * Pi agents in editor tabs. Each tab is a `WebviewPanel` running the same chat UI as the sidebar,
 * with its own `ChatViewProvider`, Pi process and session. Tabs are restored after a window reload
 * by the panel serializer, and a Pi that kept running behind its relay is reattached right away.
 */
export class EditorAgents implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private readonly agents = new Map<string, Agent>();
  /** The agent the user worked in last; commands such as Add Selection to Chat go there. */
  private active: Agent | undefined;
  /** Set while the window closes or reloads, so tabs going away do not stop their Pi. */
  private shuttingDown = false;

  constructor(private readonly options: EditorAgentsOptions) {}

  /** Every agent's chat, shown in a tab or not yet restored. */
  get chats(): ChatViewProvider[] {
    return [...this.agents.values()].map((agent) => agent.chat);
  }

  /** The chat of the tab the user worked in last, if any is open. */
  get activeChat(): ChatViewProvider | undefined {
    return this.activeAgent()?.chat;
  }

  /** Opens a new agent in its own editor tab. */
  open(): ChatViewProvider {
    const agent = this.agent(randomUUID());
    this.show(agent, this.createPanel());
    return agent.chat;
  }

  /** The agent the user worked in last, or a new one if no agent tab is open. */
  current(): ChatViewProvider {
    return this.activeAgent()?.chat ?? this.open();
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const agent = this.agent(agentIdFrom(state) ?? randomUUID());
    if (agent.panel && agent.panel !== panel) {
      // The agent is already on screen (for example, revealed before this tab was restored).
      panel.dispose();
      return;
    }
    this.show(agent, panel);
  }

  /**
   * Reattaches to the Pi of every agent that kept running through a window reload, before its tab
   * is restored: VS Code restores a tab only when it is shown, and the relay would stop Pi first.
   */
  resumeRunning(): void {
    const ids = this.registered();
    if (!ids.length) return;
    if (!openAgentTabs()) {
      // The tabs are gone (closed with the window, or editors not restored): forget the agents.
      void this.forget(ids);
      return;
    }
    for (const id of ids) {
      if (this.options.memento.get(agentStateKey(RELAY_KEY, id)) === undefined) continue;
      this.agent(id).chat.resumeRunningPi();
    }
  }

  /** The window is closing or reloading: let go of every Pi, leaving it running behind its relay. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.chats.map((chat) => chat.shutdown()));
  }

  dispose(): void {
    this.shuttingDown = true;
    for (const agent of this.agents.values()) {
      for (const listener of agent.listeners.splice(0)) listener.dispose();
      agent.chat.dispose();
    }
    this.agents.clear();
    this.active = undefined;
  }

  private activeAgent(): Agent | undefined {
    if (this.active?.panel) return this.active;
    return [...this.agents.values()].reverse().find((agent) => agent.panel);
  }

  private agent(id: string): Agent {
    const existing = this.agents.get(id);
    if (existing) return existing;
    const chat = this.options.createChat(id);
    const agent: Agent = { id, chat, listeners: [] };
    this.agents.set(id, agent);
    const ids = this.registered();
    if (!ids.includes(id)) void Promise.resolve(this.options.memento.update(AGENTS_KEY, [...ids, id])).catch(() => undefined);
    return agent;
  }

  private createPanel(): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(
      AGENT_PANEL_TYPE,
      DEFAULT_AGENT_TITLE,
      { viewColumn: agentViewColumn(this.options.isAgentTab ?? isAgentPanelTab), preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, "dist")],
      },
    );
  }

  private show(agent: Agent, panel: vscode.WebviewPanel): void {
    agent.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.options.extensionUri, "media", "pi-light.svg"),
      dark: vscode.Uri.joinPath(this.options.extensionUri, "media", "pi-dark.svg"),
    };
    agent.chat.attachPanel(panel);
    this.active = agent;
    agent.listeners.push(
      panel.onDidChangeViewState(() => {
        if (panel.active) this.active = agent;
      }),
      panel.onDidDispose(() => void this.closed(agent, panel)),
    );
  }

  /** The user closed the tab: stop its Pi and forget it, so it is not restored. */
  private async closed(agent: Agent, panel: vscode.WebviewPanel): Promise<void> {
    if (this.shuttingDown || agent.panel !== panel) return;
    for (const listener of agent.listeners.splice(0)) listener.dispose();
    agent.panel = undefined;
    this.agents.delete(agent.id);
    if (this.active === agent) this.active = undefined;
    await Promise.all([agent.chat.close(), this.forget([agent.id])]);
  }

  private registered(): string[] {
    const value = this.options.memento.get<unknown>(AGENTS_KEY);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && AGENT_ID.test(id)) : [];
  }

  private async forget(ids: readonly string[]): Promise<void> {
    const memento = this.options.memento;
    const remaining = this.registered().filter((id) => !ids.includes(id));
    const updates = [memento.update(AGENTS_KEY, remaining)];
    for (const id of ids) {
      if (this.agents.has(id)) continue;
      updates.push(memento.update(agentStateKey(ACTIVE_CHAT_KEY, id), undefined), memento.update(agentStateKey(RELAY_KEY, id), undefined));
    }
    await Promise.all(updates.map((update) => Promise.resolve(update).catch(() => undefined)));
  }
}
