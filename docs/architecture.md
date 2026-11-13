# Architecture

Pi Agent Manager is a webview view in VS Code's Secondary Side Bar. Hosts that do not register that bar, such as Cursor, show the same chat from the left activity bar instead. VS Code moves a view into Explorer when its container is missing. The secondary view stays hidden while the activity bar fallback is on. The extension host drives one `pi --mode rpc` child process. The webview is a React app that renders Pi's event stream as a chat.

```
┌──────────────── Extension host (Node) ────────────────┐        ┌──────── Webview (React) ────────┐
│ ChatViewProvider ── protocol (validated) ─────────────┼──────▶ │ App → chatReducer(state, event) │
│   │                                                   │ ◀──────┼── prompt / abort / model.set …  │
│   ├─ ChatSession   (lifecycle, commands, batching)    │        │ Header · SessionPicker          │
│   │    └─ PiRpcClient ── JSONL over stdio ──▶ pi      │        │ Transcript · ToolCard · Dialog  │
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
  - The open chat (folder and transcript path) is kept in `workspaceState` under `piAgentManager.activeChat`. The first start after activation reopens that folder and resumes the transcript with `switch_session`, as long as it is still in the folder's history, so a window reload brings the chat back.
- `src/pi/chat-session.ts`:
  - **Startup:** posts a snapshot built from `get_state`, `get_messages`, `get_available_models`, `get_commands` and `get_session_stats`.
  - **Chat commands:** prompts (`streamingBehavior` is `followUp` or `steer` while busy), `abort`, `new_session` and `switch_session`.
  - **Settings commands:** `set_model`, `set_thinking_level`, `set_session_name`, `compact`, and `extension_ui_response`.
  - **Events:** sanitized by `src/pi/sanitize.ts` (drops `agent_end`/`turn_end` payloads and system messages, bounds string sizes), then batched every 16 ms.
  - **End of a run:** `agent_settled`, not `agent_end`, because retries, compaction and queued messages can follow `agent_end`.

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
| Real Pi E2E | `npm run test:e2e` | The pinned `@earendil-works/pi-coding-agent` CLI in RPC mode, using `test/e2e/support/` (mock OpenAI-compatible server, temporary HOME, confirm-before-bash extension). Checks the protocol contract, a full tool turn with a dialog, a declined tool, extension commands, abort, provider errors, resume/hydration parity, model switching and new chats |
| Webview UI | `npm run test:ui` | Playwright drives the built `dist/` webview bridged to a real `ChatSession` (`test/ui/harness.ts`); screenshots in both themes |
