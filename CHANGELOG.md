# Changelog

All notable changes to Pi Coding Agent for VS Code, formerly Pi Agent Manager, are documented here. (During development of 0.2.0 it was briefly called "Pi Chat".)

## Unreleased

### Changed

- The Marketplace and Open VSX listings no longer show a **Preview** badge.

## 0.4.0 — 2026-11-16

### Added

- **Terminal tabs.** Set `piAgentManager.tabMode` to `terminal` to open **New Pi Agent** as interactive `pi` in an editor-area terminal, as the Pi Coding Agent Tabs extension does, instead of the chat UI. **Add Selection to Chat** types an `@path#lines` mention into the Pi terminal, and **Switch Workspace Folder** opens a new terminal in the folder you pick. Each terminal runs its own Pi session under a distinct title (Pi Agent, Pi Agent 2, …), and the open terminals are reopened with their sessions, folders, editor groups and titles after a window reload. The side bar keeps the chat UI. ([#54](https://github.com/peilundai/pi-agent-manager/issues/54))

### Changed

- **New agents open beside your editors.** When other editors are open, **New Pi Agent** opens the chat or terminal in a new editor group on the right instead of covering the file you are in. Later agents, chat or terminal, open as tabs in that Pi group. With nothing else open, the agent still takes the whole editor area.

## 0.3.1 — 2026-11-15

0.3.0 was tagged but never reached the stores: the Marketplace rejected the display name "Pi Agent for VS Code" because another extension already uses it. 0.3.1 ships the same changes under the name Pi Coding Agent for VS Code.

### Added

- **Pi agents in editor tabs.** **New Pi Agent** (the π button in the editor title bar) opens the chat in an editor tab, and each tab runs its own Pi process and session, so several agents can work at once. Tabs are named after their chat and are restored after a window reload, reattaching to a Pi that kept running. Closing a tab stops that agent; the chat stays in **Past Chats**. Commands such as **Add Selection to Chat** go to the tab you used last. ([#53](https://github.com/peilundai/pi-agent-manager/issues/53))
- **`piAgentManager.defaultLocation`** chooses where agents open: `editor` (the default) or `sidebar`, which keeps the single side-bar chat, including the activity bar fallback in Cursor. Set it to `sidebar` to keep the previous behaviour.

### Changed

- **Renamed to Pi Coding Agent for VS Code.** The Marketplace listing, side-bar titles, settings section, output channel and command palette category use the new name. The extension ID `peilundai.pi-agent-manager` and every `piAgentManager.*` command, setting and view ID are unchanged, so existing installs, settings and keybindings keep working.
- **Marketplace description and README** say agents open in editor tabs by default, several side by side, with a single side-bar chat when `piAgentManager.defaultLocation` is `sidebar`.

### Fixed

- In editor mode, the unused side-bar chat no longer reacts to every editor-selection and settings change.

## 0.2.5 — 2026-11-14

### Added

- **The open chat comes back after a reload.** Reloading the window reopens that chat in the same folder when its transcript is still in the folder's history.

### Changed

- **Codemode calls are grouped.** A `codemode` script shows as one card: the script, the tool calls it made, and its output. Before, the calls were listed beside the script as if Pi had made them directly. The card shows the lines its edits changed, and it follows `piAgentManager.expandToolCards`: with the default `edits` it opens when the script edited files, showing those diffs. Any tool that calls other tools is grouped the same way.

### Fixed

- Tool calls made by a codemode script disappeared when a chat was reloaded or resumed. They are rebuilt from the record Pi keeps with the script's result.
- The empty-chat tip and the composer placeholder name the current shortcuts. **Add Selection to Chat** is `Alt+L` (`⌥L` on macOS). **Focus Chat Input** is `Ctrl+Alt+P` (`⌃⌘P` on macOS).

## 0.2.4 — 2026-11-04

### Added

- **Live selection.** While code is selected in the editor, the composer shows **N lines selected**. That selection is sent with your next message; click it to place it in the text, or × to leave it out.
- Selections in sent messages show as `@file#lines` chips. Click one to open the file at those lines, or hover to preview the code. Recalling a past prompt with ↑ brings its chips back.

### Changed

- **Add Selection to Chat** inserts a compact `@file#43-48` chip instead of pasting the whole code block. The code is still sent to Pi, and one Backspace removes the chip.

### Fixed

- In Cursor, Pi opens from the left activity bar. Cursor does not register the Secondary Side Bar, so opening Pi failed with `command 'workbench.view.extension.piAgentManager' not found`. VS Code still opens Pi in the Secondary Side Bar, and only one panel is shown.
- A failed shell command is summarized by its exit status, such as `Exit code 128`, a timeout, or an abort, instead of the first line of its output. Only that status line is red. The command's own output keeps its normal color.
- Long notices, dialog answers, and links keep to the width of the transcript. A long URL is a one-line chip you can open or copy. A long answer truncates, and the full value shows on hover. Notices, thinking text, and quotes are rounded cards.

## 0.2.3 — 2026-11-04

### Changed

- **Add Selection to Chat** now defaults to `Alt+L` (`⌥L` on macOS) instead of `Cmd/Ctrl+L`, which clashed with VS Code's **Expand Line Selection** and other chat extensions. To keep the old shortcut, rebind **Pi Agent Manager: Add Selection to Chat** in **Keyboard Shortcuts**.
- **Focus Chat Input** now defaults to `Ctrl+Alt+P` (`⌃⌘P` on macOS) instead of `Cmd/Ctrl+Esc`, which clashed with Claude Code and, on Windows, opened the Start menu.

## 0.2.2 — 2026-11-03 (first Marketplace preview)

First release published to the VS Code Marketplace, as an unofficial preview. Open VSX publishing is set up but waits for its access token, so this version reaches Open VSX later. 0.2.0 and 0.2.1 were released on GitHub only.

### Changed

- The publisher ID is now `peilundai`, so the extension ID is `peilundai.pi-agent-manager`. If you installed 0.2.0 or 0.2.1 from a VSIX, uninstall it before installing from a store.
- The editor title bar button and the sidebar icon now show the pixel-art π bot from the Marketplace icon. The title bar button uses the theme's accent purple in light and dark themes, and the sidebar icon follows the theme's icon color.

## 0.2.1 — 2026-11-03

### Added

- `piAgentManager.maxContentWidth` setting (default `800`): the transcript and composer stop growing past this width and stay centered when the view is wider. `0` fills the view.
- Edit and write tool cards show added and removed line counts (`+N -M`) next to the file path, so the size of a change stays visible when the card is folded.
- `piAgentManager.expandToolCards` setting (`edits`, `all` or `none`; default `edits`): chooses which tool cards start expanded. Changes apply to open chats, and cards you already toggled keep their state.

### Changed

- Write tool cards now start folded, showing their line count and summary; click the header to see the content. Edit diffs still open by default.

## 0.2.0 — 2026-11-03

Rewritten from scratch as a native chat UI for the Pi coding agent. Released on GitHub as a VSIX.

### Added

- Marketplace listing: π icon, preview flag, unofficial disclaimer, privacy note and third-party notices (including Pi's MIT-licensed palette).
- Chat view in the Secondary Side Bar driving the local `pi --mode rpc` process. It reuses the CLI's providers, models, skills, extensions and sessions with no extra setup.
- Streaming Markdown with syntax highlighting, collapsible thinking, and a timeline dot per step.
- Tool cards with one-line summaries, inline diffs for `edit`/`write`, command output and clickable paths.
- Inline cards for Pi extension `confirm`/`select`/`input`/`editor` dialogs, and notices for notifications and errors.
- Composer:
  - `/` commands (Pi templates, skills and extension commands, plus local `/new`, `/compact`, `/model`, `/rename`, `/history`).
  - `@` file mentions and image paste or drop.
  - Follow-up queue and steering, Esc to interrupt, prompt history.
- Model and thinking-level picker, and a context-usage ring.
- Searchable, date-grouped past chats with resume, rename and delete, scoped to the workspace folder.
- Multi-root windows: an empty chat follows the active editor's folder, New Chat starts there, and a header button switches folders.
- Pi 1.5 color palette for light, dark and high-contrast themes.
- `Cmd/Ctrl+L` inserts the editor selection into the composer.
- Works without manual setup when VS Code was not started from a terminal: Pi gets the variables your login shell exports (gateway keys, MCP tokens, `PATH`). Missing variables referenced by Pi's `models.json` or `mcp.json` are named, with a one-click fix that stores the value in VS Code's encrypted secret storage. New commands: Set/Remove Environment Secret, Reload Environment and Restart Pi, and Show Environment Diagnostics. New settings: `piAgentManager.loadShellEnvironment` and `piAgentManager.environment`.

### Fixed

- The π button in the editor title bar is now visible in dark themes. It ships light and dark icon variants; the sidebar icon already follows the theme.
- Inline diffs use the active VS Code theme's diff-editor and Git colors, so they match the built-in diff view in light, dark and high-contrast themes.

### Removed

- Embedded terminal (xterm.js + node-pty) sessions and the status bridge extension. Packages are now a single universal VSIX with no native code.

## 0.1.0 — 2026-08-13

### Added

- Real Pi TUI sessions in VS Code's Secondary Side Bar, backed by native pseudoterminals.
- Responsive live-session tabs and searchable, date-grouped workspace history.
- Live session status and title updates through an authenticated local status bridge.
- New, resume, rename, detach, stop, archive, restore, and guarded delete workflows.
- Workspace file links, web links, and selected-code insertion with `Cmd/Ctrl+L`.
- Workspace-scoped persistence, theme integration, keyboard navigation, and reduced-motion support.
- Production build and VSIX packaging with the current-platform `node-pty` runtime.
- Host-derived platform metadata and matching native inventories for macOS x64/arm64, Windows x64/arm64, and glibc Linux x64/arm64.
- Node-based extracted-package PTY verification and stable `pi-agent-manager-0.1.0.vsix` local artifact naming.
