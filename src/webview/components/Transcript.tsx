import { memo, useEffect, useState } from "react";
import type { DialogResponse } from "../../shared/protocol";
import type { AssistantBlock, ChatItem, DialogRequest, ToolState } from "../chat-state";
import { useChat } from "./context";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

const COLLAPSE_USER_CHARS = 900;

export const UserMessage = memo(function UserMessage({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  const long = item.text.length > COLLAPSE_USER_CHARS || item.text.split("\n").length > 14;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`user-message${item.pending ? " pending" : ""}`}>
      {item.images.length > 0 && (
        <div className="image-strip">
          {item.images.map((image, index) => (
            <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={image.name ?? `Image ${index + 1}`} />
          ))}
        </div>
      )}
      {item.text && <div className={`user-text${long && !expanded ? " clamped" : ""}`}>{item.text}</div>}
      {long && (
        <button type="button" className="link-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
});

function ThinkingBlock({ text, redacted, live }: { text: string; redacted?: boolean; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="timeline-row thinking">
      <span className="dot dot-thinking" aria-hidden="true" />
      <div className="timeline-content">
        <button type="button" className="thinking-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={live ? "shimmer" : ""}>{redacted ? "Thinking (redacted)" : live ? "Thinking…" : "Thought"}</span>
          <span className={`codicon codicon-chevron-${open ? "down" : "right"}`} aria-hidden="true" />
        </button>
        {open && text && <div className="thinking-text">{text}</div>}
      </div>
    </div>
  );
}

function Block({
  block,
  tools,
  live,
}: {
  block: AssistantBlock;
  tools: Record<string, ToolState>;
  live: boolean;
}) {
  if (block.type === "thinking") return <ThinkingBlock text={block.text} live={live} {...(block.redacted ? { redacted: true } : {})} />;
  if (block.type === "tool") {
    const tool = tools[block.id];
    if (!tool) return null;
    return (
      <div className="timeline-row">
        <span className={`dot dot-${tool.status}`} aria-hidden="true" />
        <div className="timeline-content">
          <ToolCard tool={tool} />
        </div>
      </div>
    );
  }
  if (!block.text.trim()) return null;
  return (
    <div className="timeline-row">
      <span className="dot dot-text" aria-hidden="true" />
      <div className="timeline-content">
        <Markdown text={block.text} />
      </div>
    </div>
  );
}

export function AssistantMessage({
  item,
  tools,
}: {
  item: Extract<ChatItem, { kind: "assistant" }>;
  tools: Record<string, ToolState>;
}) {
  const lastIndex = item.blocks.length - 1;
  return (
    <div className="assistant-message">
      {item.blocks.map((block, index) => (
        <Block key={index} block={block} tools={tools} live={item.streaming && index === lastIndex} />
      ))}
      {item.error && (
        <div className={`timeline-row ${item.stopReason === "aborted" ? "interrupted" : "error"}`}>
          <span className={`dot ${item.stopReason === "aborted" ? "dot-interrupted" : "dot-error"}`} aria-hidden="true" />
          <div className="timeline-content message-error">{item.error}</div>
        </div>
      )}
    </div>
  );
}

function useDeadline(deadline: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : undefined;
}

export function DialogCard({
  request,
  answer,
  onAnswer,
}: {
  request: DialogRequest;
  answer: string | undefined;
  onAnswer(id: string, label: string): void;
}) {
  const { post } = useChat();
  const [text, setText] = useState(request.prefill ?? "");
  const remaining = useDeadline(answer ? undefined : request.deadline);
  const expired = remaining === 0;
  const respond = (label: string, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => {
    const message: DialogResponse = { id: request.id, ...response };
    post({ version: 1, type: "dialog.respond", response: message });
    onAnswer(request.id, label);
  };
  if (answer || expired) {
    return (
      <div className="dialog-receipt">
        <span className="codicon codicon-pass" aria-hidden="true" />
        <span className="dialog-receipt-title">{request.title}</span>
        <span className="dialog-receipt-answer">{answer ?? "Timed out"}</span>
      </div>
    );
  }
  return (
    <div className="dialog-card" role="group" aria-label={request.title}>
      <div className="dialog-title">
        <span className="codicon codicon-question" aria-hidden="true" />
        {request.title}
        {remaining !== undefined && <span className="dialog-timer">{remaining}s</span>}
      </div>
      {request.message && <div className="dialog-message">{request.message}</div>}
      {request.method === "confirm" && (
        <div className="dialog-actions">
          <button type="button" className="button primary" onClick={() => respond("Yes", { confirmed: true })} autoFocus>
            Yes
          </button>
          <button type="button" className="button" onClick={() => respond("No", { confirmed: false })}>
            No
          </button>
        </div>
      )}
      {request.method === "select" && (
        <div className="dialog-options">
          {(request.options ?? []).map((option, index) => (
            <button key={option} type="button" className="dialog-option" onClick={() => respond(option, { value: option })} autoFocus={index === 0}>
              <span className="dialog-option-index">{index + 1}</span>
              {option}
            </button>
          ))}
          <button type="button" className="link-button" onClick={() => respond("Cancelled", { cancelled: true })}>
            Cancel
          </button>
        </div>
      )}
      {(request.method === "input" || request.method === "editor") && (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            respond(text || "(empty)", { value: text });
          }}
        >
          {request.method === "input" ? (
            <input className="text-input" value={text} placeholder={request.placeholder ?? ""} onChange={(event) => setText(event.target.value)} autoFocus />
          ) : (
            <textarea className="text-input" rows={6} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
          )}
          <div className="dialog-actions">
            <button type="submit" className="button primary">
              Submit
            </button>
            <button type="button" className="button" onClick={() => respond("Cancelled", { cancelled: true })}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function TranscriptItem({
  item,
  tools,
  onDialogAnswer,
  onDismiss,
}: {
  item: ChatItem;
  tools: Record<string, ToolState>;
  onDialogAnswer(id: string, label: string): void;
  onDismiss(id: string): void;
}) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <AssistantMessage item={item} tools={tools} />;
    case "dialog":
      return <DialogCard request={item.request} answer={item.answer} onAnswer={onDialogAnswer} />;
    case "bash":
      return (
        <div className="bash-item">
          <pre className="tool-command">! {item.command}</pre>
          {item.output && <pre className="tool-output">{item.output}</pre>}
          {item.exitCode !== undefined && item.exitCode !== 0 && <div className="tool-summary error">Exit code {item.exitCode}</div>}
        </div>
      );
    case "compaction":
      return (
        <div className="divider-notice">
          <span>
            Conversation compacted
            {item.tokensBefore ? ` · ${Math.round(item.tokensBefore / 1000)}k tokens summarized` : ""}
          </span>
        </div>
      );
    case "notice":
      return (
        <div className={`notice notice-${item.level}`} role={item.level === "error" ? "alert" : "status"}>
          <span
            className={`codicon codicon-${item.level === "error" ? "error" : item.level === "warning" ? "warning" : "info"}`}
            aria-hidden="true"
          />
          <span className="notice-text">{item.text}</span>
          <button type="button" className="icon-button small" aria-label="Dismiss" onClick={() => onDismiss(item.id)}>
            <span className="codicon codicon-close" />
          </button>
        </div>
      );
    default:
      return null;
  }
}
