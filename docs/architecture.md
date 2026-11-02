# Architecture

Pi Chat is a webview view in VS Code's Secondary Side Bar. The extension host drives one `pi --mode rpc` child process. The webview is a React app that renders Pi's event stream as a chat.

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
  - The working directory is the workspace folder.
  - `src/pi/jsonl.ts` splits stdout strictly on LF, not with `readline`, so U+2028/U+2029 inside JSON strings stay intact.
  - Requests carry an `id` and are matched to their `response`. Everything else is an event.
  - Closing stdin shuts Pi down gracefully. A process that is still alive after 2 s is killed.
- `src/pi/chat-session.ts`:
  - **Startup:** posts a snapshot built from `get_state`, `get_messages`, `get_available_models`, `get_commands` and `get_session_stats`.
  - **Chat commands:** prompts (`streamingBehavior` is `followUp` or `steer` while busy), `abort`, `new_session` and `switch_session`.
  - **Settings commands:** `set_model`, `set_thinking_level`, `set_session_name`, `compact`, and `extension_ui_response`.
  - **Events:** sanitized by `src/pi/sanitize.ts` (drops `agent_end`/`turn_end` payloads and system messages, bounds string sizes), then batched every 16 ms.
  - **End of a run:** `agent_settled`, not `agent_end`, because retries, compaction and queued messages can follow `agent_end`.

## Webview state

`src/webview/chat-state.ts` is a pure reducer from Pi events to transcript items:

- `message_start` for an assistant opens an empty streaming item. Pi's snapshot may already contain the first delta, so content is rebuilt from `text_*`, `thinking_*` and `toolcall_*` deltas. `*_end` and `message_end` then replace it with the authoritative content.
- Tool calls are blocks inside the assistant message. They point into a `tools` map that `tool_execution_*` events and `toolResult` messages update.
- Extension UI dialogs become dialog items, and `notify` becomes a notice.
- A snapshot (`get_messages`) rehydrates the same structures, so reloading the webview or resuming a chat renders the same way as live streaming.

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
