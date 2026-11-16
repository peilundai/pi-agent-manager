import { memo, useState, type MouseEvent } from "react";
import type { ToolState } from "../chat-state";
import {
  autoExpands,
  describeTool,
  diffStats,
  nestedDiffStats,
  scriptSource,
  splitShellStatus,
  summarizeCalls,
  toolDiffRows,
  type DiffRow,
} from "../tool-format";
import { useChat } from "./context";
import { Markdown } from "./Markdown";

const MAX_DIFF_ROWS = 400;
const MAX_OUTPUT_CHARS = 20_000;

export function DiffView({ rows }: { rows: DiffRow[] }) {
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  return (
    <div className="diff" role="table" aria-label="Diff">
      {shown.map((row, index) => (
        <div key={index} className={`diff-row diff-${row.kind}`} role="row">
          <span className="diff-line" aria-hidden="true">
            {row.line ?? ""}
          </span>
          <span className="diff-sign" aria-hidden="true">
            {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
          </span>
          <span className="diff-text">{row.text || " "}</span>
        </div>
      ))}
      {rows.length > shown.length && <div className="diff-row diff-skip">… {rows.length - shown.length} more lines</div>}
    </div>
  );
}

const MAX_DEPTH = 8;
const NO_TOOLS: Record<string, ToolState> = {};

/** Wraps a script in a code fence longer than any backtick run inside it. */
function fenced(code: string, language: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${code}\n${fence}`;
}

function ScriptBody({ tool }: { tool: ToolState }) {
  const code = scriptSource(tool.args);
  if (!code) return null;
  return (
    <section className="tool-section" aria-label="Script">
      <div className="tool-section-label">Script</div>
      <Markdown text={fenced(code, "javascript")} />
    </section>
  );
}

function NestedCalls({ tool, tools, depth }: { tool: ToolState; tools: Record<string, ToolState>; depth: number }) {
  const calls = (tool.children ?? []).map((id) => tools[id]).filter((child): child is ToolState => Boolean(child));
  if (!calls.length) return null;
  return (
    <section className="tool-section" aria-label="Tool calls">
      <div className="tool-section-label">Tool calls</div>
      <ul className="tool-children">
        {calls.map((child) => (
          <li key={child.id} className={`tool-child tool-child-${child.status}`}>
            {depth < MAX_DEPTH ? (
              <ToolCard tool={child} tools={tools} depth={depth + 1} />
            ) : (
              <span className="tool-verb">{describeTool(child).verb}</span>
            )}
          </li>
        ))}
      </ul>
      {tool.childrenIncomplete && <div className="tool-section-note">Pi did not record every call or its arguments.</div>}
    </section>
  );
}

function ToolBody({ tool }: { tool: ToolState }) {
  if (tool.name === "edit" || (tool.name === "write" && typeof tool.args.content === "string")) {
    const rows = toolDiffRows(tool);
    return (
      <>
        {rows.length > 0 && <DiffView rows={rows} />}
        {tool.status === "error" && tool.output && <pre className="tool-output error">{tool.output}</pre>}
      </>
    );
  }
  const shell = tool.name === "bash" || tool.name === "powershell";
  // A failed shell command's output is mostly ordinary stdout; only Pi's status line is the error.
  const { body, status } = shell && tool.status === "error" ? splitShellStatus(tool.output) : { body: tool.output, status: undefined };
  const output = body.length > MAX_OUTPUT_CHARS ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n…` : body;
  const command = shell && typeof tool.args.command === "string" ? tool.args.command : undefined;
  return (
    <>
      {command && <pre className="tool-command">$ {command}</pre>}
      {status ? (
        <pre className="tool-output">
          {output && `${output}\n\n`}
          <span className="tool-output-status error">{status}</span>
        </pre>
      ) : output ? (
        <pre className={`tool-output${tool.status === "error" ? " error" : ""}`}>{output}</pre>
      ) : (
        !command && tool.name !== "codemode" && <pre className="tool-output muted">{JSON.stringify(tool.args, null, 2)}</pre>
      )}
    </>
  );
}

interface ToolCardProps {
  tool: ToolState;
  /** Every tool in the chat, to look up the calls this tool made. */
  tools?: Record<string, ToolState>;
  depth?: number;
}

function ToolCardView({ tool, tools = NO_TOOLS, depth = 0 }: ToolCardProps) {
  const { post, toolExpansion = "edits" } = useChat();
  const description = describeTool(tool);
  const summary = summarizeCalls(tool, tools);
  const ownStats = tool.status === "success" || tool.status === "running" ? diffStats(tool) : undefined;
  // Calls a script made are real even when the script fails afterwards, so their edits always count.
  const stats = ownStats ?? nestedDiffStats(tool, tools);
  const autoOpen = autoExpands(tool, tools, toolExpansion);
  const hasCalls = Boolean(tool.children?.length);
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? (autoOpen && tool.status !== "streaming");
  const live = tool.status === "running" || tool.status === "streaming";
  const openPath = (event: MouseEvent) => {
    if (!description.path) return;
    event.stopPropagation();
    post({ version: 1, type: "file.open", path: description.path, ...(description.line !== undefined ? { line: description.line } : {}) });
  };
  return (
    <div className={`tool tool-${tool.status}`}>
      <button
        type="button"
        className="tool-header"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        title={live ? "Running" : tool.status}
      >
        <span className="tool-verb">{description.verb}</span>
        {description.target && (
          <span
            className={`tool-target${description.path ? " link" : ""}`}
            onClick={description.path ? openPath : undefined}
            title={description.path ? `Open ${description.path}` : description.target}
          >
            {description.target}
          </span>
        )}
        {stats && (
          <span className="tool-stats" aria-label={`${stats.added} added, ${stats.removed} removed`}>
            {stats.added > 0 && <span className="tool-stat-add">+{stats.added}</span>}
            {stats.removed > 0 && <span className="tool-stat-del">-{stats.removed}</span>}
          </span>
        )}
        {tool.durationMs !== undefined && tool.durationMs >= 1_000 && (
          <span className="tool-duration">{(tool.durationMs / 1000).toFixed(1)}s</span>
        )}
        <span className={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-chevron`} aria-hidden="true" />
      </button>
      {summary && !expanded && (
        <div className={`tool-summary${tool.status === "error" ? " error" : ""}`}>
          <span className="tool-elbow" aria-hidden="true">⎿</span>
          {summary}
        </div>
      )}
      {expanded && (
        <div className="tool-body">
          {tool.name === "codemode" && <ScriptBody tool={tool} />}
          {hasCalls && <NestedCalls tool={tool} tools={tools} depth={depth} />}
          {hasCalls || tool.name === "codemode" ? (
            tool.output && (
              <section className="tool-section" aria-label="Output">
                <div className="tool-section-label">Output</div>
                <ToolBody tool={tool} />
              </section>
            )
          ) : (
            <ToolBody tool={tool} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A tool call and, nested inside it, the calls it made. The reducer replaces a parent's state
 * whenever one of its calls changes, so comparing `tool` alone is enough to re-render.
 */
export const ToolCard = memo(
  ToolCardView,
  (previous, next) => previous.tool === next.tool && previous.depth === next.depth,
);
