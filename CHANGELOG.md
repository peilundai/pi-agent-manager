# Changelog

All notable changes to Pi Agent Manager are documented here. (During development of 0.2.0 it was briefly called "Pi Chat".)

## Unreleased

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
