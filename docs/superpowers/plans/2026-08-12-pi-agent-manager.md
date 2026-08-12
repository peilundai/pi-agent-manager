# Pi Agent Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and package a polished VS Code Secondary Side Bar extension that manages real Pi TUI sessions, matches the supplied Cursor Agent Manager shell, and inserts editor selections into Pi with `Cmd/Ctrl+L`.

**Architecture:** A VS Code extension host owns workspace-scoped Pi discovery, JSONL session metadata, authenticated status events, PTY processes, and editor commands. A React webview renders the session manager and preserves one xterm.js terminal per attached session; shared discriminated unions form the only host/webview contract.

**Tech Stack:** TypeScript 5.9, VS Code Extension API 1.106+, React 19, xterm.js 6 beta, node-pty 1.1, esbuild, Vitest, Testing Library, ESLint, and `@vscode/vsce`.

## Global Constraints

- Package identifier: `peilun-dai.pi-agent-manager`; display name: `Pi Agent Manager`; command/configuration prefix: `piAgent`.
- Preserve Pi's interactive TUI. Do not replace it with an RPC-rendered chat interface.
- Target VS Code `^1.106.0`, Node 22 type definitions, macOS, Linux, and Windows command construction.
- Run Pi with the workspace folder as `cwd`; scope history and persisted view state to that workspace.
- Title precedence is explicit `session_info.name`, then local first-prompt title, then `New Agent`; never make a hidden model call.
- Archive state is extension metadata keyed by Pi session ID; never move or rewrite Pi transcripts for archive/restore.
- Closing a tab detaches it; stopping or deleting is explicit. Deletion always confirms first.
- `Cmd+L` on macOS and `Ctrl+L` elsewhere inserts selected code as bracketed paste and never submits it.
- Validate every webview message and status report at runtime, use a nonce CSP, and bound input/output payloads.
- Use VS Code theme variables and Codicons; support keyboard navigation, reduced motion, light/dark/high-contrast themes, and narrow layouts.
- Commit subjects use `[PIEXT-1] <type>: <subject> [ai:y]`.

---

## File Map

### Extension host and shared domain

- `package.json` — extension manifest, commands, keybindings, dependencies, and scripts.
- `tsconfig.json` — strict shared TypeScript configuration.
- `vitest.config.ts` — jsdom test environment and VS Code module alias.
- `eslint.config.mjs` — TypeScript/React lint rules.
- `scripts/build.mjs` — deterministic extension, webview, CSS, and Pi-status bundles.
- `src/extension.ts` — activation and command registration only.
- `src/shared/model.ts` — session, tab, status, selection, and presentation types.
- `src/shared/protocol.ts` — versioned host/webview messages and runtime guards.
- `src/pi/command-resolver.ts` — executable discovery and platform invocation.
- `src/pi/session-title.ts` — deterministic local title generation.
- `src/pi/session-parser.ts` — tolerant JSONL metadata parsing.
- `src/pi/session-repository.ts` — discovery, watching, archive metadata, and deletion.
- `src/pi/session-groups.ts` — date grouping and search.
- `src/pi/status-report.ts` — status report schema and monotonic acceptance.
- `src/pi/status-bridge.ts` — authenticated loopback JSONL server.
- `src/pi/pty-adapter.ts` — node-pty boundary.
- `src/pi/session-controller.ts` — live process and attachment lifecycle.
- `src/editor/selection.ts` — editor-context formatting and bracketed paste.
- `src/terminal/links.ts` — URL and workspace file-location parsing.
- `src/view/view-state.ts` — persisted-state normalization.
- `src/view/pi-view-provider.ts` — orchestration and webview message handling.
- `resources/pi-status.ts` — Pi extension that reports session lifecycle/name state.

### Webview

- `src/webview/index.html` — mount point used by the production build.
- `src/webview/main.tsx` — React bootstrap and VS Code API acquisition.
- `src/webview/App.tsx` — top-level layout.
- `src/webview/state.ts` — reducer and selectors.
- `src/webview/vscode.ts` — typed outbound messaging wrapper.
- `src/webview/components/ManagerHeader.tsx` — title and global controls.
- `src/webview/components/SessionTabs.tsx` — horizontal open-session tabs.
- `src/webview/components/SessionPane.tsx` — search, New Agent, groups, and responsive overlay.
- `src/webview/components/SessionRow.tsx` — status, title, metadata, and actions.
- `src/webview/components/TerminalWorkspace.tsx` — xterm instance ownership and active terminal.
- `src/webview/components/ConfirmDialog.tsx` — accessible destructive confirmation.
- `src/webview/styles.css` — screenshot-matched VS Code-native visual system.

### Tests and delivery

- `test/protocol.test.ts`
- `test/session-title.test.ts`
- `test/session-parser.test.ts`
- `test/session-groups.test.ts`
- `test/command-resolver.test.ts`
- `test/status-report.test.ts`
- `test/status-bridge.test.ts`
- `test/session-controller.test.ts`
- `test/selection.test.ts`
- `test/terminal-links.test.ts`
- `test/view-state.test.ts`
- `test/webview-state.test.ts`
- `test/webview-components.test.tsx`
- `test/pi-view-provider.test.ts`
- `test/setup.ts`
- `test/vscode-mock.ts`
- `README.md`, `CHANGELOG.md`, `LICENSE`, `media/pi.svg`, `.vscodeignore`, `.gitignore` — user-facing and package assets.

---

### Task 1: Project foundation and typed protocol

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `scripts/build.mjs`
- Create: `src/shared/model.ts`
- Create: `src/shared/protocol.ts`
- Create: `test/setup.ts`
- Create: `test/vscode-mock.ts`
- Create: `test/protocol.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: `SessionStatus`, `SessionSummary`, `TerminalTab`, `ViewSnapshot`, `HostToWebviewMessage`, `WebviewToHostMessage`, `isHostMessage()`, and `isWebviewMessage()`.
- Consumes: no project interfaces.

- [ ] **Step 1: Create the package/test/build foundation and a failing protocol test**

Create `package.json` with these exact scripts and contributions; keep `node-pty` external in the build so its native binary remains in the VSIX:

```json
{
  "name": "pi-agent-manager",
  "displayName": "Pi Agent Manager",
  "description": "Run and manage Pi coding-agent sessions in VS Code's Secondary Side Bar.",
  "version": "0.1.0",
  "publisher": "peilun-dai",
  "license": "MIT",
  "engines": { "vscode": "^1.106.0" },
  "categories": ["AI", "Other"],
  "extensionKind": ["workspace"],
  "activationEvents": ["onView:piAgent.view", "onCommand:piAgent.open"],
  "main": "./dist/extension.js",
  "scripts": {
    "build": "node scripts/build.mjs",
    "check": "tsc --noEmit && eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "package": "npm run check && npm test && npm run build && vsce package"
  },
  "dependencies": {
    "@xterm/addon-fit": "0.12.0-beta.292",
    "@xterm/addon-search": "0.17.0-beta.292",
    "@xterm/addon-unicode11": "0.10.0-beta.292",
    "@xterm/addon-web-links": "0.13.0-beta.292",
    "@xterm/addon-webgl": "0.20.0-beta.291",
    "@xterm/xterm": "6.1.0-beta.292",
    "node-pty": "1.1.0",
    "react": "^19.1.1",
    "react-dom": "^19.1.1"
  },
  "devDependencies": {
    "@eslint/js": "^9.33.0",
    "@testing-library/jest-dom": "^6.6.4",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^22.17.2",
    "@types/react": "^19.1.10",
    "@types/react-dom": "^19.1.7",
    "@types/vscode": "^1.106.0",
    "@typescript-eslint/eslint-plugin": "^8.39.1",
    "@typescript-eslint/parser": "^8.39.1",
    "@vscode/vsce": "^3.6.0",
    "esbuild": "^0.25.9",
    "eslint": "^9.33.0",
    "eslint-plugin-react-hooks": "^5.2.0",
    "globals": "^16.3.0",
    "jsdom": "^26.1.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

Use this strict TypeScript configuration:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vscode", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "resources/**/*.ts", "test/**/*.ts", "test/**/*.tsx", "vitest.config.ts"]
}
```

Configure Vitest exactly as follows; `test/vscode-mock.ts` initially exports an empty object and grows only when a provider test needs a concrete API:

```ts
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL("./test/vscode-mock.ts", import.meta.url)) } },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
```

Use this flat ESLint configuration:

```js
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json", ecmaVersion: 2022, sourceType: "module" },
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { "@typescript-eslint": tsPlugin, "react-hooks": reactHooks },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "no-undef": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];
```

`test/setup.ts` imports `@testing-library/jest-dom/vitest`, installs deterministic `matchMedia` and `ResizeObserver` fakes, and calls Testing Library `cleanup()` after each test.

Create `scripts/build.mjs` with three explicit esbuild targets and deterministic asset copying:

```js
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/resources", { recursive: true });

await Promise.all([
  build({ entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode", "node-pty"], sourcemap: true }),
  build({ entryPoints: ["src/webview/main.tsx"], outfile: "dist/webview.js", bundle: true, platform: "browser", format: "iife", target: "es2022", jsx: "automatic", sourcemap: true }),
  build({ entryPoints: ["resources/pi-status.ts"], outfile: "dist/resources/pi-status.mjs", bundle: true, platform: "node", format: "esm", target: "node20", sourcemap: true }),
]);

const [xtermCss, managerCss] = await Promise.all([
  readFile("node_modules/@xterm/xterm/css/xterm.css", "utf8"),
  readFile("src/webview/styles.css", "utf8"),
]);
await Promise.all([
  writeFile("dist/webview.css", `${xtermCss}\n${managerCss}`, "utf8"),
  copyFile("src/webview/index.html", "dist/index.html"),
]);
```

During Task 1, create minimal compile-safe `src/extension.ts`, `src/webview/main.tsx`, `src/webview/styles.css`, `src/webview/index.html`, and `resources/pi-status.ts` entrypoints that contain no product behavior; later tasks replace each entrypoint through failing tests. This is build plumbing, not an alternate implementation.

Write this first test before `src/shared/protocol.ts` exists:

```ts
import { describe, expect, it } from "vitest";
import { isWebviewMessage } from "../src/shared/protocol";

describe("isWebviewMessage", () => {
  it("accepts a bounded terminal input message", () => {
    expect(isWebviewMessage({ version: 1, type: "terminal.input", tabId: "tab-1", data: "hello" })).toBe(true);
  });

  it("rejects unknown versions and oversized input", () => {
    expect(isWebviewMessage({ version: 2, type: "ready" })).toBe(false);
    expect(isWebviewMessage({ version: 1, type: "terminal.input", tabId: "tab-1", data: "x".repeat(1_048_577) })).toBe(false);
  });
});
```

- [ ] **Step 2: Install dependencies and verify the test fails for the missing module**

Run: `npm install`

Run: `npm test -- --run test/protocol.test.ts`

Expected: FAIL because `../src/shared/protocol` does not exist.

- [ ] **Step 3: Implement the shared model and guarded message union**

Define the stable domain types in `src/shared/model.ts`:

```ts
export type SessionStatus = "starting" | "working" | "waiting" | "stopped" | "failed";

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  status: SessionStatus;
}

export interface TerminalTab {
  tabId: string;
  sessionId?: string;
  sessionPath?: string;
  title: string;
  status: SessionStatus;
  attached: boolean;
}

export interface ViewSnapshot {
  sessions: SessionSummary[];
  tabs: TerminalTab[];
  activeTabId?: string;
  paneVisible: boolean;
  paneWidth: number;
  collapsedGroups: string[];
}
```

In `src/shared/protocol.ts`, define versioned discriminated unions. Implement guards with `isRecord`, `isString`, `isBoolean`, `isFiniteInteger`, and `hasOnlyProtocolVersion`. Enforce input at 1 MiB, output chunks at 256 KiB, dimensions `1..1000`, pane widths `180..480`, and non-empty IDs no longer than 200 characters.

```ts
export type WebviewToHostMessage =
  | { version: 1; type: "ready" }
  | { version: 1; type: "session.new" }
  | { version: 1; type: "session.focus"; tabId: string }
  | { version: 1; type: "session.detach"; tabId: string }
  | { version: 1; type: "session.stop"; tabId: string }
  | { version: 1; type: "session.resume"; sessionId: string }
  | { version: 1; type: "session.archive"; sessionId: string; archived: boolean }
  | { version: 1; type: "session.delete"; sessionId: string }
  | { version: 1; type: "session.rename"; sessionId: string }
  | { version: 1; type: "history.refresh" }
  | { version: 1; type: "link.open"; kind: "file" | "url"; target: string }
  | { version: 1; type: "terminal.input"; tabId: string; data: string }
  | { version: 1; type: "terminal.resize"; tabId: string; cols: number; rows: number }
  | { version: 1; type: "view.update"; paneVisible: boolean; paneWidth: number; collapsedGroups: string[] };

export type HostToWebviewMessage =
  | { version: 1; type: "state.replace"; snapshot: ViewSnapshot }
  | { version: 1; type: "terminal.output"; tabId: string; data: string }
  | { version: 1; type: "terminal.focus"; tabId: string }
  | { version: 1; type: "notice"; level: "info" | "warning" | "error"; message: string };
```

- [ ] **Step 4: Run the focused and complete foundation checks**

Run: `npm test -- --run test/protocol.test.ts`

Expected: PASS with 2 tests.

Run: `npm run check`

Expected: PASS with zero TypeScript or ESLint errors.

- [ ] **Step 5: Commit the foundation**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.mjs scripts/build.mjs src/shared src/extension.ts src/webview/main.tsx src/webview/styles.css src/webview/index.html resources/pi-status.ts test/setup.ts test/vscode-mock.ts test/protocol.test.ts .gitignore
git commit -m "[PIEXT-1] chore: scaffold extension core [ai:y]"
```

---

### Task 2: Session metadata, titles, grouping, and repository

**Files:**
- Create: `src/pi/session-title.ts`
- Create: `src/pi/session-parser.ts`
- Create: `src/pi/session-groups.ts`
- Create: `src/pi/session-repository.ts`
- Create: `test/session-title.test.ts`
- Create: `test/session-parser.test.ts`
- Create: `test/session-groups.test.ts`

**Interfaces:**
- Produces: `generateSessionTitle(prompt, maxLength?)`, `parseSessionLines(lines, path, stat)`, `listWorkspaceSessions(cwd, options)`, `groupSessions(sessions, now)`, and `filterSessions(sessions, query)`.
- Consumes: `SessionSummary` and `SessionStatus` from `src/shared/model.ts`.

- [ ] **Step 1: Write failing title/parser/grouping tests**

Cover explicit-name precedence, first-prompt fallback, selected-code stripping, corrupt-tail tolerance, workspace mismatch, and exact date buckets:

```ts
it("uses the latest explicit name and tolerates a partial trailing line", () => {
  const parsed = parseSessionLines([
    JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: "/repo", timestamp: "2026-08-12T01:00:00.000Z" }),
    JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "2026-08-12T01:00:01.000Z", message: { role: "user", content: "Refactor the auth middleware", timestamp: 1 } }),
    JSON.stringify({ type: "session_info", id: "b", parentId: "a", timestamp: "2026-08-12T01:00:02.000Z", name: "Auth middleware cleanup" }),
    "{partial"
  ], "/sessions/session-1.jsonl", { mtimeMs: 20, birthtimeMs: 10 });

  expect(parsed?.title).toBe("Auth middleware cleanup");
  expect(parsed?.id).toBe("session-1");
});

it("removes injected code before generating a fallback title", () => {
  expect(generateSessionTitle("From src/auth.ts lines 8-12:\n```ts\nconst secret = true;\n```\nPlease fix the token refresh race."))
    .toBe("Fix the token refresh race");
});
```

- [ ] **Step 2: Run the tests to verify missing implementations**

Run: `npm test -- --run test/session-title.test.ts test/session-parser.test.ts test/session-groups.test.ts`

Expected: FAIL because the three domain modules do not exist.

- [ ] **Step 3: Implement deterministic parsing and discovery**

Implement `generateSessionTitle()` as a pure function: remove `From <path> lines <range>:` headers, fenced blocks, leading request filler (`please`, `can you`, `could you`), collapse whitespace, use the first sentence, capitalize the first remaining character, and truncate at a word boundary with `…` at 52 characters by default.

Define the parser result and keep the line parser tolerant:

```ts
export interface ParsedSession {
  id: string;
  path: string;
  cwd: string;
  title: string;
  explicitTitle?: string;
  generatedTitle?: string;
  createdAt: number;
  updatedAt: number;
}

export function parseSessionLines(
  lines: Iterable<string>,
  path: string,
  stat: { mtimeMs: number; birthtimeMs: number }
): ParsedSession | undefined;
```

Only accept a first valid `{type:"session", id, cwd}` header. Scan all later valid lines for the latest normalized `session_info.name` and the first `message.role === "user"` text. Use explicit title, generated title, then `New Agent`.

`SessionRepository` receives filesystem and archive-state adapters, searches both current `sessions/--cwd--/` and legacy `session/--cwd--/`, caps concurrent reads at 8, caches by path/mtime/size, compares real paths case-insensitively only on Windows, and exposes:

```ts
export interface SessionRepository {
  list(cwd: string): Promise<SessionSummary[]>;
  watch(cwd: string, onChange: () => void): { dispose(): void };
  setArchived(sessionId: string, archived: boolean): Promise<void>;
  delete(session: SessionSummary): Promise<void>;
}
```

Deletion rejects non-`.jsonl` paths, unlinks the transcript, and recursively removes only the exact same-basename sidecar directory.

- [ ] **Step 4: Run focused tests and quality checks**

Run: `npm test -- --run test/session-title.test.ts test/session-parser.test.ts test/session-groups.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit session metadata**

```bash
git add src/pi/session-title.ts src/pi/session-parser.ts src/pi/session-groups.ts src/pi/session-repository.ts test/session-title.test.ts test/session-parser.test.ts test/session-groups.test.ts
git commit -m "[PIEXT-1] feat: add session history model [ai:y]"
```

---

### Task 3: Pi executable resolution and invocation

**Files:**
- Create: `src/pi/command-resolver.ts`
- Create: `test/command-resolver.test.ts`

**Interfaces:**
- Produces: `resolvePiCommand(options): Promise<ResolvedPiCommand>` and `buildPiInvocation(command, piArgs, platform): PiInvocation`.
- Consumes: Node process environment and injected `access`/`execFile` probes.

- [ ] **Step 1: Write failing cross-platform resolver tests**

```ts
it("wraps a Windows npm cmd shim without shell interpolation", () => {
  expect(buildPiInvocation("C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd", ["--session", "C:\\work\\a b.jsonl"], "win32")).toEqual({
    file: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "\"\"C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd\" --session \"C:\\work\\a b.jsonl\"\""],
  });
});

it("prefers an explicit executable after validating it", async () => {
  const resolved = await resolvePiCommand({
    configured: "/custom/pi",
    env: { PATH: "/bin" },
    platform: "darwin",
    access: async path => path === "/custom/pi",
    npmRoot: async () => undefined,
  });
  expect(resolved.path).toBe("/custom/pi");
  expect(resolved.source).toBe("configured");
});
```

- [ ] **Step 2: Verify the resolver tests fail**

Run: `npm test -- --run test/command-resolver.test.ts`

Expected: FAIL because `command-resolver.ts` does not exist.

- [ ] **Step 3: Implement safe discovery and argument construction**

Use the configured value only as an executable path, never a command line. Search explicit absolute paths, every `PATH` directory (`pi` and `pi.cmd`), npm's global bin/root, and common `/opt/homebrew/bin`, `/usr/local/bin`, and `%APPDATA%\\npm` locations. Return detection attempts for the error UI.

```ts
export interface ResolvedPiCommand {
  path: string;
  source: "configured" | "path" | "npm" | "common";
  attempts: string[];
}

export interface PiInvocation { file: string; args: string[] }

export function buildPiArgs(statusExtensionPath: string, sessionPath?: string): string[] {
  const args = ["--extension", statusExtensionPath];
  if (sessionPath) args.push("--session", sessionPath);
  return args;
}
```

Escape Windows `cmd.exe` arguments by doubling embedded quotes and rejecting CR, LF, NUL, `&`, `|`, `<`, `>`, and `^` in executable paths. POSIX invocations pass argument arrays directly.

- [ ] **Step 4: Run resolver tests and checks**

Run: `npm test -- --run test/command-resolver.test.ts`

Expected: PASS on POSIX and simulated Windows cases.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit command resolution**

```bash
git add src/pi/command-resolver.ts test/command-resolver.test.ts
git commit -m "[PIEXT-1] feat: resolve pi executable [ai:y]"
```

---

### Task 4: Authenticated Pi status bridge

**Files:**
- Create: `src/pi/status-report.ts`
- Create: `src/pi/status-bridge.ts`
- Create: `resources/pi-status.ts`
- Create: `test/status-report.test.ts`
- Create: `test/status-bridge.test.ts`

**Interfaces:**
- Produces: `StatusReport`, `StatusReportGate.accept(value)`, and `PiStatusBridge.start()/environmentFor(tabId)/dispose()`.
- Consumes: Pi extension events `session_start`, `session_info_changed`, `agent_start`, `agent_settled`, and `session_shutdown`.

- [ ] **Step 1: Write failing validation and socket tests**

Test authentication, loopback binding, malformed JSON, line-size limits, stale sequence rejection, and current session metadata:

```ts
it("rejects stale status reports per tab", () => {
  const gate = new StatusReportGate("secret");
  const newer = { version: 1, token: "secret", tabId: "tab-1", sequence: 2, status: "waiting", timestamp: 20 } as const;
  const older = { version: 1, token: "secret", tabId: "tab-1", sequence: 1, status: "working", timestamp: 10 } as const;
  expect(gate.accept(newer)).toEqual(newer);
  expect(gate.accept(older)).toBeUndefined();
});
```

- [ ] **Step 2: Verify the status tests fail**

Run: `npm test -- --run test/status-report.test.ts test/status-bridge.test.ts`

Expected: FAIL because status modules do not exist.

- [ ] **Step 3: Implement the bridge and bundled Pi reporter**

Define reports as:

```ts
export interface StatusReport {
  version: 1;
  token: string;
  tabId: string;
  sequence: number;
  status: "starting" | "working" | "waiting" | "stopped" | "failed";
  timestamp: number;
  sessionId?: string;
  sessionPath?: string;
  name?: string;
}
```

`PiStatusBridge.start()` binds `node:net` to `127.0.0.1` with port `0`, generates a 32-byte random token, accepts LF-delimited JSON up to 64 KiB per line, verifies loopback peers, validates reports, and invokes `onReport`. `environmentFor(tabId)` returns `PI_VSCODE_STATUS_HOST`, `PI_VSCODE_STATUS_PORT`, `PI_VSCODE_STATUS_TOKEN`, and `PI_VSCODE_TAB_ID` only after start.

The bundled Pi extension reads those variables and uses `node:net.createConnection`. It increments a local sequence and sends reports with current `ctx.sessionManager.getSessionId()`, `getSessionFile()`, and `getSessionName()`. Event mapping is exact:

```ts
pi.on("session_start", async (_event, ctx) => send("waiting", ctx));
pi.on("session_info_changed", async (event, ctx) => send(ctx.isIdle() ? "waiting" : "working", ctx, event.name));
pi.on("agent_start", async (_event, ctx) => send("working", ctx));
pi.on("agent_settled", async (_event, ctx) => send("waiting", ctx));
pi.on("session_shutdown", async (_event, ctx) => send("stopped", ctx));
```

Connection failure is swallowed by the reporter so Pi remains usable without the manager bridge.

- [ ] **Step 4: Build the resource and run status tests**

Run: `npm test -- --run test/status-report.test.ts test/status-bridge.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: `dist/resources/pi-status.mjs` exists and contains no unresolved TypeScript import.

- [ ] **Step 5: Commit live status support**

```bash
git add src/pi/status-report.ts src/pi/status-bridge.ts resources/pi-status.ts test/status-report.test.ts test/status-bridge.test.ts scripts/build.mjs
git commit -m "[PIEXT-1] feat: bridge live pi status [ai:y]"
```

---

### Task 5: PTY-backed session lifecycle

**Files:**
- Create: `src/pi/pty-adapter.ts`
- Create: `src/pi/session-controller.ts`
- Create: `test/session-controller.test.ts`

**Interfaces:**
- Produces: `PtyAdapter`, `SessionController.start()`, `input()`, `resize()`, `detach()`, `stop()`, `rename()`, `snapshot()`, and lifecycle events.
- Consumes: `PiInvocation`, bridge environment, `TerminalTab`, and injected clock/UUID factories.

- [ ] **Step 1: Write failing fake-PTY lifecycle tests**

```ts
it("detaches without killing and explicitly stops the process", async () => {
  const fake = new FakePtyAdapter();
  const controller = createController(fake);
  const tab = await controller.start({ cwd: "/repo" });

  controller.detach(tab.tabId);
  expect(fake.processes[0]?.killed).toBe(false);
  expect(controller.snapshot().find(item => item.tabId === tab.tabId)?.attached).toBe(false);

  await controller.stop(tab.tabId);
  expect(fake.processes[0]?.killed).toBe(true);
  expect(controller.snapshot().find(item => item.tabId === tab.tabId)?.status).toBe("stopped");
});

it("does not write input larger than one MiB", async () => {
  const fake = new FakePtyAdapter();
  const controller = createController(fake);
  const tab = await controller.start({ cwd: "/repo" });
  expect(() => controller.input(tab.tabId, "x".repeat(1_048_577))).toThrow(/too large/i);
});
```

- [ ] **Step 2: Verify lifecycle tests fail**

Run: `npm test -- --run test/session-controller.test.ts`

Expected: FAIL because PTY modules do not exist.

- [ ] **Step 3: Implement the node-pty adapter and controller**

Use an adapter so tests never load native `node-pty`:

```ts
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface PtyAdapter {
  spawn(file: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number }): PtyProcess;
}
```

`SessionController` stores running processes separately from attached tabs, emits bounded output chunks, persists up to 2 MiB of per-process replay output for webview reloads, constrains size to `1..1000`, and maps exit code `0` to stopped and non-zero to failed. Starting an already-running session reattaches its existing process. Resuming a stopped transcript launches `pi --session <path>`.

Rename accepts a normalized 1–80 character name only when waiting, writes bracketed paste for `/name <name>`, then writes `\r` as an explicit manager action.

- [ ] **Step 4: Run lifecycle tests and check native externalization**

Run: `npm test -- --run test/session-controller.test.ts`

Expected: PASS.

Run: `npm run build && rg -n "require\(\"node-pty\"\)" dist/extension.js`

Expected: one external `node-pty` require and no bundled native code.

- [ ] **Step 5: Commit PTY lifecycle**

```bash
git add src/pi/pty-adapter.ts src/pi/session-controller.ts test/session-controller.test.ts
git commit -m "[PIEXT-1] feat: manage pi terminal sessions [ai:y]"
```

---

### Task 6: Editor selection and terminal links

**Files:**
- Create: `src/editor/selection.ts`
- Create: `src/terminal/links.ts`
- Create: `test/selection.test.ts`
- Create: `test/terminal-links.test.ts`

**Interfaces:**
- Produces: `formatEditorSelection(context)`, `asBracketedPaste(text)`, `parseTerminalTarget(text, cwd)`, and `resolveFileTarget(target, cwd)`.
- Consumes: workspace-relative document metadata and `SessionController.input()`.

- [ ] **Step 1: Write failing selection and link tests**

```ts
it("formats selected code with a one-based range and does not submit", () => {
  const text = formatEditorSelection({
    relativePath: "src/auth.ts",
    languageId: "typescript",
    startLine: 7,
    endLine: 11,
    text: "export function refresh() {}",
  });
  expect(text).toBe("From `src/auth.ts` lines 8-12:\n\n```typescript\nexport function refresh() {}\n```\n\n");
  expect(asBracketedPaste(text)).toBe(`\u001b[200~${text}\u001b[201~`);
  expect(asBracketedPaste(text)).not.toContain("\r");
});

it("resolves a workspace-relative source location", () => {
  expect(resolveFileTarget("src/auth.ts:12:4", "/repo")).toEqual({ path: "/repo/src/auth.ts", line: 11, column: 3 });
});
```

- [ ] **Step 2: Verify selection/link tests fail**

Run: `npm test -- --run test/selection.test.ts test/terminal-links.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement bounded formatting and safe target parsing**

Reject selection text over 512 KiB, NUL bytes, and document schemes other than `file`, `untitled`, and `vscode-remote`. Escape a fence by choosing a delimiter one backtick longer than the longest source run, with a minimum of three.

For an empty selection, the command layer supplies the full current line. Normalize CRLF to LF but preserve all other source text. `asBracketedPaste()` strips no content and adds no newline or Enter.

Accept HTTP(S) URLs and file targets in these forms: `path`, `path:line`, `path:line:column`, and `path#Lline`. Resolve relative paths below `cwd`, preserve absolute paths, convert user coordinates to zero-based values, and reject NUL/control characters. Do not require the target to exist in the pure parser; the provider verifies it before opening.

- [ ] **Step 4: Run focused tests and checks**

Run: `npm test -- --run test/selection.test.ts test/terminal-links.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit editor and link behavior**

```bash
git add src/editor/selection.ts src/terminal/links.ts test/selection.test.ts test/terminal-links.test.ts
git commit -m "[PIEXT-1] feat: add editor context command [ai:y]"
```

---

### Task 7: Webview state and Cursor-style manager shell

**Files:**
- Create: `src/webview/index.html`
- Create: `src/webview/main.tsx`
- Create: `src/webview/App.tsx`
- Create: `src/webview/state.ts`
- Create: `src/webview/vscode.ts`
- Create: `src/webview/components/ManagerHeader.tsx`
- Create: `src/webview/components/SessionTabs.tsx`
- Create: `src/webview/components/SessionPane.tsx`
- Create: `src/webview/components/SessionRow.tsx`
- Create: `src/webview/components/ConfirmDialog.tsx`
- Create: `src/webview/styles.css`
- Create: `test/webview-state.test.ts`
- Create: `test/webview-components.test.tsx`

**Interfaces:**
- Produces: `webviewReducer`, `WebviewState`, accessible manager components, and outbound typed actions.
- Consumes: `ViewSnapshot`, `HostToWebviewMessage`, `groupSessions()`, and `filterSessions()`.

- [ ] **Step 1: Write failing reducer and component interaction tests**

```tsx
it("filters sessions and keeps New Agent available", async () => {
  const user = userEvent.setup();
  render(<App initialState={stateWithSessions([authSession, metricsSession])} transport={transport} />);
  await user.type(screen.getByRole("searchbox", { name: /search agents/i }), "auth");
  expect(screen.getByText("Auth middleware cleanup")).toBeVisible();
  expect(screen.queryByText("Metrics query fix")).toBeNull();
  expect(screen.getByRole("button", { name: /new agent/i })).toBeVisible();
});

it("asks before deleting a session", async () => {
  const user = userEvent.setup();
  render(<App initialState={stateWithSessions([authSession])} transport={transport} />);
  await user.click(screen.getByRole("button", { name: /more actions for auth middleware cleanup/i }));
  await user.click(screen.getByRole("menuitem", { name: /delete/i }));
  expect(screen.getByRole("dialog", { name: /delete agent/i })).toBeVisible();
  expect(transport.messages).not.toContainEqual(expect.objectContaining({ type: "session.delete" }));
});
```

- [ ] **Step 2: Verify state/component tests fail**

Run: `npm test -- --run test/webview-state.test.ts test/webview-components.test.tsx`

Expected: FAIL because webview modules do not exist.

- [ ] **Step 3: Implement the reducer, manager components, and visual system**

`WebviewState` contains the latest snapshot, search query, open menu session ID, confirm-delete session ID, narrow-overlay state, and transient notice. Host messages are reduced idempotently; search and dialog state remain local.

Render wide layout as `minmax(0,1fr) var(--session-pane-width)` with a draggable separator. Use 36 px manager header, 34 px tabs, 32 px search field, 34 px New Agent row, 36 px primary session row plus optional 18 px subtitle, 8 px outer padding, 6 px row radius, and 1 px VS Code-token borders. The selected row uses `--vscode-list-activeSelectionBackground`; hover and focus use their matching list tokens.

Use semantic `tablist`/`tab`, named toolbar buttons, `role=list` for each group, `role=menu`, and a modal dialog that restores focus. Arrow keys move between visible session rows; Enter resumes/focuses; Delete opens confirmation; Escape closes menus/overlay. Status icons have accessible labels and use a reduced-motion-safe spinner only for working/starting.

CSS breakpoints:

```css
.manager-layout { grid-template-columns: minmax(0, 1fr) var(--session-pane-width, 248px); }
@media (max-width: 680px) {
  .session-pane { position: absolute; inset: 70px 8px 8px auto; width: min(300px, calc(100% - 16px)); z-index: 20; }
  .session-pane[data-visible="false"] { display: none; }
}
@media (max-width: 420px) {
  .session-tabs { overflow-x: auto; scrollbar-width: thin; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

- [ ] **Step 4: Run component, accessibility, and build checks**

Run: `npm test -- --run test/webview-state.test.ts test/webview-components.test.tsx`

Expected: PASS; the dialog test confirms no delete message before confirmation.

Run: `npm run check && npm run build`

Expected: PASS; `dist/webview.js`, `dist/webview.css`, and `dist/index.html` exist.

- [ ] **Step 5: Commit the manager shell**

```bash
git add src/webview test/webview-state.test.ts test/webview-components.test.tsx scripts/build.mjs
git commit -m "[PIEXT-1] feat: build agent manager shell [ai:y]"
```

---

### Task 8: xterm terminal workspace and clickable links

**Files:**
- Create: `src/webview/components/TerminalWorkspace.tsx`
- Modify: `src/webview/App.tsx`
- Modify: `src/webview/state.ts`
- Modify: `src/webview/styles.css`
- Modify: `test/webview-components.test.tsx`

**Interfaces:**
- Produces: one preserved `Terminal` instance per attached tab and typed terminal input/resize/link messages.
- Consumes: xterm core plus fit, search, Unicode 11, web-links, and optional WebGL addons; `terminal.output` and `terminal.focus` messages.

- [ ] **Step 1: Add failing terminal ownership tests with an injected factory**

```tsx
it("preserves terminal instances while switching tabs", async () => {
  const terminals = new FakeTerminalFactory();
  const { rerender } = render(<TerminalWorkspace tabs={[tabA, tabB]} activeTabId="a" transport={transport} factory={terminals} />);
  rerender(<TerminalWorkspace tabs={[tabA, tabB]} activeTabId="b" transport={transport} factory={terminals} />);
  expect(terminals.createdIds).toEqual(["a", "b"]);
  expect(terminals.disposedIds).toEqual([]);
});

it("disposes a terminal only after its tab is removed", () => {
  const terminals = new FakeTerminalFactory();
  const { rerender } = render(<TerminalWorkspace tabs={[tabA]} activeTabId="a" transport={transport} factory={terminals} />);
  rerender(<TerminalWorkspace tabs={[]} transport={transport} factory={terminals} />);
  expect(terminals.disposedIds).toEqual(["a"]);
});
```

- [ ] **Step 2: Verify the terminal tests fail**

Run: `npm test -- --run test/webview-components.test.tsx -t "terminal"`

Expected: FAIL because `TerminalWorkspace` does not exist.

- [ ] **Step 3: Implement terminal lifecycle and links**

Create terminals lazily with `scrollback: 10_000`, `cursorBlink: true`, `macOptionIsMeta: true`, `allowProposedApi: false`, VS Code-derived font family/size/line height, and theme colors from computed CSS variables. Load Fit, Search, Unicode 11, and WebLinks. Try WebGL once per terminal; on context loss or construction failure, dispose only the WebGL addon and keep the canvas/DOM renderer.

Use `ResizeObserver` plus `requestAnimationFrame` to fit active terminals and send dimensions only when changed. Forward `onData` to `terminal.input`. Register a file-link provider that recognizes `path:line:column` and sends the raw target to the host; modifier-click is required for both URL and file activation.

Incoming output queues per tab until the terminal exists and writes chunks in order. `terminal.focus` selects the tab, focuses xterm's textarea, and scrolls the cursor into view.

- [ ] **Step 4: Run terminal tests and production build**

Run: `npm test -- --run test/webview-components.test.tsx`

Expected: PASS.

Run: `npm run build`

Expected: PASS and xterm CSS is included in `dist/webview.css`.

- [ ] **Step 5: Commit terminal integration**

```bash
git add src/webview/components/TerminalWorkspace.tsx src/webview/App.tsx src/webview/state.ts src/webview/styles.css test/webview-components.test.tsx scripts/build.mjs
git commit -m "[PIEXT-1] feat: embed pi terminal tabs [ai:y]"
```

---

### Task 9: VS Code provider, persistence, lifecycle actions, and commands

**Files:**
- Create: `src/view/view-state.ts`
- Create: `src/view/pi-view-provider.ts`
- Create: `src/extension.ts`
- Create: `test/view-state.test.ts`
- Create: `test/pi-view-provider.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: extension activation, `PiViewProvider`, `normalizeViewState()`, editor-title/open/new/send-selection commands, and full host/webview orchestration.
- Consumes: every prior host service and protocol.

- [ ] **Step 1: Write failing persistence and provider orchestration tests**

```ts
it("normalizes unsafe persisted pane values", () => {
  expect(normalizeViewState({ paneVisible: "yes", paneWidth: 9999, collapsedGroups: ["Today", 3], openSessions: [{ id: "s", path: 7 }] })).toEqual({
    paneVisible: true,
    paneWidth: 248,
    collapsedGroups: ["Today"],
    openSessions: [],
  });
});

it("opens a session and pastes selection without enter", async () => {
  const harness = providerHarness({ activeSelection: selectionFixture });
  await harness.provider.sendSelection();
  expect(harness.controller.started).toHaveLength(1);
  expect(harness.controller.inputs[0]?.data).toMatch(/^\u001b\[200~/);
  expect(harness.controller.inputs[0]?.data.endsWith("\u001b[201~")).toBe(true);
  expect(harness.controller.inputs[0]?.data).not.toContain("\r");
  expect(harness.webview.messages).toContainEqual(expect.objectContaining({ type: "terminal.focus" }));
});
```

- [ ] **Step 2: Verify provider tests fail**

Run: `npm test -- --run test/view-state.test.ts test/pi-view-provider.test.ts`

Expected: FAIL because view modules and activation do not exist.

- [ ] **Step 3: Implement provider orchestration and manifest contributions**

`PiViewProvider` uses `retainContextWhenHidden: true`, a nonce CSP, packaged `dist/` roots only, and a debounced 150 ms history refresh. It starts the bridge before any Pi process, owns repository watchers, posts an initial `state.replace`, and updates state after every lifecycle event.

Handle each guarded webview message with one explicit branch. Delete uses `vscode.window.showWarningMessage` with modal confirmation even after the webview dialog, preventing forged messages from deleting transcripts. Rename uses `showInputBox`. Link opening verifies HTTP(S), opens existing files in preview at a bounded position, and ignores missing output paths.

`sendSelection()` captures the editor before revealing the Secondary Side Bar, uses the current line for an empty selection, waits up to 15 seconds for a new session to reach waiting, sends bracketed paste, then posts terminal focus. On timeout it leaves the manager open and reports that Pi is still starting.

Add exact contributions:

```json
{
  "commands": [
    { "command": "piAgent.open", "title": "Pi: Open Agent Manager", "icon": "media/pi.svg" },
    { "command": "piAgent.newSession", "title": "Pi: New Agent", "icon": "$(add)" },
    { "command": "piAgent.sendSelection", "title": "Pi: Send Selection", "icon": "$(send)" }
  ],
  "keybindings": [
    { "command": "piAgent.sendSelection", "key": "ctrl+l", "mac": "cmd+l", "when": "editorTextFocus && resourceScheme =~ /^(file|untitled|vscode-remote)$/" }
  ],
  "viewsContainers": {
    "secondarySidebar": [{ "id": "piAgent", "title": "Pi", "icon": "media/pi.svg" }]
  },
  "views": {
    "piAgent": [{ "type": "webview", "id": "piAgent.view", "name": "Agents", "icon": "media/pi.svg" }]
  },
  "menus": {
    "editor/title": [{ "command": "piAgent.open", "group": "navigation@1" }]
  },
  "configuration": {
    "title": "Pi Agent Manager",
    "properties": {
      "piAgent.command": { "type": "string", "default": "pi", "description": "Executable name or absolute path used to start Pi." },
      "piAgent.closeBehavior": { "type": "string", "enum": ["detach", "stop"], "default": "detach", "description": "Whether closing a session tab detaches its UI or stops Pi." }
    }
  }
}
```

Activation registers the view and all three commands, and deactivation disposes the provider, bridge, watchers, and live processes.

- [ ] **Step 4: Run provider tests and complete automated suite**

Run: `npm test -- --run test/view-state.test.ts test/pi-view-provider.test.ts`

Expected: PASS.

Run: `npm run check && npm test && npm run build`

Expected: all checks and tests PASS.

- [ ] **Step 5: Commit integrated extension behavior**

```bash
git add src/view src/extension.ts test/view-state.test.ts test/pi-view-provider.test.ts package.json
git commit -m "[PIEXT-1] feat: integrate vscode agent view [ai:y]"
```

---

### Task 10: Product assets, documentation, packaging, and runtime verification

**Files:**
- Create: `media/pi.svg`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`
- Create: `.vscodeignore`
- Modify: `package.json`
- Modify: any source or test file implicated by verification failures.

**Interfaces:**
- Produces: installable `pi-agent-manager-0.1.0.vsix` and evidence for every delivery-boundary requirement.
- Consumes: complete extension build.

- [ ] **Step 1: Add product metadata and package-focused documentation**

Create a simple single-color Pi mark whose SVG paths use `currentColor` for view-container rendering and a marketplace PNG generated from the same mark if `vsce` requires a raster package icon. README sections must cover Features, Requirements (`pi --version`), Open/New/Resume, `Cmd/Ctrl+L`, session statuses, close versus stop, archive/delete semantics, configuration, privacy/no telemetry, development, and known follow-up features. Document that audio, fork/rewind UI, and panel orchestration are not part of 0.1.0.

`.vscodeignore` must exclude source tests, docs/superpowers, coverage, editor settings, and development configs while retaining `dist/**`, `media/**`, `package.json`, README, license, changelog, and the runtime portion of `node_modules/node-pty/**`.

- [ ] **Step 2: Run the full automated verification matrix**

Run: `npm run check`

Expected: zero TypeScript and ESLint errors.

Run: `npm test`

Expected: all protocol, session, resolver, bridge, controller, selection, link, reducer, component, state, and provider tests PASS.

Run: `npm run build`

Expected: extension, webview, CSS, HTML, and Pi resource bundles exist in `dist/`.

- [ ] **Step 3: Package and inspect the VSIX**

Run: `npm run package`

Expected: `pi-agent-manager-0.1.0.vsix` is created.

Run: `unzip -l pi-agent-manager-0.1.0.vsix | rg "extension/(dist/(extension.js|webview.js|webview.css|index.html|resources/pi-status.mjs)|media/pi.svg|node_modules/node-pty/.+pty\.node|package.json|README.md|LICENSE)"`

Expected: every required runtime artifact appears, including a native `pty.node` for the current packaging platform.

- [ ] **Step 4: Run Extension Development Host and visual/interaction smoke tests**

Launch the worktree with VS Code's Extension Development Host configuration. In a temporary Git workspace:

1. Open the Pi manager from the editor-title Pi icon and confirm it appears in the Secondary Side Bar.
2. Create two agents; verify horizontal tabs, wide right-side history pane, live starting/working/waiting glyphs, and active-row styling.
3. Submit prompts, use `/name Verify manager title`, and verify both tab and history row update without reopening.
4. Detach one tab, confirm Pi stays live, then resume it from history and confirm terminal history is visible.
5. Select multi-line source, press `Cmd+L`, and verify the exact path/range/fenced code appears in Pi's input without submission.
6. Modifier-click a `src/file.ts:line:column` output path and verify the editor opens at the location.
7. Archive/restore a session and verify its JSONL path does not move; delete a disposable session and verify both confirmation layers and exact transcript/sidecar removal.
8. Resize through widths above 680 px, 420–680 px, and below 420 px; verify split, overlay, and scrollable-tab behaviors.
9. Inspect dark, light, high-contrast, and reduced-motion modes; capture screenshots matching the supplied composition.
10. Stop a session and force a non-zero fake Pi exit to confirm stopped/failed states and non-blocking warnings.

Record any runtime defect as a failing automated regression test before fixing it, then rerun the focused test and the full matrix.

- [ ] **Step 5: Run a requirement-by-requirement completion audit**

Create a temporary audit table in the delivery notes with one row for: Secondary Side Bar, editor icon, horizontal tabs, collapsible/date-grouped vertical sessions, search/New Agent, live statuses, title precedence and rename update, real Pi TUI/PTY, persistence/resume, lifecycle actions, links, `Cmd/Ctrl+L`, responsive themes/accessibility, error states, automated checks, runtime smoke, and VSIX contents. For each row, cite source path, covering test, and runtime/package evidence. Any row without all applicable evidence remains incomplete.

- [ ] **Step 6: Commit delivery assets and verified fixes**

```bash
git add README.md CHANGELOG.md LICENSE media/pi.svg .vscodeignore package.json package-lock.json src test scripts resources
git commit -m "[PIEXT-1] docs: package agent manager [ai:y]"
```

- [ ] **Step 7: Final clean-state verification**

Run: `git status --short`

Expected: no output.

Run: `npm run check && npm test && npm run build && npm run package`

Expected: every command exits 0 and recreates `pi-agent-manager-0.1.0.vsix`.
