import * as vscode from "vscode";

/** The webview panel type of an editor-tab agent; also the `onWebviewPanel:` activation event. */
export const AGENT_PANEL_TYPE = "piAgentManager.agent";

/** Tells Pi tabs (chat or terminal) apart from the user's own editors. */
export type AgentTabTest = (tab: vscode.Tab) => boolean;

/** A Pi chat tab, restored or not; VS Code prefixes the panel type. */
export function isAgentPanelTab(tab: vscode.Tab): boolean {
  return (
    tab.input instanceof vscode.TabInputWebview &&
    tab.input.viewType.endsWith(AGENT_PANEL_TYPE)
  );
}

/** VS Code has at most nine editor columns. */
const MAX_VIEW_COLUMN = 9;

/** The editor groups, as far as placement needs them. */
export interface PlacementGroups {
  all: readonly Pick<vscode.TabGroup, "viewColumn" | "tabs">[];
  activeTabGroup: Pick<vscode.TabGroup, "viewColumn" | "tabs"> | undefined;
}

/**
 * Where a new Pi agent tab opens, as Claude Code places its editor tabs:
 *
 * 1. In the group the user is in, if it already holds a Pi tab.
 * 2. Otherwise in an existing Pi group: `preferred` (the group of the Pi tab
 *    used last) if it still holds one, else the right-most group that does.
 * 3. Otherwise, when other editors are open, in a new group to the right of
 *    them, so the chat does not cover the user's files.
 * 4. Otherwise (nothing open, or the user is in an empty group) where the user is.
 */
export function agentViewColumn(
  isAgentTab: AgentTabTest,
  preferred?: number,
  groups: PlacementGroups = vscode.window.tabGroups,
): vscode.ViewColumn {
  const all = groups.all ?? [];
  const active = groups.activeTabGroup;
  if (active?.tabs.some(isAgentTab)) return active.viewColumn;
  const agentGroups = all.filter((group) => group.tabs.some(isAgentTab));
  const preferredGroup = agentGroups.find(
    (group) => group.viewColumn === preferred,
  );
  const agentGroup =
    preferredGroup ??
    agentGroups.reduce<(typeof agentGroups)[number] | undefined>(
      (right, group) =>
        !right || group.viewColumn > right.viewColumn ? group : right,
      undefined,
    );
  if (agentGroup) return agentGroup.viewColumn;
  if (!active?.tabs.length) return vscode.ViewColumn.Active;
  const rightMost = Math.max(...all.map((group) => group.viewColumn));
  // A column one past the last group makes VS Code open a new group on the right.
  return rightMost < MAX_VIEW_COLUMN
    ? ((rightMost + 1) as vscode.ViewColumn)
    : vscode.ViewColumn.Beside;
}
