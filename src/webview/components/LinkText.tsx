import { Fragment, useState } from "react";
import { useChat } from "./context";

/** URLs at least this long get their own chip instead of an inline link. */
const CHIP_MIN_LENGTH = 48;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = ".,;:!?'\"";
const CLOSING_BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/**
 * Drops prose punctuation that ends a URL, as GitHub's autolinks do: trailing marks
 * such as "." or "," and closing brackets without a matching opener in the URL,
 * so "(see https://x.io/a_(b))" keeps "a_(b)".
 */
export function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1] ?? "";
    const opener = CLOSING_BRACKETS[char];
    const body = url.slice(0, end);
    if (TRAILING_PUNCTUATION.includes(char) || (opener && count(body, char) > count(body, opener))) end -= 1;
    else break;
  }
  return url.slice(0, end);
}

export type TextSegment = { type: "text"; text: string } | { type: "url"; url: string; block: boolean };

/**
 * Splits plain text into text and URL segments. Long URLs are marked as blocks; the
 * whitespace around a block is dropped so the chip does not leave blank lines behind.
 */
export function splitLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const url = trimUrl(match[0]);
    if (start > last) segments.push({ type: "text", text: text.slice(last, start) });
    segments.push({ type: "url", url, block: url.length >= CHIP_MIN_LENGTH });
    last = start + url.length;
  }
  if (last < text.length) segments.push({ type: "text", text: text.slice(last) });
  return segments
    .map((segment, index) => {
      if (segment.type !== "text") return segment;
      const before = segments[index - 1];
      const after = segments[index + 1];
      let value = segment.text;
      if (before?.type === "url" && before.block) value = value.replace(/^\s+/, "");
      if (after?.type === "url" && after.block) value = value.replace(/\s+$/, "");
      return { ...segment, text: value };
    })
    .filter((segment) => segment.type !== "text" || segment.text !== "");
}

export function isUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/** Host in full, the rest of the URL dimmed and truncated with an ellipsis. */
function UrlParts({ url }: { url: string }) {
  const match = /^(https?:\/\/)([^/?#]+)(.*)$/i.exec(url);
  if (!match) return <span className="url-rest">{url}</span>;
  return (
    <>
      <span className="url-host">{match[2]}</span>
      <span className="url-rest">{match[3]}</span>
    </>
  );
}

export function UrlChip({ url }: { url: string }) {
  const { post } = useChat();
  const [copied, setCopied] = useState(false);
  return (
    <span className="url-chip">
      <button type="button" className="url-chip-open" title={url} onClick={() => post({ version: 1, type: "url.open", url })}>
        <span className="codicon codicon-link-external" aria-hidden="true" />
        <span className="url-chip-text">
          <UrlParts url={url} />
        </span>
      </button>
      <button
        type="button"
        className="icon-button small url-chip-copy"
        aria-label={copied ? "Copied" : "Copy link"}
        title={copied ? "Copied" : "Copy link"}
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <span className={`codicon codicon-${copied ? "check" : "copy"}`} aria-hidden="true" />
      </button>
    </span>
  );
}

/** Plain text with its URLs made clickable: short ones inline, long ones as chips. */
export function LinkText({ text }: { text: string }) {
  const { post } = useChat();
  return (
    <>
      {splitLinks(text).map((segment, index) => {
        if (segment.type === "text") return <Fragment key={index}>{segment.text}</Fragment>;
        if (segment.block) return <UrlChip key={index} url={segment.url} />;
        return (
          <a
            key={index}
            href={segment.url}
            className="inline-link"
            onClick={(event) => {
              event.preventDefault();
              post({ version: 1, type: "url.open", url: segment.url });
            }}
          >
            {segment.url}
          </a>
        );
      })}
    </>
  );
}
