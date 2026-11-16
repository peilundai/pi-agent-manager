import type { ContextReference } from "./protocol";

export interface ReferenceToken {
  start: number;
  end: number;
  label: string;
}

/** A reference recovered from a sent prompt, with the location its label names. */
export interface ParsedReference extends ContextReference {
  path: string;
  /** One-based, inclusive. */
  startLine: number;
  endLine: number;
  code: string;
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

/** Matches one block written by `formatEditorSelection`, anchored where `lastIndex` points. */
const BLOCK = /From `((?:[^`\\\n]|\\.)+)` (?:line (\d+)|lines (\d+)-(\d+)):\n\n(`{3,})[^\n`]*\n([\s\S]*?)\n\5(?=\n\n|$)/y;

function parseBlocks(text: string, from: number): ParsedReference[] | undefined {
  const references: ParsedReference[] = [];
  let position = from;
  while (position < text.length) {
    BLOCK.lastIndex = position;
    const match = BLOCK.exec(text);
    if (!match) return undefined;
    const path = (match[1] ?? "").replace(/\\`/g, "`");
    const startLine = Number(match[2] ?? match[3]);
    const endLine = Number(match[2] ?? match[4]);
    references.push({
      label: `@${path}#${startLine === endLine ? startLine : `${startLine}-${endLine}`}`,
      text: `${match[0]}\n\n`,
      path,
      startLine,
      endLine,
      code: match[6] ?? "",
    });
    position = BLOCK.lastIndex;
    if (position === text.length) break;
    if (!text.startsWith("\n\n", position)) return undefined;
    position += 2;
  }
  return references.length ? references : undefined;
}

/**
 * Splits a prompt built by `expandReferences` back into the typed message and its references,
 * so a sent prompt can show chips again. Anything else comes back unchanged with no references.
 */
export function parseReferencedPrompt(text: string): { message: string; references: ParsedReference[] } {
  for (let index = text.indexOf("\n\nFrom `"); index !== -1; index = text.indexOf("\n\nFrom `", index + 1)) {
    const references = parseBlocks(text, index + 2);
    if (!references) continue;
    const message = text.slice(0, index);
    const present = new Set(findReferenceTokens(message, references.map((reference) => reference.label)).map((token) => token.label));
    if (references.every((reference) => present.has(reference.label))) return { message, references };
  }
  return { message: text, references: [] };
}
