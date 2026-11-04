import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { ContextReference, ImageAttachment, PromptMode } from "../../shared/protocol";
import type { PiCommand, PiModel, PiSessionStats, ThinkingLevel } from "../../pi/rpc-types";
import { useChat } from "./context";
import { ModelPicker, modelLabel, supportedLevels, thinkingLabel } from "./ModelPicker";

export interface ComposerHandle {
  focus(): void;
  insert(text: string, images?: ImageAttachment[], references?: ContextReference[]): void;
  toggleModelPicker(): void;
}

/** The composer's text plus the selections its reference tokens point to. */
export interface ComposerDraft {
  text: string;
  references: ContextReference[];
}

export interface ReferenceToken {
  start: number;
  end: number;
  label: string;
}

/** Finds each reference label that stands as a whitespace-delimited token in `text`. */
export function findReferenceTokens(text: string, labels: readonly string[]): ReferenceToken[] {
  const found: ReferenceToken[] = [];
  for (const label of new Set(labels)) {
    if (!label) continue;
    for (let start = text.indexOf(label); start !== -1; start = text.indexOf(label, start + 1)) {
      const end = start + label.length;
      if ((start === 0 || /\s/.test(text.charAt(start - 1))) && (end === text.length || /\s/.test(text.charAt(end)))) {
        found.push({ start, end, label });
      }
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const tokens: ReferenceToken[] = [];
  for (const token of found) {
    if (token.start >= (tokens.at(-1)?.end ?? 0)) tokens.push(token);
  }
  return tokens;
}

/** Appends the context of every reference still present in `text`, in the order they appear. */
export function expandReferences(text: string, references: readonly ContextReference[]): string {
  const byLabel = new Map(references.map((reference) => [reference.label, reference.text]));
  const labels = [...new Set(findReferenceTokens(text, [...byLabel.keys()]).map((token) => token.label))];
  const context = labels.map((label) => (byLabel.get(label) ?? "").trim()).filter(Boolean).join("\n\n");
  if (!context) return text;
  return text ? `${text}\n\n${context}` : context;
}

export interface LocalCommand {
  name: string;
  description: string;
  run(): void;
}

interface MenuItem {
  key: string;
  label: string;
  description: string;
  badge?: string;
  apply(): void;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function readImage(file: File): Promise<ImageAttachment | undefined> {
  if (!SUPPORTED_IMAGES.has(file.type) || file.size > MAX_IMAGE_BYTES) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const data = result.slice(result.indexOf(",") + 1);
      resolve(data ? { data, mimeType: file.type, name: file.name } : undefined);
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/** Finds an `@query` token that ends at the caret. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  return { start: caret - (match[2]?.length ?? 0) - 1, query: match[2] ?? "" };
}

/** Finds a `/command` being typed at the start of the prompt. */
export function slashQuery(text: string, caret: number): string | undefined {
  const match = /^\/([^\s]*)$/.exec(text.slice(0, caret));
  return match && !text.slice(caret).includes("\n") ? match[1] ?? "" : undefined;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function ContextRing({ stats }: { stats: PiSessionStats | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const percent = stats?.contextUsage?.percent;
  if (typeof percent !== "number") return null;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(Math.max(percent, 0), 100);
  const tokens = stats?.contextUsage?.tokens;
  const window = stats?.contextUsage?.contextWindow;
  const cost = typeof stats?.cost === "number" && stats.cost > 0 ? stats.cost : undefined;
  const title = `Context ${clamped.toFixed(0)}% used${
    typeof tokens === "number" && window ? ` (${Math.round(tokens / 1000)}k / ${Math.round(window / 1000)}k tokens)` : ""
  }${cost !== undefined ? ` · $${cost.toFixed(2)}` : ""}`;
  const high = clamped > 80;
  const usage = stats?.tokens;
  const rows: [string, number | undefined][] = [
    ["Input", usage?.input],
    ["Output", usage?.output],
    ["Cache read", usage?.cacheRead],
    ["Cache write", usage?.cacheWrite],
    ["Total", usage?.total],
  ];
  const tokenRows = rows.filter((row): row is [string, number] => typeof row[1] === "number");

  return (
    <div className="context-ring-wrap" ref={ref}>
      <button
        type="button"
        className={`context-ring${high ? " high" : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={radius} className="ring-track" />
          <circle
            cx="8"
            cy="8"
            r={radius}
            className="ring-value"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped / 100)}
          />
        </svg>
      </button>
      {open && (
        <div className="popover context-popover" role="dialog" aria-label="Context usage">
          <div className="picker-label">Context window</div>
          <div className="context-headline">
            <span className="context-percent">{clamped.toFixed(0)}%</span>
            <span className="context-sub">
              {typeof tokens === "number" && window ? `${formatTokens(tokens)} / ${formatTokens(window)} tokens` : "used"}
            </span>
          </div>
          <div className={`context-bar${high ? " high" : ""}`} aria-hidden="true">
            <span style={{ width: `${clamped}%` }} />
          </div>
          {tokenRows.length > 0 && (
            <>
              <div className="picker-label context-section">Session tokens</div>
              <dl className="context-rows">
                {tokenRows.map(([label, value]) => (
                  <div key={label} className="context-row">
                    <dt>{label}</dt>
                    <dd>{value.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {cost !== undefined && (
            <dl className="context-rows context-cost">
              <div className="context-row">
                <dt>Cost</dt>
                <dd>${cost.toFixed(2)}</dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

export interface ComposerProps {
  busy: boolean;
  disabled: boolean;
  platform: string;
  models: PiModel[];
  model: PiModel | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  commands: PiCommand[];
  localCommands: LocalCommand[];
  stats: PiSessionStats | undefined;
  /** Returns the latest saved draft; read once when the composer mounts. */
  loadDraft(): ComposerDraft;
  history: string[];
  onDraftChange(draft: ComposerDraft): void;
  onSubmit(text: string, images: ImageAttachment[], mode: PromptMode): void;
  onAbort(): void;
  files: { requestId: number; files: string[] };
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { post } = useChat();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightsRef = useRef<HTMLDivElement>(null);
  const [initialDraft] = useState(() => props.loadDraft());
  const [text, setText] = useState(initialDraft.text);
  /** Selections inserted from the editor, shown as `@path#lines` tokens and expanded on send. */
  const [references, setReferences] = useState<ContextReference[]>(initialDraft.references);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [dragging, setDragging] = useState(false);
  /** The @-mention file search whose results the menu may show. */
  const [fileRequest, setFileRequest] = useState<{ id: number; query: string } | undefined>(undefined);
  const requestCounter = useRef(0);
  const isMac = props.platform === "darwin";

  const tokens = useMemo(() => findReferenceTokens(text, references.map((reference) => reference.label)), [text, references]);

  const syncHighlights = useCallback(() => {
    if (highlightsRef.current && textareaRef.current) highlightsRef.current.scrollTop = textareaRef.current.scrollTop;
  }, []);

  const resize = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
    syncHighlights();
  }, [syncHighlights]);

  useEffect(resize, [text, tokens, resize]);
  const { onDraftChange } = props;
  useEffect(() => {
    // Only persist the selections the draft still refers to.
    const used = new Set(tokens.map((token) => token.label));
    onDraftChange({ text, references: references.filter((reference) => used.has(reference.label)) });
  }, [text, tokens, references, onDraftChange]);

  const insert = useCallback((value: string, extraImages?: ImageAttachment[], extraReferences?: ContextReference[]) => {
    if (extraImages?.length) setImages((current) => [...current, ...extraImages].slice(0, 20));
    if (extraReferences?.length) {
      // Re-sending the same lines refreshes their content.
      const labels = new Set(extraReferences.map((reference) => reference.label));
      setReferences((current) => [...current.filter((reference) => !labels.has(reference.label)), ...extraReferences]);
    }
    if (!value) return;
    const element = textareaRef.current;
    setText((current) => {
      const start = element?.selectionStart ?? current.length;
      const end = element?.selectionEnd ?? current.length;
      const prefix = current.slice(0, start);
      const spacer = prefix && !/\s$/.test(prefix) ? (extraReferences?.length ? " " : "\n\n") : "";
      const next = `${prefix}${spacer}${value}${current.slice(end)}`;
      const position = prefix.length + spacer.length + value.length;
      requestAnimationFrame(() => {
        element?.setSelectionRange(position, position);
        setCaret(position);
      });
      return next;
    });
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    insert,
    toggleModelPicker: () => setPickerOpen((open) => !open),
  }), [insert]);

  const mention = menuDismissed ? undefined : mentionAt(text, caret);
  const slash = menuDismissed ? undefined : slashQuery(text, caret);

  /**
   * Called from input events: when the caret sits in a new `@query`, ask the host for matching
   * files. Only the latest request's results are shown, so stale responses are ignored.
   */
  const requestFiles = (nextText: string, nextCaret: number, dismissed: boolean) => {
    const nextMention = dismissed ? undefined : mentionAt(nextText, nextCaret);
    if (nextMention === undefined) {
      // Leaving the mention ends that search, so re-entering it fetches fresh results.
      if (fileRequest !== undefined) setFileRequest(undefined);
      return;
    }
    if (nextMention.query === fileRequest?.query) return;
    requestCounter.current += 1;
    const id = requestCounter.current;
    setFileRequest({ id, query: nextMention.query });
    setMenuIndex(0);
    post({ version: 1, type: "files.search", requestId: id, query: nextMention.query });
  };

  const replaceRange = useCallback((start: number, end: number, value: string) => {
    setText((current) => current.slice(0, start) + value + current.slice(end));
    const position = start + value.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  }, []);

  const menu: MenuItem[] = useMemo(() => {
    if (slash !== undefined) {
      const needle = slash.toLowerCase();
      const local: MenuItem[] = props.localCommands
        .filter((command) => command.name.startsWith(needle))
        .map((command) => ({
          key: `local:${command.name}`,
          label: `/${command.name}`,
          description: command.description,
          apply: () => {
            setText("");
            command.run();
          },
        }));
      const remote: MenuItem[] = props.commands
        .filter((command) => command.name.toLowerCase().includes(needle))
        .sort((left, right) => Number(!left.name.startsWith(needle)) - Number(!right.name.startsWith(needle)))
        .slice(0, 50)
        .map((command) => ({
          key: `pi:${command.name}`,
          label: `/${command.name}`,
          description: command.description ?? "",
          badge: command.source === "skill" ? "skill" : command.source === "prompt" ? "prompt" : "extension",
          apply: () => replaceRange(0, caret, `/${command.name} `),
        }));
      return [...local, ...remote];
    }
    if (mention !== undefined && fileRequest !== undefined && props.files.requestId === fileRequest.id) {
      // Nothing to complete when the typed path already is the only match.
      if (props.files.files.length === 1 && props.files.files[0] === mention.query) return [];
      return props.files.files.map((file) => ({
        key: `file:${file}`,
        label: file.slice(file.lastIndexOf("/") + 1),
        description: file,
        apply: () => replaceRange(mention.start, caret, `@${file} `),
      }));
    }
    return [];
  }, [slash, mention, props.commands, props.localCommands, props.files, fileRequest, caret, replaceRange]);
  const activeIndex = menu.length ? Math.min(menuIndex, menu.length - 1) : 0;

  const submit = (mode: PromptMode) => {
    const value = expandReferences(text.trim(), references);
    if (!value && !images.length) return;
    props.onSubmit(value, images, mode);
    setText("");
    setImages([]);
    setReferences([]);
    setHistoryIndex(-1);
    setMenuDismissed(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menu.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setMenuIndex((activeIndex + delta + menu.length) % menu.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        menu[activeIndex]?.apply();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === "Backspace" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      // A reference token behaves like a chip: one Backspace removes all of it.
      const { selectionStart, selectionEnd } = event.currentTarget;
      const token = selectionStart === selectionEnd ? tokens.find((candidate) => candidate.end === selectionStart) : undefined;
      if (token) {
        event.preventDefault();
        replaceRange(token.start, token.end, "");
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const steer = isMac ? event.metaKey : event.ctrlKey;
      submit(props.busy ? (steer ? "steer" : "followUp") : "send");
      return;
    }
    if (event.key === "Escape" && props.busy) {
      event.preventDefault();
      props.onAbort();
      return;
    }
    if (event.key === "ArrowUp" && (!text || historyIndex >= 0) && props.history.length) {
      const next = Math.min(historyIndex + 1, props.history.length - 1);
      const value = props.history[props.history.length - 1 - next];
      if (value !== undefined) {
        event.preventDefault();
        setHistoryIndex(next);
        setText(value);
      }
      return;
    }
    if (event.key === "ArrowDown" && historyIndex >= 0) {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setText(next < 0 ? "" : props.history[props.history.length - 1 - next] ?? "");
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const loaded = (await Promise.all([...files].map(readImage))).filter((image): image is ImageAttachment => Boolean(image));
    if (loaded.length) setImages((current) => [...current, ...loaded].slice(0, 20));
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
    else {
      const uri = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (uri) insert(`@${uri.replace(/^file:\/\//, "").split("\n")[0]} `);
    }
  };

  const highlights: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    highlights.push(text.slice(cursor, token.start));
    highlights.push(
      <mark key={token.start} className="composer-reference">
        {token.label}
      </mark>,
    );
    cursor = token.end;
  }
  // The trailing space keeps a final empty line, so the overlay scrolls as far as the textarea.
  highlights.push(`${text.slice(cursor)} `);

  const levels = supportedLevels(props.model);
  const canSend = (text.trim().length > 0 || images.length > 0) && !props.disabled;
  const placeholder = props.busy
    ? `Queue a follow-up · ${isMac ? "⌘" : "Ctrl"}+Enter to steer now`
    : `${isMac ? "⌘" : "Ctrl"} Esc to focus or unfocus Pi`;

  return (
    <div
      className={`composer${dragging ? " dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {menu.length > 0 && (
        <div className="popover composer-menu" role="listbox" aria-label={slash !== undefined ? "Commands" : "Files"}>
          {menu.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`picker-item${index === activeIndex ? " active" : ""}`}
              onMouseEnter={() => setMenuIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => item.apply()}
            >
              <span className="picker-item-main">
                <span className="picker-item-title">{item.label}</span>
                <span className="picker-item-sub">{item.description}</span>
              </span>
              {item.badge && <span className="badge">{item.badge}</span>}
            </button>
          ))}
        </div>
      )}
      {pickerOpen && (
        <ModelPicker
          models={props.models}
          current={props.model}
          thinkingLevel={props.thinkingLevel}
          onSelectModel={(model) => {
            post({ version: 1, type: "model.set", provider: model.provider, modelId: model.id });
            setPickerOpen(false);
            textareaRef.current?.focus();
          }}
          onSelectLevel={(level) => post({ version: 1, type: "thinking.set", level })}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {images.length > 0 && (
        <div className="attachments">
          {images.map((image, index) => (
            <div key={index} className="attachment">
              <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name ?? `Image ${index + 1}`} />
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${image.name ?? "image"}`}
                onClick={() => setImages((current) => current.filter((_, position) => position !== index))}
              >
                <span className="codicon codicon-close" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-field">
      {tokens.length > 0 && (
        <div ref={highlightsRef} className="composer-highlights" aria-hidden="true">
          {highlights}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label="Message Pi"
        disabled={props.disabled}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setMenuDismissed(false);
          setMenuIndex(0);
          setHistoryIndex(-1);
          requestFiles(event.target.value, event.target.selectionStart, false);
        }}
        onSelect={(event) => {
          setCaret(event.currentTarget.selectionStart);
          requestFiles(event.currentTarget.value, event.currentTarget.selectionStart, menuDismissed);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onScroll={syncHighlights}
      />
      </div>
      <div className="composer-toolbar">
        <button
          type="button"
          className="icon-button"
          title="Attach files or images"
          aria-label="Attach files or images"
          onClick={() => post({ version: 1, type: "attach.pick" })}
        >
          <span className="codicon codicon-add" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Commands and skills"
          aria-label="Commands and skills"
          onClick={() => {
            if (!text.startsWith("/")) replaceRange(0, 0, "/");
            else textareaRef.current?.focus();
          }}
        >
          <span className="slash-glyph" aria-hidden="true">/</span>
        </button>
        <button
          type="button"
          className="model-pill"
          title="Choose model and thinking level"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(!pickerOpen)}
        >
          <span className="model-name">{modelLabel(props.model)}</span>
          {levels.length > 1 && props.thinkingLevel && (
            <span className={`model-level level-${props.thinkingLevel}`}>{thinkingLabel(props.thinkingLevel)}</span>
          )}
        </button>
        <span className="toolbar-spacer" />
        <ContextRing stats={props.stats} />
        {props.busy && !canSend ? (
          <button type="button" className="send-button stop" title="Stop (Esc)" aria-label="Stop" onClick={props.onAbort}>
            <span className="stop-glyph" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="send-button"
            title={props.busy ? "Queue follow-up (Enter)" : "Send (Enter)"}
            aria-label="Send"
            disabled={!canSend}
            onClick={() => submit(props.busy ? "followUp" : "send")}
          >
            <span className="codicon codicon-arrow-up" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
});
