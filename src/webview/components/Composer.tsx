import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { ImageAttachment, PromptMode } from "../../shared/protocol";
import type { PiCommand, PiModel, PiSessionStats, ThinkingLevel } from "../../pi/rpc-types";
import { useChat } from "./context";
import { ModelPicker, modelLabel, supportedLevels, thinkingLabel } from "./ModelPicker";

export interface ComposerHandle {
  focus(): void;
  insert(text: string, images?: ImageAttachment[]): void;
  toggleModelPicker(): void;
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

function ContextRing({ stats }: { stats: PiSessionStats | undefined }) {
  const percent = stats?.contextUsage?.percent;
  if (typeof percent !== "number") return null;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(Math.max(percent, 0), 100);
  const tokens = stats?.contextUsage?.tokens;
  const window = stats?.contextUsage?.contextWindow;
  const cost = typeof stats?.cost === "number" && stats.cost > 0 ? ` · $${stats.cost.toFixed(2)}` : "";
  const title = `Context ${clamped.toFixed(0)}% used${
    typeof tokens === "number" && window ? ` (${Math.round(tokens / 1000)}k / ${Math.round(window / 1000)}k tokens)` : ""
  }${cost}`;
  return (
    <span className={`context-ring${clamped > 80 ? " high" : ""}`} title={title} aria-label={title} role="img">
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
    </span>
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
  initialDraft: string;
  history: string[];
  onDraftChange(text: string): void;
  onSubmit(text: string, images: ImageAttachment[], mode: PromptMode): void;
  onAbort(): void;
  files: { requestId: number; files: string[] };
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { post } = useChat();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(props.initialDraft);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [dragging, setDragging] = useState(false);
  const requestRef = useRef(0);
  const isMac = props.platform === "darwin";

  const resize = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
  }, []);

  useEffect(resize, [text, resize]);
  const { onDraftChange } = props;
  useEffect(() => onDraftChange(text), [text, onDraftChange]);

  const insert = useCallback((value: string, extraImages?: ImageAttachment[]) => {
    if (extraImages?.length) setImages((current) => [...current, ...extraImages].slice(0, 20));
    if (!value) return;
    const element = textareaRef.current;
    setText((current) => {
      const start = element?.selectionStart ?? current.length;
      const end = element?.selectionEnd ?? current.length;
      const prefix = current.slice(0, start);
      const spacer = prefix && !/\s$/.test(prefix) ? "\n\n" : "";
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

  // Keep the latest `post` in a ref so a new callback identity does not re-issue the search
  // (which would invalidate the results currently on screen).
  const postRef = useRef(post);
  postRef.current = post;
  const mentionQuery = mention?.query;
  useEffect(() => {
    if (mentionQuery === undefined) return;
    requestRef.current += 1;
    postRef.current({ version: 1, type: "files.search", requestId: requestRef.current, query: mentionQuery });
  }, [mentionQuery]);

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
    if (mention !== undefined && props.files.requestId === requestRef.current) {
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
  }, [slash, mention, props.commands, props.localCommands, props.files, caret, replaceRange]);

  useEffect(() => setMenuIndex(0), [slash, mention?.query]);

  const submit = (mode: PromptMode) => {
    const value = text.trim();
    if (!value && !images.length) return;
    props.onSubmit(value, images, mode);
    setText("");
    setImages([]);
    setHistoryIndex(-1);
    setMenuDismissed(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menu.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setMenuIndex((index) => (index + delta + menu.length) % menu.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        menu[menuIndex]?.apply();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(true);
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
              aria-selected={index === menuIndex}
              className={`picker-item${index === menuIndex ? " active" : ""}`}
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
          setHistoryIndex(-1);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
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
