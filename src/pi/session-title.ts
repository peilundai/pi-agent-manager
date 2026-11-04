import { findReferenceTokens, parseReferencedPrompt } from "../shared/context-references";

const DEFAULT_MAX_LENGTH = 52;

/** Drops attached selections and names each `@path#lines` chip by its file name. */
function removeSelectionChips(prompt: string): string {
  const { message, references } = parseReferencedPrompt(prompt);
  if (!references.length) return prompt;
  const names = new Map(references.map((reference) => [reference.label, reference.path.slice(reference.path.lastIndexOf("/") + 1)]));
  let output = "";
  let cursor = 0;
  for (const token of findReferenceTokens(message, [...names.keys()])) {
    output += message.slice(cursor, token.start) + (names.get(token.label) ?? "");
    cursor = token.end;
  }
  return output + message.slice(cursor);
}

function removeEditorContext(prompt: string): string {
  return stripFencedBlocks(removeSelectionChips(prompt))
    .replace(/^\s*From\s+`?[^`\n]+`?\s+lines?\s+\d+(?:-\d+)?:\s*/i, " ");
}

function stripFencedBlocks(prompt: string): string {
  const output: string[] = [];
  let fenceLength: number | undefined;
  for (const line of prompt.split(/\r?\n/)) {
    if (fenceLength === undefined) {
      const opening = /^\s*(`{3,})[^`]*$/.exec(line);
      if (opening) fenceLength = opening[1]?.length;
      else output.push(line);
      continue;
    }
    const closing = new RegExp("^\\s*`{" + fenceLength + ",}\\s*$");
    if (closing.test(line)) fenceLength = undefined;
  }
  return output.join("\n");
}

function removeRequestFiller(value: string): string {
  return value.replace(
    /^(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+|i\s+need\s+you\s+to\s+|help\s+me\s+)/i,
    "",
  );
}

function firstSentence(value: string): string {
  const match = /^(.+?)(?:[.!?](?:\s|$)|$)/.exec(value);
  return (match?.[1] ?? value).trim();
}

function truncateAtWord(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return "…".slice(0, maximum);

  const available = maximum - 1;
  const prefix = value.slice(0, available + 1);
  const boundary = prefix.lastIndexOf(" ");
  const truncated = boundary > 0 ? prefix.slice(0, boundary) : value.slice(0, available);
  return `${truncated.trimEnd()}…`;
}

export function generateSessionTitle(
  prompt: string,
  maximumLength = DEFAULT_MAX_LENGTH,
): string | undefined {
  if (!Number.isInteger(maximumLength) || maximumLength < 1) return undefined;

  const normalized = removeRequestFiller(removeEditorContext(prompt).replace(/\s+/g, " ").trim());
  const sentence = firstSentence(normalized).replace(/^[\s:;,\-–—]+|[\s:;,\-–—]+$/g, "");
  if (!sentence) return undefined;

  const title = `${sentence[0]?.toLocaleUpperCase() ?? ""}${sentence.slice(1)}`;
  return truncateAtWord(title, maximumLength);
}
