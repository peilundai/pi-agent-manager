import { memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { parseFileReference, useChat } from "./context";

/**
 * Splits markdown into top-level blocks separated by blank lines, keeping fenced
 * code intact. While streaming only the last block changes, so earlier blocks
 * stay memoized and are not re-parsed on every delta.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  let blankRun = 0;
  for (const line of lines) {
    if (!fence && line.trim() === "") {
      if (current.length) blankRun += 1;
      continue;
    }
    if (blankRun) {
      // Indented lines continue the previous block (list item paragraphs, nested code).
      if (/^[ \t]/.test(line)) current.push(...Array<string>(blankRun).fill(""));
      else {
        blocks.push(current.join("\n"));
        current = [];
      }
      blankRun = 0;
    }
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function CodeBlock({ language, children }: { language: string | undefined; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(textOf(children).replace(/\n$/, "")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_200);
    });
  };
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language ?? "text"}</span>
        <button type="button" className="icon-button small" onClick={copy} aria-label="Copy code" title="Copy">
          <span className={`codicon codicon-${copied ? "check" : "copy"}`} />
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function useComponents(): Components {
  const { post } = useChat();
  return useMemo<Components>(
    () => ({
      a({ href, children }) {
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (!href) return;
              if (/^https?:\/\//i.test(href)) post({ version: 1, type: "url.open", url: href });
              else {
                const ref = parseFileReference(href.replace(/^file:\/\//, ""));
                if (ref) post({ version: 1, type: "file.open", path: ref.path, ...(ref.line !== undefined ? { line: ref.line } : {}) });
              }
            }}
          >
            {children}
          </a>
        );
      },
      pre({ children }) {
        const child = Array.isArray(children) ? children[0] : children;
        const className =
          child && typeof child === "object" && "props" in child
            ? String((child as { props: { className?: string } }).props.className ?? "")
            : "";
        const language = /language-([\w+-]+)/.exec(className)?.[1];
        return <CodeBlock language={language}>{children}</CodeBlock>;
      },
      code({ className, children }) {
        if (className) return <code className={className}>{children}</code>;
        const text = textOf(children);
        const ref = parseFileReference(text);
        if (!ref) return <code>{children}</code>;
        return (
          <code
            className="file-ref"
            role="link"
            tabIndex={0}
            title={`Open ${ref.path}`}
            onClick={() => post({ version: 1, type: "file.open", path: ref.path, ...(ref.line !== undefined ? { line: ref.line } : {}) })}
            onKeyDown={(event) => {
              if (event.key === "Enter") post({ version: 1, type: "file.open", path: ref.path, ...(ref.line !== undefined ? { line: ref.line } : {}) });
            }}
          >
            {children}
          </code>
        );
      },
      table({ children }) {
        return (
          <div className="table-wrap">
            <table>{children}</table>
          </div>
        );
      },
    }),
    [post],
  );
}

const remarkPlugins = [remarkGfm];
const rehypePlugins: Parameters<typeof ReactMarkdown>[0]["rehypePlugins"] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

const MarkdownBlock = memo(function MarkdownBlock({ source, components }: { source: string; components: Components }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {source}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const components = useComponents();
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <div className="markdown">
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} source={block} components={components} />
      ))}
    </div>
  );
});
