# Pi Agent Manager for VS Code — Design

## Goal

Build a production-quality VS Code extension that runs real Pi coding-agent TUI sessions in the Secondary Side Bar while making the surrounding session manager feel as polished and compact as Cursor's Agent Manager.

The Pi TUI remains the conversation interface. The extension owns session discovery, lifecycle, navigation, status, titles, editor integration, and the responsive manager shell.

The packaged extension uses the identifier `peilun-dai.pi-agent-manager`, display name `Pi Agent Manager`, and command/configuration prefix `piAgent`.

## Visual and Functional Inventory

The supplied screenshots require the following visible elements:

- A Pi icon in the editor title toolbar that opens the extension.
- A dedicated Pi container in VS Code's Secondary Side Bar.
- A compact manager header with the active session title and global actions.
- Horizontal tabs for open sessions, each with status and close affordances.
- A collapsible vertical session pane with search and a prominent New Agent action.
- Date-grouped session history: Today, Yesterday, Last 7 Days, Last 30 Days, Older, and Archived.
- Active, hover, keyboard-focus, working, waiting, stopped, and failed states.
- One unchanged Pi TUI per open session, rendered in xterm.js and backed by a real PTY.
- Responsive behavior that prioritizes the TUI at narrow widths and never silently discards the session list.
- Cursor-like density, spacing, borders, typography, icon weight, and quiet animations using VS Code theme tokens.

The extension must also provide:

- New, resume, detach, stop, archive, restore, delete, rename, refresh, and reveal-session actions.
- Persistent open tabs, active tab, collapsed groups, pane visibility, and terminal scrollback for the workspace.
- Live status and title updates without scraping terminal pixels.
- Clickable terminal file locations and HTTP(S) links.
- `Cmd+L` on macOS and `Ctrl+L` elsewhere to open Pi and place selected code in the active Pi editor without submitting it.
- Pi executable discovery, actionable empty/error states, automated tests, and a packaged VSIX.

Audio cues, fork/rewind UI, and multi-agent panel orchestration are follow-up capabilities. The design keeps boundaries that allow them to be added without replacing the session model.

## Chosen Architecture

### Extension host

The extension host is split into focused services:

1. `PiViewProvider` owns Secondary Side Bar activation and the webview lifecycle.
2. `PiCommandResolver` validates the configured executable and searches VS Code's process environment, common npm locations, and Windows command shims.
3. `SessionRepository` discovers workspace-matching Pi JSONL transcripts, extracts durable metadata, watches for changes, and performs archive/delete operations.
4. `SessionController` owns PTY processes and terminal attachment. Each live Pi process continues running when its UI tab is detached and stops only through an explicit stop/delete action or extension shutdown.
5. `StatusBridge` accepts authenticated, workspace-scoped lifecycle reports from a bundled Pi extension. JSONL remains the durable source; bridge reports are ephemeral live state.
6. `SelectionController` formats editor context and queues a bracketed paste into the active Pi TUI.
7. `WorkspaceViewState` validates and persists presentation state through VS Code `Memento`.

Interfaces isolate filesystem, PTY, clock, and VS Code APIs so core behavior is testable without launching an Extension Development Host.

### Webview

The webview uses TypeScript, React, and a small reducer-based state model. It renders:

- `ManagerHeader`
- `SessionTabs`
- `TerminalWorkspace`
- `SessionPane`
- `SessionSearch`
- `SessionGroup`
- `SessionRow`
- accessible menus, confirmations, empty states, and toasts

Each attached session owns one xterm.js instance with fit, search, Unicode, web-links, and optional WebGL addons. Terminal instances are preserved while hidden so switching tabs does not lose scrollback or selection.

All colors come from `--vscode-*` variables. Codicons are used for controls. Animations respect `prefers-reduced-motion`.

### Why not the alternatives

- Native VS Code terminal tabs plus a TreeView cannot reproduce the unified shell, responsive split pane, or controlled selected-code insertion.
- Pi RPC mode would require recreating the conversation renderer, editor, extensions UI, keybindings, and terminal semantics. It conflicts with the requirement to preserve the Pi TUI.

## Session Identity, Titles, and Status

Session identity is the Pi session header ID. The transcript path is a storage locator rather than the logical identity. Archiving is extension metadata keyed by session ID and does not move or rewrite Pi's transcript.

Title precedence is deterministic:

1. The latest explicit Pi `session_info.name` value.
2. A locally generated title from the first meaningful user prompt.
3. `New Agent`.

Local title generation removes injected file-context headers and fenced selected code, normalizes whitespace, uses the first request sentence, and truncates at a word boundary. It performs no hidden model call and creates no token cost. The generated fallback is kept in workspace state rather than written into Pi's transcript. `/name`, the manager's Rename action, or a later Pi session-name event replaces it immediately. Rename prompts in a VS Code input box and submits Pi's native `/name` command to the waiting session.

Live status is one of:

- `starting`
- `working`
- `waiting`
- `stopped`
- `failed`

The bridge includes a random per-panel authentication token, session/tab ID, monotonically increasing sequence number, and event timestamp. Stale or malformed reports are ignored. If live reports disappear, the UI falls back to process state rather than claiming that the agent is waiting.

## Main Interaction Flows

### Open and restore

1. The editor-title icon or `Pi: Open Agent Manager` reveals the Secondary Side Bar container.
2. The extension resolves the workspace and Pi executable.
3. Session history and persisted view state load in parallel.
4. Previously attached sessions resume with `pi --session <path>`; a workspace with no open sessions shows a focused New Agent empty state rather than starting a process unexpectedly.

### New and resume

1. New Agent creates a tab in `starting` state.
2. `SessionController` launches Pi with the workspace as `cwd`, the bundled status extension, and bridge environment variables.
3. The first status report binds the Pi session path and ID to the tab.
4. Selecting a stopped historical row launches `pi --session <path>` in a new or existing tab.

### Selected code via `Cmd/Ctrl+L`

1. The command captures the active text editor, document URI, language ID, selected range, and selected text.
2. With an empty selection it uses the current line; binary, oversized, and untrusted-scheme documents are rejected with an actionable message.
3. The manager opens and chooses the focused live session, or creates one if none exists.
4. It formats a compact context block containing a workspace-relative path, 1-based line range, and fenced code.
5. After Pi reaches `waiting`, it writes the content as bracketed paste and focuses xterm. It never appends Enter.

### Close and stop

- Closing a tab detaches its terminal UI by default and keeps the process alive.
- Stop terminates the PTY process tree and leaves the transcript resumable.
- Deleting requires confirmation, stops the process, removes the transcript and sidecar directory, and reports partial filesystem failures.
- Archive adds the session ID to workspace-scoped archive metadata, moves the row into the Archived group, and detaches its tab; restore reverses that metadata operation. Pi's transcript stays in its original session directory.

## Layout and Responsive Behavior

At wide widths, the TUI occupies the flexible left pane and the session pane uses a restrained 220–280 px width on the right, matching the screenshots. A draggable divider persists the user's chosen width.

At medium widths, the session pane becomes a fixed overlay opened from the header. At narrow widths, horizontal session tabs remain scrollable and the terminal keeps a minimum usable column count. Keyboard focus returns to the invoking control when menus, dialogs, or the overlay close.

The session pane supports fuzzy case-insensitive search over title and workspace-relative transcript metadata. Groups and the whole pane are collapsible. Session rows expose their primary action without requiring a context menu; destructive and secondary actions live in an accessible overflow menu.

## Message Contract

Host-to-webview and webview-to-host messages are discriminated TypeScript unions validated at runtime. Messages carry protocol version `1`; unknown versions and unknown message types are ignored and logged in development mode.

Large terminal output is chunked and bounded. Input, paste, and resize messages enforce length and numeric limits. Webview HTML uses a nonce-based Content Security Policy and exposes only packaged resources.

## Error Handling

- No workspace: show an inline empty state with `Open Folder`.
- Pi missing: show detection details and `Choose Executable` / `Open Settings` actions.
- PTY launch failure: mark only that tab failed and keep history usable.
- Non-zero Pi exit: close the live attachment, retain the transcript, and show a non-blocking warning.
- Corrupt/in-progress JSONL: keep the last valid metadata and retry after the write settles.
- Bridge unavailable: continue the TUI with conservative process-derived status and surface a single warning.
- Webview reload: rehydrate tabs, replay bounded scrollback, and refit terminals.

## Accessibility and Quality Bar

- All controls are reachable and operable by keyboard.
- Icon-only controls have labels and tooltips.
- Lists, tabs, dialogs, and menus use appropriate ARIA roles and state.
- Status is communicated by icon and text/label, never color alone.
- Focus outlines use VS Code theme tokens and remain visible in high-contrast themes.
- No network request, telemetry, or model call is made by the extension itself.

## Testing and Verification

### Unit tests

- Pi command resolution and platform command construction.
- JSONL parsing, workspace matching, title precedence/generation, grouping, archive paths, and corrupt-tail tolerance.
- Session reducer and persisted-state validation.
- Host/webview protocol guards and stale status rejection.
- Selected-code formatting, line ranges, size limits, and bracketed paste.
- Terminal link resolution and workspace-relative path handling.

### Component tests

- Session search, grouping, collapse, keyboard navigation, tabs, menus, dialogs, and responsive pane state.
- Terminal lifecycle through a fake PTY adapter.

### Build verification

- Type-check, lint, unit/component tests, and production bundle.
- VSIX packaging with an inspection that required runtime assets and native PTY files are included.
- Extension Development Host smoke test: open manager, create Pi session, switch/detach/resume, verify title/status, and inject selected code with `Cmd/Ctrl+L`.
- Visual inspection at wide, medium, narrow, dark, light, and high-contrast configurations against the supplied screenshots.

## Delivery Boundary

The first packaged release is complete only when the manager shell, real Pi TUI sessions, workspace history, live status, deterministic title updates, core lifecycle actions, clickable links, persistent view state, and selected-code insertion are implemented and verified. Documentation will identify audio, fork/rewind UI, and agent-panel orchestration as future enhancements rather than presenting them as shipped.
