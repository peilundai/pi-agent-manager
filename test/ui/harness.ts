import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { ChatSession } from "../../src/pi/chat-session";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../../src/shared/protocol";
import { startMockLlm, type MockLlm } from "../e2e/support/mock-llm";
import { createPiTestEnv, type PiTestEnv } from "../e2e/support/pi-env";

const DIST = join(process.cwd(), "dist");
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf" };

const THEMES = {
  dark: "--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-input-background:#313131;--vscode-focusBorder:#0078d4;--vscode-diffEditor-insertedLineBackground:#9bb95533;--vscode-diffEditor-removedLineBackground:#ff000033;--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-deletedResourceForeground:#c74e39",
  light: "--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-focusBorder:#005fb8;--vscode-diffEditor-insertedLineBackground:#9bb95533;--vscode-diffEditor-removedLineBackground:#ff000033;--vscode-gitDecoration-addedResourceForeground:#587c0c;--vscode-gitDecoration-deletedResourceForeground:#ad0707",
} as const;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/webview.css"></head>
<body class="vscode-dark" style="--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;${THEMES.dark}">
<div id="root"></div><script src="/webview.js"></script></body></html>`;

async function serveDist(): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
}

export interface ChatFixture {
  page: Page;
  pi: PiTestEnv;
  received: WebviewToHostMessage[];
  setTheme(theme: keyof typeof THEMES): Promise<void>;
  screenshot(name: string): Promise<void>;
}

/**
 * Bridges the webview to a real ChatSession the same way ChatViewProvider does,
 * minus the VS Code APIs (file search returns a fixed list).
 */
export const test = base.extend<{ chat: ChatFixture }, { llm: MockLlm }>({
  llm: [
    async ({}, use) => {
      const llm = await startMockLlm({ delayMs: 15 });
      await use(llm);
      await llm.close();
    },
    { scope: "worker" },
  ],
  chat: async ({ page, llm }, use, testInfo) => {
    const pi = await createPiTestEnv(llm.url);
    const { url, server } = await serveDist();
    const received: WebviewToHostMessage[] = [];
    const post = (message: HostToWebviewMessage) =>
      page.evaluate((value) => window.postMessage(value, "*"), message).catch(() => undefined);
    const sendSessions = async () => post({ version: 1, type: "sessions", sessions: await pi.repository.list(pi.workspace) });
    const session = new ChatSession({ createClient: (listener) => pi.createClient(listener), post, onSessionsChanged: () => void sendSessions() });

    page.on("pageerror", (error) => {
      throw error;
    });
    await page.exposeFunction("__toHost", async (message: WebviewToHostMessage) => {
      received.push(message);
      switch (message.type) {
        case "ready":
          await post({ version: 1, type: "init", workspaceName: "greeter", platform: "darwin" });
          await sendSessions();
          await session.ensureStarted();
          return;
        case "prompt":
          return session.prompt(message.text, message.images, message.mode);
        case "abort":
          return session.abort();
        case "chat.new":
          return session.newChat();
        case "chat.open":
          return session.openSession(message.path);
        case "model.set":
          return session.setModel(message.provider, message.modelId);
        case "thinking.set":
          return session.setThinkingLevel(message.level);
        case "dialog.respond":
          return session.respondToDialog(message.response);
        case "sessions.refresh":
          return sendSessions();
        case "files.search":
          return post({ version: 1, type: "files.result", requestId: message.requestId, files: ["src/greet.ts", "src/app.ts", "README.md"].filter((file) => file.includes(message.query)) });
        default:
          return undefined;
      }
    });
    await page.addInitScript(() => {
      const bridge = window as unknown as { __toHost(message: unknown): void; acquireVsCodeApi(): unknown };
      bridge.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => bridge.__toHost(message), getState: () => ({}), setState: () => undefined });
    });
    await page.goto(url);

    const fixture: ChatFixture = {
      page,
      pi,
      received,
      async setTheme(theme) {
        await page.evaluate(
          ([name, vars]) => {
            document.body.className = `vscode-${name}`;
            for (const declaration of vars.split(";")) {
              const [key, value] = declaration.split(":");
              if (key && value) document.body.style.setProperty(key, value);
            }
          },
          [theme, THEMES[theme]] as const,
        );
      },
      async screenshot(name) {
        const body = await page.screenshot();
        await testInfo.attach(name, { body, contentType: "image/png" });
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir("test-results/screenshots", { recursive: true });
        await writeFile(join("test-results/screenshots", `${name}.png`), body);
      },
    };
    await use(fixture);
    await session.dispose();
    await new Promise((resolve) => server.close(resolve));
    await pi.cleanup();
  },
});

export { expect };
