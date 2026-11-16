# Architecture

Pi Coding Agent for VS Code shows a React chat webview in one of two places, chosen by `piAgentManager.defaultLocation`:

- **Editor tabs** (`editor`, the default): every agent is a `WebviewPanel` of type `piAgentManager.agent` with its own `ChatViewProvider`, and so its own `pi --mode rpc` process and session. `src/view/editor-agents.ts` (`EditorAgents`) creates, tracks and restores them.
- **Terminal tabs** (`editor` with `piAgentManager.tabMode` set to `terminal`): `src/view/terminal-agents.ts` (`TerminalAgents`) opens plain interactive `pi` (`buildTerminalArgs()`, not RPC) in editor-area terminals via `vscode.window.createTerminal`. On macOS and Linux it runs through the login shell (`exec pi …`); on Windows it uses `buildPiInvocation()`. New terminals reuse the editor group of the last one. There is no webview, relay or session history UI. Each terminal runs its own session (`pi --session-id <uuid>`, which creates the session on first use and reopens it afterwards) and gets the lowest free title number (Pi Agent, Pi Agent 2, …). The open terminals (session ID, folder, editor group, title number, last-used order) are kept in `workspaceState` under `piAgentManager.terminalAgents`. The terminals are `isTransient`, because VS Code would restore a plain shell rather than Pi, so on activation in terminal mode `TerminalAgents.restore()` reopens each saved one in its folder and group with the same session. A terminal closed by the user, or whose Pi exits, is dropped from the list; one closed with `TerminalExitReason.Shutdown` (reload or window close) is kept. A session switched inside Pi (`/new`, `/resume`) is not tracked. **Add Selection to Chat** types an `@path#lines` mention with `sendText(…, false)`; with no Pi terminal open it only opens one, because keystrokes sent during shell and Pi startup can be lost. **Reload Environment and Restart Pi** reopens each terminal in its folder with the same session. Chat tabs opened before the mode was switched keep working, and so does the side bar.
- **Side bar** (`sidebar`): one `ChatViewProvider` behind a webview view in VS Code's Secondary Side Bar. Hosts that do not register that bar, such as Cursor, show the same chat from the left activity bar instead. VS Code moves a view into Explorer when its container is missing. The secondary view stays hidden while the activity bar fallback is on. Both views are hidden while agents open in editor tabs.

Each `ChatViewProvider` drives one Pi. The webview renders Pi's event stream as a chat.

```
┌──────────────── Extension host (Node) ────────────────┐        ┌──────── Webview (React) ────────┐
│ ChatViewProvider ── protocol (validated) ─────────────┼──────▶ │ App → chatReducer(state, event) │
│   │                                                   │ ◀──────┼── prompt / abort / model.set …  │
│   ├─ ChatSession   (lifecycle, commands, batching)    │        │ Header · SessionPicker          │
│   │    └─ RelayClient ═ socket ═ relay ─ stdio ─▶ pi  │        │ Transcript · ToolCard · Dialog  │
│   ├─ PiSessionRepository (~/.pi/agent/sessions)       │        │ Composer · ModelPicker          │
│   └─ editor helpers (selection, @-file search)        │        └─────────────────────────────────┘
└───────────────────────────────────────────────────────┘
```

## Pi RPC

- `src/pi/rpc-client.ts` spawns Pi with `buildPiInvocation()` (which handles Windows `.cmd` shims) and `buildRpcArgs()`.
  - The working directory is the chat's workspace folder. In a multi-root window, `ChatViewProvider` moves to the active editor's folder while the chat is empty (`ChatSession.isPristine`), on **New Chat**, or through the folder picker. Each move restarts Pi, because a Pi process is bound to its working directory.
  - `src/pi/jsonl.ts` splits stdout strictly on LF, not with `readline`, so U+2028/U+2029 inside JSON strings stay intact.
  - Requests carry an `id` and are matched to their `response`. Everything else is an event.
  - Closing stdin shuts Pi down gracefully. A process that is still alive after 2 s is killed.
- `src/pi/chat-session.ts`:
  - **Startup:** posts a snapshot built from `get_state`, `get_messages`, `get_available_models`, `get_commands` and `get_session_stats`.
  - **Chat commands:** prompts (`streamingBehavior` is `followUp` or `steer` while busy), `abort`, `new_session` and `switch_session`.
  - **Settings commands:** `set_model`, `set_thinking_level`, `set_session_name`, `compact`, and `extension_ui_response`.
  - **Events:** sanitized by `src/pi/sanitize.ts` (drops `agent_end`/`turn_end` payloads and system messages, bounds string sizes), then batched every 16 ms.
  - **End of a run:** `agent_settled`, not `agent_end`, because retries, compaction and queued messages can follow `agent_end`.

## Surviving a window reload

Reloading the window ends the extension host, so Pi is not its direct child. `src/pi/relay-client.ts` launches `dist/relay.js` (`src/relay.ts` → `src/pi/relay-server.ts`) as a **detached** process with Electron's Node (`ELECTRON_RUN_AS_NODE=1`), and the relay owns `pi --mode rpc`.

```
extension host ── RelayClient ══ local socket ══ relay (detached) ── stdio ── pi --mode rpc
```

- **Launch:** the config, including Pi's environment, goes to the relay's stdin, never its command line. The relay answers `relay.ready` and is then on its own. It listens on a Unix socket in a private `mkdtemp` directory, or a named pipe on Windows. Clients must present a random 256-bit token.
- **Wire format:** JSONL. Pi's records pass through unchanged, except request ids are scoped per connection, so a reloaded window's ids never get another window's answers. Control records are `relay.*`.
- **Reload:** `deactivate` calls `ChatSession.detach()`, which closes the socket and leaves Pi running. The endpoint (socket path, token, folder) is kept in `workspaceState` under `piAgentManager.relay`. The extension activates `onStartupFinished` and calls `ChatViewProvider.resumeRunningPi()`, so it reattaches even while the view is hidden. A reattached client skips `switch_session`.
- **Catch-up:** `src/pi/run-replay.ts` tracks the live part of a run that a `get_messages` snapshot cannot show: the run itself, the streaming message's deltas, running tools (latest output only), queue/compaction/retry status and unanswered dialogs (with their remaining timeout). Completed messages are dropped when they end. The relay sends this replay right after `relay.welcome`. `ChatSession` keeps its own `RunReplay` too and posts it after every snapshot, so a reloaded webview also shows a run in progress.
- **Close:** if nothing reattaches within 30 s (`RELAY_GRACE_MS`), the relay closes Pi's stdin, kills it after 2 s, removes its socket directory and exits. **New Chat** across folders, folder switches and **Restart Pi** stop the relay as before.
- **Fallback:** if the relay is gone (closed window, reboot), the first start resumes the last open transcript instead. The folder and transcript path are kept under `piAgentManager.activeChat` and resumed with `switch_session` if the transcript is still in that folder's history.

## Editor-tab agents

- **Identity:** each agent has a random id. The provider puts it in the page as `<meta name="pi-agent-id">`, and the webview transport (`src/webview/vscode.ts`) adds it to every `setState`, so VS Code hands it back to the panel serializer after a reload. The agent's relay endpoint and open chat are kept under `piAgentManager.relay.<id>` and `piAgentManager.activeChat.<id>`; the ids of open agents are in `piAgentManager.editorAgents`.
- **Commands:** **New Pi Agent** opens a new tab. Other chat commands (**Open**, **New Chat**, **Past Chats**, **Add Selection to Chat**, **Focus Chat Input**, **Switch Workspace Folder**) go to the tab that was active last, opening one if none is open. **Reload Environment and Restart Pi** restarts every agent.
- **Reload:** `deactivate` detaches every agent; their Pi keeps running behind its relay. VS Code restores a webview tab only when it is shown, which can be after the relay's grace period, so on activation `EditorAgents.resumeRunning()` reattaches every registered agent that has a relay endpoint right away, without a tab, as the sidebar does. When the tab is restored (`deserializeWebviewPanel`), it attaches to that agent. If the window has no agent tabs at all, the registered agents are forgotten. The extension also activates on `onWebviewPanel:piAgentManager.agent`.
- **Close:** closing a tab disposes the agent: Pi and its relay stop, and its state keys are cleared. The transcript stays in history. Tabs that go away while the window closes or reloads are not treated as closed.
- **Title:** the tab is named after the chat's title from its transcript, shortened to 40 characters, or **Pi Agent** for a new chat.

## Pi's environment

`src/view/pi-environment.ts` builds the environment Pi is spawned with. Later sources win:

1. VS Code's own `process.env`.
2. The login-shell environment from `src/pi/shell-environment.ts`. It runs `$SHELL -i -l -c` once per window, with a Node probe (the Electron helper with `ELECTRON_RUN_AS_NODE=1`) that prints `JSON.stringify(process.env)` between random markers, so rc-file output can't corrupt it. It only fills in variables that are unset or empty, and appends missing `PATH` entries. It has a 10 s timeout, the shell's process group is killed on timeout, and Windows skips this step.
3. `piAgentManager.environment` (machine-scoped setting).
4. Secrets in VS Code `SecretStorage` under `piAgentManager.env.<NAME>`.

The probe never reads the shell's stderr, because startup files can trace exported secrets there (`set -x`). The merged environment is also used to find the `pi` executable and to locate session transcripts (`PiSessionRepository.useEnvironment`). If `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR` moves them, the history watcher is recreated. `src/pi/config-references.ts` lists the variables that `models.json` and `mcp.json` reference (`$NAME`, `${NAME}`, `{ "env": "NAME" }`, `*EnvVar` keys, and legacy all-caps `apiKey` names). `PiEnvironment.checkMissing()` warns once per missing name. Secret values are never logged or posted to the webview.

## Webview state

`src/webview/chat-state.ts` is a pure reducer from Pi events to transcript items:

- `message_start` for an assistant opens an empty streaming item. Pi's snapshot may already contain the first delta, so content is rebuilt from `text_*`, `thinking_*` and `toolcall_*` deltas. `*_end` and `message_end` then replace it with the authoritative content.
- Tool calls are blocks inside the assistant message. They point into a `tools` map that `tool_execution_*` events and `toolResult` messages update.
- Calls a tool makes while it runs, such as a `codemode` script's `tools.read(...)`, carry `parentToolCallId` and ids of the form `<parentId>/<n>`. They are stored in `tools` with `parentId` and listed in the parent's `children`, not added as blocks. `ToolCard` renders them inside the parent. A `toolResult`'s `nestedCalls` record (name, arguments, status, error; no results) rebuilds them on reload. When a nested call changes, its ancestors' states are replaced so their memoized cards re-render. A call whose parent is unknown falls back to a top-level block.
- Extension UI dialogs become dialog items, and `notify` becomes a notice.
- A snapshot (`get_messages`) rehydrates the same structures, so reloading the webview or resuming a chat renders the same way as live streaming.

Editor selections travel as `ContextReference`s (`src/shared/context-references.ts`). The composer shows a compact `@path#lines` token, painted as a chip by an overlay behind the textarea, and `expandReferences` appends each referenced code block when the prompt is sent. `parseReferencedPrompt` reverses that, so sent messages, recalled history and session titles show the chip again, even after a reload. The host posts the active editor's selection (`editor.selection`, debounced) for the composer's **N lines selected** indicator.

Host messages are applied once per animation frame. Markdown is split into blank-line-separated blocks (fences kept intact), so only the growing tail is re-parsed while text streams.

## Theme

`src/webview/theme.css` defines Pi 1.5's palette, converted from okhsl to sRGB. There is a dark set and a light set, chosen by VS Code's `body.vscode-dark` / `body.vscode-light` classes. Derived tokens (hairlines, hover, raised surfaces) are computed on `body` so they follow the active set. High-contrast themes fall back to VS Code colors.

## Testing

| Suite | Command | What it covers |
|---|---|---|
| Unit + components | `npm test` | JSONL decoder; RPC client against `test/fixtures/fake-pi.mjs`; `ChatSession` with a fake client; `ChatViewProvider` and activation against `test/vscode-mock.ts`; reducer, tool formatting, protocol, sanitizer, editor helpers; React components (composer, pickers, Markdown, tool cards, dialogs) |
| Coverage | `npm run test:coverage` | Same, with V8 thresholds in `vitest.config.ts` |
| Real Pi E2E | `npm run test:e2e` | The pinned `@earendil-works/pi-coding-agent` CLI in RPC mode, using `test/e2e/support/` (mock OpenAI-compatible server, temporary HOME, confirm-before-bash extension). Checks the protocol contract, a full tool turn with a dialog, a declined tool, extension commands, abort, provider errors, resume/hydration parity, model switching and new chats. `editor-agents.e2e.test.ts` runs `activate()` against `test/vscode-mock.ts` with two editor-tab agents, then reloads and checks each tab reattaches to its own Pi |
| Webview UI | `npm run test:ui` | Playwright drives the built `dist/` webview bridged to a real `ChatSession` (`test/ui/harness.ts`); screenshots in both themes |
