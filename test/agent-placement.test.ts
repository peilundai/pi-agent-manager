import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { agentViewColumn, isAgentPanelTab } from "../src/view/agent-placement";
import {
  type MockTab,
  resetVscodeMock,
  setTabGroups,
  tabGroup,
  TabInputTerminal,
  TabInputWebview,
} from "./vscode-mock";
import type * as VscodeMock from "./vscode-mock";

const mock = vscode as unknown as typeof VscodeMock;

const file = (): MockTab => ({ input: {}, label: "index.ts" });
const chat = (): MockTab => ({
  input: new TabInputWebview("mainThreadWebview-piAgentManager.agent"),
  label: "Pi Agent",
});
const piTerminal = (): MockTab => ({
  input: new TabInputTerminal(),
  label: "Pi Agent",
});
const shell = (): MockTab => ({ input: new TabInputTerminal(), label: "zsh" });

const isPiTab = (tab: vscode.Tab) =>
  isAgentPanelTab(tab) ||
  (tab.input instanceof vscode.TabInputTerminal && tab.label === "Pi Agent");
const place = (preferred?: number) => agentViewColumn(isPiTab, preferred);

beforeEach(() => {
  resetVscodeMock();
});

describe("agentViewColumn", () => {
  it("opens where the user is when no editor is open", () => {
    expect(place()).toBe(mock.ViewColumn.Active);
    setTabGroups([tabGroup(1)]);
    expect(place()).toBe(mock.ViewColumn.Active);
  });

  it("opens a new group to the right of the user's editors", () => {
    setTabGroups([tabGroup(1, [file()])]);
    expect(place()).toBe(2);
    setTabGroups([tabGroup(1, [file()]), tabGroup(2, [file(), shell()])]);
    expect(place()).toBe(3);
  });

  it("opens in an existing Pi group, chat or terminal, instead of a new one", () => {
    setTabGroups([tabGroup(1, [file()]), tabGroup(2, [chat()])]);
    expect(place()).toBe(2);
    setTabGroups([
      tabGroup(1, [file()]),
      tabGroup(2, [piTerminal()]),
      tabGroup(3, [file()]),
    ]);
    expect(place()).toBe(2);
  });

  it("prefers the active group, then the group used last, then the right-most Pi group", () => {
    setTabGroups(
      [
        tabGroup(1, [file(), chat()]),
        tabGroup(2, [chat()]),
        tabGroup(3, [piTerminal()]),
      ],
      2,
    );
    expect(place(1)).toBe(2);
    mock.window.tabGroups.activeTabGroup = tabGroup(4, [file()]);
    expect(place(1)).toBe(1);
    expect(place()).toBe(3);
    // A remembered group the Pi tabs have since left no longer counts.
    expect(place(4)).toBe(3);
  });

  it("opens in an empty group the user is in", () => {
    setTabGroups([tabGroup(1, [file()]), tabGroup(2)], 2);
    expect(place()).toBe(mock.ViewColumn.Active);
  });

  it("opens beside the active group once all nine columns are taken", () => {
    setTabGroups(
      Array.from({ length: 9 }, (_, index) => tabGroup(index + 1, [file()])),
    );
    expect(place()).toBe(mock.ViewColumn.Beside);
  });
});
