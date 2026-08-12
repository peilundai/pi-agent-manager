# Pi Agent Manager

Run real [Pi coding agent](https://github.com/badlogic/pi-mono) terminal sessions beside your editor. Pi Agent Manager keeps the Pi TUI intact and adds a compact, workspace-scoped shell for session history, tabs, status, lifecycle actions, and editor context.

## Features

- Real Pi TUI sessions backed by pseudoterminals, with terminal scrollback preserved while switching tabs.
- A Pi view in VS Code's Secondary Side Bar with horizontal live-session tabs and a searchable, date-grouped history pane.
- Live `starting`, `working`, `waiting`, `stopped`, and `failed` status indicators.
- Persistent open tabs, active tab, session-pane layout, collapsed groups, and workspace session history.
- Session rename, detach, stop, resume, archive, restore, and guarded delete actions.
- Clickable HTTP(S) links and workspace file locations from terminal output.
- Selected-code insertion with `Cmd+L` on macOS or `Ctrl+L` on Windows and Linux.
- Responsive layouts, VS Code theme colors, keyboard navigation, and reduced-motion support.

## Requirements

- VS Code 1.106 or newer.
- Pi installed and available as `pi` on VS Code's process path.

Verify Pi before starting VS Code:

```sh
pi --version
```

If Pi is installed elsewhere, set `piAgent.command` to its absolute executable path.

## Open, start, and resume

Open the manager with the Pi icon in an editor title bar or run **Pi: Open Agent Manager** from the Command Palette. The manager appears in the Secondary Side Bar.

Choose **New Agent**, the plus button in the tab strip, or run **Pi: New Agent** to start Pi in the current workspace. Select a stopped session in history to resume its transcript with `pi --session`.

Pi Agent Manager scopes discovery, persisted view state, and process working directories to one workspace folder. In a multi-root window, activate it from an editor that belongs to the intended folder.

## Send selected code

Select code in an editor and press `Cmd+L` on macOS or `Ctrl+L` on Windows and Linux. With no selection, the current line is used. The manager opens and inserts a workspace-relative path, one-based line range, language-tagged fenced code block, and the selected text into the active waiting Pi input.

The insertion is a bracketed paste only: it does not submit the prompt. Review or extend the text in Pi, then submit it yourself.

## Sessions and status

The history pane groups sessions into Today, Yesterday, Last 7 Days, Last 30 Days, Older, and Archived. Search matches session titles and transcript metadata.

- **Starting** — the Pi process is launching.
- **Working** — Pi is processing a request.
- **Waiting** — Pi is ready for input.
- **Stopped** — the process is not running; the transcript can be resumed.
- **Failed** — Pi exited unexpectedly or could not start. The transcript remains available when one exists.

An explicit Pi session name, including one set with `/name`, takes precedence over the locally generated first-prompt title and updates the tab and history without reopening the manager.

## Close, stop, archive, and delete

Closing a tab detaches its UI by default; Pi continues running. Use **Stop** when you intend to terminate the process. You can change tab-close behavior with `piAgent.closeBehavior`.

Archiving changes only workspace-scoped extension metadata. It moves the session row to Archived and detaches its tab without moving or rewriting Pi's JSONL transcript. Restore reverses that metadata change.

Delete is permanent. It requires an in-view confirmation followed by a VS Code modal confirmation, stops a matching live process, then removes the selected JSONL transcript and its same-name sidecar directory. Use it only for disposable sessions.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `piAgent.command` | `pi` | Executable name or absolute path used to start Pi. |
| `piAgent.closeBehavior` | `detach` | Whether closing a tab detaches its UI or stops Pi. Values: `detach`, `stop`. |

## Privacy

Pi Agent Manager sends no telemetry and makes no network requests or hidden model calls. It reads Pi session metadata for the active workspace, launches the configured Pi executable locally, and stores presentation/archive state in VS Code's workspace storage. Pi itself and any Pi extensions or model providers retain their own behavior and privacy terms.

## Development

```sh
npm install
npm run check
npm test
npm run build
npm run package
```

Open this repository in VS Code and press `F5` to launch an Extension Development Host. The production bundles are written to `dist/`; packaging creates `pi-agent-manager-0.1.0.vsix`.

## Known follow-up features

Version 0.1.0 does not include audio cues, fork/rewind UI, or multi-agent panel orchestration. These are planned as follow-up capabilities rather than shipped features.

## License

MIT License.
