import { memo, useState, type MouseEvent } from "react";
import type { ToolState } from "../chat-state";
import { describeTool, diffStats, splitShellStatus, summarizeTool, toolDiffRows, type DiffRow } from "../tool-format";
import { useChat } from "./context";

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
        !command && <pre className="tool-output muted">{JSON.stringify(tool.args, null, 2)}</pre>
      )}
    </>
  );
}

export const ToolCard = memo(function ToolCard({ tool }: { tool: ToolState }) {
  const { post, toolExpansion = "edits" } = useChat();
  const description = describeTool(tool);
  const summary = summarizeTool(tool);
  const stats = tool.status === "success" || tool.status === "running" ? diffStats(tool) : undefined;
  const autoOpen = toolExpansion === "all" || (toolExpansion === "edits" && tool.name === "edit");
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
          <ToolBody tool={tool} />
        </div>
      )}
    </div>
  );
});
