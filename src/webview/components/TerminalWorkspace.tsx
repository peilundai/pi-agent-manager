import { useEffect, useRef, useState } from "react";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalTab } from "../../shared/model";
import { fileLinksForBuffer } from "../file-links";
import type { WebviewTransport } from "../vscode";

export interface TerminalWorkspaceBinding {
  readonly cols: number;
  readonly rows: number;
  write(data: string, onComplete: () => void): void;
  focus(): void;
  fit(): void;
  dispose(): void;
}

export interface TerminalWorkspaceFactory {
  create(options: {
    tabId: string;
    container: HTMLElement;
    onData(data: string): void;
    onLink(kind: "file" | "url", target: string): void;
  }): TerminalWorkspaceBinding;
}

function cssColor(style: CSSStyleDeclaration, variable: string, fallback: string): string {
  return style.getPropertyValue(variable).trim() || fallback;
}

function numericCssValue(value: string, fallback: number): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function hasLinkModifier(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function fileLinkProvider(terminal: Terminal, onLink: (target: string) => void): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback): void {
      const links: ILink[] = fileLinksForBuffer(terminal.buffer.active, bufferLineNumber)
        .map((link) => ({
          ...link,
          activate: (event) => {
            if (hasLinkModifier(event)) onLink(link.text);
          },
        }));
      callback(links.length ? links : undefined);
    },
  };
}

export const browserTerminalFactory: TerminalWorkspaceFactory = {
  create({ container, onData, onLink }): TerminalWorkspaceBinding {
    const style = getComputedStyle(container);
    const fontSize = numericCssValue(style.getPropertyValue("--vscode-editor-font-size"), 13);
    const lineHeight = numericCssValue(style.getPropertyValue("--vscode-editor-line-height"), fontSize * 1.2) / fontSize;
    const terminal = new Terminal({
      scrollback: 10_000,
      cursorBlink: true,
      macOptionIsMeta: true,
      allowProposedApi: true,
      fontFamily: cssColor(style, "--vscode-editor-font-family", "monospace"),
      fontSize,
      lineHeight,
      theme: {
        background: cssColor(style, "--vscode-terminal-background", cssColor(style, "--vscode-editor-background", "#1e1e1e")),
        foreground: cssColor(style, "--vscode-terminal-foreground", cssColor(style, "--vscode-editor-foreground", "#cccccc")),
        cursor: cssColor(style, "--vscode-terminalCursor-foreground", "#ffffff"),
        selectionBackground: cssColor(style, "--vscode-terminal-selectionBackground", "#264f78"),
        black: cssColor(style, "--vscode-terminal-ansiBlack", "#000000"),
        red: cssColor(style, "--vscode-terminal-ansiRed", "#cd3131"),
        green: cssColor(style, "--vscode-terminal-ansiGreen", "#0dbc79"),
        yellow: cssColor(style, "--vscode-terminal-ansiYellow", "#e5e510"),
        blue: cssColor(style, "--vscode-terminal-ansiBlue", "#2472c8"),
        magenta: cssColor(style, "--vscode-terminal-ansiMagenta", "#bc3fbc"),
        cyan: cssColor(style, "--vscode-terminal-ansiCyan", "#11a8cd"),
        white: cssColor(style, "--vscode-terminal-ansiWhite", "#e5e5e5"),
      },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    try {
      terminal.loadAddon(unicode11Addon);
      terminal.unicode.activeVersion = "11";
    } catch (error) {
      unicode11Addon.dispose();
      terminal.dispose();
      throw error;
    }
    terminal.loadAddon(new WebLinksAddon((event, target) => {
      if (hasLinkModifier(event)) onLink("url", target);
    }));
    const provider = fileLinkProvider(terminal, (target) => onLink("file", target));
    const linkRegistration = terminal.registerLinkProvider(provider);
    const dataRegistration = terminal.onData(onData);
    terminal.open(container);

    let webglAddon: WebglAddon | undefined;
    let webglContextLoss: { dispose(): void } | undefined;
    try {
      webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
      webglContextLoss = webglAddon.onContextLoss(() => {
        webglContextLoss?.dispose();
        webglContextLoss = undefined;
        webglAddon?.dispose();
        webglAddon = undefined;
      });
    } catch {
      webglAddon?.dispose();
      webglAddon = undefined;
    }

    return {
      get cols() { return terminal.cols; },
      get rows() { return terminal.rows; },
      write: (data, onComplete) => terminal.write(data, onComplete),
      focus: () => {
        terminal.focus();
        terminal.scrollToBottom();
      },
      fit: () => fitAddon.fit(),
      dispose: () => {
        webglContextLoss?.dispose();
        webglAddon?.dispose();
        linkRegistration.dispose();
        dataRegistration.dispose();
        terminal.dispose();
      },
    };
  },
};

export interface TerminalOutputMessage {
  id: number;
  type: "terminal.output";
  tabId: string;
  data: string;
}

export interface TerminalFocusMessage {
  id: number;
  type: "terminal.focus";
  tabId: string;
}

export type TerminalWorkspaceMessage = TerminalOutputMessage | TerminalFocusMessage;

export interface TerminalWorkspaceProps {
  tabs: readonly TerminalTab[];
  activeTabId?: string;
  transport: WebviewTransport;
  factory: TerminalWorkspaceFactory;
  messages?: readonly TerminalWorkspaceMessage[];
  onMessagesHandled?(ids: readonly number[]): void;
}

export function TerminalWorkspace({
  tabs,
  activeTabId,
  transport,
  factory,
  messages = [],
  onMessagesHandled,
}: TerminalWorkspaceProps) {
  const workspace = useRef<HTMLDivElement>(null);
  const mounts = useRef(new Map<string, HTMLDivElement>());
  const terminals = useRef(new Map<string, TerminalWorkspaceBinding>());
  const terminalGenerations = useRef(new Map<string, number>());
  const handledMessages = useRef(new Set<number>());
  const inFlightWrites = useRef(new Map<string, { id: number; generation: number }>());
  const sentDimensions = useRef(new Map<string, string>());
  const transportRef = useRef(transport);
  const messagesHandledRef = useRef(onMessagesHandled);
  const [outputQueueVersion, advanceOutputQueue] = useState(0);
  transportRef.current = transport;
  messagesHandledRef.current = onMessagesHandled;

  useEffect(() => {
    const attachedTabs = tabs.filter((tab) => tab.attached);
    const attachedIds = new Set(attachedTabs.map((tab) => tab.tabId));

    for (const [tabId, terminal] of terminals.current) {
      if (!attachedIds.has(tabId)) {
        terminal.dispose();
        terminals.current.delete(tabId);
        inFlightWrites.current.delete(tabId);
        sentDimensions.current.delete(tabId);
      }
    }

    for (const tab of attachedTabs) {
      const container = mounts.current.get(tab.tabId);
      if (container && !terminals.current.has(tab.tabId)) {
        terminalGenerations.current.set(tab.tabId, (terminalGenerations.current.get(tab.tabId) ?? 0) + 1);
        terminals.current.set(tab.tabId, factory.create({
          tabId: tab.tabId,
          container,
          onData: (data) => transportRef.current.post({ version: 1, type: "terminal.input", tabId: tab.tabId, data }),
          onLink: (kind, target) => transportRef.current.post({ version: 1, type: "link.open", kind, target }),
        }));
      }
    }
  }, [factory, tabs]);

  useEffect(() => {
    const handled: number[] = [];
    for (const message of messages) {
      if (handledMessages.current.has(message.id)) continue;
      const terminal = terminals.current.get(message.tabId);
      if (!terminal) continue;
      if (message.type === "terminal.output") {
        if (inFlightWrites.current.has(message.tabId)) continue;
        const generation = terminalGenerations.current.get(message.tabId) ?? 0;
        inFlightWrites.current.set(message.tabId, { id: message.id, generation });
        terminal.write(message.data, () => {
          const inFlight = inFlightWrites.current.get(message.tabId);
          if (!inFlight || inFlight.id !== message.id || inFlight.generation !== generation) return;
          inFlightWrites.current.delete(message.tabId);
          handledMessages.current.add(message.id);
          messagesHandledRef.current?.([message.id]);
          advanceOutputQueue((version) => version + 1);
        });
      } else {
        terminal.focus();
        handledMessages.current.add(message.id);
        handled.push(message.id);
      }
    }
    if (handled.length) messagesHandledRef.current?.(handled);
  }, [messages, outputQueueVersion, tabs]);

  useEffect(() => {
    let frame: number | undefined;
    let fitScheduled = false;
    const fitActiveTerminal = (): void => {
      frame = undefined;
      fitScheduled = false;
      if (!activeTabId) return;
      const terminal = terminals.current.get(activeTabId);
      if (!terminal) return;
      terminal.fit();
      const dimensions = `${terminal.cols}x${terminal.rows}`;
      if (sentDimensions.current.get(activeTabId) === dimensions) return;
      sentDimensions.current.set(activeTabId, dimensions);
      transportRef.current.post({
        version: 1,
        type: "terminal.resize",
        tabId: activeTabId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };
    const scheduleFit = (): void => {
      if (fitScheduled) return;
      fitScheduled = true;
      frame = requestAnimationFrame(fitActiveTerminal);
    };
    const observer = typeof ResizeObserver === "undefined" || !workspace.current
      ? undefined
      : new ResizeObserver(scheduleFit);
    if (workspace.current) observer?.observe(workspace.current);
    scheduleFit();

    return () => {
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [activeTabId, tabs]);

  useEffect(() => () => {
    inFlightWrites.current.clear();
    for (const terminal of terminals.current.values()) terminal.dispose();
    terminals.current.clear();
  }, []);

  return (
    <div ref={workspace} className="terminal-workspace" data-testid="terminal-workspace">
      {tabs.filter((tab) => tab.attached).map((tab) => (
        <div
          key={tab.tabId}
          ref={(element) => {
            if (element) mounts.current.set(tab.tabId, element);
            else mounts.current.delete(tab.tabId);
          }}
          className="terminal-mount"
          data-testid={`terminal-mount-${tab.tabId}`}
          data-active={tab.tabId === activeTabId}
          hidden={tab.tabId !== activeTabId}
        />
      ))}
    </div>
  );
}
