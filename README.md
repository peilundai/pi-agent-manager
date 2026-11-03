# Pi Agent Manager for VS Code

[![CI](https://github.com/peilundai/pi-agent-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/peilundai/pi-agent-manager/actions/workflows/ci.yml)

Chat with your local [Pi coding agent](https://github.com/earendil-works/pi) from VS Code's side bar: streaming answers, tool cards with diffs, and your past chats, drawn in Pi's own colors.

> **Unofficial, preview.** Pi Agent Manager is a community extension. It is not affiliated with or endorsed by the Pi project or its authors. See [Disclaimer and acknowledgements](#disclaimer-and-acknowledgements).

## Requirements

- VS Code 1.106 or newer.
- Pi installed, signed in and working in a terminal:

  ```sh
  npm install -g @earendil-works/pi-coding-agent
  pi            # sign in / pick a provider once
  ```

<p align="center">
  <img src="docs/images/chat-dark.png" width="360" alt="Pi Agent Manager in a dark theme" />
  <img src="docs/images/chat-light.png" width="360" alt="Pi Agent Manager in a light theme" />
</p>

## Zero setup

If `pi` already works in your terminal, Pi Agent Manager works too. It runs your installed CLI in RPC mode (`pi --mode rpc`), so it uses your existing:

- providers, API keys and logins,
- default model and thinking level,
- skills, prompt templates and extensions,
- session history in `~/.pi/agent/sessions`.

The extension adds no accounts, keys or configuration of its own.

## API keys, company gateways and MCP tokens

Pi often reads keys from environment variables: `"apiKey": "${GATEWAY_API_KEY}"` for a custom provider or company gateway in `models.json`, or `"Authorization": "Bearer ${DOCS_TOKEN}"` for an MCP server in `mcp.json`. A VS Code window opened from the Dock, a desktop launcher or an automatic update restart does not run your shell startup files, so those variables can be missing even though `pi` works in your terminal.

Pi Agent Manager handles this for you:

1. **Login-shell environment.** When it starts Pi, the extension asks your login shell (`$SHELL -i -l -c`, run once per window) for the variables it sets up. It adds the ones VS Code doesn't have, plus missing `PATH` entries, so Pi sees what a terminal sees. Variables VS Code already has are left as they are. If the shell fails or takes longer than 10 s, Pi starts with VS Code's environment and the reason is logged to the **Pi Agent Manager** output channel.
2. **Missing-variable check.** The extension reads Pi's `models.json` and `mcp.json` (user and project). If a variable they reference is still unset, it names the variable and offers **Set Secret…**, instead of leaving you with an authentication error from the gateway.
3. **Secrets in VS Code.** **Pi Agent Manager: Set Environment Secret…** stores a value in VS Code's encrypted secret storage and passes it only to Pi. Use it for keys you don't export from your shell. **Remove Environment Secret…** deletes one.

Other commands: **Reload Environment and Restart Pi** (after you edit your shell files) and **Show Environment Diagnostics**, which lists each variable Pi's config needs and where it comes from. Values are never shown or logged.

## Features

- **Chat in the Secondary Side Bar.** Click the π icon in an editor title bar, or run **Pi Agent Manager: Open**.
- **Streaming transcript.** Markdown with syntax highlighting, collapsible thinking, and a status dot per step.
- **Tool cards** for `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` and custom tools:
  - one-line summaries (`⎿ Read 120 lines`),
  - inline diffs for edits and writes,
  - command output,
  - click a path to open the file.
- **Extension dialogs.** Pi extension `confirm`, `select`, `input` and `editor` prompts appear as inline cards. Notifications appear as notices.
- **Composer:**
  - <kbd>Enter</kbd> sends and <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a new line.
  - <kbd>Esc</kbd> interrupts Pi while it works.
  - Messages sent while Pi works are queued as follow-ups. <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> steers immediately instead.
  - <kbd>↑</kbd> recalls earlier prompts.
- **`/` menu.** Pi's prompt templates, skills and extension commands, plus `/new`, `/compact`, `/model`, `/rename` and `/history`.
- **`@` mentions.** Fuzzy workspace file search.
- **Images.** Paste or drop screenshots, or attach files with <kbd>+</kbd>.
- **Model pill.** Switch model and thinking level, with a context-usage ring showing tokens and cost.
- **Past chats.** A searchable list grouped by Today, Yesterday, Last 7 Days and so on. Resume or delete chats, and rename the current one from the header.
- **Add selection.** Select code and press <kbd>⌘L</kbd> / <kbd>Ctrl+L</kbd> to insert a fenced snippet with its path and lines.
- **Themes.** Light, dark and high-contrast, with Pi's palette for accents, status, diffs and syntax colors.

| Model & thinking picker | Extension confirm dialog |
|---|---|
| <img src="docs/images/model-picker-dark.png" width="320" alt="Model picker" /> | <img src="docs/images/dialog-dark.png" width="320" alt="Dialog card" /> |

## Finding the pi executable

If VS Code can't find `pi`, the view offers **Choose Executable…**. You can also set `piAgentManager.command` to an absolute path.

Pi is looked up in this order:

1. The `piAgentManager.command` setting.
2. `PATH`.
3. npm's global bin directory.
4. Homebrew and `/usr/local/bin`.

The executable's directory is added to the child process `PATH`, so nvm-managed Node installs work when VS Code is launched from the Dock.

## Settings

| Setting | Default | Description |
|---|---|---|
| `piAgentManager.command` | `pi` | Executable name or absolute path of the Pi CLI. |
| `piAgentManager.extraArgs` | `[]` | Extra arguments for `pi --mode rpc`, such as `["--provider", "anthropic"]` or `["--offline"]`. Mode and session flags are managed by the extension. |
| `piAgentManager.loadShellEnvironment` | `true` | Add the variables your login shell sets up (API keys, gateway settings, `PATH`) to Pi's environment. Not used on Windows. |
| `piAgentManager.environment` | `{}` | Extra variables for Pi, such as a gateway base URL. Put keys in **Set Environment Secret…** instead. |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| <kbd>⌘L</kbd> / <kbd>Ctrl+L</kbd> | Add the editor selection (or current line) to the chat |
| <kbd>⌘Esc</kbd> / <kbd>Ctrl+Esc</kbd> | Focus the chat input |
| <kbd>⌘N</kbd> / <kbd>Ctrl+N</kbd> (in the chat) | New chat |
| <kbd>Esc</kbd> (while working) | Interrupt Pi |

<kbd>⌘L</kbd> / <kbd>Ctrl+L</kbd> replaces VS Code's built-in **Expand Line Selection** while an editor has focus, as other chat extensions do. To keep the built-in shortcut, rebind **Pi Agent Manager: Add Selection to Chat** in **Keyboard Shortcuts**.

## Notes

- Chats are scoped to the workspace folder of the active editor, or the first folder in a multi-root window.
- Pi's [project trust](https://github.com/earendil-works/pi) applies as in the CLI. RPC mode cannot show the trust prompt, so trust a project once with `/trust` in the terminal, or pass `--approve` through `piAgentManager.extraArgs`.
- Built-in TUI-only commands (for example `/settings`) are not available over RPC.

## Privacy

Pi Agent Manager collects no telemetry and makes no network requests of its own. Your prompts, files and images go only to your local `pi` process, which sends them to whichever model provider you configured in Pi.

## Development

```sh
npm install
npm run check          # TypeScript + ESLint
npm test               # unit + React component tests (Vitest, jsdom)
npm run test:coverage  # same, with V8 coverage thresholds
npm run test:e2e       # real Pi CLI (devDependency) against a mock LLM
npm run test:ui        # build, then drive the webview in Chromium (Playwright)
npm run package        # check, test, build, then a verified universal .vsix
```

The end-to-end suites need no API key. They point a custom OpenAI-compatible `mock` provider (in a temporary `~/.pi/agent/models.json`) at a local scripted server. That server streams thinking, `read` → `edit` → `bash` tool calls and Markdown. A test extension asks for confirmation before `bash`. Playwright saves light and dark screenshots to `test-results/screenshots/`.

**CI** (`.github/workflows/ci.yml`):
- typecheck and lint
- unit tests on Ubuntu, macOS and Windows (Node 22, plus Node 24 on Ubuntu)
- coverage with thresholds
- the real-Pi and Playwright suites
- a packaged `.vsix` artifact

Pushing a `vX.Y.Z` tag that matches `package.json` publishes the VSIX to the VS Code Marketplace and Open VSX and creates a GitHub Release with its CHANGELOG notes. See [docs/PUBLISHING.md](docs/PUBLISHING.md). Dependabot keeps npm packages and actions current.

See [docs/architecture.md](docs/architecture.md) for how the extension talks to Pi.

## Disclaimer and acknowledgements

- Pi Agent Manager is an independent, unofficial client for the [Pi coding agent](https://github.com/earendil-works/pi). It is not affiliated with, endorsed by or sponsored by the Pi project or its authors. "Pi" refers to that third-party project.
- The extension does not include or redistribute any Pi code. It starts the `pi` executable you installed yourself, so Pi's own license and terms apply to it.
- The color palette is adapted from Pi's MIT-licensed themes (Copyright (c) Mario Zechner). Bundled third-party packages and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The π icon and mascot are original artwork for this extension.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
