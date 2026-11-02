# Changelog

All notable changes to Pi Chat (formerly Pi Agent Manager) are documented here.

## 0.2.0 — 2026-11-02

Rewritten from scratch as a native chat UI modeled on the Claude Code extension.

### Added

- Chat view in the Secondary Side Bar driving the local `pi --mode rpc` process. It reuses the CLI's providers, models, skills, extensions and sessions with no extra setup.
- Streaming Markdown with syntax highlighting, collapsible thinking, and a timeline dot per step.
- Tool cards with one-line summaries, inline diffs for `edit`/`write`, command output and clickable paths.
- Inline cards for Pi extension `confirm`/`select`/`input`/`editor` dialogs, and notices for notifications and errors.
- Composer:
  - `/` commands (Pi templates, skills and extension commands, plus local `/new`, `/compact`, `/model`, `/rename`, `/history`).
  - `@` file mentions and image paste or drop.
  - Follow-up queue and steering, Esc to interrupt, prompt history.
- Model and thinking-level picker, and a context-usage ring.
- Searchable, date-grouped past chats with resume, rename and delete.
- Pi 1.5 color palette for light, dark and high-contrast themes.
- `Cmd/Ctrl+L` inserts the editor selection into the composer.

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
